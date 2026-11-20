// Ledgers: whose budget a dollar belongs to. One household ledger plus one
// personal ledger per adult (a household member with a login).
//
// - An account belongs to the household when it has no owner or several
//   (joint), else to its single owner (`accountLedger`).
// - A transaction belongs to its account's ledger unless `ledger` says
//   otherwise; an itemized one can send each item elsewhere (the item's
//   `ledger`, else the transaction's).
// - Each ledger's budget runs the ordinary budget math (budget.ts) over that
//   ledger's slice of every transaction (`sliceForLedger`): the parts that
//   belong to it, with amount and items cut down to match, so nothing in
//   budget.ts needs to know about ledgers.
// - Household spending paid from a personal account is that person's
//   contribution in kind: it counts toward their household contribution
//   line as if they'd moved the money into the joint account. Personal
//   spending paid from household money is the reverse (it lowers what they
//   contributed). `inKindContributions`.
// - The "all" view puts the ledgers side by side: every personal income and
//   every spending and savings line, each measured in its own ledger. The
//   household's contribution lines are money moving between ledgers, so
//   they're left out of it.

import { categoryParts, effectiveCategory, isExcludedFromBudget, parseLineItems, INCOME_CATEGORIES, TRANSFER_CATEGORY, type LineItem } from "./categories";
import { householdBudget, type BudgetLine, type HouseholdBudgetView } from "./budget";
import type { DateRange } from "./dates";
import type { RecurringLike, TxLike } from "./types";
import { isHouseholdMember } from "../household";

export const HOUSEHOLD = "household";
export const ALL_LEDGERS = "all";

type AccountLike = { id: string; ownerPersonIds?: (string | null)[] | null };
type PersonLike = { id: string; name: string; cognitoUsername?: string | null; groups?: (string | null)[] | null; active?: boolean | null };

/** "household", or the single owner's person id. */
export function accountLedger(a: AccountLike | null | undefined): string {
  const owners = (a?.ownerPersonIds ?? []).filter((x): x is string => !!x);
  return owners.length === 1 ? owners[0] : HOUSEHOLD;
}

/**
 * Whether something funded by these accounts (a savings goal) belongs to
 * the ledger: a person's when one of its accounts is theirs, the
 * household's when one is joint or when it's tracked by hand (no accounts);
 * everything for "all".
 */
export function fundedInLedger(accountIds: string[], accounts: AccountLike[], ledger: string): boolean {
  if (ledger === ALL_LEDGERS) return true;
  if (accountIds.length === 0) return ledger === HOUSEHOLD;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return accountIds.some((id) => accountLedger(byId.get(id)) === ledger);
}

export function ledgerOf(tx: { ledger?: string | null }, accountLedgerKey: string): string {
  return tx.ledger?.trim() || accountLedgerKey;
}

/** A schedule's budget: its own ledger (a household bill on a personal card), else its account's. */
export function scheduleLedger(rule: { ledger?: string | null; accountId?: string | null }, accountLedgerOf: (accountId: string) => string | undefined): string {
  return rule.ledger?.trim() || accountLedgerOf(rule.accountId ?? "") || HOUSEHOLD;
}

/** The adults who get a personal ledger: household members with a login (guests have logins too). */
export function ledgerPeople<P extends PersonLike>(people: P[]): P[] {
  return people.filter((p) => !!p.cognitoUsername && isHouseholdMember(p));
}

export function ledgerLabel(key: string | null | undefined, people: PersonLike[]): string {
  if (!key || key === HOUSEHOLD) return "Household";
  if (key === ALL_LEDGERS) return "Everything";
  return people.find((p) => p.id === key)?.name ?? "Someone";
}

/**
 * The transaction cut into ledgers: per ledger, its magnitude and its
 * items (amounts already scaled so they sum to that magnitude, see
 * categoryParts). A plain row is one part in its own ledger.
 */
export function ledgerParts(tx: TxLike & { ledger?: string | null }, accountLedgerKey: string): Array<{ ledger: string; amount: number; items: LineItem[] | null }> {
  const own = ledgerOf(tx, accountLedgerKey);
  const items = parseLineItems(tx);
  const magnitude = Math.abs(tx.amount ?? 0);
  const raw = items ? items.reduce((s, i) => s + i.amount, 0) : 0;
  if (!items || raw <= 0) return [{ ledger: own, amount: magnitude, items: null }];
  const byLedger = new Map<string, LineItem[]>();
  for (const it of items) {
    const key = it.ledger?.trim() || own;
    byLedger.set(key, [...(byLedger.get(key) ?? []), { ...it, amount: (it.amount * magnitude) / raw }]);
  }
  return [...byLedger].map(([ledger, its]) => ({ ledger, amount: its.reduce((s, i) => s + i.amount, 0), items: its }));
}

