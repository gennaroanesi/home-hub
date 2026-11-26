// Category-rule tooling shared by the web Rules page and the phone's: the
// pattern check, the tester ("which rule decides what"), re-applying the
// current rules to stored transactions (never over anything set by hand or
// by the row's bill), and the sort orders for adding / moving a rule.

import { classify, patternMatches, stripProcessorPrefix, type CategoryRule } from "./categories";
import { canTakeRuleLedger } from "./ledger";
import { findRefundPurchase, mayBeRefund, refundFields, withRefundNote } from "./refunds";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The error in a `/regex/flags` pattern, or null (plain text is always fine). */
export function rulePatternError(pattern: string): string | null {
  const m = pattern.trim().match(/^\/(.+)\/([imsu]*)$/);
  if (!m) return null;
  try {
    new RegExp(m[1], m[2]);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid regex";
  }
}

/** Why a rule can't be saved, or null. */
export function ruleSaveError(f: { pattern: string; category?: string | null; personId?: string | null; ledger?: string | null }): string | null {
  if (!f.pattern.trim()) return "A pattern is required";
  if (!f.category?.trim() && !f.personId && !f.ledger) return "Set a category, a person or a budget";
  return rulePatternError(f.pattern);
}

export type RuleHit = CategoryRule & { n: number };

/**
 * What the rules make of a description: classify's category / person /
 * budget, plus the rule (1-based position) that decided each.
 */
export function testRules(
  description: string,
  direction: "out" | "in",
  rules: CategoryRule[],
): { category: string | null; personId: string | null; ledger: string | null; catRule: RuleHit | null; personRule: RuleHit | null; ledgerRule: RuleHit | null } | null {
  const desc = description.trim();
  if (!desc) return null;
  const out = classify({ description: desc, amount: direction === "out" ? -1 : 1 }, rules);
  const stripped = stripProcessorPrefix(desc);
  const hits = (p: string) => patternMatches(p, desc) || (stripped !== desc && patternMatches(p, stripped));
  const find = (has: (r: CategoryRule) => unknown): RuleHit | null => {
    const i = rules.findIndex((r) => has(r) && hits(r.pattern));
    return i >= 0 ? { n: i + 1, ...rules[i] } : null;
  };
  return { ...out, catRule: find((r) => r.category), personRule: find((r) => r.personId), ledgerRule: find((r) => r.ledger) };
}

export type RuleChange = { tx: any; category?: string; personId?: string; ledger?: string; spendGroupId?: string; outOfBudget?: boolean | null; refundOf?: any; notes?: string };

/**
 * What the current rules would change on a transaction. Never touches a
 * MANUAL category or person; a guessed (LLM) category is replaced only
 * when a rule now matches; transfers paired by the sync are left alone.
 *
 * With `purchases` (rows from up to REFUND_LOOKBACK_DAYS before), a refund
 * takes its original purchase's category, budget and spend group instead of
 * the rule's (lib/finance/refunds.ts).
 */
export function planRuleChange(tx: any, rules: CategoryRule[], accountLedgerOf: (id: string) => string, purchases?: any[]): RuleChange | null {
  if (tx.type === "TRANSFER") return null;
  const hit = classify({ description: tx.description, amount: tx.amount, type: tx.type }, rules);
  const personId = hit.personId;
  let { category, ledger } = hit;
  const change: RuleChange = { tx };
  const src = tx.categorySource ?? null;
  const purchase =
    purchases && src !== "MANUAL" && mayBeRefund({ ...tx, category: category ?? tx.category }) ? findRefundPurchase(tx, purchases) : null;
  if (purchase) {
    const f = refundFields(purchase);
    change.refundOf = purchase;
    const notes = withRefundNote(tx.notes, purchase);
    if (notes !== (tx.notes ?? "").trim()) change.notes = notes;
    category = f.category;
    if (f.ledger) ledger = f.ledger;
    if (f.spendGroupId && !tx.spendGroupId) {
      change.spendGroupId = f.spendGroupId;
      change.outOfBudget = f.outOfBudget;
    }
  }
  if (src !== "MANUAL" && category && category !== (tx.category ?? "")) change.category = category;
  // A person is only a contributor (money in); spending's owner is its ledger.
  if ((tx.amount ?? 0) > 0 && tx.personSource !== "MANUAL" && personId && personId !== tx.personId) change.personId = personId;
  // Never over a budget picked by hand or by the row's bill (canTakeRuleLedger).
  if (ledger && ledger !== (tx.ledger ?? "") && canTakeRuleLedger(tx, accountLedgerOf(tx.accountId))) change.ledger = ledger;
  return change.category !== undefined || change.personId !== undefined || change.ledger !== undefined || change.spendGroupId !== undefined || change.notes !== undefined ? change : null;
}

/**
 * Re-apply over the rows dated `fromIso` or later, with every row in `txs`
 * (load REFUND_LOOKBACK_DAYS more) as purchases a refund can match.
 */
export function planRuleChanges(txs: any[], rules: CategoryRule[], accountLedgerOf: (id: string) => string, fromIso: string): RuleChange[] {
  return txs
    .filter((t) => (t.date ?? "") >= fromIso)
    .map((t) => planRuleChange(t, rules, accountLedgerOf, txs))
    .filter((c): c is RuleChange => !!c);
}

/** The homeFinanceTransaction update for a change (without the id), marking each field as set by a rule. */
export function ruleChangePatch(c: RuleChange): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (c.category !== undefined) Object.assign(patch, { category: c.category, categorySource: "RULE" });
  if (c.personId !== undefined) Object.assign(patch, { personId: c.personId, personSource: "RULE" });
  if (c.ledger !== undefined) Object.assign(patch, { ledger: c.ledger, ledgerSource: "RULE" });
  if (c.spendGroupId !== undefined) Object.assign(patch, { spendGroupId: c.spendGroupId, outOfBudget: c.outOfBudget ?? null });
  if (c.notes !== undefined) patch.notes = c.notes;
  return patch;
}

/** Days for re-apply as typed: 1–3650, 90 when blank or not a number. */
export function reapplyDays(typed: string): number {
  return Math.max(1, Math.min(3650, parseInt(typed, 10) || 90));
}

/** A new rule's sortOrder: above every rule ("top") or below them ("bottom"). */
export function newRuleSortOrder(rows: Array<{ sortOrder?: number | null }>, position: "top" | "bottom"): number {
  if (!rows.length) return 100;
  const orders = rows.map((r) => r.sortOrder ?? 0);
  return position === "top" ? Math.min(...orders) - 10 : Math.max(...orders) + 100;
}

/**
 * The sortOrder updates that move rule `index` one step (`dir`) in the
 * list (sorted by sortOrder): a swap, or on a tie a renumbering (100, 200…)
 * with the two swapped.
 */
export function moveRuleUpdates(rows: Array<{ id: string; sortOrder?: number | null }>, index: number, dir: -1 | 1): Array<{ id: string; sortOrder: number }> {
  const j = index + dir;
  if (j < 0 || j >= rows.length) return [];
  const a = rows[index];
  const b = rows[j];
  if ((a.sortOrder ?? 0) !== (b.sortOrder ?? 0)) {
    return [
      { id: a.id, sortOrder: b.sortOrder ?? 0 },
      { id: b.id, sortOrder: a.sortOrder ?? 0 },
    ];
  }
  const next = [...rows];
  [next[index], next[j]] = [next[j], next[index]];
  return next.flatMap((r, i) => (r.sortOrder !== (i + 1) * 100 ? [{ id: r.id, sortOrder: (i + 1) * 100 }] : []));
}
