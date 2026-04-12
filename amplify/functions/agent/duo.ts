/**
 * Minimal Duo Auth API client for the home-hub document vault.
 *
 * We use just three endpoints — ping, preauth, auth — and hand-roll the
 * HMAC-SHA1 signature Duo expects rather than pulling in a full SDK.
 * Secrets are fetched once from AWS Secrets Manager at cold start and
 * cached in module scope for the life of the Lambda container.
 *
 * Duo Auth API docs: https://duo.com/docs/authapi
 *
 * Signing is nitpicky — if the canonicalization is off by a single
 * character every request fails with "40103 Invalid signature in
 * request credentials". The three subtle things are:
 *   1. The Date header must be RFC 2822 with a "-0000" tz suffix, NOT
 *      "GMT". Node's toUTCString() produces "GMT", so we rewrite.
 *   2. Params are URL-encoded application/x-www-form-urlencoded-style
 *      with "+" for spaces, not "%20".
 *   3. Keys must be sorted lexicographically and the host must be
 *      lowercased in the canonical request.
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
  const secretName = process.env.DUO_SECRET_NAME;
  if (!secretName) throw new Error("DUO_SECRET_NAME env var not set");
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
  // application/x-www-form-urlencoded: space -> "+", everything else
  // per RFC 3986 unreserved. encodeURIComponent is close enough —
  // Duo's reference implementation does the same swap.
  return encodeURIComponent(s).replace(/%20/g, "+");
}

function canonicalizeParams(params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  return sortedKeys
    .map((k) => `${duoUrlEncode(k)}=${duoUrlEncode(params[k])}`)
    .join("&");
}

/**
 * Sign a Duo API request per https://duo.com/docs/authapi#authentication.
 * The canonical request is: date, method, host, path, sorted params
 * joined with "&", each separated by newline. HMAC-SHA1 with secretKey,
 * hex digest. Auth header is `Basic base64(integrationKey:signature)`.
 */
function signRequest(
  method: "GET" | "POST",
  host: string,
  path: string,
  params: Record<string, string>,
  integrationKey: string,
  secretKey: string
): { headers: Record<string, string>; body: string; dateHeader: string } {
  // toUTCString() emits "... GMT" but Duo's canonicalization expects the
  // RFC 2822 "-0000" offset form. The bytes on the wire in the Date
  // header itself must match what we sign, so we rewrite both.
  const dateHeader = new Date().toUTCString().replace(/GMT$/, "-0000");
  const canonParams = canonicalizeParams(params);
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
    dateHeader,
  };
}

interface DuoEnvelope<T> {
  stat: string;
  response?: T;
  code?: number;
  message?: string;
  message_detail?: string;
}

async function duoRequest<T = unknown>(
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
  const baseUrl = `https://${creds.apiHostname}${path}`;
  const url = method === "POST" ? baseUrl : body ? `${baseUrl}?${body}` : baseUrl;
  const init: RequestInit = { method, headers };
  if (method === "POST") {
    init.body = body;
  }
  const res = await fetch(url, init);
  const json = (await res.json()) as DuoEnvelope<T>;
  if (json.stat !== "OK") {
    const detail = json.message_detail ? ` — ${json.message_detail}` : "";
    throw new Error(
      `Duo API ${path} failed: ${json.message ?? "unknown"} (${
        json.code ?? "no code"
      })${detail}`
    );
  }
  return json.response as T;
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
 * Check whether a user can receive a Duo push. Call this before auth()
 * so we can give the agent a clear error if the user isn't enrolled,
 * is locked out, or has no push-capable device.
 */
export async function preauth(username: string): Promise<PreauthResponse> {
  return duoRequest<PreauthResponse>("POST", "/auth/v2/preauth", { username });
}

export interface AuthResponse {
  result: "allow" | "deny";
  status: string;
  status_msg: string;
}

/**
 * Send a Duo Push to the user's device and block until they respond or
 * the push times out (~60s). pushinfo is shown in the push notification
 * body so the user can see what they're approving.
 */
export async function pushAuth(params: {
  username: string;
  device?: string; // optional — defaults to "auto" (first push-capable device)
  pushinfo: Record<string, string>; // shown as "key=value" lines
  type?: string; // label above the pushinfo block, max 20 chars
  displayUsername?: string; // what the push renders — falls back to username
}): Promise<AuthResponse> {
  const pushinfoEncoded = Object.entries(params.pushinfo)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const body: Record<string, string> = {
    username: params.username,
    factor: "push",
    device: params.device ?? "auto",
    async: "0",
    pushinfo: pushinfoEncoded,
  };
  if (params.type) body.type = params.type;
  if (params.displayUsername) body.display_username = params.displayUsername;
  return duoRequest<AuthResponse>("POST", "/auth/v2/auth", body);
}

/**
 * Ping the Duo API — useful for health checks or verifying that secrets
 * load. No auth required.
 */
export async function ping(): Promise<{ time: number }> {
  return duoRequest<{ time: number }>("GET", "/auth/v2/ping", {});
}
