/**
 * Interactive REPL for the Home Hub Amplify data client.
 *
 * Signs in with a Cognito user pool identity, configures Amplify, and
 * drops you into a Node REPL with the generated data client in scope.
 * Handy for ad-hoc queries and debugging without the edit → deploy →
 * refresh cycle.
 *
 * Usage:
 *   npx tsx scripts/amplify-repl.ts
 *
 * Optional env vars (otherwise prompted interactively):
 *   AMPLIFY_EMAIL      Cognito email / username
 *   AMPLIFY_PASSWORD   Cognito password
 *   AMPLIFY_AUTHMODE   "userPool" (default) | "iam"
 *
 * Once in the REPL, a few starter commands:
 *   await client.models.homePerson.list()
 *   await client.models.homePersonAuth.list({ limit: 10 })
 *   await client.models.homePersonAuth.list({ filter: { personId: { eq: "..." } } })
 *   await client.models.homePersonAuth.listHomePersonAuthByPersonId({ personId: "..." }, { limit: 1 })
 *   await me()           // resolves the signed-in user's homePerson
 */

import { readFile } from "node:fs/promises";
import readline from "node:readline/promises";
import repl from "node:repl";
import { Amplify } from "aws-amplify";
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchAuthSession,
  fetchUserAttributes,
} from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";

async function prompt(label: string, silent = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // readline doesn't mask input; for password prompts this leaks the
  // characters to the terminal. Acceptable for a local diagnostic tool
  // but don't use this on a shared machine.
  const answer = (await rl.question(`${label}${silent ? " (input visible)" : ""}: `)).trim();
  rl.close();
  return answer;
}

async function main() {
  const outputsPath = "./amplify_outputs.json";
  const outputs = JSON.parse(await readFile(outputsPath, "utf8"));
  Amplify.configure(outputs, { ssr: false });

  const email = process.env.AMPLIFY_EMAIL ?? (await prompt("Cognito email"));
  const password =
    process.env.AMPLIFY_PASSWORD ?? (await prompt("Password", true));

  // Make sure we're not reusing a stale local session from a previous
  // run with a different user.
  try {
    await signOut();
  } catch {
    /* no-op */
  }

  const signInResult = await signIn({ username: email, password });
  if (!signInResult.isSignedIn) {
    console.error("Sign-in incomplete:", signInResult.nextStep);
    process.exit(1);
  }

  const { username } = await getCurrentUser();
  const attrs = await fetchUserAttributes();
  console.log(`\nSigned in as ${username} (${attrs.email ?? "no email attr"})`);
  console.log(`  custom:full_name = ${attrs["custom:full_name"] ?? "(unset)"}`);

  const authMode =
    (process.env.AMPLIFY_AUTHMODE as "userPool" | "iam" | undefined) ??
    "userPool";
  console.log(`  client authMode  = ${authMode}`);

  const client = generateClient<Schema>({ authMode });

  async function me() {
    const u = (await getCurrentUser()).username;
    const a = await client.models.homePerson.list({ limit: 100 });
    const byUsername = (a.data ?? []).find((p) => p.cognitoUsername === u);
    if (byUsername) return byUsername;
    const fn = (await fetchUserAttributes())["custom:full_name"] ?? "";
    return (
      (a.data ?? []).find(
        (p) => p.name.toLowerCase() === fn.toLowerCase()
      ) ?? null
    );
  }

  const r = repl.start({
    prompt: "amplify> ",
    useGlobal: true,
    // Show promise results inline — awaits work without explicit .then.
    preview: true,
    terminal: true,
  });

  Object.assign(r.context, {
    client,
    username,
    attrs,
    Amplify,
    signOut,
    fetchAuthSession,
    me,
  });

  r.on("exit", async () => {
    await signOut().catch(() => {});
    process.exit(0);
  });

  console.log("\nIn scope: `client`, `username`, `attrs`, `me()`, `signOut`, `fetchAuthSession`, `Amplify`.");
  console.log("Use top-level await. Ctrl-D to exit (signs you out first).\n");
}

main().catch((err) => {
  console.error("REPL bootstrap failed:", err);
  process.exit(1);
});
