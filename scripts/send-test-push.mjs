#!/usr/bin/env node
/**
 * Send a test Expo push notification to every registered
 * homePushSubscription row (optionally filtered to one person).
 *
 * Used end-to-end to verify the mobile app's push pipeline:
 *   mobile signs in →
 *   registers Expo token →
 *   row lands in homePushSubscription →
 *   this script reads the row + fires a notification →
 *   the device receives it.
 *
 * Once the expo-push-deliver Lambda is in place this script becomes
 * redundant; until then it's the easiest way to confirm a token works.
 *
 * Usage:
 *   node scripts/send-test-push.mjs                            # everyone
 *   node scripts/send-test-push.mjs --person <homePerson.id>   # one person
 *   node scripts/send-test-push.mjs --title "Hi" --body "Hello"
 */

import { SignatureV4 } from "@smithy/signature-v4";
import { fromIni } from "@aws-sdk/credential-providers";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import process from "node:process";

const args = process.argv.slice(2);
const PROFILE = pickArg("--profile", "amplify-dev");
const REGION = pickArg("--region", "us-east-1");
const ENDPOINT = pickArg(
  "--endpoint",
  "https://pzn6gqjwxndatgpb6ujcey47fe.appsync-api.us-east-1.amazonaws.com/graphql"
);
const PERSON_ID = pickArg("--person", null);
const TITLE = pickArg("--title", "Janet test");
const BODY = pickArg("--body", "Push pipeline is alive 🚀");

function pickArg(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1];
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
  query ListSubs($nextToken: String) {
    listHomePushSubscriptions(limit: 200, nextToken: $nextToken) {
      items { id personId expoPushToken deviceLabel platform lastSeenAt }
      nextToken
    }
  }
`;

async function listAllSubs() {
  const all = [];
  let nextToken = null;
  do {
    const data = await gql(LIST_QUERY, { nextToken });
    const conn = data.listHomePushSubscriptions;
    if (conn?.items?.length) all.push(...conn.items);
    nextToken = conn?.nextToken ?? null;
  } while (nextToken);
  return all;
}

const subs = await listAllSubs();
const targets = PERSON_ID ? subs.filter((s) => s.personId === PERSON_ID) : subs;

console.log(`Found ${subs.length} subscription(s); targeting ${targets.length}.`);
if (targets.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

const messages = targets.map((s) => ({
  to: s.expoPushToken,
  sound: "default",
  title: TITLE,
  body: BODY,
}));

const res = await fetch("https://exp.host/--/api/v2/push/send", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify(messages),
});
const json = await res.json();
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(json, null, 2));

if (Array.isArray(json.data)) {
  let ok = 0;
  let bad = 0;
  json.data.forEach((r, i) => {
    if (r.status === "ok") ok++;
    else {
      bad++;
      console.error(`  ${targets[i].deviceLabel}: ${r.message ?? r.status}`);
    }
  });
  console.log(`\n${ok} ok, ${bad} failed`);
  process.exit(bad > 0 ? 1 : 0);
}
process.exit(0);
