// Household budget: versioned buckets of categories, measured against
// posted spending. Ported from gennaroanesi.com (components/finance/budget.ts),
// keeping its SCD resolution, validation, pace and range scaling; the
// funding-source pools (salary/bonus/RSU) become one household pool fed by
// each member's contribution (INCOME lines carry a personId).

import { effectiveCategory, isExcludedFromBudget, INCOME_CATEGORIES } from "./categories";
import { daysBetween, monthEnd, occurrencesBetween, previousDay, type DateRange } from "./dates";
import type { RecurringLike, TxLike } from "./types";

export const BUDGET_KINDS = ["INCOME", "EXPENSE"] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

export const BUDGET_PERIODS = ["MONTHLY", "QUARTERLY", "ANNUALLY", "ONCE"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  MONTHLY: "Month",
  QUARTERLY: "Quarter",
  ANNUALLY: "Year",
  ONCE: "One-off",
};

const PERIOD_MONTHS: Record<Exclude<BudgetPeriod, "ONCE">, number> = { MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12 };

/** The fields of a homeFinanceBudget row this module needs. */
export type BudgetLine = {
  id: string;
  seriesId: string;
  name: string;
  kind?: string | null;
  personId?: string | null;
  categories?: (string | null)[] | null;
  amount?: number | null;
  period?: string | null;
  rollover?: boolean | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  active?: boolean | null;
  label?: string | null;
  notes?: string | null;
};

export function budgetKind(line: BudgetLine): BudgetKind {
  return line.kind === "INCOME" ? "INCOME" : "EXPENSE";
}

export function bucketCategories(line: BudgetLine): string[] {
  return (line.categories ?? []).filter((c): c is string => !!c && c.trim() !== "").map((c) => c.trim());
}

// ── SCD resolution ────────────────────────────────────────────────────────────

/** In force on `onDate`: enabled, started, not ended. Null effectiveTo = open-ended. */
export function isInForce(line: BudgetLine, onDate: string): boolean {
  if (line.active === false) return false;
  if (!line.effectiveFrom || line.effectiveFrom > onDate) return false;
  return line.effectiveTo == null || line.effectiveTo >= onDate;
}

/**
 * At most one version per series in force on `onDate`; on overlap the
 * latest effectiveFrom wins, which makes insert-new-then-close-old safe.
 */
export function resolveBudgetLines(lines: BudgetLine[], onDate: string): BudgetLine[] {
  const best = new Map<string, BudgetLine>();
  for (const line of lines) {
    if (!isInForce(line, onDate)) continue;
    const cur = best.get(line.seriesId);
    if (!cur || (line.effectiveFrom ?? "") > (cur.effectiveFrom ?? "")) best.set(line.seriesId, line);
  }
  return [...best.values()];
}

/**
 * The date to resolve a window at: a closed period at its end, the current
 * one at today, a future one at its start.
 */
export function resolutionDate(window: DateRange, todayIso: string): string {
  if (todayIso < window.fromIso) return window.fromIso;
  if (todayIso > window.toIso) return window.toIso;
  return todayIso;
}

// ── Validation ────────────────────────────────────────────────────────────────

export type BudgetHistoryIssue = {
  kind: "overlap" | "multiple-open" | "reversed-range" | "missing-from" | "shared-category";
  seriesId: string;
  name: string;
  detail: string;
  lineIds: string[];
};