/**
 * `tx` as seen from one ledger: whole, cut down to the items that belong to
 * it, or null when nothing does. A personal slice with no person on it is
 * that person's (their paycheck counts as their income).
 */
export function sliceForLedger<T extends TxLike & { ledger?: string | null }>(tx: T, accountLedgerKey: string, ledger: string): T | null {
  const parts = ledgerParts(tx, accountLedgerKey);
  const mine = parts.find((p) => p.ledger === ledger);
  if (!mine) return null;
  const withPerson = <X extends T>(x: X): X => (ledger !== HOUSEHOLD && !x.personId ? { ...x, personId: ledger } : x);
  if (parts.length === 1) return withPerson(tx);
  const sign = (tx.amount ?? 0) < 0 ? -1 : 1;
  return withPerson({ ...tx, amount: sign * mine.amount, lineItems: JSON.stringify(mine.items) });
}

export function txsForLedger<T extends TxLike & { ledger?: string | null }>(txs: T[], accounts: AccountLike[], ledger: string): T[] {
  const byId = new Map(accounts.map((a) => [a.id, accountLedger(a)]));
  const out: T[] = [];
  for (const tx of txs) {
    const s = sliceForLedger(tx, byId.get(tx.accountId) ?? HOUSEHOLD, ledger);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Per person, what they contributed to the household other than through a
 * Contribution row: money moved between their own account and a household
 * one (a transfer the sync paired: in counts for them, back out against),
 * plus household spending paid from their own accounts, minus personal
 * spending paid with household money. Posted, in the window, not
 * spend-group rows; card payments and other transfers aren't spending.
 */
export function inKindContributions(txs: (TxLike & { ledger?: string | null })[], accounts: AccountLike[], window: DateRange): Map<string, number> {
  const byId = new Map(accounts.map((a) => [a.id, accountLedger(a)]));
  const out = new Map<string, number>();
  const add = (k: string, n: number) => out.set(k, (out.get(k) ?? 0) + n);
  for (const tx of txs) {
    if (tx.status === "PENDING" || tx.spendGroupId) continue;
    if ((tx.date ?? "") < window.fromIso || (tx.date ?? "") > window.toIso) continue;
    const acct = byId.get(tx.accountId) ?? HOUSEHOLD;
    // Transfers are counted on the household side only, so a pair counts once.
    if (tx.toAccountId && (tx.type === "TRANSFER" || effectiveCategory(tx) === TRANSFER_CATEGORY)) {
      const other = byId.get(tx.toAccountId) ?? HOUSEHOLD;
      if (acct === HOUSEHOLD && other !== HOUSEHOLD) add(other, tx.amount ?? 0);
      continue;
    }
    if ((tx.amount ?? 0) >= 0) continue;
    for (const part of ledgerParts(tx, acct)) {
      if (part.ledger === acct) continue;
      // Only what the budget counts as spending moves between ledgers.
      const sliced = { ...tx, amount: -part.amount, lineItems: part.items ? JSON.stringify(part.items) : tx.lineItems };
      const spend = categoryParts(sliced)
        .filter((p) => !isExcludedFromBudget(p.category) && !INCOME_CATEGORIES.has(p.category))
        .reduce((s, p) => s + p.amount, 0);
      if (spend <= 0) continue;
      if (part.ledger === HOUSEHOLD && acct !== HOUSEHOLD) add(acct, spend);
      else if (acct === HOUSEHOLD && part.ledger !== HOUSEHOLD) add(part.ledger, -spend);
    }
  }
  return out;
}

export function linesForLedger(lines: BudgetLine[], ledger: string): BudgetLine[] {
  return lines.filter((l) => (l.ledger?.trim() || HOUSEHOLD) === ledger);
}

export type LedgerBudgetView = HouseholdBudgetView & {
  ledger: string;
  /** Household view: per person, what they paid for the household directly (in-kind, already in `received`). */
  paidDirectly: Map<string, number>;
  /**
   * Personal view: what goes to the household: planned (the household's
   * contribution lines for this person) and sent (transfers in + paid
   * directly, as the household counts it).
   */
  toHousehold: { planned: number; sent: number } | null;
};

/**
 * One ledger's budget. `txs` are every cash-flow transaction (all accounts);
 * the ledger's slice is taken here. Personal views take what the person
 * planned to put into the household out of what's left to allocate.
 */
export function ledgerBudget(
  ledger: string,
  lines: BudgetLine[],
  txs: (TxLike & { ledger?: string | null })[],
  rules: (RecurringLike & { accountId?: string | null })[],
  accounts: AccountLike[],
  window: DateRange,
  todayIso: string,
): LedgerBudgetView {
  const byId = new Map(accounts.map((a) => [a.id, accountLedger(a)]));
  const myRules = rules.filter((r) => scheduleLedger(r, (id) => byId.get(id)) === ledger);
  const inKind = inKindContributions(txs, accounts, window);
  const view = householdBudget(linesForLedger(lines, ledger), txsForLedger(txs, accounts, ledger), myRules, window, todayIso, ledger === HOUSEHOLD ? inKind : undefined);
  if (ledger === HOUSEHOLD) return { ...view, ledger, paidDirectly: inKind, toHousehold: null };

  const household = householdBudget(linesForLedger(lines, HOUSEHOLD), txsForLedger(txs, accounts, HOUSEHOLD), [], window, todayIso, inKind);
  const mine = household.incomeViews.filter((v) => v.line.personId === ledger);
  const planned = mine.reduce((s, v) => s + v.budgeted, 0);
  const sent = household.receivedByPersonId.get(ledger) ?? 0;
  return { ...view, ledger, paidDirectly: new Map(), toHousehold: { planned, sent }, unallocated: view.unallocated - planned };
}

/**
 * Every ledger side by side. Lines keep their ledger (`line.ledger`), each
 * measured within it; the household's contribution lines are left out
 * (money between ledgers), so `planned`/`received` are personal income.
 */
export function allLedgersBudget(
  ledgers: string[],
  lines: BudgetLine[],
  txs: (TxLike & { ledger?: string | null })[],
  rules: (RecurringLike & { accountId?: string | null })[],
  accounts: AccountLike[],
  window: DateRange,
  todayIso: string,
): LedgerBudgetView {
  const views = [HOUSEHOLD, ...ledgers.filter((l) => l !== HOUSEHOLD)].map((l) => ledgerBudget(l, lines, txs, rules, accounts, window, todayIso));
  const tag = <V extends { line: BudgetLine }>(vs: V[], ledger: string) => vs.map((v) => ({ ...v, line: { ...v.line, ledger } }));
  const incomeViews = views.filter((v) => v.ledger !== HOUSEHOLD).flatMap((v) => tag(v.incomeViews, v.ledger));
  const savingsViews = views.flatMap((v) => tag(v.savingsViews, v.ledger));
  const expenseViews = views.flatMap((v) => tag(v.expenseViews, v.ledger)).sort((a, b) => b.budgeted - a.budgeted);
  const spanViews = views.flatMap((v) => tag(v.spanViews, v.ledger)).sort((a, b) => b.budgeted - a.budgeted);
  const unassigned = new Map<string, number>();
  for (const v of views) for (const u of v.unassigned) unassigned.set(u.category, (unassigned.get(u.category) ?? 0) + u.spent);
  const sum = <V>(vs: V[], f: (v: V) => number) => vs.reduce((s, v) => s + f(v), 0);
  const planned = sum(incomeViews, (v) => v.budgeted);
  const allocated = sum(expenseViews, (v) => v.budgeted);
  const savingsPlanned = sum(savingsViews, (v) => v.budgeted);
  return {
    window,
    ledger: ALL_LEDGERS,
    planned,
    received: sum(incomeViews, (v) => v.spent),
    receivedByPersonId: new Map(),
    allocated,
    savingsPlanned,
    saved: sum(savingsViews, (v) => v.spent),
    spentBudgeted: sum(expenseViews, (v) => v.spent),
    spentTotal: sum(views, (v) => v.spentTotal),
    overspend: sum(expenseViews, (v) => Math.max(0, v.spent - v.budgeted)),
    unallocated: planned - allocated - savingsPlanned,
    incomeViews,
    savingsViews,
    expenseViews,
    spanViews,
    unassigned: [...unassigned].map(([category, spent]) => ({ category, spent })).sort((a, b) => b.spent - a.spent),
    issues: views.flatMap((v) => v.issues),
    paidDirectly: new Map(),
    toHousehold: null,
  };
}
