// Reads the CalDAV account (Apple ID + app-specific password) from Secrets
// Manager for ics-sync and calendar-push. Stored by
// scripts/setup-icloud-caldav.ts as {"username": …, "password": …}.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CALDAV_SECRET_NAME, type CaldavCreds } from "./caldav";

let cached: CaldavCreds | null = null;

export async function readCaldavCreds(secretName = process.env.CALDAV_SECRET_NAME || CALDAV_SECRET_NAME): Promise<CaldavCreds> {
  if (cached) return cached;
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  const v = JSON.parse(res.SecretString ?? "{}") as Partial<CaldavCreds>;
  if (!v.username || !v.password) throw new Error(`${secretName} is missing username/password`);
  cached = { username: v.username, password: v.password };
  return cached;
}
