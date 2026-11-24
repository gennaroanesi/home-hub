// One account's detail view (web /finance/accounts/[id], the phone's
// finance/account screen): loading its daily snapshots and the sync runs
// that touched it, and the small derivations both pages show (balance
// history window, month in/out, positions with gain, sync summaries).
// Works with any Amplify data client.

import { listAllPages } from "../list-all";
import { addDays, round2 } from "./dates";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

/** Balance-history windows offered on the detail pages (null = all). */
export const HISTORY_WINDOWS: Array<{ label: string; days: number | null }> = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All", days: null },
];

export function parseJsonOr<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** One account's entry in a sync log's perAccountJson / its lastSyncDetails. */
export type SyncEntry = {
  accountId?: string;
  fromIso?: string;
  toIso?: string;
  txNew?: number;
  txUpdated?: number;
  txTotal?: number;
  linked?: number;
  holdingsChanged?: number;
  balanceBefore?: number;
  balanceAfter?: number;
};

/** Every daily snapshot of one account, oldest first (the snapshot key is accountId + date). */
export async function listAccountSnapshots(client: Client, accountId: string): Promise<Array<{ date: string; balance: number }>> {
  const rows = await listAllPages<any>({ list: (opts: any) => client.models.homeFinanceAccountSnapshot.list({ ...opts, accountId }) });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export type AccountSyncRun = { log: any; entry: SyncEntry };

/** The sync runs that touched this account, newest first. Pure. */
export function accountSyncRuns(logs: any[], accountId: string, limit = 10): AccountSyncRun[] {
  return logs
    .map((log) => ({ log, entry: parseJsonOr<SyncEntry[]>(log.perAccountJson, []).find((p) => p?.accountId === accountId) }))
    .filter((x): x is AccountSyncRun => !!x.entry)
    .sort((a, b) => (b.log.startedAt ?? "").localeCompare(a.log.startedAt ?? ""))
    .slice(0, limit);
}

/** Loads the sync log and keeps this account's runs. */
export async function listAccountSyncRuns(client: Client, accountId: string, limit = 10): Promise<AccountSyncRun[]> {
  return accountSyncRuns(await listAllPages<any>(client.models.homeFinanceSyncLog), accountId, limit);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 new · 1 updated · 20 seen · 2 matched · 1 position changed". */
export function syncEntrySummary(e: SyncEntry): string {
  return [
    `${e.txNew ?? 0} new`,
    `${e.txUpdated ?? 0} updated`,
    `${e.txTotal ?? 0} seen`,
    e.linked ? `${e.linked} matched` : null,
    e.holdingsChanged ? `${plural(e.holdingsChanged, "position")} changed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The account's lastSyncDetails as one line: "2026-10-25 → 2026-11-24: 3 new, 1 updated, 2 matched of 40". */
export function lastSyncSummary(details: SyncEntry | null | undefined): string | null {
  if (!details) return null;
  return (
    `${details.fromIso} → ${details.toIso}: ${details.txNew ?? 0} new, ${details.txUpdated ?? 0} updated` +
    (details.linked ? `, ${details.linked} matched` : "") +
    ` of ${details.txTotal ?? 0}` +
    (details.holdingsChanged ? `; ${plural(details.holdingsChanged, "position")} changed` : "")
  );
}

/** Snapshots inside the window ending today (days null = all). */
export function balanceHistory(snapshots: Array<{ date: string; balance: number }>, days: number | null, today: string): Array<{ date: string; balance: number }> {
  const from = days == null ? "" : addDays(today, -days);
  return snapshots.filter((s) => s.date >= from).map((s) => ({ date: s.date, balance: s.balance }));
}

/** At most `max` points, evenly spaced, always keeping the first and the last (for small bar charts). */
export function samplePoints<T>(points: T[], max: number): T[] {
  if (points.length <= max || max < 2) return points;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return out;
}

/** Low, high and change over a balance history. */
export function historyStats(points: Array<{ date: string; balance: number }>): { min: number; max: number; first: { date: string; balance: number }; last: { date: string; balance: number }; change: number } | null {
  if (!points.length) return null;
  const balances = points.map((p) => p.balance);
  const first = points[0];
  const last = points[points.length - 1];
  return { min: Math.min(...balances), max: Math.max(...balances), first, last, change: round2(last.balance - first.balance) };
}

/** A month of one account's rows: posted money in and out, and how many are pending. */
export function monthFlow(txs: Array<{ amount?: number | null; status?: string | null }>): { inflow: number; outflow: number; pending: number } {
  const posted = txs.filter((t) => t.status !== "PENDING");
  return {
    inflow: round2(posted.filter((t) => (t.amount ?? 0) > 0).reduce((s, t) => s + (t.amount ?? 0), 0)),
    outflow: round2(posted.filter((t) => (t.amount ?? 0) < 0).reduce((s, t) => s + (t.amount ?? 0), 0)),
    pending: txs.filter((t) => t.status === "PENDING").length,
  };
}

export type HoldingRow = { holdingKey?: string; ticker?: string | null; description?: string | null; quantity?: number | null; marketValue?: number | null; costBasisTotal?: number | null; asOf?: string | null; source?: string | null };

/** Positions in an invested account: each with its gain (when the cost basis is known), the cash left over, and the latest as-of date. */
export function holdingsSummary<H extends HoldingRow>(balance: number, holdings: H[]): { rows: Array<H & { gain: number | null }>; positions: number; cash: number; asOf: string | null } {
  const positions = holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  return {
    rows: holdings.map((h) => ({ ...h, gain: h.marketValue != null && h.costBasisTotal != null ? round2(h.marketValue - h.costBasisTotal) : null })),
    positions: round2(positions),
    cash: round2(balance - positions),
    asOf: holdings.map((h) => h.asOf).filter((d): d is string => !!d).sort().pop() ?? null,
  };
}
