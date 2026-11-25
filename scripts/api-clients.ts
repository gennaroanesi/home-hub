// Manages the external API's clients (lib/api-clients.ts): one bearer key per
// third-party service, stored as a hash in Secrets Manager
// (home-hub/api-clients). The gateway re-reads the list every 5 minutes, so
// changes take effect without a redeploy.
//
//   AWS_PROFILE=amplify-dev npx tsx scripts/api-clients.ts list
//   AWS_PROFILE=amplify-dev npx tsx scripts/api-clients.ts add <name> --sender <household member> [--note "…"]
//   AWS_PROFILE=amplify-dev npx tsx scripts/api-clients.ts add <name> --sender <member> --key-from-env MUSE_API_KEY
//   AWS_PROFILE=amplify-dev npx tsx scripts/api-clients.ts rotate <name>
//   AWS_PROFILE=amplify-dev npx tsx scripts/api-clients.ts revoke <name>
//   AWS_PROFILE=amplify-dev npx tsx scripts/api-clients.ts restore <name>
//   AWS_PROFILE=amplify-dev npx tsx scripts/api-clients.ts remove <name>
//
// `add` and `rotate` print the new key once; only its SHA-256 is stored, so it
// can't be shown again. `--key-from-env VAR` stores an existing key instead of
// making one (to move the old MUSE_API_KEY in without changing it for Muse / hh).
// `--sender` is the household member's name, as Janet knows them.

import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  API_CLIENTS_SECRET_NAME,
  generateApiKey,
  hashApiKey,
  parseApiClients,
  type ApiClient,
} from "../lib/api-clients";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v;
};
const [cmd, name] = argv;
const secretId = process.env.API_CLIENTS_SECRET_NAME || API_CLIENTS_SECRET_NAME;
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-1" });

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function load(): Promise<{ clients: ApiClient[]; exists: boolean }> {
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    return { clients: parseApiClients(r.SecretString), exists: true };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return { clients: [], exists: false };
    throw err;
  }
}

async function save(clients: ApiClient[], exists: boolean) {
  const SecretString = JSON.stringify({ clients }, null, 2);
  if (exists) await sm.send(new PutSecretValueCommand({ SecretId: secretId, SecretString }));
  else
    await sm.send(
      new CreateSecretCommand({
        Name: secretId,
        Description: "Home Hub external API clients (bearer key hashes). Managed by scripts/api-clients.ts.",
        SecretString,
      })
    );
}

function find(clients: ApiClient[], n: string | undefined): ApiClient {
  if (!n) fail("Name the client.");
  return clients.find((c) => c.name === n) ?? fail(`No client named "${n}". Run "list".`);
}

function showKey(c: ApiClient, key: string) {
  console.log(`\nKey for "${c.name}" (acts as ${c.sender}). Shown once, store it now:\n\n  ${key}\n`);
  console.log("Use it as:  Authorization: Bearer <key>");
  console.log("Spec:       GET https://<your-app>/api/v1/openapi.json");
  console.log("Takes effect within 5 minutes.");
}

const COMMANDS = ["list", "add", "rotate", "revoke", "restore", "remove"];

(async () => {
  if (!COMMANDS.includes(cmd)) {
    fail("Usage: api-clients.ts list | add <name> --sender <member> [--note …] [--key-from-env VAR] | rotate | revoke | restore | remove <name>");
  }
  const { clients, exists } = await load();
  const now = new Date().toISOString();

  switch (cmd) {
    case "list": {
      if (!clients.length) return console.log(exists ? "No clients." : `${secretId} doesn't exist yet; "add" creates it.`);
      for (const c of clients) {
        const state = c.disabledAt ? `REVOKED ${c.disabledAt.slice(0, 10)}` : "active";
        console.log(`${c.name.padEnd(20)} sender=${c.sender.padEnd(12)} ${state.padEnd(18)} created ${c.createdAt?.slice(0, 10) ?? "?"}${c.note ? `  (${c.note})` : ""}`);
      }
      return;
    }
    case "add": {
      if (!name || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) fail("Name: lowercase letters, digits, - or _, up to 40.");
      if (clients.some((c) => c.name === name)) fail(`"${name}" already exists; use "rotate" for a new key.`);
      const sender = flag("sender")?.trim() || fail("--sender <household member> is required.");
      const fromEnv = flag("key-from-env");
      const key = fromEnv !== undefined ? process.env[fromEnv] || fail(`${fromEnv} isn't set.`) : generateApiKey();
      const hash = hashApiKey(key);
      if (clients.some((c) => c.keyHash === hash)) fail("That key already belongs to another client.");
      const c: ApiClient = { name, keyHash: hash, sender, createdAt: now, disabledAt: null, ...(flag("note") ? { note: flag("note") } : {}) };
      await save([...clients, c], exists);
      if (fromEnv !== undefined) console.log(`Stored ${fromEnv} as "${name}" (acts as ${sender}).`);
      else showKey(c, key);
      return;
    }
    case "rotate": {
      const c = find(clients, name);
      const key = generateApiKey();
      c.keyHash = hashApiKey(key);
      c.disabledAt = null;
      await save(clients, exists);
      console.log(`Old key for "${c.name}" stops working within 5 minutes.`);
      return showKey(c, key);
    }
    case "revoke":
    case "restore": {
      const c = find(clients, name);
      c.disabledAt = cmd === "revoke" ? now : null;
      await save(clients, exists);
      return console.log(`"${c.name}" ${cmd === "revoke" ? "revoked" : "restored"}; takes effect within 5 minutes.`);
    }
    case "remove": {
      find(clients, name);
      await save(clients.filter((c) => c.name !== name), exists);
      return console.log(`"${name}" removed; takes effect within 5 minutes.`);
    }
    default:
      fail("Usage: api-clients.ts list | add <name> --sender <member> [--note …] [--key-from-env VAR] | rotate | revoke | restore | remove <name>");
  }
})().catch((err) => fail(String(err?.message ?? err)));
