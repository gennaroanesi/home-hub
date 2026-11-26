// The monthly review (web /finance/review, phone Finance → Review): looking
// back at a month, quarter, year or the last 3 months for one ledger. What
// came in vs what went out, spending by category against its budget line and
// the usual level, the trend over the last year, the biggest transactions,
// which scheduled payments happened, and spend groups. Pure: the caller loads
// the rows (reviewWindow says from when) and renders the result.

import {
  bucketCategories,
  budgetedForRange,
  budgetKind,
  monthsInRange,
  receivedByPerson,
  resolutionDate,
  resolveBudgetLines,
  seedFromHistory,
  spendByCategory,
  spendParts,
  totalOutflow,
  type BudgetLine,
} from "./budget";
import { CONTRIBUTION_CATEGORY, effectiveCategory, INCOME_CATEGORIES, isExcludedFromBudget } from "./categories";
import { monthEnd, monthStart, monthsIn, occurrencesBetween, shiftMonth, type DateRange } from "./dates";
import { periodContaining, shiftPeriod, type Period } from "./periods";
import { ALL_LEDGERS, HOUSEHOLD, householdContributions, linesForLedger, txsForLedger } from "./ledger";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const REVIEW_TREND_MONTHS = 12;
/** "Usual" = median month over this many months before the period, scaled to its length. */
export const REVIEW_USUAL_MONTHS = 6;
export const REVIEW_TOP_CATEGORIES = 6;
export const REVIEW_BIGGEST = 10;

/** This month, or last month on the 1st (nothing to review yet). */
export function defaultReviewPeriod(today: string): Period {
  const m = periodContaining("month", today);
  return monthStart(today) === today ? shiftPeriod(m, -1) : m;
}

