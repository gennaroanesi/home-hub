// Sets up one of the household's SimpleFIN connections
// (lib/finance/simplefin-connections.ts): claims a SimpleFIN Bridge setup
// token for its access URL and stores it in the connection's Secrets Manager
// secret as {"accessUrl": "…"}, creating the secret or replacing its value.
// finance-sync reads the secret at run time, so no redeploy is needed.
//
//   AWS_PROFILE=amplify-dev node scripts/setup-simplefin-connection.mjs --connection cristine --setup-token <token from SimpleFIN Bridge>
//   AWS_PROFILE=amplify-dev node scripts/setup-simplefin-connection.mjs --connection cristine --access-url 'https://user:pass@bridge.simplefin.org/simplefin'
//   AWS_PROFILE=amplify-dev node scripts/setup-simplefin-connection.mjs --connection cristine --check
//
// A setup token can be claimed once; the access URL is the real secret and is
// never printed (only masked). --check lists the account names the stored
// URL can see (balances-only call), to confirm the right banks are connected.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? "true" : arr[i + 1]]);
    return acc;
  }, []),
);

const CONNECTIONS = {
  gennaro: "home-hub/simplefin/gennaro", // gennaroanesi.com keeps its own copy in gennaroanesi/simplefin
  cristine: "home-hub/simplefin/cristine",
};
const key = args.connection;
const secretName = CONNECTIONS[key];
if (!secretName) {
  console.error(`--connection must be one of: ${Object.keys(CONNECTIONS).join(", ")} (see lib/finance/simplefin-connections.ts)`);
  process.exit(1);
}
const region = process.env.AWS_REGION ?? "us-east-1";
// Homebrew's aws isn't always on PATH for node; AWS_CLI overrides.
const AWS_BIN = process.env.AWS_CLI ?? (existsSync("/opt/homebrew/bin/aws") ? "/opt/homebrew/bin/aws" : "aws");
const aws = (...a) => execFileSync(AWS_BIN, ["secretsmanager", ...a, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function mask(url) {
  try {
    const u = new URL(url);
    u.username = u.username ? u.username[0] + "***" : "";
    u.password = u.password ? "***" : "";
    return u.toString();
  } catch {
    return "(unparseable)";
  }
}

async function claim(setupToken) {
  const claimUrl = Buffer.from(setupToken.trim(), "base64").toString("utf8");
  if (!claimUrl.startsWith("http")) throw new Error("The setup token didn't decode to a URL; copy it again from SimpleFIN Bridge");
  const res = await fetch(claimUrl, { method: "POST" });
  if (!res.ok) throw new Error(`Claim failed: HTTP ${res.status} ${await res.text()}`);
  const accessUrl = (await res.text()).trim();
  if (!accessUrl.startsWith("http")) throw new Error(`Claim returned something other than a URL: ${accessUrl.slice(0, 80)}`);
  return accessUrl;
}

async function listNames(accessUrl) {
  const u = new URL(accessUrl);
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
  u.username = "";
  u.password = "";
  const res = await fetch(`${u.toString().replace(/\/$/, "")}/accounts?balances-only=1`, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`SimpleFIN /accounts: HTTP ${res.status}`);
  const body = await res.json();
  return { names: (body.accounts ?? []).map((a) => `${a.org?.name ?? ""} · ${a.name}`), errors: body.errors ?? [] };
}

function readStored() {
  try {
    const out = JSON.parse(aws("get-secret-value", "--secret-id", secretName));
    return JSON.parse(out.SecretString ?? "{}").accessUrl ?? null;
  } catch (e) {
    if (String(e.stderr ?? e.message).includes("ResourceNotFoundException")) return null;
    throw e;
  }
}

function store(accessUrl) {
  const value = JSON.stringify({ accessUrl });
  const exists = secretExists();
  if (exists) aws("put-secret-value", "--secret-id", secretName, "--secret-string", value);
  else aws("create-secret", "--name", secretName, "--description", `Home Hub SimpleFIN access URL (${key})`, "--secret-string", value);
  return exists ? "replaced" : "created";
}

function secretExists() {
  try {
    aws("describe-secret", "--secret-id", secretName);
    return true;
  } catch {
    return false;
  }
}

try {
  if (args.check === "true") {
    const stored = readStored();
    if (!stored) {
      console.log(`${key}: no access URL stored in ${secretName} yet.`);
      process.exit(2);
    }
    console.log(`${key}: ${secretName} → ${mask(stored)}`);
    const { names, errors } = await listNames(stored);
    for (const n of names) console.log(`  ${n}`);
    for (const e of errors) console.log(`  ! ${e}`);
    process.exit(0);
  }
  let accessUrl = args["access-url"] && args["access-url"] !== "true" ? args["access-url"].trim() : null;
  if (!accessUrl) {
    if (!args["setup-token"] || args["setup-token"] === "true") throw new Error("Pass --setup-token <token> (from SimpleFIN Bridge → New App) or --access-url");
    accessUrl = await claim(args["setup-token"]);
    console.log(`Claimed: ${mask(accessUrl)}`);
  }
  const { names } = await listNames(accessUrl);
  console.log(`That URL sees ${names.length} account(s):`);
  for (const n of names) console.log(`  ${n}`);
  const what = store(accessUrl);
  console.log(`Secret ${secretName} ${what}. finance-sync picks it up within 15 minutes (or on its next cold start); "Pick" on /finance/accounts lists these under ${key}.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
