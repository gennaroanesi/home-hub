// Scheduled transactions: matching posted rows to their schedule, and
// projecting an account's balance forward from its schedules. Matching is
// ported from gennaroanesi.com (components/finance/recurring-match.ts).

import { addDays, advanceByCadence, occurrencesBetween, type Cadence } from "./dates";
import { patternMatches } from "./categories";
import type { RecurringLike, TxLike } from "./types";

export const MATCH_AUTO_THRESHOLD = 65;
export const MATCH_SUGGEST_THRESHOLD = 45;

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "pmt", "pay", "payment", "usd", "ach", "ppd", "dep", "tfr", "ref", "debit", "credit"]);

function tokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function absDays(a: string, b: string): number {
  return Math.abs(Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000));
}

/** Live = active, not past its end, and (for ONCE) not already past. */
export function isScheduleLive(rule: RecurringLike, todayIso: string): boolean {
  if (rule.active === false) return false;
  if (rule.endDate && rule.endDate < todayIso) return false;
  if (rule.cadence === "ONCE") {
    const d = rule.nextDate ?? rule.startDate;
    if (d && d < todayIso) return false;
  }
  return true;
}

/**
 * Score how likely `tx` is an occurrence of `rule`. 0 = impossible (other
 * account, other direction, pattern miss, amount far off).
 */
export function scoreMatch(tx: TxLike, rule: RecurringLike): { score: number; reasons: string[] } {
  const none = { score: 0, reasons: [] };
  const txAmt = tx.amount ?? 0;
  const ruleAmt = rule.amount ?? 0;
  if (tx.accountId !== rule.accountId) return none;
  if (Math.sign(txAmt) !== Math.sign(ruleAmt)) return none;
  if (rule.active === false) return none;

  const reasons: string[] = [];
  let score = 0;
  const hasPattern = !!rule.matchPattern?.trim();
  if (hasPattern) {
    if (!patternMatches(rule.matchPattern!, tx.description ?? "")) return none;
    score += 50;
    reasons.push("matches pattern");
  }

  // Without a pattern the amount is the "same bill" signal, so it's strict;
  // with one, variable bills (utilities) may swing.
  const absRule = Math.abs(ruleAmt);
  const pct = absRule > 0 ? Math.abs(Math.abs(txAmt) - absRule) / absRule : 1;
  if (pct < 0.01) (score += 35), reasons.push("amount exact");
  else if (pct < 0.05) (score += 20), reasons.push("amount within 5%");
  else if (hasPattern && pct < 0.25) (score += 15), reasons.push("amount within 25%");
  else if (hasPattern && pct < 0.75) (score += 5), reasons.push("amount within 75%");
  else return none;

  const due = rule.nextDate ?? rule.startDate;
  if (tx.date && due) {
    const d = absDays(tx.date, due);
    if (d === 0) (score += 25), reasons.push("on the due date");
    else if (d <= 3) (score += 20), reasons.push(`${d}d from due date`);
    else if (d <= 7) (score += 15), reasons.push(`${d}d from due date`);
  }

  const txT = tokens(tx.description);
  const ruleT = tokens(rule.description);
  if (txT.size && ruleT.size) {
    const ruleStr = (rule.description ?? "").toLowerCase();
    const overlap = [...ruleT].filter((t) => txT.has(t)).length / ruleT.size;
    if (ruleStr && (tx.description ?? "").toLowerCase().includes(ruleStr)) (score += 25), reasons.push("description contains the schedule's");
    else if (overlap >= 0.6) (score += 20), reasons.push(`${Math.round(overlap * 100)}% word overlap`);
    else if (overlap >= 0.3) (score += 10), reasons.push(`${Math.round(overlap * 100)}% word overlap`);
  }

  if (rule.category && tx.category && rule.category === tx.category) (score += 10), reasons.push("same category");
  return { score, reasons };
}

export function findScheduleMatches<R extends RecurringLike>(tx: TxLike, rules: R[], minScore = MATCH_SUGGEST_THRESHOLD) {
  return rules
    .map((rule) => ({ rule, ...scoreMatch(tx, rule) }))
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

/** The schedule's next due date after a posted occurrence on `txDate` (never rewinds). */
export function nextDateAfter(rule: RecurringLike, txDate: string): string | null {
  const cadence = (rule.cadence ?? "MONTHLY") as Cadence;
  const seed = rule.nextDate ?? rule.startDate ?? txDate;
  if (cadence === "ONCE" || txDate < seed) return null;
  let next = seed;
  for (let guard = 0; next <= txDate && guard < 500; guard++) {
    const step = advanceByCadence(next, cadence, cadence === "WEEKLY" || cadence === "BIWEEKLY" ? null : rule.startDate);
    if (step <= next) break;
    next = step;
  }
  return next;
}

export type ProjectedEvent = { date: string; amount: number; description: string; recurringId: string };
export type ProjectionPoint = { date: string; balance: number; events: ProjectedEvent[] };

/**
 * Upcoming scheduled money movements for one account in (todayIso, toIso],
 * including TRANSFER schedules that land in it.
 */
export function upcomingEvents(accountId: string, rules: RecurringLike[], todayIso: string, toIso: string): ProjectedEvent[] {
  const out: ProjectedEvent[] = [];
  for (const r of rules) {
    if (!isScheduleLive(r, todayIso)) continue;
    const amt = r.amount ?? 0;
    let signed: number | null = null;
    if (r.accountId === accountId) signed = r.type === "TRANSFER" ? -Math.abs(amt) : amt;
    else if (r.type === "TRANSFER" && r.toAccountId === accountId) signed = Math.abs(amt);
    if (signed == null || signed === 0) continue;
    for (const date of occurrencesBetween(r, addDays(todayIso, 1), toIso)) {
      out.push({ date, amount: signed, description: r.description ?? "", recurringId: r.id });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Balance after each day with scheduled activity, starting from today's balance. */
export function projectBalance(startBalance: number, events: ProjectedEvent[]): ProjectionPoint[] {
  const byDate = new Map<string, ProjectedEvent[]>();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date)!.push(e);
  }
  let bal = startBalance;
  return [...byDate.keys()].sort().map((date) => {
    const evs = byDate.get(date)!;
    bal += evs.reduce((s, e) => s + e.amount, 0);
    return { date, balance: bal, events: evs };
  });
}

/** The lowest projected point, for "the balance dips below the buffer on the 1st". */
export function lowestPoint(points: ProjectionPoint[]): ProjectionPoint | null {
  return points.reduce<ProjectionPoint | null>((lo, p) => (!lo || p.balance < lo.balance ? p : lo), null);
}
