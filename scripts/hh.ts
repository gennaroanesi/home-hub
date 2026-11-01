/**
 * hh — command line for Home Hub, generated from the external API spec.
 * Every operation Janet and the Muse API have is a command here, with no
 * per-command code. See docs/ops-architecture.md.
 *
 *   npm run hh                         list operations (R = read, W = write, ? = legacy, may write)
 *   npm run hh -- help save_wardrobe_item
 *   npm run hh -- list_wardrobe --status WISHLIST --limit 5
 *   npm run hh -- save_wardrobe_item --itemId abc --status KEEP          (dry run)
 *   npm run hh -- save_wardrobe_item --itemId abc --status KEEP --yes    (does it)
 *   npm run hh -- save_wardrobe_item --json '{"name":"…","category":"Tops"}' --yes
 *
 * Flags are coerced by the parameter's type in the spec; repeat a flag for
 * an array, or pass JSON (--imageUrls '["https://…"]'). Anything that isn't
 * a read is a dry run unless --yes.
 *
 * Reads MUSE_API_KEY (required) and HOME_HUB_URL (default prod) from the
 * environment or .env.local. Acts as the API's MUSE_SENDER.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Schema = { type?: string | string[]; enum?: unknown[]; description?: string; items?: Schema; anyOf?: Schema[] };
export type Operation = {
  operationId: string;
  summary?: string;
  description?: string;
  "x-access"?: string;
  requestBody?: { content?: { "application/json"?: { schema?: { properties?: Record<string, Schema>; required?: string[] } } } };
};

function loadEnv() {
  try {
    const text = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // no .env.local: rely on the environment
  }
}

/** Thrown for user mistakes; main prints the message and exits 1. */
export class UsageError extends Error {}
function fail(msg: string): never {
  throw new UsageError(msg);
}

/** The /tools/* operations in an OpenAPI document, by name. */
export function operationsFrom(doc: { paths: Record<string, { post?: Operation }> }): Map<string, Operation> {
  const ops = new Map<string, Operation>();
  for (const [p, item] of Object.entries(doc.paths)) {
    if (p.startsWith("/tools/") && item.post) ops.set(item.post.operationId, item.post);
  }
  return ops;
}

const params = (op: Operation) => op.requestBody?.content?.["application/json"]?.schema ?? {};
const typesOf = (s: Schema): string[] =>
  s.anyOf ? s.anyOf.flatMap(typesOf) : Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
const accessMark = (op: Operation) => ({ read: "R", write: "W", sensitive: "S" })[op["x-access"] ?? ""] ?? "?";

export function coerce(raw: string, s: Schema | undefined): unknown {
  const types = s ? typesOf(s) : [];
  if (types.length === 1 && types[0] === "string") return raw; // keep "0042" style codes as text
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function parseArgs(argv: string[], op: Operation) {
  const props = params(op).properties ?? {};
  let input: Record<string, unknown> = {};
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") {
      yes = true;
      continue;
    }
    if (!a.startsWith("--")) fail(`Unexpected argument "${a}". Use --name value.`);
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const raw = eq > 0 ? a.slice(eq + 1) : (argv[++i] ?? fail(`--${key} needs a value`));
    if (key === "json") {
      input = { ...input, ...(JSON.parse(raw) as Record<string, unknown>) };
      continue;
    }
    if (!props[key]) fail(`${op.operationId} has no parameter "${key}". Try: npm run hh -- help ${op.operationId}`);
    const isArray = typesOf(props[key]).includes("array");
    // An array flag takes one value per repeat, or a whole JSON array.
    const whole = isArray && raw.trim().startsWith("[") ? (() => { try { return JSON.parse(raw) as unknown; } catch { return undefined; } })() : undefined;
    const value = Array.isArray(whole) ? whole : coerce(raw, isArray ? props[key].items : props[key]);
    if (isArray) input[key] = [...((input[key] as unknown[]) ?? []), ...(Array.isArray(value) ? value : [value])];
    else input[key] = value;
  }
  return { input, yes };
}

function help(op: Operation) {
  console.log(`${op.operationId}  [${op["x-access"] ?? "unknown"}]\n\n${op.description ?? ""}\n`);
  const { properties = {}, required = [] } = params(op);
  for (const [k, s] of Object.entries(properties)) {
    const type = s.enum ? s.enum.join("|") : typesOf(s).join("|") || "any";
    console.log(`  --${k}${required.includes(k) ? " (required)" : ""}  ${type}${s.description ? `  ${s.description}` : ""}`);
  }
}

/** Only reads skip the dry run; legacy tools ("unknown") might write. */
export const needsConfirmation = (op: Operation) => op["x-access"] !== "read";

async function main() {
  loadEnv();
  const base = (process.env.HOME_HUB_URL ?? "https://home.cristinegennaro.com/api/v1").replace(/\/$/, "");
  const key = process.env.MUSE_API_KEY ?? fail("MUSE_API_KEY isn't set (add it to .env.local).");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const specRes = await fetch(`${base}/openapi.json`, { headers });
  if (!specRes.ok) fail(`Couldn't load ${base}/openapi.json (HTTP ${specRes.status})`);
  const ops = operationsFrom((await specRes.json()) as { paths: Record<string, { post?: Operation }> });

  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "list") {
    for (const op of Array.from(ops.values()).sort((a, b) => a.operationId.localeCompare(b.operationId))) {
      console.log(`${accessMark(op)} ${op.operationId.padEnd(30)} ${op.summary ?? ""}`);
    }
    return;
  }
  if (cmd === "help") {
    const op = ops.get(rest[0] ?? "") ?? fail(`Unknown operation "${rest[0] ?? ""}"`);
    return help(op);
  }
  const op = ops.get(cmd) ?? fail(`Unknown operation "${cmd}". Run npm run hh to list them.`);
  const { input, yes } = parseArgs(rest, op);
  if (needsConfirmation(op) && !yes) {
    console.log(`Dry run (${op["x-access"] ?? "unknown"} operation). Would POST /tools/${cmd}:\n${JSON.stringify(input, null, 2)}\nRe-run with --yes to do it.`);
    return;
  }
  const res = await fetch(`${base}/tools/${cmd}`, { method: "POST", headers, body: JSON.stringify(input) });
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { result?: unknown; error?: string; details?: unknown };
  if (!res.ok || body.error) {
    console.error(JSON.stringify({ error: body.error ?? `HTTP ${res.status}`, ...(body.details ? { details: body.details } : {}) }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(body.result, null, 2));
}

// Run only as a command, not when a test imports the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