/** Invariant violations, surfaced on the page (DynamoDB enforces none of them). */
export function validateBudgetHistory(lines: BudgetLine[], onDate?: string): BudgetHistoryIssue[] {
  const issues: BudgetHistoryIssue[] = [];
  const bySeries = new Map<string, BudgetLine[]>();
  for (const l of lines) {
    if (l.active === false) continue;
    if (!bySeries.has(l.seriesId)) bySeries.set(l.seriesId, []);
    bySeries.get(l.seriesId)!.push(l);
  }
  for (const [seriesId, group] of bySeries) {
    const base = { seriesId, name: group[0].name };
    for (const l of group) {
      if (!l.effectiveFrom) issues.push({ ...base, kind: "missing-from", lineIds: [l.id], detail: "no start date, so it never applies" });
      else if (l.effectiveTo != null && l.effectiveTo < l.effectiveFrom)
        issues.push({ ...base, kind: "reversed-range", lineIds: [l.id], detail: `ends ${l.effectiveTo}, before it starts ${l.effectiveFrom}` });
    }
    const open = group.filter((l) => l.effectiveFrom && l.effectiveTo == null);
    if (open.length > 1)
      issues.push({ ...base, kind: "multiple-open", lineIds: open.map((l) => l.id), detail: `${open.length} open-ended versions; only the latest applies` });
    const dated = group
      .filter((l) => l.effectiveFrom && (l.effectiveTo == null || l.effectiveTo >= l.effectiveFrom))
      .sort((a, b) => (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? ""));
    for (let i = 1; i < dated.length; i++) {
      const prev = dated[i - 1];
      const cur = dated[i];
      if (prev.effectiveTo == null || prev.effectiveTo >= (cur.effectiveFrom ?? ""))
        issues.push({ ...base, kind: "overlap", lineIds: [prev.id, cur.id], detail: `${prev.effectiveFrom}→${prev.effectiveTo ?? "open"} overlaps ${cur.effectiveFrom}` });
    }
  }
  if (onDate) {
    const owner = new Map<string, BudgetLine>();
    for (const l of resolveBudgetLines(lines, onDate)) {
      if (budgetKind(l) !== "EXPENSE") continue;
      for (const cat of bucketCategories(l)) {
        const prev = owner.get(cat);
        if (prev && prev.seriesId !== l.seriesId)
          issues.push({ seriesId: l.seriesId, name: l.name, kind: "shared-category", lineIds: [prev.id, l.id], detail: `"${cat}" is also in "${prev.name}", so its spending would count twice` });
        else owner.set(cat, l);
      }
    }
  }
  return issues;
}

/**
 * The two writes that record a change, in the order that fails safely:
 * insert the new version, then close the old one the day before.
 */
export function planBudgetChange(
  current: BudgetLine | null,
  next: Omit<BudgetLine, "id" | "effectiveFrom" | "effectiveTo" | "active">,
  effectiveFrom: string,
): { insert: Omit<BudgetLine, "id">; close: { id: string; effectiveTo: string } | null } {
  return {
    insert: {
      seriesId: next.seriesId,
      name: next.name,
      kind: next.kind ?? "EXPENSE",
      personId: next.personId ?? null,
      categories: next.categories ?? [],
      amount: next.amount ?? 0,
      period: next.period ?? "MONTHLY",
      rollover: next.rollover ?? false,
      label: next.label ?? null,
      notes: next.notes ?? null,
      effectiveFrom,
      effectiveTo: null,
      active: true,
    },
    close: current && current.effectiveFrom && current.effectiveFrom < effectiveFrom ? { id: current.id, effectiveTo: previousDay(effectiveFrom) } : null,
  };
}

// ── Scaling a line to a range ─────────────────────────────────────────────────

export function monthsSpanned(range: DateRange): number {
  const [fy, fm] = range.fromIso.split("-").map(Number);
  const [ty, tm] = range.toIso.split("-").map(Number);
  return ty * 12 + tm - (fy * 12 + fm) + 1;
}

export function isMonthAligned(range: DateRange): boolean {
  return range.fromIso.endsWith("-01") && range.toIso === monthEnd(range.toIso);
}

/** Whole months for calendar-aligned ranges; elapsed months otherwise. */
export function monthsInRange(range: DateRange): number {
  if (isMonthAligned(range)) return monthsSpanned(range);
  return (daysBetween(range.fromIso, range.toIso) + 1) / 30.44;
}

