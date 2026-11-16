// What a "Sync now" press reports, from the syncFinance mutation's JSON
// ({ ok, accountsChecked, txInserted, txUpdated, linked, errors }). Shared by
// the web finance shell and the phone's finance screen.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type SyncOutcome = { ok: boolean; title: string; detail?: string };

/** `data` is the mutation's result (AWSJSON, possibly still a string); `error` a GraphQL error message. */
export function describeSyncResult(data: unknown, error?: string | null): SyncOutcome {
  let d: any = data;
  while (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      break;
    }
  }
  if (error || !d?.ok) return { ok: false, title: "Sync failed", detail: error ?? d?.errors?.[0] ?? "" };
  if (!d.accountsChecked) return { ok: true, title: "No accounts linked to SimpleFIN yet" };
  const parts = [`${d.txInserted ?? 0} new`, `${d.txUpdated ?? 0} updated`];
  if (d.linked) parts.push(`${d.linked} matched to schedules`);
  return { ok: true, title: "Synced", detail: parts.join(", ") };
}
