// Net worth: accounts (cash, invested, debts) plus assets, now and over
// time, and each asset's equity against the loans it secures. Pure;
// shared by /finance/net-worth, the ops and the overview.
//
// History comes from the daily account snapshots (finance-sync writes one
// per active account) and the asset valuations (a step function: the value
// on a date is the latest valuation on or before it). It starts on the
// first snapshot: before that, account balances are unknown.

import { addDays, daysBetween, round2 } from "./dates";

export const ASSET_TYPES = ["REAL_ESTATE", "VEHICLE", "COLLECTIBLE", "OTHER"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  REAL_ESTATE: "Real estate",
  VEHICLE: "Vehicle",
  COLLECTIBLE: "Collectible",
  OTHER: "Other",
};

export type NetWorthGroup = "cash" | "invested" | "property" | "debt" | "other";
export const GROUP_LABELS: Record<NetWorthGroup, string> = {
  cash: "Cash",
  invested: "Invested",
  property: "Property",
  debt: "Debt",
  other: "Other",
};

type AccountLike = { id: string; name?: string | null; type?: string | null; currentBalance?: number | null; active?: boolean | null };
type AssetLike = {
  id: string;
  name?: string | null;
  type?: string | null;
  currentValue?: number | null;
  purchaseDate?: string | null;
  soldDate?: string | null;
  active?: boolean | null;
};
type ValuationLike = { assetId: string; date: string; value: number };
type SnapshotLike = { accountId: string; date: string; balance: number };
type LoanLike = { id: string; accountId: string; assetId?: string | null };

/** Which bucket an account's balance belongs in. Debt balances are negative. */
export function accountGroup(type: string | null | undefined): NetWorthGroup {
  switch (type) {
    case "CHECKING":
    case "SAVINGS":
    case "CASH":
      return "cash";
    case "BROKERAGE":
    case "RETIREMENT":
      return "invested";
    case "LOAN":
    case "CREDIT":
      return "debt";
    default:
      return "other";
  }
}

export type NetWorthTotals = { total: number; assets: number; liabilities: number } & Record<NetWorthGroup, number>;

const zero = (): NetWorthTotals => ({ total: 0, assets: 0, liabilities: 0, cash: 0, invested: 0, property: 0, debt: 0, other: 0 });

function add(t: NetWorthTotals, group: NetWorthGroup, amount: number) {
  t[group] += amount;
  t.total += amount;
  if (amount >= 0) t.assets += amount;
  else t.liabilities -= amount;
}

function finish(t: NetWorthTotals): NetWorthTotals {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round2(v)])) as NetWorthTotals;
}

const assetLive = (a: AssetLike) => a.active !== false;

/** Today's net worth from live balances and current asset values. */
export function netWorthNow(accounts: AccountLike[], assets: AssetLike[]): NetWorthTotals {
  const t = zero();
  for (const a of accounts) if (a.active !== false) add(t, accountGroup(a.type), a.currentBalance ?? 0);
  for (const a of assets) if (assetLive(a)) add(t, "property", a.currentValue ?? 0);
  return finish(t);
}

export type AssetEquity = {
  asset: AssetLike;
  value: number;
  owed: number; // what the loans it secures still owe (positive)
  equity: number;
  ltv: number | null; // owed / value
  loans: Array<{ loanId: string; accountId: string; name: string | null; owed: number }>;
};

/** Each live asset with the loans that point at it. */
export function assetEquity(assets: AssetLike[], loans: LoanLike[], accounts: AccountLike[]): AssetEquity[] {
  return assets.filter(assetLive).map((asset) => {
    const mine = loans
      .filter((l) => l.assetId === asset.id)
      .map((l) => {
        const acct = accounts.find((a) => a.id === l.accountId);
        return { loanId: l.id, accountId: l.accountId, name: acct?.name ?? null, owed: round2(Math.max(0, -(acct?.currentBalance ?? 0))) };
      });
    const value = asset.currentValue ?? 0;
    const owed = round2(mine.reduce((s, l) => s + l.owed, 0));
    return { asset, value, owed, equity: round2(value - owed), ltv: value > 0 ? owed / value : null, loans: mine };
  });
}

/**
 * An asset's value on a date: the latest valuation on or before it. 0 before
 * it was bought and from the day it was sold. Owned but not valued yet: the
 * earliest valuation (or the current value when there are none).
 */
export function assetValueOn(asset: AssetLike, valuations: ValuationLike[], date: string): number {
  if (asset.soldDate && date >= asset.soldDate) return 0;
  if (asset.purchaseDate && date < asset.purchaseDate) return 0;
  const mine = valuations.filter((v) => v.assetId === asset.id).sort((a, b) => a.date.localeCompare(b.date));
  if (!mine.length) return asset.currentValue ?? 0;
  let value: number | null = null;
  for (const v of mine) {
    if (v.date > date) break;
    value = v.value;
  }
  if (value != null) return value;
  // Before its first valuation: owned only if a purchase date says so.
  return asset.purchaseDate ? mine[0].value : 0;
}

export type NetWorthPoint = { date: string } & NetWorthTotals;

/** Dates to plot from `first` to `today`: daily up to ~6 months, then weekly, then monthly; always ends on today. */
export function historyDates(first: string, today: string): string[] {
  if (first > today) return [today];
  const span = daysBetween(first, today);
  const step = span <= 186 ? 1 : span <= 731 ? 7 : 30;
  const out: string[] = [];
  for (let d = today; d >= first; d = addDays(d, -step)) out.push(d);
  if (out[out.length - 1] !== first) out.push(first);
  return out.reverse();
}

/**
 * Net worth on each date: every account's latest snapshot on or before it
 * (none yet = not tracked then, counts 0), plus asset values. Today uses live
 * balances, so the last point matches netWorthNow.
 */
export function netWorthHistory(input: { accounts: AccountLike[]; snapshots: SnapshotLike[]; assets: AssetLike[]; valuations: ValuationLike[]; today: string }): NetWorthPoint[] {
  const { accounts, snapshots, assets, valuations, today } = input;
  if (!snapshots.length) return [{ date: today, ...netWorthNow(accounts, assets) }];
  const first = snapshots.reduce((m, s) => (s.date < m ? s.date : m), snapshots[0].date);
  const byAccount = new Map<string, SnapshotLike[]>();
  for (const s of snapshots) {
    if (!byAccount.has(s.accountId)) byAccount.set(s.accountId, []);
    byAccount.get(s.accountId)!.push(s);
  }
  for (const list of byAccount.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  const typeOf = new Map(accounts.map((a) => [a.id, a.type ?? null]));

  return historyDates(first, today).map((date) => {
    if (date === today) return { date, ...netWorthNow(accounts, assets) };
    const t = zero();
    for (const [accountId, list] of byAccount) {
      let last: SnapshotLike | null = null;
      for (const s of list) {
        if (s.date > date) break;
        last = s;
      }
      if (last) add(t, accountGroup(typeOf.get(accountId)), last.balance);
    }
    for (const a of assets) {
      const v = assetValueOn(a, valuations, date);
      if (v) add(t, "property", v);
    }
    return { date, ...finish(t) };
  });
}

/** Change in total net worth since `days` ago, from a history series (null when it doesn't reach back that far). */
export function changeSince(history: NetWorthPoint[], days: number): { from: string; amount: number } | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  const target = addDays(last.date, -days);
  const base = [...history].reverse().find((p) => p.date <= target);
  return base ? { from: base.date, amount: round2(last.total - base.total) } : null;
}
