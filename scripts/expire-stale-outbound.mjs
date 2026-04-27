#!/usr/bin/env node
/**
 * Mark all PENDING homeOutboundMessage rows older than 12h as FAILED.
 *
 * One-shot cleanup tool. The bot now does this automatically on every
 * poll (whatsapp-bot/src/index.ts pollOutbound), but this script lets
 * you flush stale rows without waiting for the bot to redeploy or to
 * run, e.g. when the bot is offline or you want a clean queue before
 * shipping.
 *
 * Usage:
 *   node scripts/expire-stale-outbound.mjs               # dry run
 *   node scripts/expire-stale-outbound.mjs --apply        # actually update
 *   node scripts/expire-stale-outbound.mjs --apply --age-hours 24
 *
 * Auth: signed with AWS SigV4 against the prod AppSync endpoint, using
 * the `amplify-dev` profile (override with --profile).
 */

import { SignatureV4 } from "@smithy/signature-v4";
import { fromIni } from "@aws-sdk/credential-providers";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import process from "node:process";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PROFILE = pickArg("--profile", "amplify-dev");
const AGE_HOURS = Number(pickArg("--age-hours", "12"));
const REGION = pickArg("--region", "us-east-1");
const ENDPOINT = pickArg(
  "--endpoint",
  "https://pzn6gqjwxndatgpb6ujcey47fe.appsync-api.us-east-1.amazonaws.com/graphql"
);

function pickArg(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1];
}

if (!Number.isFinite(AGE_HOURS) || AGE_HOURS <= 0) {
  console.error(`Bad --age-hours: ${AGE_HOURS}`);
  process.exit(2);
}

const signer = new SignatureV4({
  credentials: fromIni({ profile: PROFILE }),
  region: REGION,
  service: "appsync",
  sha256: Sha256,
});

async function gql(query, variables = {}) {
  const url = new URL(ENDPOINT);
  const body = JSON.stringify({ query, variables });
  const req = new HttpRequest({
    method: "POST",
    hostname: url.hostname,
    path: url.pathname,
    headers: { "Content-Type": "application/json", host: url.hostname },
    body,
  });
  const signed = await signer.sign(req);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: signed.headers,
    body,
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    throw new Error(`AppSync ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

const LIST_QUERY = `
  query ListPending($nextToken: String) {
    listHomeOutboundMessageByStatus(status: PENDING, limit: 100, nextToken: $nextToken) {
      items { id kind target createdAt }
      nextToken
    }
  }
`;

const FAIL_MUTATION = `
  mutation FailOutbound($input: UpdateHomeOutboundMessageInput!) {
    updateHomeOutboundMessage(input: $input) { id status }
  }
`;

async function listAllPending() {
  const all = [];
  let nextToken = null;
  do {
    const data = await gql(LIST_QUERY, { nextToken });
    const conn = data.listHomeOutboundMessageByStatus;
    if (conn?.items?.length) all.push(...conn.items);
    nextToken = conn?.nextToken ?? null;
  } while (nextToken);
  return all;
}

async function failOne(id, createdAt) {
  await gql(FAIL_MUTATION, {
    input: {
      id,
      status: "FAILED",
      error: `Stale: PENDING for >${AGE_HOURS}h (created ${createdAt})`,
    },
  });
}

const cutoffMs = Date.now() - AGE_HOURS * 3600 * 1000;
const cutoffIso = new Date(cutoffMs).toISOString();

console.log(`Profile : ${PROFILE}`);
console.log(`Endpoint: ${ENDPOINT}`);
console.log(`Cutoff  : ${cutoffIso} (>${AGE_HOURS}h old)`);
console.log(`Mode    : ${APPLY ? "APPLY" : "DRY RUN (use --apply to actually update)"}`);
console.log();

const pending = await listAllPending();
console.log(`Found ${pending.length} PENDING row(s) total`);

const stale = pending.filter((m) => new Date(m.createdAt).getTime() < cutoffMs);
const fresh = pending.filter((m) => new Date(m.createdAt).getTime() >= cutoffMs);

console.log(`  ${stale.length} stale (will FAIL)`);
console.log(`  ${fresh.length} fresh (will keep)`);
console.log();

for (const m of stale.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
  console.log(`  STALE  ${m.id}  ${m.createdAt}  ${m.kind ?? "?"}/${m.target}`);
}
for (const m of fresh.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
  console.log(`  KEEP   ${m.id}  ${m.createdAt}  ${m.kind ?? "?"}/${m.target}`);
}

if (!APPLY) {
  console.log("\nDry run complete. Re-run with --apply to FAIL stale rows.");
  process.exit(0);
}

if (stale.length === 0) {
  console.log("\nNothing to do.");
  process.exit(0);
}

console.log(`\nMarking ${stale.length} stale row(s) FAILED…`);
let ok = 0;
let bad = 0;
for (const m of stale) {
  try {
    await failOne(m.id, m.createdAt);
    ok++;
    process.stdout.write(".");
  } catch (err) {
    bad++;
    console.error(`\n  FAIL ${m.id}: ${err.message}`);
  }
}
console.log(`\nDone. ${ok} succeeded, ${bad} failed.`);
process.exit(bad > 0 ? 1 : 0);
