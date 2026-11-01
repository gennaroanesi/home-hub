/**
 * Post-deploy integration check for lib/ops on a deployed branch. Only reads
 * and deliberately invalid writes: it never changes data.
 *
 *   1. Web/mobile path: Cognito login → runOp mutation → ops Lambda.
 *   2. Janet/Muse path: the agent Lambda's apiListTools / apiTool entry points,
 *      and one real Claude call the way /ask makes it.
 *   3. External API (only when MUSE_API_KEY is set): spec + /tools/*, and the
 *      old /api/muse URL.
 *
 * Usage (from the repo root, after the deploy finishes):
 *   npx ampx generate outputs --app-id <id> --branch main --out-dir /tmp/prod-outputs
 *   AWS_PROFILE=amplify-dev npm run ops-smoke -- /tmp/prod-outputs/amplify_outputs.json
 *
 * Reads PRD_USER / PRD_PASS (and MUSE_API_KEY, HOME_HUB_URL) from .env.local.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { InvokeCommand, LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import type { Schema } from "../amplify/data/resource";
import { OPS } from "../lib/ops/registry";

for (const line of readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

const opNames = OPS.map((o) => o.name);
const INVALID_SAVE = { itemId: "smoke-test-no-such-item", status: "OWNED" };

async function webPath(outputsPath: string) {
  console.log("\n== runOp mutation (web/mobile)");
  Amplify.configure(JSON.parse(readFileSync(outputsPath, "utf8")), { ssr: false });
  await signOut().catch(() => {});
  await signIn({ username: process.env.PRD_USER!, password: process.env.PRD_PASS! });
  const client = generateClient<Schema>({ authMode: "userPool" }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = async (name: string, input: unknown) => {
    const r = await client.mutations.runOp({ name, input: JSON.stringify(input), via: "web" });
    if (r.errors?.length) return { error: `GraphQL: ${r.errors[0].message}` };
    let data = r.data;
    while (typeof data === "string") data = JSON.parse(data);
    return data;
  };
  try {
    const list = await call("list_wardrobe", { personName: process.env.SMOKE_PERSON ?? "Gennaro", limit: 1 });
    check("list_wardrobe returns items with every field", Array.isArray(list.result?.items) && "photoUrls" in (list.result.items[0] ?? {}), list);
    const plan = await call("get_trip_plan", { personName: process.env.SMOKE_PERSON ?? "Gennaro" });
    check("get_trip_plan answers (a plan or a clear error)", !!plan.result?.status || /No upcoming trips/.test(plan.error ?? ""), plan);
    const bad = await call("save_wardrobe_item", INVALID_SAVE);
    check("save_wardrobe_item rejects bad input without saving", /status/.test(bad.error ?? ""), bad);
    const unknown = await call("no_such_op", {});
    check("unknown op is refused", unknown.error === "Unknown operation: no_such_op", unknown);
  } finally {
    await signOut();
  }
}

async function agentPath() {
  console.log("\n== agent Lambda (Janet + Muse)");
  const lambda = new LambdaClient({ region: "us-east-1" });
  const branch = process.env.SMOKE_BRANCH ?? "main";
  let fn: string | undefined;
  let marker: string | undefined;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
    fn ??= page.Functions?.find((f) => f.FunctionName?.includes(`-${branch}-homeagentlambda`))?.FunctionName;
    marker = page.NextMarker;
  } while (!fn && marker);
  if (!fn) return check(`found the ${branch} agent Lambda`, false);
  const invoke = async (payload: unknown) => {
    const out = await lambda.send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(payload)) }));
    return JSON.parse(Buffer.from(out.Payload ?? []).toString() || "null");
  };
  const { tools } = await invoke({ apiListTools: true });
  for (const name of opNames) {
    const t = tools.find((x: any) => x.name === name); // eslint-disable-line @typescript-eslint/no-explicit-any
    check(`${name} is listed with output schema and access`, !!t?.output_schema && !!t?.access, t && { access: t.access });
  }
  const list = await invoke({ apiTool: { name: "list_wardrobe", input: { limit: 1 }, sender: process.env.SMOKE_PERSON ?? "Gennaro" } });
  check("apiTool list_wardrobe returns a result", Array.isArray(list.result?.items), list);
  const bad = await invoke({ apiTool: { name: "save_wardrobe_item", input: INVALID_SAVE, sender: "Gennaro" } });
  check("apiTool reports op errors as error (gateway → 400)", typeof bad.error === "string" && bad.result === undefined, bad);
  // A real Claude call with the API tool list, the path /ask takes. Asks for
  // no tools, so it changes nothing.
  const ask = await invoke({
    arguments: {
      message: "Smoke test: reply with just OK. Don't use any tools.",
      history: [],
      sender: process.env.SMOKE_PERSON ?? "Gennaro",
      chatContext: { channel: "API", chatJid: null },
    },
  });
  check("/ask path gets a reply from Claude", typeof ask?.message === "string" && !ask?.errorMessage, ask);
}

async function musePath() {
  const key = process.env.MUSE_API_KEY;
  if (!key) return console.log("\n== external API: skipped (no MUSE_API_KEY)");
  console.log("\n== external API");
  const base = (process.env.HOME_HUB_URL ?? "https://home.cristinegennaro.com/api/v1").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const spec = await (await fetch(`${base}/openapi.json`, { headers })).json();
  check("spec marks ops with x-access", opNames.every((n) => spec.paths?.[`/tools/${n}`]?.post?.["x-access"]), Object.keys(spec.paths ?? {}).length);
  const ok = await fetch(`${base}/tools/list_wardrobe`, { method: "POST", headers, body: JSON.stringify({ limit: 1 }) });
  check("POST /tools/list_wardrobe → 200", ok.status === 200, ok.status);
  const bad = await fetch(`${base}/tools/save_wardrobe_item`, { method: "POST", headers, body: JSON.stringify(INVALID_SAVE) });
  check("POST invalid save → 400", bad.status === 400, await bad.text());
  const noKey = await fetch(`${base}/tools/list_wardrobe`, { method: "POST", body: "{}" });
  check("no bearer key → 401", noKey.status === 401, noKey.status);
  const old = await fetch(`${base.replace(/\/api\/v1$/, "/api/muse")}/tools/list_wardrobe`, { method: "POST", headers, body: JSON.stringify({ limit: 1 }) });
  check("old /api/muse URL still works", old.status === 200, old.status);
}

(async () => {
  const outputs = process.argv[2] ?? "amplify_outputs.json";
  await webPath(outputs);
  await agentPath();
  await musePath();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
