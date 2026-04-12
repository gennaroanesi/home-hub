/**
 * Duo Auth API client for Next.js API routes (server-side only).
 *
 * This is a slimmed-down copy of amplify/functions/agent/duo.ts that
 * runs in the Amplify Hosting SSR runtime rather than inside the agent
 * Lambda. The signing algorithm is identical. We keep two copies rather
 * than a shared package because the agent Lambda's build pipeline
 * bundles from amplify/functions/agent/ and the Next.js build bundles
 * from lib/ — trying to share one file across both would require a
 * monorepo workspace setup that isn't worth the complexity.
 *
 * The only endpoint exposed here is `preauth`, which the /security
 * page uses to verify a Duo username before saving homePersonAuth.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { createHmac } from "node:crypto";

interface DuoCredentials {
  integrationKey: string;
  secretKey: string;
  apiHostname: string;
}

let cachedCredentials: DuoCredentials | null = null;
const secretsClient = new SecretsManagerClient({});

async function getCredentials(): Promise<DuoCredentials> {
  if (cachedCredentials) return cachedCredentials;
  const secretName = process.env.DUO_SECRET_NAME ?? "home-hub/duo-auth-api";
  const res = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );
  if (!res.SecretString) {
    throw new Error(`Duo secret ${secretName} has no SecretString`);
  }
  const parsed = JSON.parse(res.SecretString) as Partial<DuoCredentials>;
  if (!parsed.integrationKey || !parsed.secretKey || !parsed.apiHostname) {
    throw new Error(
      "Duo secret missing one of integrationKey/secretKey/apiHostname"
    );
  }
  cachedCredentials = parsed as DuoCredentials;
  return cachedCredentials;
}

function duoUrlEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

function signRequest(
  method: "GET" | "POST",
  host: string,
  path: string,
  params: Record<string, string>,
  integrationKey: string,
  secretKey: string
): { headers: Record<string, string>; body: string } {
  const dateHeader = new Date().toUTCString().replace(/GMT$/, "-0000");
  const sortedKeys = Object.keys(params).sort();
  const canonParams = sortedKeys
    .map((k) => `${duoUrlEncode(k)}=${duoUrlEncode(params[k])}`)
    .join("&");
  const canonRequest = [
    dateHeader,
    method.toUpperCase(),
    host.toLowerCase(),
    path,
    canonParams,
  ].join("\n");
  const signature = createHmac("sha1", secretKey)
    .update(canonRequest, "utf8")
    .digest("hex");
  const authHeader =
    "Basic " +
    Buffer.from(`${integrationKey}:${signature}`).toString("base64");
  return {
    headers: {
      Date: dateHeader,
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: canonParams,
  };
}

interface DuoEnvelope<T> {
  stat: string;
  response?: T;
  code?: number;
  message?: string;
  message_detail?: string;
}

export interface PreauthResponse {
  result: "auth" | "allow" | "deny" | "enroll";
  status_msg?: string;
  devices?: Array<{
    device: string;
    type: string;
    name?: string;
    capabilities?: string[];
  }>;
}

/**
 * Run Duo preauth to verify a username is enrolled and can receive a
 * push. Used by /api/security/duo-preauth before saving homePersonAuth.
 */
export async function preauth(username: string): Promise<PreauthResponse> {
  const creds = await getCredentials();
  const params = { username };
  const { headers, body } = signRequest(
    "POST",
    creds.apiHostname,
    "/auth/v2/preauth",
    params,
    creds.integrationKey,
    creds.secretKey
  );
  const url = `https://${creds.apiHostname}/auth/v2/preauth`;
  const res = await fetch(url, { method: "POST", headers, body });
  const json = (await res.json()) as DuoEnvelope<PreauthResponse>;
  if (json.stat !== "OK") {
    const detail = json.message_detail ? ` — ${json.message_detail}` : "";
    throw new Error(
      `Duo preauth failed: ${json.message ?? "unknown"} (${
        json.code ?? "no code"
      })${detail}`
    );
  }
  return json.response as PreauthResponse;
}
