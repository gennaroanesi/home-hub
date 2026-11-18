// Which transactions a list shows, and in what order: one set of rules for
// the web Transactions page (filters the loaded period in the browser) and
// list_finance_transactions (the phone, Janet, hh). Pure.

import { CATEGORY_RULES, categoryCovers, categoryParts, effectiveCategory, parseLineItems, UNCATEGORIZED, type CategoryRule } from "./categories";
import { HOUSEHOLD, ledgerParts } from "./ledger";
import type { TxLike } from "./types";

export const TX_SORTS = ["newest", "oldest", "largest", "smallest", "description"] as const;
export type TxSort = (typeof TX_SORTS)[number];
export const TX_SORT_LABELS: Record<TxSort, string> = { newest: "Newest", oldest: "Oldest", largest: "Largest", smallest: "Smallest", description: "A–Z" };

/** No group: only rows outside every spend group. */
export const NO_SPEND_GROUP = "__none";

export type TxFilter = {
  /** Words that must all appear in the description, notes, categories or item names (any case). */
  query?: string;
  /** Any of these accounts. */
  accountIds?: string[];
  /** Any of these categories (any case); a parent also matches its sub-categories, an itemized charge any item's. */
  categories?: string[];
  /** Only rows nothing has categorized. */
  uncategorized?: boolean;
  /** Contributors: money in from any of these people. */
  personIds?: string[];
  /** A spend group, or NO_SPEND_GROUP. */
  spendGroupId?: string;
  direction?: "in" | "out";
  /** Counts (at least partly) in this budget: "household" or a person id. */
  ledger?: string;
};

type Row = TxLike & { notes?: string | null };

export function txMatches(
  t: Row,
  f: TxFilter,
  ctx: { rules?: CategoryRule[]; accountLedger: (accountId: string) => string },
): boolean {
  const rules = ctx.rules ?? CATEGORY_RULES;
  const amount = t.amount ?? 0;
  if (f.accountIds?.length && !f.accountIds.includes(t.accountId)) return false;
  if (f.direction === "in" && amount <= 0) return false;
  if (f.direction === "out" && amount >= 0) return false;
  if (f.personIds?.length && !(amount > 0 && f.personIds.includes(t.personId ?? ""))) return false;
  if (f.spendGroupId === NO_SPEND_GROUP ? !!t.spendGroupId : f.spendGroupId && t.spendGroupId !== f.spendGroupId) return false;
  if (f.uncategorized && effectiveCategory(t, rules) !== UNCATEGORIZED) return false;
  const cats = categoryParts(t, rules).map((p) => p.category);
  if (f.categories?.length) {
    const want = f.categories.map((c) => c.toLowerCase());
    if (!cats.some((c) => want.some((w) => categoryCovers(w, c.toLowerCase())))) return false;
  }
  if (f.ledger && !ledgerParts(t, ctx.accountLedger(t.accountId) || HOUSEHOLD).some((p) => p.ledger === f.ledger)) return false;
  const words = (f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const hay = `${t.description ?? ""} ${t.notes ?? ""} ${cats.join(" ")} ${(parseLineItems(t) ?? []).map((i) => i.name ?? "").join(" ")}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

export function filterTransactions<T extends Row>(txs: T[], f: TxFilter, ctx: { rules?: CategoryRule[]; accountLedger: (accountId: string) => string }): T[] {
  return txs.filter((t) => txMatches(t, f, ctx));
}

const size = (t: Row) => Math.abs(t.amount ?? 0);
const newestFirst = (a: Row, b: Row) => (b.date ?? "").localeCompare(a.date ?? "");
const ORDER: Record<TxSort, (a: Row, b: Row) => number> = {
  newest: newestFirst,
  oldest: (a, b) => newestFirst(b, a),
  // By size, money in or out; ties newest first.
  largest: (a, b) => size(b) - size(a) || newestFirst(a, b),
  smallest: (a, b) => size(a) - size(b) || newestFirst(a, b),
  description: (a, b) => (a.description ?? "").localeCompare(b.description ?? "", undefined, { sensitivity: "base" }) || newestFirst(a, b),
};

/** A sorted copy. */
export function sortTransactions<T extends Row>(txs: T[], sort: TxSort = "newest"): T[] {
  return [...txs].sort(ORDER[sort]);
}
