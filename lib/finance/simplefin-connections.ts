/**
 * simplefin-connections.ts — the household's SimpleFIN connections, one per
 * person. Each is a SimpleFIN Bridge subscription with its own access URL,
 * stored in Secrets Manager under `secretName` as {"accessUrl": "https://…"}
 * (scripts/setup-simplefin-connection.mjs claims a setup token and stores
 * it). finance-sync reads the secrets at run time, so a connection that
 * isn't set up yet just reports that instead of breaking the deploy.
 *
 * A homeFinanceAccount's `simplefinConnection` says which connection its
 * `simplefinAccountId` belongs to; rows from before there were two (null)
 * belong to the first one. Browser-safe: no secrets here, only names.
 */

export type SimplefinConnection = {
  /** Stored on homeFinanceAccount.simplefinConnection. */
  key: string;
  /** Whose connection it is, as shown in the account picker. */
  label: string;
  /** Secrets Manager secret holding {"accessUrl": …}. */
  secretName: string;
};

export const SIMPLEFIN_CONNECTIONS: readonly SimplefinConnection[] = [
  // A copy of gennaroanesi.com's token (`gennaroanesi/simplefin`, same AWS
  // account), which its personal sync still uses: if the token is ever
  // re-claimed, both secrets need the new URL.
  { key: "gennaro", label: "Gennaro", secretName: "home-hub/simplefin/gennaro" },
  { key: "cristine", label: "Cristine", secretName: "home-hub/simplefin/cristine" },
];

export const DEFAULT_SIMPLEFIN_CONNECTION = SIMPLEFIN_CONNECTIONS[0].key;

/** The connection for a key; null / "" is the default one, an unknown key is null. */
export function simplefinConnection(key: string | null | undefined): SimplefinConnection | null {
  const k = key?.trim() || DEFAULT_SIMPLEFIN_CONNECTION;
  return SIMPLEFIN_CONNECTIONS.find((c) => c.key === k) ?? null;
}

export function simplefinConnectionLabel(key: string | null | undefined): string {
  return simplefinConnection(key)?.label ?? key?.trim() ?? "?";
}

/** Mapped accounts grouped by connection key (default filled in); unknown keys kept under their own key. */
export function groupBySimplefinConnection<T extends { simplefinConnection?: string | null }>(accounts: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const a of accounts) {
    const key = a.simplefinConnection?.trim() || DEFAULT_SIMPLEFIN_CONNECTION;
    out.set(key, [...(out.get(key) ?? []), a]);
  }
  return out;
}