/** What a line budgets for a range. ONCE belongs wholly to the range containing its start. */
export function budgetedForRange(line: BudgetLine, range: DateRange): number {
  const amount = Math.abs(line.amount ?? 0);
  const period = (line.period ?? "MONTHLY") as BudgetPeriod;
  if (period === "ONCE") {
    const at = line.effectiveFrom;
    return at && at >= range.fromIso && at <= range.toIso ? amount : 0;
  }
  return amount * (monthsInRange(range) / PERIOD_MONTHS[period]);
}

export function elapsedFraction(window: DateRange, todayIso: string): number {
  const total = daysBetween(window.fromIso, window.toIso) + 1;
  if (total <= 0) return 1;
  const gone = daysBetween(window.fromIso, todayIso) + 1;
  return Math.min(1, Math.max(0, gone / total));
}

// ── Actuals ───────────────────────────────────────────────────────────────────

function inWindow(tx: TxLike, window: DateRange): boolean {
  const d = tx.date ?? "";
  return d >= window.fromIso && d <= window.toIso;
}

/**
 * Counts against the monthly budget: posted money out in the window, not
 * tagged to a spend group (those have their own budget) and not internal
 * movement or income. Refunds are money in under their own category, so
 * they don't reduce a line's spend.
 */
export function countsTowardBudget(tx: TxLike, window: DateRange): boolean {
  if (tx.status === "PENDING" || tx.spendGroupId || !inWindow(tx, window)) return false;
  const cat = effectiveCategory(tx);
  if (isExcludedFromBudget(cat) || INCOME_CATEGORIES.has(cat)) return false;
  return (tx.amount ?? 0) < 0;
}

export function spendByCategory(txs: TxLike[], window: DateRange): Map<string, number> {
  const out = new Map<string, number>();
  for (const tx of txs) {
    if (!countsTowardBudget(tx, window)) continue;
    const cat = effectiveCategory(tx);
    out.set(cat, (out.get(cat) ?? 0) + Math.abs(tx.amount ?? 0));
  }
  return out;
}

/** The rows behind a bucket's number, largest first. Same filter as spendByCategory. */
export function budgetTransactions<T extends TxLike>(txs: T[], window: DateRange, categories: string[]): T[] {
  const want = new Set(categories);
  return txs
    .filter((tx) => countsTowardBudget(tx, window) && want.has(effectiveCategory(tx)))
    .sort((a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0));
}

/** All money that left in the window except internal movement — the honest "spent". */
export function totalOutflow(txs: TxLike[], window: DateRange): number {
  let sum = 0;
  for (const tx of txs) {
    if (tx.status === "PENDING" || !inWindow(tx, window)) continue;
    const amt = tx.amount ?? 0;
    if (amt >= 0 || isExcludedFromBudget(effectiveCategory(tx))) continue;
    sum += -amt;
  }
  return sum;
}

/**
 * Money in, by contributor (personId; "" = unattributed). Counts the income
 * categories (Contribution, Income, Interest), not refunds or transfers.
 */
export function receivedByPerson(txs: TxLike[], window: DateRange): Map<string, number> {
  const out = new Map<string, number>();
  for (const tx of txs) {
    if (tx.status === "PENDING" || !inWindow(tx, window)) continue;
    const amt = tx.amount ?? 0;
    if (amt <= 0 || !INCOME_CATEGORIES.has(effectiveCategory(tx))) continue;
    const key = tx.personId ?? "";
    out.set(key, (out.get(key) ?? 0) + amt);
  }
  return out;
}

/**
 * Spending already committed by scheduled transactions in the window, per
 * category. Decomposes a line ("Utilities $300: $240 scheduled, $60
 * variable"); never adds to it.
 */
export function committedByCategory(rules: RecurringLike[], window: DateRange): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rules) {
    if (r.active === false) continue;
    const amt = r.amount ?? 0;
    if (!(r.type === "EXPENSE" || amt < 0)) continue;
    const cat = (r.category ?? "").trim();
    if (!cat) continue;
    const n = occurrencesBetween(r, window.fromIso, window.toIso).length;
    if (n > 0) out.set(cat, (out.get(cat) ?? 0) + Math.abs(amt) * n);
  }
  return out;
}

