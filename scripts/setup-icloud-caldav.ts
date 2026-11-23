// Sets up the two-way family calendar (lib/calendar-sync.ts): checks an
// Apple ID + app-specific password against iCloud CalDAV, lists the
// calendars it can see, stores the pair in Secrets Manager
// (home-hub/icloud-caldav) and links a calendar feed to one of them.
//
//   1. List calendars (and store the secret):
//      AWS_PROFILE=amplify-dev npx tsx scripts/setup-icloud-caldav.ts --apple-id you@icloud.com
//   2. Link the feed (signs in with PRD_USER / PRD_PASS from .env.local):
//      AWS_PROFILE=amplify-dev npx tsx scripts/setup-icloud-caldav.ts --link "Family" \
//        --feed "Apple Family Calendar" --outputs <prod amplify_outputs.json> [--no-new-events]
//
// The password is read from ICLOUD_APP_PASSWORD or asked for (not echoed);
// with no --apple-id the stored secret is used. App-specific passwords are
// made at account.apple.com → Sign-In and Security → App-Specific Passwords.
// --link sets the feed's caldavUrl and, unless --no-new-events, makes it
// where events created in the app go; then runs the sync once.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CALDAV_SECRET_NAME, listCalendars, type CaldavCreds } from "../lib/caldav";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
};

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-1" });

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let shown = false;
    out._writeToOutput = (s: string) => {
      if (!shown) {
        out.output.write(s);
        shown = true;
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function storedCreds(): Promise<CaldavCreds | null> {
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: CALDAV_SECRET_NAME }));
    const v = JSON.parse(r.SecretString ?? "{}");
    return v.username && v.password ? v : null;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }
}

async function storeCreds(c: CaldavCreds) {
  const SecretString = JSON.stringify(c);
  try {
    await sm.send(new PutSecretValueCommand({ SecretId: CALDAV_SECRET_NAME, SecretString }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
    await sm.send(new CreateSecretCommand({ Name: CALDAV_SECRET_NAME, SecretString, Description: "Home Hub: iCloud CalDAV (Apple ID + app-specific password) for the two-way family calendar" }));
  }
}

async function main() {
  const appleId = flag("apple-id");
  let creds: CaldavCreds | null;
  if (appleId && appleId !== "true") {
    const password = process.env.ICLOUD_APP_PASSWORD?.trim() || (await askHidden(`App-specific password for ${appleId}: `));
    creds = { username: appleId, password };
  } else {
    creds = await storedCreds();
    if (!creds) throw new Error(`No ${CALDAV_SECRET_NAME} secret yet: pass --apple-id`);
  }

  const calendars = await listCalendars(creds);
  console.log(`Signed in as ${creds.username}. Calendars:`);
  for (const c of calendars) console.log(`  ${c.writable ? "rw" : "ro"}  ${c.name}`);

  if (appleId && appleId !== "true") {
    await storeCreds(creds);
    console.log(`Stored in Secrets Manager: ${CALDAV_SECRET_NAME}`);
  }

  const linkName = flag("link");
  if (!linkName) return;
  const cal = calendars.find((c) => c.name === linkName) ?? calendars.find((c) => c.name.toLowerCase() === linkName.toLowerCase());
  if (!cal) throw new Error(`No calendar named "${linkName}"`);
  if (!cal.writable) throw new Error(`"${cal.name}" is read-only for ${creds.username}`);

  const outputsPath = flag("outputs");
  if (!outputsPath) throw new Error("--link needs --outputs <amplify_outputs.json>");
  const env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
  const { Amplify } = await import("aws-amplify");
  const { signIn } = await import("aws-amplify/auth");
  const { generateClient } = await import("aws-amplify/data");
  Amplify.configure(JSON.parse(readFileSync(outputsPath, "utf8")));
  await signIn({ username: env.PRD_USER, password: env.PRD_PASS });
  const client = generateClient({ authMode: "userPool" }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

  const feedName = flag("feed") ?? "Apple Family Calendar";
  const { data: feeds } = await client.models.homeCalendarFeed.list({ limit: 1000 });
  const feed = (feeds ?? []).find((f: { name: string }) => f.name === feedName);
  if (!feed) throw new Error(`No calendar feed named "${feedName}"`);
  const writeNewEvents = flag("no-new-events") !== "true";
  if (writeNewEvents) {
    for (const f of feeds) if (f.id !== feed.id && f.writeNewEvents) await client.models.homeCalendarFeed.update({ id: f.id, writeNewEvents: false });
  }
  const { errors } = await client.models.homeCalendarFeed.update({ id: feed.id, caldavUrl: cal.url, writeNewEvents });
  if (errors?.length) throw new Error(errors.map((e: { message: string }) => e.message).join("; "));
  console.log(`Linked "${feed.name}" to "${cal.name}"${writeNewEvents ? " (new app events go here)" : ""}. Syncing…`);
  const { data: sync, errors: syncErrors } = await client.mutations.syncCalendarFeeds({});
  console.log(JSON.stringify(syncErrors?.length ? syncErrors : sync, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
