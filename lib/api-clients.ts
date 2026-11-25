/**
 * api-clients.ts — the third-party clients allowed to call the external API
 * (/api/v1/*), each with its own bearer key.
 *
 * Stored in Secrets Manager under API_CLIENTS_SECRET_NAME as
 *   {"clients": [{"name": "muse", "keyHash": "<sha256 hex>", "sender": "Gennaro"}, …]}
 * Only the SHA-256 of each key is stored; the key itself is shown once by
 * scripts/api-clients.ts when it's made. `sender` is the household member the
 * client acts as (what MUSE_SENDER used to be for the single key), and
 * `disabledAt` revokes a client without forgetting who it was.
 *
 * Pure (no AWS): the gateway (lib/external-api.ts) loads the secret, the
 * script edits it, and both use these helpers.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const API_CLIENTS_SECRET_NAME = "home-hub/api-clients";

export type ApiClient = {
  /** Short unique label: shows up in logs and `list`. */
  name: string;
  /** SHA-256 hex of the bearer key. */
  keyHash: string;
  /** Household member name the client acts as (the ops' default person). */
  sender: string;
  createdAt?: string;
  /** Set to revoke; the key then gets 401. */
  disabledAt?: string | null;
  note?: string;
};

export type ApiClientsSecret = { clients: ApiClient[] };

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A new random key; prefixed so a leaked one is recognisable. */
export function generateApiKey(): string {
  return `hh_${randomBytes(32).toString("base64url")}`;
}

/** Reads the secret's JSON, dropping malformed entries rather than failing the whole list. */
export function parseApiClients(raw: string | undefined | null): ApiClient[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (v as Partial<ApiClientsSecret>)?.clients;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is ApiClient =>
      !!c &&
      typeof c.name === "string" && !!c.name.trim() &&
      typeof c.keyHash === "string" && /^[0-9a-f]{64}$/.test(c.keyHash) &&
      typeof c.sender === "string" && !!c.sender.trim()
  );
}

/**
 * The enabled client whose key this is, or null. Compares every entry in
 * constant time (fixed-length digests, no early exit) so timing doesn't
 * reveal which entry, or whether any, came close.
 */
export function matchApiClient(supplied: string, clients: ApiClient[]): ApiClient | null {
  if (!supplied) return null;
  const got = new Uint8Array(Buffer.from(hashApiKey(supplied), "hex"));
  let found: ApiClient | null = null;
  for (const c of clients) {
    const want = new Uint8Array(Buffer.from(c.keyHash, "hex"));
    if (want.length === got.length && timingSafeEqual(got, want) && !c.disabledAt && !found) found = c;
  }
  return found;
}