// ── The view ──────────────────────────────────────────────────────────────────

export type BudgetStatus = "under" | "on" | "over";

export type BudgetLineView = {
  line: BudgetLine;
  budgeted: number;
  committed: number;
  variable: number;
  spent: number;
  remaining: number;
  elapsed: number;
  expectedByNow: number;
  /** spent ÷ expectedByNow; 1 = on pace. Null before any time has passed. */
  pace: number | null;
  status: BudgetStatus;
  /** Spend per remaining day that lands exactly on budget. */
  safeDailyRemaining: number;
};

const PACE_TOLERANCE = 0.05;

/**
 * One line against the window. For INCOME lines, `spent` is what that
 * member actually contributed. Status is the fact (above/below), not a
 * verdict: over is bad for spending and good for income.
 */
export function computeLineView(
  line: BudgetLine,
  window: DateRange,
  spentByCat: Map<string, number>,
  committedByCat: Map<string, number>,
  receivedByPersonId: Map<string, number>,
  todayIso: string,
): BudgetLineView {
  const budgeted = budgetedForRange(line, window);
  const income = budgetKind(line) === "INCOME";
  const cats = bucketCategories(line);
  const sum = (m: Map<string, number>) => cats.reduce((s, c) => s + (m.get(c) ?? 0), 0);
  const spent = income ? receivedByPersonId.get(line.personId ?? "") ?? 0 : sum(spentByCat);
  const committed = income ? 0 : sum(committedByCat);
  const elapsed = elapsedFraction(window, todayIso);
  const expectedByNow = budgeted * elapsed;
  const pace = expectedByNow > 0 ? spent / expectedByNow : null;
  const remaining = budgeted - spent;
  const daysLeft = Math.max(0, daysBetween(todayIso, window.toIso) + 1);
  let status: BudgetStatus = "on";
  if (pace != null) {
    if (pace > 1 + PACE_TOLERANCE) status = "over";
    else if (pace < 1 - PACE_TOLERANCE) status = "under";
  } else if (spent > budgeted) status = "over";
  return {
    line,
    budgeted,
    committed,
    variable: budgeted - committed,
    spent,
    remaining,
    elapsed,
    expectedByNow,
    pace,
    status,
    safeDailyRemaining: remaining > 0 && daysLeft > 0 ? remaining / daysLeft : 0,
  };
}

export type HouseholdBudgetView = {
  window: DateRange;
  /** Planned contributions (INCOME lines). */
  planned: number;
  /** What actually came in, all contributors. */
  received: number;
  /** Sum of EXPENSE lines. */
  allocated: number;
  /** Spending counted against EXPENSE lines. */
  spentBudgeted: number;
  /** All money out except internal movement, budgeted or not. */
  spentTotal: number;
  /** Sum of the lines that are over, not netted against the ones under. */
  overspend: number;
  /** planned − allocated: negative means more is budgeted than comes in. */
  unallocated: number;
  incomeViews: BudgetLineView[];
  expenseViews: BudgetLineView[];
  /** Spending in categories no in-force line covers. */
  unassigned: Array<{ category: string; spent: number }>;
  issues: BudgetHistoryIssue[];
};

