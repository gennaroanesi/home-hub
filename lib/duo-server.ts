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
 * Exposes `preauth` (used by /security to verify a Duo username before
 * saving homePersonAuth) and `pushAuth` (used by /api/documents/download
 * to gate file retrieval behind a Duo push approval).
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
  // Use %20 for spaces, not +. Duo's server-side HMAC uses %20.
  // See amplify/functions/agent/duo.ts for the full explanation.
  return encodeURIComponent(s);
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
async function duoRequest<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>
): Promise<T> {
  const creds = await getCredentials();
  const { headers, body } = signRequest(
    method,
    creds.apiHostname,
    path,
    params,
    creds.integrationKey,
    creds.secretKey
  );
  const url = `https://${creds.apiHostname}${path}`;
  const res = await fetch(method === "POST" ? url : `${url}?${body}`, {
    method,
    headers,
    ...(method === "POST" ? { body } : {}),
  });
  const json = (await res.json()) as DuoEnvelope<T>;
  if (json.stat !== "OK") {
    const detail = json.message_detail ? ` — ${json.message_detail}` : "";
    throw new Error(
      `Duo ${path} failed: ${json.message ?? "unknown"} (${
        json.code ?? "no code"
      })${detail}`
    );
  }
  return json.response as T;
}

export async function preauth(username: string): Promise<PreauthResponse> {
  return duoRequest<PreauthResponse>("POST", "/auth/v2/preauth", { username });
}

export interface AuthResponse {
  result: "allow" | "deny";
  status: string;
  status_msg: string;
}

export interface AuthStatusResponse {
  result: "allow" | "deny" | "waiting";
  status: string;
  status_msg: string;
}

/**
 * Send a Duo Push and return the raw Duo response. With `async: "1"`
 * (the default here) Duo returns immediately with a txid that callers
 * poll via `authStatus`. With `async: "0"` Duo blocks up to ~60s for
 * the user to respond — risky from Amplify SSR which caps at 30s, so
 * most callers should prefer `pushAndWait` below.
 */
export async function pushAuth(params: {
  username: string;
  pushinfo: Record<string, string>;
  async?: "0" | "1";
}): Promise<AuthResponse & { txid?: string }> {
  const pushinfoEncoded = Object.entries(params.pushinfo)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return duoRequest<AuthResponse & { txid?: string }>("POST", "/auth/v2/auth", {
    username: params.username,
    factor: "push",
    device: "auto",
    async: params.async ?? "1",
    pushinfo: pushinfoEncoded,
  });
}

/**
 * Poll the status of an async Duo push by txid. Returns immediately
 * with `waiting` if the user hasn't responded yet.
 */
export async function authStatus(txid: string): Promise<AuthStatusResponse> {
  return duoRequest<AuthStatusResponse>("GET", "/auth/v2/auth_status", { txid });
}

/**
 * Fire a Duo push asynchronously and poll until the user responds or
 * we hit our local timeout budget. This is the right helper for
 * Amplify SSR API routes — doing a sync `pushAuth` with async: "0"
 * makes Duo block up to 60s, which exceeds Amplify's 30s SSR cap and
 * leaves the user's approval stranded.
 *
 * `maxWaitMs` is our local deadline (independent of Duo's own push
 * expiration). Default 25s leaves ~5s of headroom inside the 30s
 * Amplify budget for response serialization.
 */
export async function pushAndWait(params: {
  username: string;
  pushinfo: Record<string, string>;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}): Promise<AuthStatusResponse> {
  const maxWaitMs = params.maxWaitMs ?? 25_000;
  const pollIntervalMs = params.pollIntervalMs ?? 2_000;

  const pushed = await pushAuth({
    username: params.username,
    pushinfo: params.pushinfo,
    async: "1",
  });
  if (!pushed.txid) {
    // Shouldn't happen — async:"1" always returns a txid. If it
    // doesn't, Duo ran the auth synchronously and gave us a final
    // result; surface it as-is.
    return {
      result: (pushed.result as "allow" | "deny") ?? "deny",
      status: pushed.status ?? "",
      status_msg: pushed.status_msg ?? "",
    };
  }

  const deadline = Date.now() + maxWaitMs;
  let last: AuthStatusResponse | null = null;
  while (Date.now() < deadline) {
    last = await authStatus(pushed.txid);
    if (last.result !== "waiting") return last;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return (
    last ?? {
      result: "deny",
      status: "timeout",
      status_msg: "Duo push timed out",
    }
  );
}