/** "Nov 26" for a YYYY-MM. */
export function reviewMonthLabel(ym: string): string {
  return new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

/** The months the review needs: the trend ends with the period; "usual" looks at the months before it. Load transactions from `loadFrom`. */
export function reviewWindow(range: DateRange): { endMonth: string; trendFrom: string; usualFrom: string; loadFrom: string } {
  const endMonth = monthStart(range.toIso);
  const trendFrom = shiftMonth(endMonth, -(REVIEW_TREND_MONTHS - 1));
  const usualFrom = shiftMonth(monthStart(range.fromIso), -REVIEW_USUAL_MONTHS);
  return { endMonth, trendFrom, usualFrom, loadFrom: usualFrom < trendFrom ? usualFrom : trendFrom };
}

export type ReviewCategoryRow = { category: string; spent: number; median: number; line: BudgetLine | null; lineBudget: number | null; lineShared: boolean };
export type ReviewScheduleRow = { r: any; due: string[]; paid: any[]; actual: number; expected: number; done: boolean; notSeen: boolean };
export type ReviewGroupRow = { g: any; month: number; total: number };

export type Review = {
  /** Transactions in the period (the ledger's view). */
  periodTxs: any[];
  /** Money in by person ("" = household / nobody). */
  received: Map<string, number>;
  totalIn: number;
  totalOut: number;
  /** Of totalOut, spending tagged to a spend group. */
  groupedOut: number;
  byCategory: ReviewCategoryRow[];
  /** The largest of spent / usual / an unshared line's budget, for bar scales. */
  maxCategory: number;
  trend: {
    /** One per month: { month: "Nov 26", [category]: n, Other: n, Contributions: n }. */
    rows: Array<Record<string, number | string>>;
    /** The top categories, then "Other". */
    series: string[];
    /** The months of the selected period (labels), shaded on the chart. */
    shade: { x1: string; x2: string } | null;
  };
  biggest: any[];
  scheduled: ReviewScheduleRow[];
  groups: ReviewGroupRow[];
  /** Money in counted income other than contributions (interest, deposits) in the period. */
  hasOtherIncome: boolean;
};

/**
 * Everything the review shows for `ledger` (HOUSEHOLD, a person id, or
 * ALL_LEDGERS). `rawTxs` are every cash-flow account's rows from
 * reviewWindow(range).loadFrom to range.toIso; `lines` every budget row.
 * Everything leaves out contributions (money moving between ledgers) and
 * budget lines (each ledger has its own).
 */
export function buildReview(input: {
  rawTxs: any[];
  accounts: any[];
  lines: BudgetLine[];
  schedules: any[];
  groups: any[];
  ledger: string;
  range: DateRange;
  today: string;
}): Review {
  const { rawTxs, accounts, schedules, ledger, range, today } = input;
  const { endMonth, trendFrom, usualFrom } = reviewWindow(range);
  const txs =
    ledger === ALL_LEDGERS
      ? rawTxs.filter((t) => !((t.amount ?? 0) > 0 && effectiveCategory(t) === CONTRIBUTION_CATEGORY))
      : txsForLedger(rawTxs, accounts, ledger);
  const lines = ledger === ALL_LEDGERS ? [] : linesForLedger(input.lines, ledger);

  const periodTxs = txs.filter((t) => t.date >= range.fromIso && t.date <= range.toIso);

  // In vs out. The household counts transfers and spending from personal accounts as contributions too.
  const received = ledger === HOUSEHOLD ? householdContributions(rawTxs, accounts, range) : receivedByPerson(txs, range);
  const totalIn = [...received.values()].reduce((s, n) => s + n, 0);
  const totalOut = totalOutflow(txs, range);
  // Spend-group spending, refunds netted (spendParts: money in under a spending category is negative).
  const groupedOut = periodTxs
    .filter((t) => t.status !== "PENDING" && t.spendGroupId)
    .reduce((s, t) => s + spendParts(t).reduce((n, p) => n + p.amount, 0), 0);

  // By category: the period, its budget line, and the usual level — the
  // median month over the REVIEW_USUAL_MONTHS before the period (only months
  // we have data for), times the period's length in months.
  const spent = spendByCategory(txs, range);
  const firstMonth = txs.reduce((min: string, t) => (t.date && t.date < min ? t.date : min), "9999").slice(0, 7);
  const prior = monthsIn({ fromIso: usualFrom, toIso: shiftMonth(monthStart(range.fromIso), -1) }).filter((ym) => ym >= firstMonth);
  const scale = monthsInRange(range);
  const medians = new Map(seedFromHistory(txs, prior).map((s) => [s.category, s.median * scale]));
  const inForce = resolveBudgetLines(lines, resolutionDate(range, today)).filter((l) => budgetKind(l) === "EXPENSE");
  const lineOf = new Map<string, BudgetLine>();
  for (const l of inForce) for (const c of bucketCategories(l)) lineOf.set(c, l);
  const byCategory: ReviewCategoryRow[] = [...new Set([...spent.keys(), ...medians.keys()])]
    .map((category) => {
      const line = lineOf.get(category) ?? null;
      return {
        category,
        spent: spent.get(category) ?? 0,
        median: medians.get(category) ?? 0,
        line,
        lineBudget: line ? budgetedForRange(line, range) : null,
        lineShared: line ? bucketCategories(line).length > 1 : false,
      };
    })
    .filter((r) => r.spent > 0 || r.median > 0)
    .sort((a, b) => b.spent - a.spent || b.median - a.median);
  const maxCategory = Math.max(1, ...byCategory.map((r) => Math.max(r.spent, r.median, r.lineShared ? 0 : (r.lineBudget ?? 0))));

  // Trend: spending by top categories per month + contributions.
  const months = monthsIn({ fromIso: trendFrom, toIso: endMonth });
  const total = spendByCategory(txs, { fromIso: trendFrom, toIso: range.toIso, label: "" });
  const top = [...total.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, REVIEW_TOP_CATEGORIES)
    .map(([c]) => c);
  const trendRows = months.map((ym) => {
    const r = { fromIso: `${ym}-01`, toIso: monthEnd(`${ym}-01`), label: ym };
    const row: Record<string, number | string> = { month: reviewMonthLabel(ym) };
    let other = 0;
    for (const [c, v] of spendByCategory(txs, r)) {
      if (top.includes(c)) row[c] = Math.round(v);
      else other += v;
    }
    row.Other = Math.round(other);
    row.Contributions = Math.round([...receivedByPerson(txs, r).values()].reduce((s, n) => s + n, 0));
    return row;
  });
  const inPeriod = months.filter((ym) => `${ym}-01` >= monthStart(range.fromIso)).map(reviewMonthLabel);

  const biggest = periodTxs
    .filter((t) => t.status !== "PENDING" && (t.amount ?? 0) < 0 && !isExcludedFromBudget(effectiveCategory(t)))
    .sort((a, b) => a.amount - b.amount)
    .slice(0, REVIEW_BIGGEST);

  // Scheduled vs actual: every schedule due in the period, and whether a posted row is linked to it.
  const linked = new Map<string, any[]>();
  for (const t of periodTxs) if (t.recurringId) linked.set(t.recurringId, [...(linked.get(t.recurringId) ?? []), t]);
  const scheduled: ReviewScheduleRow[] = schedules
    .filter((r) => r.active !== false || linked.has(r.id))
    .map((r) => {
      const due = occurrencesBetween({ ...r, nextDate: r.startDate ?? r.nextDate }, range.fromIso, range.toIso);
      const paid = linked.get(r.id) ?? [];
      const actual = paid.reduce((s: number, t: any) => s + t.amount, 0);
      return {
        r,
        due,
        paid,
        actual,
        // Paid: the expected total for as many times as it came due (at least once).
        expected: r.amount * (paid.length ? Math.max(1, due.length) : due.length),
        done: paid.length >= due.length && paid.length > 0,
        notSeen: paid.length === 0 && due.some((d: string) => d < today),
      };
    })
    .filter((x) => x.due.length > 0 || x.paid.length > 0)
    .sort((a, b) => (a.due[0] ?? a.paid[0]?.date ?? "").localeCompare(b.due[0] ?? b.paid[0]?.date ?? ""));

  // Spend groups with activity in the period, or whose dates overlap it.
  const net = (rows: any[]) => -rows.reduce((s, t) => s + (t.amount ?? 0), 0);
  const groups: ReviewGroupRow[] = input.groups
    .map((g) => {
      const tagged = txs.filter((t) => t.spendGroupId === g.id && t.status !== "PENDING");
      const inMonth = tagged.filter((t) => t.date >= range.fromIso && t.date <= range.toIso);
      const overlaps = (!g.startDate || g.startDate <= range.toIso) && (!g.endDate || g.endDate >= range.fromIso) && (g.startDate || g.endDate);
      return { g, month: net(inMonth), total: net(tagged), active: inMonth.length > 0 || !!overlaps };
    })
    .filter((x) => x.active)
    .sort((a, b) => b.month - a.month)
    .map(({ g, month, total }) => ({ g, month, total }));

  const hasOtherIncome = periodTxs.some((t) => (t.amount ?? 0) > 0 && INCOME_CATEGORIES.has(effectiveCategory(t)) && effectiveCategory(t) !== CONTRIBUTION_CATEGORY);

  return {
    periodTxs,
    received,
    totalIn,
    totalOut,
    groupedOut,
    byCategory,
    maxCategory,
    trend: { rows: trendRows, series: [...top, "Other"], shade: inPeriod.length ? { x1: inPeriod[0], x2: inPeriod[inPeriod.length - 1] } : null },
    biggest,
    scheduled,
    groups,
    hasOtherIncome,
  };
}