/** Everything the budget page and the finance ops need for one window. */
export function householdBudget(
  lines: BudgetLine[],
  txs: TxLike[],
  rules: RecurringLike[],
  window: DateRange,
  todayIso: string,
): HouseholdBudgetView {
  const inForce = resolveBudgetLines(lines, resolutionDate(window, todayIso));
  const spentByCat = spendByCategory(txs, window);
  const committed = committedByCategory(rules, window);
  const received = receivedByPerson(txs, window);
  const views = inForce.map((l) => computeLineView(l, window, spentByCat, committed, received, todayIso));
  const incomeViews = views.filter((v) => budgetKind(v.line) === "INCOME").sort((a, b) => a.line.name.localeCompare(b.line.name));
  const expenseViews = views.filter((v) => budgetKind(v.line) === "EXPENSE").sort((a, b) => b.budgeted - a.budgeted);
  const covered = new Set(expenseViews.flatMap((v) => bucketCategories(v.line)));
  const unassigned = [...spentByCat.entries()]
    .filter(([c]) => !covered.has(c))
    .map(([category, spent]) => ({ category, spent }))
    .sort((a, b) => b.spent - a.spent);
  const planned = incomeViews.reduce((s, v) => s + v.budgeted, 0);
  const allocated = expenseViews.reduce((s, v) => s + v.budgeted, 0);
  return {
    window,
    planned,
    received: [...received.values()].reduce((s, n) => s + n, 0),
    allocated,
    spentBudgeted: expenseViews.reduce((s, v) => s + v.spent, 0),
    spentTotal: totalOutflow(txs, window),
    overspend: expenseViews.reduce((s, v) => s + Math.max(0, v.spent - v.budgeted), 0),
    unallocated: planned - allocated,
    incomeViews,
    expenseViews,
    unassigned,
    issues: validateBudgetHistory(lines, resolutionDate(window, todayIso)),
  };
}

// ── Inventory and seeding ─────────────────────────────────────────────────────

export type BudgetSeries = {
  seriesId: string;
  name: string;
  kind: BudgetKind;
  latest: BudgetLine;
  versions: BudgetLine[];
  liveNow: boolean;
  startsOn: string | null;
  endedOn: string | null;
};

/** Every budget series, in force or not (staged for later, or ended). */
export function listBudgetSeries(lines: BudgetLine[], todayIso: string): BudgetSeries[] {
  const bySeries = new Map<string, BudgetLine[]>();
  for (const l of lines) {
    if (!bySeries.has(l.seriesId)) bySeries.set(l.seriesId, []);
    bySeries.get(l.seriesId)!.push(l);
  }
  const out: BudgetSeries[] = [];
  for (const [seriesId, group] of bySeries) {
    const versions = [...group].sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""));
    const latest = versions[0];
    const started = !!latest.effectiveFrom && latest.effectiveFrom <= todayIso;
    const ended = latest.effectiveTo != null && latest.effectiveTo < todayIso;
    out.push({
      seriesId,
      name: latest.name ?? "(unnamed)",
      kind: budgetKind(latest),
      latest,
      versions,
      liveNow: latest.active !== false && started && !ended,
      startsOn: started ? null : latest.effectiveFrom ?? null,
      endedOn: ended ? latest.effectiveTo ?? null : null,
    });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "INCOME" ? -1 : 1) || a.name.localeCompare(b.name));
}

export type CategorySeed = { category: string; median: number; min: number; max: number; volatility: number; monthly: number[] };

/** Median monthly spend per category over `months` (YYYY-MM), to pre-fill a budget. */
export function seedFromHistory(txs: TxLike[], months: string[]): CategorySeed[] {
  const byCat = new Map<string, Map<string, number>>();
  for (const tx of txs) {
    if (tx.status === "PENDING" || tx.spendGroupId) continue;
    const amt = tx.amount ?? 0;
    if (amt >= 0) continue;
    const m = (tx.date ?? "").slice(0, 7);
    if (!months.includes(m)) continue;
    const cat = effectiveCategory(tx);
    if (isExcludedFromBudget(cat) || INCOME_CATEGORIES.has(cat)) continue;
    if (!byCat.has(cat)) byCat.set(cat, new Map());
    const mm = byCat.get(cat)!;
    mm.set(m, (mm.get(m) ?? 0) - amt);
  }
  const out: CategorySeed[] = [];
  for (const [category, mm] of byCat) {
    const monthly = months.map((m) => mm.get(m) ?? 0);
    const sorted = [...monthly].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const min = Math.min(...monthly);
    const max = Math.max(...monthly);
    out.push({ category, median, min, max, monthly, volatility: median > 0 ? (max - min) / median : 0 });
  }
  return out.sort((a, b) => b.median - a.median);
}
