// Household finance: the joint account's balance, budget, transactions,
// scheduled transactions (mortgage, car, contributions) and savings goals.
// Computation lives in lib/finance/; these ops are the surface Janet, the
// API, the CLI and the finance pages' writes share.

import { z } from "zod/v4";
import { listAllPages } from "../list-all";
import {
  BUDGET_PERIODS,
  filterBudgetView,
  householdBudget,
  bucketCategories,
  defaultChangeEnd,
  planRemoveVersion,
  planSeriesChange,
  resolveBudgetLines,
  budgetKind,
  budgetTxRange,
  type BudgetLine,
  type SeriesWrite,
} from "../finance/budget";
import { filterTransactions, sortTransactions, TX_SORTS } from "../finance/tx-filter";
import { allCategories, CATEGORY_RULES, classify, effectiveCategory, parseLineItems, patternMatches, rulesFromDbRows, UNCATEGORIZED } from "../finance/categories";
import { addDays, CADENCE_MONTHLY_FACTOR, CADENCES, monthEnd, monthRange, monthStart, normalizeAmountSign, todayIso, type Cadence } from "../finance/dates";
import { listAccountTransactions, listAccounts, listBudgetLines, listCategoryRules, listGoalMilestones, listGoals, listHoldings, listSchedules, listSpendGroups, listTransactions, txIndexQuery } from "../finance/data";
import { goalAccountIds, goalProgress, milestoneViews } from "../finance/goals";
import { accountTypeLabel, householdAccounts, isInvested, isOutsideCashFlow } from "../finance/accounts";
import { isScheduleLive, lowestPoint, nextDueAfterPaid, planScheduleLinks, projectBalance, upcomingEvents } from "../finance/recurring";
import { defaultCadences, periodContaining, periodFromParam, periodRange, periodToParam } from "../finance/periods";
import { ALL_LEDGERS, HOUSEHOLD, accountLedger, allLedgersBudget, fundedInLedger, ledgerBudget, ledgerLabel, ledgerOf, ledgerPeople, scheduleLedger, canTakeScheduleLedger, txsForLedger } from "../finance/ledger";
import { CSV_FORMATS, newCsvRows, parseBankCsv } from "../finance/csv-import";
import { importHash } from "../finance/sync-engine";
import { loadCategoryVocabulary, rememberCategories } from "../finance/category-list";
import { SPEND_GROUP_KINDS, sortSpendGroups, spendGroupFields } from "../finance/spend-groups";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const r2 = (n: number) => Math.round(n * 100) / 100;

const MilestoneOut = z.object({
  id: z.string(),
  label: z.string().nullable(),
  targetAmount: z.number(),
  targetDate: z.string(),
  status: z.enum(["HIT", "MISSED", "PENDING"]).describe("HIT = progress reached it; MISSED = its date passed first"),
  monthlyNeeded: z.number().nullable().describe("Next pending milestone only: monthly saving needed to reach it on time"),
});

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function milestoneOut(rows: any[], current: number, today: string): Array<z.infer<typeof MilestoneOut>> {
  return milestoneViews(rows, current, today).map((v) => ({
    id: v.milestone.id,
    label: v.milestone.label ?? null,
    targetAmount: r2(v.milestone.targetAmount),
    targetDate: v.milestone.targetDate,
    status: v.status,
    monthlyNeeded: v.monthlyNeeded == null ? null : r2(v.monthlyNeeded),
  }));
}

type Person = { id: string; name: string };

async function people(ctx: OpContext): Promise<Person[]> {
  return listAllPages<Person>(ctx.client.models.homePerson);
}

/** personId or personName → id; undefined when neither given; null to clear. */
async function personRef(ctx: OpContext, input: { personId?: string | null; personName?: string | null }): Promise<string | null | undefined> {
  if (input.personId === null || input.personName === null) return null;
  if (!input.personId && !input.personName) return undefined;
  const all = await people(ctx);
  if (input.personId) {
    if (!all.some((p) => p.id === input.personId)) throw new OpError(`No person with id ${input.personId}`);
    return input.personId;
  }
  const p = all.find((x) => x.name.toLowerCase() === input.personName!.trim().toLowerCase());
  if (!p) throw new OpError(`No person named "${input.personName}"`);
  return p.id;
}

/**
 * A ledger given as "household", "all" (when allowed), a person id or a
 * person's name → its key. undefined when not given; null clears (back to
 * the account's ledger).
 */
async function ledgerRef(ctx: OpContext, v: string | null | undefined, opts: { allowAll?: boolean } = {}): Promise<string | null | undefined> {
  if (v === undefined) return undefined;
  if (v === null || !v.trim()) return null;
  const want = v.trim().toLowerCase();
  if (want === HOUSEHOLD || want === "joint") return HOUSEHOLD;
  if (want === ALL_LEDGERS || want === "everything") {
    if (!opts.allowAll) throw new OpError(`"${v}" isn't a ledger here: use household or a person`);
    return ALL_LEDGERS;
  }
  const all = await people(ctx);
  const first = (x: Person) => x.name.toLowerCase().split(/\s+/)[0];
  // "Cristine" finds "Cris" and "Cris" finds "Cristine" (a nickname or the full name), when only one person fits.
  const loose = all.filter((x) => want.length >= 3 && first(x).length >= 3 && (want.startsWith(first(x)) || first(x).startsWith(want)));
  const p = all.find((x) => x.id === v.trim()) ?? all.find((x) => x.name.toLowerCase() === want) ?? all.find((x) => first(x) === want) ?? (loose.length === 1 ? loose[0] : undefined);
  if (!p) throw new OpError(`No ledger "${v}": use household${opts.allowAll ? ", all" : ""} or a person's name`);
  return p.id;
}

const LEDGER_PARAM = z.string().describe('Whose budget: "household" (the joint money), a person\'s name or id (their personal money), or "all" (everything side by side). Default household.');

function nameOf(all: Person[], id: string | null | undefined): string | null {
  return id ? all.find((p) => p.id === id)?.name ?? null : null;
}

// ── get_finance_summary ───────────────────────────────────────────────────────

export const getFinanceSummary = defineOp({
  name: "get_finance_summary",
  domain: "finance",
  access: "read",
  description:
    "Money at a glance for one month (default: this month), for the household (default), one person (ledger: their own accounts and budget) or everything: account balances, the budget (what each person planned to contribute vs what came in, and each budget line's spending vs its amount), the scheduled debits coming up in the next 14 days with the projected low balance, savings goals, and how many transactions still need a category. Answers 'how are we doing this month?', 'how much have we spent on groceries?', 'did Cristine's contribution come in?', 'will we have enough for the mortgage?', 'how close are we to the emergency fund goal?'.",
  input: z.object({
    month: MONTH.optional().describe("YYYY-MM; default this month."),
    ledger: LEDGER_PARAM.optional(),
  }),
  output: z.object({
    month: z.string(),
    ledger: z.string().describe("household, all, or the person's id"),
    ledgerName: z.string(),
    ledgers: z.array(z.object({ key: z.string(), name: z.string() })).describe("Every view there is: household, each person, all"),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string().nullable(),
        ledger: z.string().describe("household or the single owner's person id"),
        balance: z.number().describe("Invested accounts: total value, positions included"),
        updatedAt: z.string().nullable(),
        institution: z.string().nullable(),
        minBalance: z.number().nullable().describe("The buffer the balance shouldn't drop under"),
        invested: z.boolean().describe("401k / IRA / brokerage: for goals, not cash flow"),
        lowPoint: z.object({ date: z.string(), balance: z.number() }).nullable().describe("Cash accounts: lowest projected balance in the next 14 days"),
      }),
    ),
    contributions: z.array(z.object({ name: z.string(), person: z.string().nullable(), period: z.string(), planned: z.number(), received: z.number() })),
    savings: z.array(z.object({ name: z.string(), account: z.string().nullable(), planned: z.number(), saved: z.number() })),
    budget: z.object({
      planned: z.number().describe("Planned contributions"),
      received: z.number().describe("Money that came in"),
      allocated: z.number().describe("Sum of spending lines"),
      savingsPlanned: z.number().describe("Sum of savings lines"),
      saved: z.number().describe("What actually went into those savings accounts"),
      unallocated: z.number().describe("Planned contributions − spending lines − savings lines; negative = more planned than comes in"),
      spentBudgeted: z.number(),
      spentTotal: z.number().describe("All money out except transfers and card payments"),
      overspend: z.number(),
      lines: z.array(
        z.object({
          seriesId: z.string(),
          name: z.string(),
          categories: z.array(z.string()),
          budgeted: z.number(),
          spent: z.number(),
          remaining: z.number(),
          scheduled: z.number().describe("Part of the line already committed by scheduled transactions"),
          status: z.enum(["under", "on", "over"]).describe("Pace vs the elapsed part of the month"),
          period: z.string().describe("How often the line repeats: MONTHLY, QUARTERLY, ANNUALLY, ONCE"),
        }),
      ),
      unbudgeted: z.array(z.object({ category: z.string(), spent: z.number() })),
      elapsed: z.number().describe("Fraction of the month gone, 0..1"),
    }),
    upcoming: z.array(z.object({ date: z.string(), description: z.string(), amount: z.number(), account: z.string() })),
    lowPoint: z.object({ account: z.string(), date: z.string(), balance: z.number(), belowBuffer: z.boolean() }).nullable(),
    goals: z.array(
      z.object({ id: z.string(), name: z.string(), current: z.number(), target: z.number(), pct: z.number(), targetDate: z.string().nullable(), monthlyNeeded: z.number().nullable(), fundedBy: z.array(z.string()).describe("Accounts whose balance counts; empty = tracked by hand"), milestones: z.array(MilestoneOut) }),
    ),
    uncategorizedCount: z.number(),
    lastSync: z
      .object({ status: z.string().nullable(), at: z.string().nullable(), txInserted: z.number().nullable() })
      .nullable()
      .describe("The latest SimpleFIN sync run"),
  }),
  async run(ctx, input) {
    const today = todayIso();
    const window = monthRange(input.month ? `${input.month}-01` : today);
    const [accounts, lines, schedules, goals, folks, milestones, lastSync] = await Promise.all([
      listAccounts(ctx.client),
      listBudgetLines(ctx.client),
      listSchedules(ctx.client),
      listGoals(ctx.client),
      people(ctx),
      listGoalMilestones(ctx.client),
      latestSync(ctx),
    ]);
    const ledger = (await ledgerRef(ctx, input.ledger, { allowAll: true })) ?? HOUSEHOLD;
    const mine = (a: (typeof accounts)[number]) => ledger === ALL_LEDGERS || accountLedger(a) === ledger;
    const active = accounts.filter((a) => a.active !== false && mine(a));
    const txs = await listTransactions(ctx.client, { ...window, accountIds: householdAccounts(accounts).map((a) => a.id) });
    const view =
      ledger === ALL_LEDGERS
        ? allLedgersBudget(ledgerPeople(folks as any[]).map((p) => p.id), lines, txs, schedules, accounts, window, today)
        : ledgerBudget(ledger, lines, txs, schedules, accounts, window, today);

    // Next 14 days of scheduled money movement on cash accounts.
    const horizon = addDays(today, 14);
    const upcoming: Array<{ date: string; description: string; amount: number; account: string }> = [];
    let lowPoint: { account: string; date: string; balance: number; belowBuffer: boolean } | null = null;
    const lowByAccount = new Map<string, { date: string; balance: number }>();
    for (const a of active.filter((x) => x.type === "CHECKING" || x.type === "SAVINGS" || x.type === "CASH")) {
      const events = upcomingEvents(a.id, schedules, today, horizon);
      upcoming.push(...events.map((e) => ({ date: e.date, description: e.description, amount: r2(e.amount), account: a.name })));
      const lo = lowestPoint(projectBalance(a.currentBalance ?? 0, events));
      if (lo) lowByAccount.set(a.id, { date: lo.date, balance: r2(lo.balance) });
      if (lo && (!lowPoint || lo.balance < lowPoint.balance)) {
        lowPoint = { account: a.name, date: lo.date, balance: r2(lo.balance), belowBuffer: lo.balance < (a.minBalance ?? 0) };
      }
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date));

    return {
      month: window.label,
      ledger,
      ledgerName: ledgerLabel(ledger, folks),
      ledgers: [HOUSEHOLD, ...ledgerPeople(folks as any[]).map((p) => p.id), ALL_LEDGERS].map((key) => ({ key, name: ledgerLabel(key, folks) })),
      accounts: active.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type ?? null,
        ledger: accountLedger(a),
        balance: r2(a.currentBalance ?? 0),
        updatedAt: a.balanceUpdatedAt ?? null,
        institution: a.institution ?? null,
        minBalance: a.minBalance ?? null,
        invested: isInvested(a.type),
        lowPoint: lowByAccount.get(a.id) ?? null,
      })),
      contributions: view.incomeViews.map((v) => ({ name: v.line.name, person: nameOf(folks, v.line.personId) ?? null, period: v.line.period ?? "MONTHLY", planned: r2(v.budgeted), received: r2(v.spent) })),
      savings: view.savingsViews.map((v) => ({ name: v.line.name, account: accounts.find((a) => a.id === v.line.accountId)?.name ?? null, planned: r2(v.budgeted), saved: r2(v.spent) })),
      budget: {
        planned: r2(view.planned),
        received: r2(view.received),
        allocated: r2(view.allocated),
        savingsPlanned: r2(view.savingsPlanned),
        saved: r2(view.saved),
        unallocated: r2(view.unallocated),
        spentBudgeted: r2(view.spentBudgeted),
        spentTotal: r2(view.spentTotal),
        overspend: r2(view.overspend),
        lines: view.expenseViews.map((v) => ({
          seriesId: v.line.seriesId,
          name: v.line.name,
          categories: bucketCategories(v.line),
          budgeted: r2(v.budgeted),
          spent: r2(v.spent),
          remaining: r2(v.remaining),
          scheduled: r2(v.committed),
          status: v.status,
          period: v.line.period ?? "MONTHLY",
        })),
        unbudgeted: view.unassigned.map((u) => ({ category: u.category, spent: r2(u.spent) })),
        elapsed: Math.round((view.expenseViews[0]?.elapsed ?? view.incomeViews[0]?.elapsed ?? 0) * 1000) / 1000,
      },
      upcoming,
      lowPoint,
      goals: goalProgress(goals, accounts, today)
        .filter((g) => g.goal.active !== false && fundedInLedger(goalAccountIds(g.goal), accounts, ledger))
        .map((g) => ({
          id: g.goal.id,
          name: g.goal.name,
          current: r2(g.current),
          target: r2(g.target),
          pct: Math.round(g.pct * 100) / 100,
          targetDate: g.goal.targetDate ?? null,
          monthlyNeeded: g.monthlyNeeded == null ? null : r2(g.monthlyNeeded),
          fundedBy: g.funded === "account" ? goalAccountIds(g.goal).map((id) => accounts.find((a) => a.id === id)?.name ?? id) : [],
          milestones: milestoneOut(milestones.filter((m) => m.goalId === g.goal.id), g.current, today),
        })),
      uncategorizedCount: (ledger === ALL_LEDGERS ? txs : txsForLedger(txs, accounts, ledger)).filter((t) => effectiveCategory(t) === UNCATEGORIZED).length,
      lastSync,
    };
  },
});

/** The most recent sync log row, or null (none yet, or the model isn't readable here). */
async function latestSync(ctx: OpContext): Promise<{ status: string | null; at: string | null; txInserted: number | null } | null> {
  const model = ctx.client.models.homeFinanceSyncLog;
  if (!model) return null;
  try {
    const logs = await listAllPages<any>(model);
    const last = logs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];
    return last ? { status: last.status ?? null, at: last.finishedAt ?? last.startedAt ?? null, txInserted: last.txInserted ?? null } : null;
  } catch {
    return null;
  }
}

// ── get_finance_budget ────────────────────────────────────────────────────────

const PERIOD_PARAM = z
  .string()
  .refine((s) => periodFromParam(s) != null, "YYYY-MM, YYYY-Qn, YYYY or last3")
  .describe("YYYY-MM (a month), YYYY-Qn (a quarter), YYYY (a year) or last3 (the 3 months ending today). Default: this month.");

const PlanLineOut = z.object({
  seriesId: z.string(),
  id: z.string(),
  name: z.string(),
  period: z.string(),
  amount: z.number().describe("The line's amount per its own period (budgeted is scaled to the window)"),
  budgeted: z.number(),
  spent: z.number().describe("Contributions: what came in; savings: what landed in the account"),
});

export const getFinanceBudget = defineOp({
  name: "get_finance_budget",
  domain: "finance",
  access: "read",
  description:
    "The household budget for a month, quarter, year or the last 3 months: what each person planned to contribute vs what came in, each savings line vs what was saved, and each spending line's budgeted / spent / remaining / pace, plus spending no line covers and any problems in the budget's history. include picks lines by how often they repeat (default: a month shows monthly lines, a quarter adds quarterly ones, a year yearly ones; one-time lines show in the period their date falls in). Answers 'how's the budget this quarter?', 'which lines are over?', 'what did we spend that isn't budgeted?'. Use the seriesIds with save_finance_budget.",
  input: z.object({
    period: PERIOD_PARAM.optional(),
    include: z.array(z.enum(BUDGET_PERIODS)).optional().describe("Line cadences to show; default depends on the period (see description)."),
    ledger: LEDGER_PARAM.optional(),
  }),
  output: z.object({
    period: z.string().describe("The period as a param (2026-11, 2026-Q4, 2026, last3)"),
    label: z.string(),
    ledger: z.string().describe("household, all, or the person's id"),
    ledgerName: z.string(),
    ledgers: z.array(z.object({ key: z.string(), name: z.string() })).describe("Every budget there is to look at: household, each person's own, all"),
    toHousehold: z.object({ planned: z.number(), sent: z.number() }).nullable().describe("Personal ledger: what this person planned to put into the household and what it counts as received (transfers + paid directly)"),
    paidDirectly: z.array(z.object({ personId: z.string(), person: z.string().nullable(), amount: z.number() })).describe("Household ledger: per person, household spending they paid from their own accounts (minus their personal spending from joint money); already in their contribution"),
    fromIso: z.string(),
    toIso: z.string(),
    include: z.array(z.string()),
    elapsed: z.number().describe("Fraction of the period gone, 0..1"),
    planned: z.number(),
    received: z.number(),
    allocated: z.number(),
    savingsPlanned: z.number(),
    saved: z.number(),
    unallocated: z.number().describe("Planned contributions − spending lines − savings lines"),
    spentBudgeted: z.number(),
    spentTotal: z.number(),
    overspend: z.number(),
    contributions: z.array(PlanLineOut.extend({ personId: z.string().nullable(), person: z.string().nullable() })),
    savings: z.array(PlanLineOut.extend({ accountId: z.string().nullable(), account: z.string().nullable() })),
    lines: z.array(
      z.object({
        seriesId: z.string(),
        id: z.string(),
        name: z.string(),
        ledger: z.string().describe("household or a person id"),
        categories: z.array(z.string()),
        period: z.string(),
        amount: z.number().describe("Per the line's own period"),
        budgeted: z.number(),
        spent: z.number(),
        remaining: z.number(),
        scheduled: z.number(),
        status: z.enum(["under", "on", "over"]),
        pace: z.number().nullable().describe("Spent ÷ what the budget expects by today; 1 = on pace"),
        share: z.number().nullable().describe("This line's budget as a fraction of all spending lines"),
      }),
    ),
    spans: z
      .array(
        z.object({
          seriesId: z.string(),
          id: z.string(),
          name: z.string(),
          ledger: z.string(),
          categories: z.array(z.string()),
          from: z.string(),
          to: z.string(),
          amount: z.number().describe("The whole budget for those dates"),
          spent: z.number().describe("Spent in its categories (and their sub-categories) from `from` up to today"),
          remaining: z.number(),
          status: z.enum(["under", "over"]),
        }),
      )
      .describe("One-off spending lines for a stretch of dates (baby prep until the birth) that overlap the period: each against everything spent over its own dates, no pacing; not in the period's totals"),
    unbudgeted: z.array(z.object({ category: z.string(), spent: z.number() })),
    issues: z.array(z.object({ name: z.string(), detail: z.string() })),
  }),
  async run(ctx, input) {
    const today = todayIso();
    const period = periodFromParam(input.period) ?? periodContaining("month", today);
    const range = periodRange(period, today);
    const include = input.include?.length ? new Set<string>(input.include) : defaultCadences(period.kind);
    const ledger = (await ledgerRef(ctx, input.ledger, { allowAll: true })) ?? HOUSEHOLD;
    const [accounts, lines, schedules, folks] = await Promise.all([listAccounts(ctx.client), listBudgetLines(ctx.client), listSchedules(ctx.client), people(ctx)]);
    const txs = await listTransactions(ctx.client, { ...budgetTxRange(lines, range), accountIds: householdAccounts(accounts).map((a) => a.id) });
    const full =
      ledger === ALL_LEDGERS
        ? allLedgersBudget(ledgerPeople(folks as any[]).map((p) => p.id), lines, txs, schedules, accounts, range, today)
        : ledgerBudget(ledger, lines, txs, schedules, accounts, range, today);
    const view = { ...full, ...filterBudgetView(full, include) };
    const plan = (v: (typeof view.incomeViews)[number]) => ({
      seriesId: v.line.seriesId,
      id: v.line.id,
      name: v.line.name,
      period: v.line.period ?? "MONTHLY",
      amount: r2(v.line.amount ?? 0),
      budgeted: r2(v.budgeted),
      spent: r2(v.spent),
    });
    const elapsed = view.expenseViews[0]?.elapsed ?? view.incomeViews[0]?.elapsed ?? view.savingsViews[0]?.elapsed ?? 0;
    return {
      period: periodToParam(period),
      label: range.label,
      fromIso: range.fromIso,
      toIso: range.toIso,
      ledger,
      ledgerName: ledgerLabel(ledger, folks),
      ledgers: [HOUSEHOLD, ...ledgerPeople(folks as any[]).map((p) => p.id), ALL_LEDGERS].map((key) => ({ key, name: ledgerLabel(key, folks) })),
      toHousehold: view.toHousehold ? { planned: r2(view.toHousehold.planned), sent: r2(view.toHousehold.sent) } : null,
      paidDirectly: [...view.paidDirectly].filter(([, n]) => Math.abs(n) >= 0.005).map(([personId, amount]) => ({ personId, person: nameOf(folks, personId), amount: r2(amount) })),
      include: BUDGET_PERIODS.filter((p) => include.has(p)),
      elapsed: Math.round(elapsed * 1000) / 1000,
      planned: r2(view.planned),
      received: r2(view.received),
      allocated: r2(view.allocated),
      savingsPlanned: r2(view.savingsPlanned),
      saved: r2(view.saved),
      unallocated: r2(view.unallocated),
      spentBudgeted: r2(view.spentBudgeted),
      spentTotal: r2(view.spentTotal),
      overspend: r2(view.overspend),
      contributions: view.incomeViews.map((v) => ({ ...plan(v), personId: v.line.personId ?? null, person: nameOf(folks, v.line.personId) })),
      savings: view.savingsViews.map((v) => ({ ...plan(v), accountId: v.line.accountId ?? null, account: accounts.find((a) => a.id === v.line.accountId)?.name ?? null })),
      lines: view.expenseViews.map((v) => ({
        seriesId: v.line.seriesId,
        id: v.line.id,
        name: v.line.name,
        ledger: v.line.ledger?.trim() || HOUSEHOLD,
        categories: bucketCategories(v.line),
        period: v.line.period ?? "MONTHLY",
        amount: r2(v.line.amount ?? 0),
        budgeted: r2(v.budgeted),
        spent: r2(v.spent),
        remaining: r2(v.remaining),
        scheduled: r2(v.committed),
        status: v.status,
        pace: v.pace == null ? null : Math.round(v.pace * 100) / 100,
        share: view.allocated > 0 ? Math.round((v.budgeted / view.allocated) * 1000) / 1000 : null,
      })),
      spans: view.spanViews.map((v) => ({
        seriesId: v.line.seriesId,
        id: v.line.id,
        name: v.line.name,
        ledger: v.line.ledger?.trim() || HOUSEHOLD,
        categories: bucketCategories(v.line),
        from: v.line.effectiveFrom ?? "",
        to: v.line.effectiveTo ?? "",
        amount: r2(v.budgeted),
        spent: r2(v.spent),
        remaining: r2(v.remaining),
        status: v.status === "over" ? ("over" as const) : ("under" as const),
      })),
      unbudgeted: view.unassigned.map((u) => ({ category: u.category, spent: r2(u.spent) })),
      issues: view.issues.map((i) => ({ name: i.name, detail: i.detail })),
    };
  },
});

// ── list_finance_transactions ─────────────────────────────────────────────────

const LineItemSchema = z.object({
  name: z.string().nullable().optional(),
  amount: z.number().positive().describe("The item's cost (positive); items are scaled to the charge, so tax and shipping needn't be spread by hand"),
  category: z.string().min(1),
  quantity: z.number().nullable().optional(),
  ledger: z.string().nullable().optional().describe('Whose budget this item counts in when not the charge\'s: "household" or a person\'s name or id (groceries for the house on a personal card)'),
});

const TxOut = z.object({
  id: z.string(),
  date: z.string(),
  description: z.string().nullable(),
  amount: z.number().describe("Positive = money in, negative = money out"),
  category: z.string(),
  categorySource: z.string().nullable().describe("RULE, LLM (guessed) or MANUAL"),
  person: z.string().nullable().describe("Money in: who contributed it"),
  personId: z.string().nullable(),
  account: z.string().nullable(),
  accountId: z.string(),
  status: z.string().nullable(),
  spendGroupId: z.string().nullable(),
  goalId: z.string().nullable(),
  recurringId: z.string().nullable(),
  notes: z.string().nullable(),
  items: z.array(LineItemSchema).nullable().describe("Itemization, when the charge is split across categories"),
  ledger: z.string().describe("Whose budget it counts in: household or a person id (an itemized charge: its own, items may differ)"),
  ledgerName: z.string(),
  ledgerSet: z.boolean().describe("true when set on the transaction; false = the account's default"),
});

export const listFinanceTransactions = defineOp({
  name: "list_finance_transactions",
  domain: "finance",
  access: "read",
  description:
    "Search the household account transactions, newest first. Default: the last 30 days, every account except 401k / IRA / brokerage ones (pass that accountId to see theirs). Filter by words in the description or notes, categories, contributors, accounts, budget (ledger), direction or spend group, or only uncategorized ones; sort by date, size or description. Returns the matching count and their total. Answers 'what did we spend at Costco this month?', 'show the uncategorized transactions', 'when did the mortgage go out?'. Use it to get a transactionId for update_finance_transaction.",
  input: z.object({
    from: DATE.optional(),
    to: DATE.optional(),
    query: z.string().optional().describe("Words that must all appear in the description, notes, categories or itemized item names."),
    category: z.string().optional(),
    categories: z.array(z.string()).optional().describe("Any of these categories (a budget line's categories)."),
    uncategorized: z.boolean().optional(),
    personId: z.string().optional().describe("Contributor: money in from this person."),
    personName: z.string().optional(),
    personIds: z.array(z.string()).optional().describe("Contributors: money in from any of these people."),
    accountId: z.string().optional(),
    accountIds: z.array(z.string()).optional().describe("Any of these accounts (an invested account's rows only when it's listed)."),
    spendGroupId: z.string().optional(),
    direction: z.enum(["in", "out"]).optional(),
    ledger: z.string().optional().describe('Only what counts in this budget: "household" or a person\'s name or id (an itemized charge matches when any item does).'),
    sort: z
      .enum(TX_SORTS)
      .optional()
      .describe("Default newest. largest / smallest go by size, money in or out; description is A–Z."),
    limit: z.number().int().min(1).max(500).optional().describe("Default 50."),
  }),
  output: z.object({ count: z.number(), total: z.number(), transactions: z.array(TxOut) }),
  async run(ctx, input) {
    const today = todayIso();
    const fromIso = input.from ?? addDays(today, -30);
    const toIso = input.to ?? today;
    const personId = await personRef(ctx, input);
    const wantLedger = await ledgerRef(ctx, input.ledger);
    const [accounts, folks, ruleRows] = await Promise.all([listAccounts(ctx.client), people(ctx), listCategoryRules(ctx.client)]);
    const rules = rulesFromDbRows(ruleRows);
    const accName = new Map(accounts.map((a) => [a.id, a.name]));
    const accLedger = new Map(accounts.map((a) => [a.id, accountLedger(a)]));
    const pickedAccounts = [...(input.accountId ? [input.accountId] : []), ...(input.accountIds ?? [])];
    const txs = await listTransactions(ctx.client, {
      fromIso,
      toIso,
      accountIds: pickedAccounts.length ? [...new Set(pickedAccounts)] : accounts.filter((a) => !isOutsideCashFlow(a.type)).map((a) => a.id),
    });
    // Same rules as the web Transactions page (lib/finance/tx-filter.ts).
    const matched = sortTransactions(
      filterTransactions(
        txs,
        {
          query: input.query,
          categories: [...(input.category ? [input.category] : []), ...(input.categories ?? [])],
          uncategorized: input.uncategorized,
          personIds: [...(personId ? [personId] : []), ...(input.personIds ?? [])],
          spendGroupId: input.spendGroupId,
          direction: input.direction,
          ledger: wantLedger ?? undefined,
        },
        { rules, accountLedger: (id) => accLedger.get(id) ?? HOUSEHOLD },
      ),
      input.sort,
    );
    return {
      count: matched.length,
      total: r2(matched.reduce((s, t) => s + (t.amount ?? 0), 0)),
      transactions: matched.slice(0, input.limit ?? 50).map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description ?? null,
        amount: t.amount,
        category: effectiveCategory(t, rules),
        categorySource: t.categorySource ?? null,
        person: nameOf(folks, t.personId),
        personId: t.personId ?? null,
        account: accName.get(t.accountId) ?? null,
        accountId: t.accountId,
        status: t.status ?? null,
        spendGroupId: t.spendGroupId ?? null,
        goalId: t.goalId ?? null,
        recurringId: t.recurringId ?? null,
        notes: t.notes ?? null,
        items: parseLineItems(t),
        ledger: ledgerOf(t, accLedger.get(t.accountId) ?? HOUSEHOLD),
        ledgerName: ledgerLabel(ledgerOf(t, accLedger.get(t.accountId) ?? HOUSEHOLD), folks),
        ledgerSet: !!t.ledger,
      })),
    };
  },
});

// ── update_finance_transaction ────────────────────────────────────────────────

export const updateFinanceTransaction = defineOp({
  name: "update_finance_transaction",
  domain: "finance",
  access: "write",
  description:
    "Change a transaction's category, ledger (whose budget it counts in: household or a person), contributor (money in only), spend group, goal, notes or itemization (only what's given; null clears). lineItems splits one charge across categories (an Amazon order with diapers and a patio cover): its spending then counts per item category instead of the charge's. A category set here is MANUAL and never overwritten by the sync. Pass rememberPattern (a word or phrase from the description, e.g. 'BLUE BOTTLE') to also add a rule so future transactions like it get the same category and person automatically. Find the transactionId with list_finance_transactions.",
  input: z.object({
    transactionId: z.string(),
    category: z.string().nullable().optional(),
    personId: z.string().nullable().optional().describe("Money in only: who contributed it (a contribution from an account not linked here). Spending has no person: use ledger for whose budget it counts in."),
    personName: z.string().nullable().optional(),
    spendGroupId: z.string().nullable().optional(),
    goalId: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    lineItems: z.array(LineItemSchema).nullable().optional().describe("The full itemization (replaces any existing); null or [] removes it."),
    ledger: z
      .string()
      .nullable()
      .optional()
      .describe('Whose budget the whole charge counts in: "household" or a person\'s name or id; null = the account\'s default (joint accounts → household, a personal account → its owner). For a mixed purchase, itemize and set ledger per item instead.'),
    rememberPattern: z.string().optional().describe("Substring or /regex/flags; creates a rule at the top of the rule list."),
  }),
  output: z.object({
    transactionId: z.string(),
    category: z.string(),
    personId: z.string().nullable(),
    ruleCreated: z.boolean(),
    newCategories: z.array(z.string()).describe("Categories this save created (now offered by list_finance_categories)"),
  }),
  async run(ctx, input) {
    const { data: tx } = await ctx.client.models.homeFinanceTransaction.get({ id: input.transactionId });
    if (!tx) throw new OpError(`No transaction ${input.transactionId}. Use list_finance_transactions to find the id.`);
    const personId = await personRef(ctx, input);
    if (personId && (tx.amount ?? 0) < 0)
      throw new OpError("A person is only set on money in (who contributed it). For spending, set ledger: whose budget it counts in (household or a person).");
    const patch: Record<string, unknown> = {};
    if (input.category !== undefined) {
      const cat = input.category?.trim() || null;
      patch.category = cat;
      patch.categorySource = cat ? "MANUAL" : null;
    }
    if (personId !== undefined) {
      patch.personId = personId;
      patch.personSource = personId ? "MANUAL" : null;
    }
    if (input.spendGroupId) {
      const { data: group } = await ctx.client.models.homeFinanceSpendGroup.get({ id: input.spendGroupId });
      if (!group) throw new OpError(`No spend group ${input.spendGroupId}. Use list_finance_spend_groups, or save_finance_spend_group to create one.`);
      patch.outOfBudget = group.keepOutOfBudget === true ? true : null;
    }
    if (input.spendGroupId !== undefined) patch.spendGroupId = input.spendGroupId;
    if (input.spendGroupId === null) patch.outOfBudget = null;
    if (input.goalId !== undefined) patch.goalId = input.goalId;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.ledger !== undefined) patch.ledger = await ledgerRef(ctx, input.ledger);
    if (input.lineItems !== undefined) {
      const items = [];
      for (const i of input.lineItems ?? []) {
        const ledger = await ledgerRef(ctx, i.ledger ?? undefined);
        items.push({ name: i.name?.trim() || null, amount: r2(i.amount), category: i.category.trim(), ...(i.quantity != null ? { quantity: i.quantity } : {}), ...(ledger ? { ledger } : {}) });
      }
      patch.lineItems = items.length ? JSON.stringify(items) : null;
    }
    if (!Object.keys(patch).length && !input.rememberPattern) throw new OpError("Nothing to change");

    let saved = tx;
    if (Object.keys(patch).length) {
      const r = await ctx.client.models.homeFinanceTransaction.update({ id: tx.id, ...patch });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      saved = r.data;
    }

    let ruleCreated = false;
    const pattern = input.rememberPattern?.trim();
    if (pattern) {
      const category = (patch.category as string | null | undefined) ?? saved.category ?? null;
      const rulePerson = (patch.personId as string | null | undefined) ?? null;
      if (!category && !rulePerson) throw new OpError("A rule needs a category or a person");
      const haystack = saved.description ?? "";
      if (!patternMatches(pattern, haystack)) throw new OpError(`"${pattern}" doesn't match this transaction's description ("${haystack}")`);
      const rows = await listCategoryRules(ctx.client);
      // The table starts empty (bundled rules apply); seed it so the new
      // rule sits on top of everything that was in force before.
      if (rows.length === 0) await seedRules(ctx);
      const top = Math.min(0, ...(await listCategoryRules(ctx.client)).map((r) => r.sortOrder ?? 0)) - 10;
      const r = await ctx.client.models.homeFinanceCategoryRule.create({ pattern, category, personId: rulePerson, sortOrder: top, active: true });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      ruleCreated = true;
    }
    // A category typed in for the first time joins the pickers' list
    // (lib/finance/category-list.ts). Best effort: the row is already saved.
    let newCategories: string[] = [];
    const used = [patch.category as string | null | undefined, ...(input.lineItems ?? []).map((i) => i.category)];
    if (used.some(Boolean)) {
      try {
        newCategories = await rememberCategories(ctx.client, used);
      } catch (e) {
        console.error("[finance] remembering new categories failed", e);
      }
    }
    return { transactionId: saved.id, category: effectiveCategory(saved), personId: saved.personId ?? null, ruleCreated, newCategories };
  },
});

/** Copy the bundled rules into the table (spaced sortOrders so new rules fit between). */
export async function seedRules(ctx: OpContext): Promise<number> {
  let i = 0;
  for (const r of CATEGORY_RULES) {
    const res = await ctx.client.models.homeFinanceCategoryRule.create({ pattern: r.pattern, category: r.category, sortOrder: (i += 100), active: true });
    if (res.errors?.length) throw new Error(res.errors[0].message);
  }
  return CATEGORY_RULES.length;
}

// ── save_finance_budget ───────────────────────────────────────────────────────

const BudgetOut = z.object({
  seriesId: z.string(),
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  person: z.string().nullable(),
  account: z.string().nullable().describe("SAVINGS: the account the money goes into"),
  categories: z.array(z.string()),
  amount: z.number(),
  period: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  ledger: z.string().describe("household or a person id"),
});

/** Runs a series plan in order; returns the row the first write produced. */
async function applySeriesWrites(ctx: { client: any }, writes: SeriesWrite[]): Promise<any> {
  let first: any = null;
  for (const [i, w] of writes.entries()) {
    const r = w.op === "insert" ? await ctx.client.models.homeFinanceBudget.create(w.row) : await ctx.client.models.homeFinanceBudget.update({ id: w.id, ...w.patch });
    if (r.errors?.length || !r.data) {
      const msg = r.errors?.[0]?.message ?? "Save failed";
      throw new Error(i === 0 ? msg : `Saved ${i} of ${writes.length} changes, then: ${msg}`);
    }
    if (i === 0) first = r.data;
  }
  return first;
}

export const saveFinanceBudget = defineOp({
  name: "save_finance_budget",
  domain: "finance",
  access: "write",
  description:
    "Create or change a household budget line. EXPENSE lines cap spending over a set of categories ('Groceries & dining $1,200/month' covering Groceries, Dining, Food Delivery); INCOME lines record what a person plans to contribute to the joint account each month; SAVINGS lines plan what moves into a savings account each month (accountId or accountName), measured by what actually lands there. A one-off EXPENSE line (period ONCE) with effectiveFrom and effectiveTo is one amount for those dates ('$3,000 on baby furniture until the birth'): tracked against everything spent between them, no monthly pacing (get_finance_budget's spans). Sub-categories are named 'Parent: Child' ('Baby: Furniture'); a line on the parent covers them, a line on the sub-category takes it over. Budgets are versioned: changing one (pass seriesId) sets it from effectiveFrom (default the 1st of this month) to effectiveTo (default: until the next existing version), trimming or splitting the versions around it, so other months keep the budget they had. A change with exactly a version's dates (or versionId alone) corrects it in place; removeVersionId deletes one. Pass endOn with seriesId to stop a budget. A category can only be in one spending line at a time. Use get_finance_summary to see the lines and their seriesIds.",
  input: z.object({
    seriesId: z.string().optional().describe("Budget to change; leave out to create one."),
    name: z.string().optional(),
    kind: z.enum(["INCOME", "SAVINGS", "EXPENSE"]).optional().describe("Default EXPENSE on create."),
    personId: z.string().optional().describe("INCOME: who contributes."),
    personName: z.string().optional(),
    accountId: z.string().optional().describe("SAVINGS: the account the money goes into."),
    accountName: z.string().optional(),
    categories: z.array(z.string()).optional().describe("EXPENSE: categories the line covers ('Baby' also covers 'Baby: Furniture'). A new sub-category is created just by naming it here."),
    amount: z.number().positive().optional(),
    period: z.enum(["MONTHLY", "QUARTERLY", "ANNUALLY", "ONCE"]).optional().describe("Default MONTHLY."),
    effectiveFrom: DATE.optional().describe("First day of the change. Default: the start of versionId, else the 1st of this month."),
    effectiveTo: DATE.nullable().optional().describe("Last day of the change. Leave out to run until the next existing version (later versions keep theirs); null = open-ended, replacing everything after."),
    versionId: z.string().optional().describe("A version (id from the series' versions) to change; with no dates it's corrected in place."),
    removeVersionId: z.string().optional().describe("Delete this version; the one before it takes its days back when they're adjacent."),
    endOn: DATE.optional().describe("Last day the budget applies; ends the series."),
    label: z.string().optional().describe("Why it changed, e.g. 'baby arrives'."),
    notes: z.string().optional(),
    ledger: z.string().optional().describe('Whose budget the line is in: "household" (default on create) or a person\'s name or id. A personal INCOME line is that person\'s own income (paychecks); household INCOME lines are what each person contributes.'),
  }),
  output: z.object({ action: z.enum(["created", "changed", "corrected", "ended", "removed"]), budget: BudgetOut }),
  async run(ctx, input) {
    const today = todayIso();
    const lines: BudgetLine[] = await listBudgetLines(ctx.client);
    const [folks, accounts] = await Promise.all([people(ctx), listAccounts(ctx.client)]);
    const out = (l: any) => ({
      seriesId: l.seriesId,
      id: l.id,
      name: l.name,
      kind: l.kind ?? "EXPENSE",
      person: nameOf(folks, l.personId),
      account: accounts.find((a) => a.id === l.accountId)?.name ?? null,
      categories: bucketCategories(l),
      amount: l.amount,
      period: l.period ?? "MONTHLY",
      effectiveFrom: l.effectiveFrom,
      effectiveTo: l.effectiveTo ?? null,
      ledger: l.ledger?.trim() || HOUSEHOLD,
    });

    const series = input.seriesId ? lines.filter((l) => l.seriesId === input.seriesId && l.active !== false) : [];
    if (input.seriesId && !series.length) throw new OpError(`No budget ${input.seriesId}`);
    const latest = [...series].sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""))[0] ?? null;

    if (input.endOn) {
      if (!latest) throw new OpError("endOn needs the seriesId of the budget to end");
      const endOn = input.endOn;
      // Versions staged to start after the end never apply: switch them off.
      for (const v of series.filter((l) => (l.effectiveFrom ?? "") > endOn)) {
        const r = await ctx.client.models.homeFinanceBudget.update({ id: v.id, active: false });
        if (r.errors?.length) throw new Error(r.errors[0].message);
      }
      const inForce = series
        .filter((l) => (l.effectiveFrom ?? "") <= endOn)
        .sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""))[0];
      if (!inForce) return { action: "ended" as const, budget: out({ ...latest, active: false }) };
      const r = await ctx.client.models.homeFinanceBudget.update({ id: inForce.id, effectiveTo: endOn });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      return { action: "ended" as const, budget: out(r.data) };
    }

    if (input.removeVersionId) {
      if (!series.some((v) => v.id === input.removeVersionId)) throw new OpError(`No version ${input.removeVersionId} in budget ${input.seriesId ?? "(pass seriesId)"}`);
      const removed = series.find((v) => v.id === input.removeVersionId)!;
      await applySeriesWrites(ctx, planRemoveVersion(series, input.removeVersionId));
      return { action: "removed" as const, budget: out({ ...removed, active: false }) };
    }

    const version = input.versionId ? series.find((v) => v.id === input.versionId) : undefined;
    if (input.versionId && !version) throw new OpError(`No version ${input.versionId} in budget ${input.seriesId ?? "(pass seriesId)"}`);
    const effectiveFrom =
      input.effectiveFrom ?? version?.effectiveFrom ?? (latest && latest.effectiveFrom! > monthStart(today) ? latest.effectiveFrom! : monthStart(today));
    const effectiveTo = input.effectiveTo !== undefined ? input.effectiveTo : defaultChangeEnd(series, effectiveFrom);
    if (effectiveTo != null && effectiveTo < effectiveFrom) throw new OpError(`effectiveTo ${effectiveTo} is before effectiveFrom ${effectiveFrom}`);
    // Values not given come from the version being changed: the one named, else the one in force on effectiveFrom, else the latest.
    const base = version ?? resolveBudgetLines(series, effectiveFrom)[0] ?? latest;

    const personId = await personRef(ctx, input);
    const ledgerIn = await ledgerRef(ctx, input.ledger);
    const ledger = ledgerIn ?? (base?.ledger?.trim() || HOUSEHOLD);
    const sameLedger = (l: BudgetLine) => (l.ledger?.trim() || HOUSEHOLD) === ledger;
    const kind = input.kind ?? (base ? budgetKind(base) : "EXPENSE");
    const name = input.name?.trim() || base?.name;
    const amount = input.amount ?? base?.amount;
    const categories = (input.categories ?? (base ? bucketCategories(base) : [])).map((c) => c.trim()).filter(Boolean);
    if (!name) throw new OpError("name is required");
    if (amount == null) throw new OpError("amount is required");
    if (kind === "EXPENSE" && !categories.length) throw new OpError("A spending line needs at least one category");
    // A personal income line is the owner's own income.
    const contributor = personId === undefined ? base?.personId ?? (ledger !== HOUSEHOLD ? ledger : null) : personId;
    if (kind === "INCOME" && !contributor) throw new OpError("An income line needs the person who contributes (personId or personName)");
    let savingsAccount: string | null = base?.accountId ?? null;
    if (input.accountId || input.accountName) {
      const want = input.accountName?.trim().toLowerCase();
      const acc = accounts.find((a) => (input.accountId ? a.id === input.accountId : a.name.toLowerCase() === want));
      if (!acc) throw new OpError(`No account ${input.accountId ?? input.accountName}. Accounts: ${accounts.map((a) => a.name).join(", ") || "none"}`);
      // Inside an invested account, fund buys and dividends would move "saved" around; goals track these.
      if (isInvested(acc.type)) throw new OpError(`${acc.name} is an investment account, which a savings line can't track (fund buys and dividends would count). Point a goal at it instead.`);
      savingsAccount = acc.id;
    }
    if (kind === "SAVINGS" && !savingsAccount) throw new OpError("A savings line needs the account the money goes into (accountId or accountName)");

    // A category may sit in only one spending line at a time: check every
    // date in the range where another line's version starts.
    if (kind === "EXPENSE") {
      const checkDates = [
        effectiveFrom,
        ...lines.map((l) => l.effectiveFrom ?? "").filter((d) => d > effectiveFrom && (effectiveTo == null || d <= effectiveTo)),
      ];
      for (const d of [...new Set(checkDates)]) {
        // Only within the same ledger: Groceries can be in the household's budget and in someone's own.
        const others = resolveBudgetLines(lines, d).filter((l) => l.seriesId !== input.seriesId && budgetKind(l) === "EXPENSE" && sameLedger(l));
        for (const c of categories) {
          const clash = others.find((l) => bucketCategories(l).some((x) => x.toLowerCase() === c.toLowerCase()));
          if (clash) throw new OpError(`"${c}" is already in "${clash.name}" on ${d}. Remove it there first (save_finance_budget with that seriesId and categories), or pick another category.`);
        }
      }
    }

    const sameRange = base && base.effectiveFrom === effectiveFrom && (base.effectiveTo ?? null) === effectiveTo;
    const next = {
      seriesId: input.seriesId ?? crypto.randomUUID(),
      name,
      kind,
      personId: kind === "INCOME" ? contributor : null,
      accountId: kind === "SAVINGS" ? savingsAccount : null,
      categories: kind === "EXPENSE" ? categories : [],
      amount,
      period: input.period ?? base?.period ?? "MONTHLY",
      rollover: base?.rollover ?? false,
      label: input.label ?? (sameRange ? base?.label ?? null : null),
      notes: input.notes ?? base?.notes ?? null,
      ledger: ledger === HOUSEHOLD ? null : ledger,
    };

    const writes = planSeriesChange(series, next, effectiveFrom, effectiveTo);
    const first = await applySeriesWrites(ctx, writes);
    const corrected = writes.length === 1 && writes[0].op === "update";
    return { action: corrected ? ("corrected" as const) : latest ? ("changed" as const) : ("created" as const), budget: out(first) };
  },
});

// ── save_finance_schedule ─────────────────────────────────────────────────────

const ScheduleOut = z.object({
  id: z.string(),
  description: z.string(),
  amount: z.number(),
  type: z.string().nullable(),
  cadence: z.string().nullable(),
  nextDate: z.string().nullable(),
  category: z.string().nullable(),
  account: z.string().nullable(),
  person: z.string().nullable(),
  active: z.boolean(),
  autopay: z.boolean(),
  accountId: z.string(),
  toAccountId: z.string().nullable(),
  personId: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  lastDayOfMonth: z.boolean().describe("Due on the last day of each month"),
  matchPattern: z.string().nullable(),
  ledger: z.string().describe("Whose budget it counts in: household or a person id (its own, else its account's)"),
  ledgerName: z.string(),
  url: z.string().nullable(),
  notes: z.string().nullable(),
});

function scheduleOut(r: any, accounts: any[], folks: Person[]): z.input<typeof ScheduleOut> {
  return {
    id: r.id,
    description: r.description,
    amount: r.amount,
    type: r.type ?? null,
    cadence: r.cadence ?? null,
    nextDate: r.nextDate ?? null,
    category: r.category ?? null,
    account: accounts.find((a) => a.id === r.accountId)?.name ?? null,
    person: nameOf(folks, r.personId),
    active: r.active !== false,
    autopay: r.autopay !== false,
    accountId: r.accountId,
    toAccountId: r.toAccountId ?? null,
    personId: r.personId ?? null,
    startDate: r.startDate ?? null,
    endDate: r.endDate ?? null,
    lastDayOfMonth: !!r.lastDayOfMonth,
    matchPattern: r.matchPattern ?? null,
    ledger: scheduleLedger(r, (id) => {
      const a = accounts.find((x) => x.id === id);
      return a ? accountLedger(a) : undefined;
    }),
    ledgerName: ledgerLabel(
      scheduleLedger(r, (id) => {
        const a = accounts.find((x) => x.id === id);
        return a ? accountLedger(a) : undefined;
      }),
      folks,
    ),
    url: r.url ?? null,
    notes: r.notes ?? null,
  };
}

export const saveFinanceSchedule = defineOp({
  name: "save_finance_schedule",
  domain: "finance",
  access: "write",
  description:
    "Create or change a scheduled transaction on a household account: the mortgage, car payment, a utility, insurance, or a person's regular contribution into the joint account. Amount is the usual amount (sign is set from type: EXPENSE out, INCOME in). nextDate is the next time it's due; cadence how often; monthly-ish ones recur on nextDate's day of the month, or on each month's last day with lastDayOfMonth (nextDate is moved to that month's end). matchPattern (a word from the bank description, e.g. 'ROCKET MORTGAGE') lets the sync link posted transactions and roll nextDate forward. autopay false means someone has to pay it by hand. Set active false to stop one. Without accountId it goes on the household's checking account. With recurringId, only the fields given change; markPaid with recurringId records it as paid by hand: nextDate moves one step on (a one-time one is switched off).",
  input: z.object({
    recurringId: z.string().optional(),
    description: z.string().optional(),
    amount: z.number().optional(),
    type: z.enum(["INCOME", "EXPENSE", "TRANSFER"]).optional().describe("Default EXPENSE."),
    cadence: z.enum(CADENCES).optional().describe("Default MONTHLY."),
    nextDate: DATE.optional(),
    endDate: DATE.nullable().optional(),
    lastDayOfMonth: z.boolean().optional().describe("Due on the last day of each month (monthly, quarterly, … cadences)."),
    category: z.string().nullable().optional(),
    accountId: z.string().optional(),
    toAccountId: z.string().nullable().optional().describe("TRANSFER destination."),
    personId: z.string().nullable().optional().describe("INCOME: the contributor."),
    personName: z.string().nullable().optional(),
    matchPattern: z.string().nullable().optional(),
    ledger: z.string().nullable().optional().describe('Whose budget it counts in when not its account\'s: "household" (a household bill on a personal card) or a person. null = the account\'s. Transactions the sync links to it get the same.'),
    autopay: z.boolean().optional(),
    active: z.boolean().optional(),
    url: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    markPaid: z.boolean().optional().describe("With recurringId: paid by hand, so roll nextDate one step (one-time: switch it off). Other fields are ignored."),
  }),
  output: z.object({ action: z.enum(["created", "updated"]), schedule: ScheduleOut }),
  async run(ctx, input) {
    const [accounts, folks] = await Promise.all([listAccounts(ctx.client), people(ctx)]);
    const out = (r: any) => scheduleOut(r, accounts, folks);
    if (input.markPaid) {
      if (!input.recurringId) throw new OpError("markPaid needs the recurringId");
      const { data: existing } = await ctx.client.models.homeFinanceRecurring.get({ id: input.recurringId });
      if (!existing) throw new OpError(`No scheduled transaction ${input.recurringId}`);
      const next = nextDueAfterPaid(existing);
      const r = await ctx.client.models.homeFinanceRecurring.update({ id: existing.id, ...(next ? { nextDate: next } : { active: false }) });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      return { action: "updated" as const, schedule: out(r.data) };
    }
    const personId = await personRef(ctx, input);
    const ledger = await ledgerRef(ctx, input.ledger);
    if (input.accountId && !accounts.some((a) => a.id === input.accountId)) throw new OpError(`No account ${input.accountId}`);
    const pick = (keys: Array<keyof typeof input>) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));

    if (input.recurringId) {
      const { data: existing } = await ctx.client.models.homeFinanceRecurring.get({ id: input.recurringId });
      if (!existing) throw new OpError(`No scheduled transaction ${input.recurringId}`);
      const type = input.type ?? existing.type ?? "EXPENSE";
      const patch: Record<string, unknown> = pick(["description", "cadence", "nextDate", "endDate", "lastDayOfMonth", "category", "accountId", "toAccountId", "matchPattern", "autopay", "active", "url", "notes"]);
      if (input.type) patch.type = type;
      if (input.amount !== undefined || input.type) patch.amount = normalizeAmountSign(input.amount ?? existing.amount, type);
      if (personId !== undefined) patch.personId = personId;
      if (ledger !== undefined) patch.ledger = ledger;
      // Last-day schedules keep their due date on a month's end.
      if (input.lastDayOfMonth ?? existing.lastDayOfMonth) {
        const due = (patch.nextDate as string | undefined) ?? existing.nextDate ?? existing.startDate;
        if (due) patch.nextDate = monthEnd(due);
      }
      if (!Object.keys(patch).length) throw new OpError("Nothing to change");
      const r = await ctx.client.models.homeFinanceRecurring.update({ id: existing.id, ...patch });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      return { action: "updated" as const, schedule: out(r.data) };
    }

    if (!input.description?.trim()) throw new OpError("description is required");
    if (input.amount == null) throw new OpError("amount is required");
    if (!input.nextDate) throw new OpError("nextDate is required (when it's next due)");
    const accountId =
      input.accountId ??
      accounts.find((a) => a.active !== false && a.type === "CHECKING" && !(a.ownerPersonIds ?? []).length)?.id ??
      accounts.find((a) => a.active !== false && a.type === "CHECKING")?.id;
    if (!accountId) throw new OpError("No household checking account yet; add one on the Finance page or pass accountId");
    const type = input.type ?? "EXPENSE";
    const nextDate = input.lastDayOfMonth ? monthEnd(input.nextDate) : input.nextDate;
    const r = await ctx.client.models.homeFinanceRecurring.create({
      ...pick(["endDate", "category", "toAccountId", "matchPattern", "url", "notes"]),
      accountId,
      description: input.description.trim(),
      amount: normalizeAmountSign(input.amount, type),
      type,
      cadence: input.cadence ?? "MONTHLY",
      startDate: nextDate,
      nextDate,
      lastDayOfMonth: input.lastDayOfMonth ?? false,
      personId: personId ?? null,
      ledger: ledger ?? null,
      autopay: input.autopay ?? true,
      active: input.active ?? true,
    });
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
    return { action: "created" as const, schedule: out(r.data) };
  },
});

// ── link_finance_schedules ────────────────────────────────────────────────────

/**
 * Saves planned schedule links: each row takes its schedule (and the
 * schedule's category unless set by hand, and its budget when the row can
 * take it), then each schedule moves on to the due date after its last
 * linked row. Shared by link_finance_schedules and the CSV import.
 */
async function applyScheduleLinks(ctx: OpContext, plan: ReturnType<typeof planScheduleLinks>, accounts: any[]): Promise<void> {
  for (const l of plan) {
    const tx = l.tx as any;
    const category = l.rule.category?.trim();
    const r = await ctx.client.models.homeFinanceTransaction.update({
      id: tx.id,
      recurringId: l.rule.id,
      ...(category && tx.categorySource !== "MANUAL" ? { category, categorySource: "RULE" } : {}),
      ...(l.rule.ledger?.trim() && canTakeScheduleLedger(tx, accountLedger(accounts.find((a) => a.id === tx.accountId))) ? { ledger: l.rule.ledger.trim() } : {}),
    });
    if (r.errors?.length) throw new Error(`${tx.date} ${tx.description}: ${r.errors[0].message}`);
  }
  const last = new Map<string, (typeof plan)[number]>();
  for (const l of plan) last.set(l.rule.id, l);
  for (const l of last.values()) {
    const current = l.rule.nextDate ?? "";
    const patch = l.rule.cadence === "ONCE" ? { active: false } : l.nextDate && l.nextDate > current ? { nextDate: l.nextDate } : null;
    if (!patch) continue;
    const r = await ctx.client.models.homeFinanceRecurring.update({ id: l.rule.id, ...patch });
    if (r.errors?.length) throw new Error(`${l.rule.description}: ${r.errors[0].message}`);
  }
}

export const linkFinanceSchedules = defineOp({
  name: "link_finance_schedules",
  domain: "finance",
  access: "write",
  description:
    "Link transactions already stored to their scheduled transactions, the way the sync does for new ones: for a schedule added after its payments came in, or after a backfill. Each posted, unlinked row in the dates takes its best-matching schedule (pattern, amount, due date); a linked row takes the schedule's category (unless set by hand) and, when the schedule has one, its budget; the schedule moves on to its next due date. dryRun shows what would be linked without saving. Answers 'did the bills this month come in?' together with list_finance_schedules.",
  input: z.object({
    from: DATE.describe("First transaction date to look at."),
    to: DATE.optional().describe("Default today."),
    recurringIds: z.array(z.string()).optional().describe("Only these schedules (default every active one)."),
    dryRun: z.boolean().optional(),
  }),
  output: z.object({
    linked: z.array(
      z.object({
        transactionId: z.string(),
        date: z.string(),
        description: z.string().nullable(),
        amount: z.number(),
        account: z.string().nullable(),
        recurringId: z.string(),
        schedule: z.string(),
        score: z.number(),
        reasons: z.array(z.string()),
        nextDate: z.string().nullable().describe("The schedule's next due date after this"),
      }),
    ),
    dryRun: z.boolean(),
  }),
  async run(ctx, input) {
    const toIso = input.to ?? todayIso();
    const [accounts, schedules] = await Promise.all([listAccounts(ctx.client), listSchedules(ctx.client)]);
    const rules = schedules.filter((r: any) => r.active !== false && (!input.recurringIds || input.recurringIds.includes(r.id)));
    const ids = [...new Set(rules.map((r: any) => r.accountId as string))];
    // Invested accounts' rows aren't household cash flow; the sync never links them either.
    const txs = ids.length ? await listTransactions(ctx.client, { fromIso: input.from, toIso, accountIds: ids }) : [];
    const plan = planScheduleLinks(
      txs.filter((t: any) => !isInvested(accounts.find((a) => a.id === t.accountId)?.type)),
      rules,
    );
    if (!input.dryRun) await applyScheduleLinks(ctx, plan, accounts);
    return {
      dryRun: !!input.dryRun,
      linked: plan.map((l) => ({
        transactionId: l.tx.id,
        date: l.tx.date ?? "",
        description: l.tx.description ?? null,
        amount: l.tx.amount ?? 0,
        account: accounts.find((a) => a.id === l.tx.accountId)?.name ?? null,
        recurringId: l.rule.id,
        schedule: l.rule.description ?? "",
        score: l.score,
        reasons: l.reasons,
        nextDate: l.nextDate,
      })),
    };
  },
});

// ── list_finance_schedules ────────────────────────────────────────────────────

export const listFinanceSchedules = defineOp({
  name: "list_finance_schedules",
  domain: "finance",
  access: "read",
  description:
    "The household's scheduled transactions (mortgage, car, utilities, insurance, contributions) with amount, cadence, next due date and whether they're autopaid, soonest first. Answers 'what bills are due this week?', 'when is the car payment?', 'what do we pay every month?'. Use it to get a recurringId for save_finance_schedule.",
  input: z.object({
    dueWithinDays: z.number().int().min(0).optional().describe("Only those due within this many days."),
    includeInactive: z.boolean().optional(),
  }),
  output: z.object({
    monthlyOut: z.number().describe("Monthly equivalent of the live outgoing schedules"),
    monthlyIn: z.number().describe("Monthly equivalent of the live incoming ones (contributions), transfers left out"),
    schedules: z.array(ScheduleOut),
  }),
  async run(ctx, input) {
    const today = todayIso();
    const [rows, accounts, folks] = await Promise.all([listSchedules(ctx.client), listAccounts(ctx.client), people(ctx)]);
    const live = rows.filter((r) => input.includeInactive || isScheduleLive(r, today));
    const within = input.dueWithinDays != null ? addDays(today, input.dueWithinDays) : null;
    const shown = live.filter((r) => !within || (r.nextDate && r.nextDate <= within)).sort((a, b) => (a.nextDate ?? "9").localeCompare(b.nextDate ?? "9"));
    const perMonth = (r: any) => Math.abs(r.amount) * (CADENCE_MONTHLY_FACTOR[(r.cadence ?? "MONTHLY") as Cadence] ?? 1);
    const monthlyOut = rows.filter((r) => isScheduleLive(r, today) && (r.amount ?? 0) < 0).reduce((s, r) => s + perMonth(r), 0);
    const monthlyIn = rows.filter((r) => isScheduleLive(r, today) && r.type !== "TRANSFER" && (r.amount ?? 0) > 0).reduce((s, r) => s + perMonth(r), 0);
    return {
      monthlyOut: r2(monthlyOut),
      monthlyIn: r2(monthlyIn),
      schedules: shown.map((r) => scheduleOut(r, accounts, folks)),
    };
  },
});

// ── save_finance_goal ─────────────────────────────────────────────────────────

export const saveFinanceGoal = defineOp({
  name: "save_finance_goal",
  domain: "finance",
  access: "write",
  description:
    "Create or change a household savings goal (emergency fund, baby, a trip, a new car, retirement). Progress is either tracked by hand (currentAmount) or follows the balance of one or more accounts (fundingAccountIds, e.g. both 401ks for a retirement goal; invested accounts count at total value); goals sharing an account are filled in priority order (lower first). milestones sets the goal's checkpoints ('$20k by June 2027'); it replaces the whole list, so pass the existing ones (with their id) to keep them. With goalId, only the fields given change; active false archives it.",
  input: z.object({
    goalId: z.string().optional(),
    name: z.string().optional(),
    targetAmount: z.number().positive().optional(),
    currentAmount: z.number().min(0).optional(),
    fundingAccountIds: z.array(z.string()).optional().describe("Accounts whose balances fund the goal, in the order drawn on; [] = tracked by hand."),
    fundingAccountId: z.string().nullable().optional().describe("Single-account shorthand for fundingAccountIds."),
    priority: z.number().int().optional(),
    targetDate: DATE.nullable().optional(),
    active: z.boolean().optional(),
    notes: z.string().nullable().optional(),
    milestones: z
      .array(
        z.object({
          id: z.string().optional().describe("An existing milestone's id, to change it in place"),
          targetAmount: z.number().positive(),
          targetDate: DATE,
          label: z.string().nullable().optional(),
          notes: z.string().nullable().optional(),
        }),
      )
      .optional()
      .describe("The goal's full milestone list; replaces the existing one ([] removes them all)."),
  }),
  output: z.object({
    action: z.enum(["created", "updated"]),
    goal: z.object({
      id: z.string(),
      name: z.string(),
      targetAmount: z.number(),
      current: z.number(),
      pct: z.number(),
      targetDate: z.string().nullable(),
      accounts: z.array(z.string()),
      milestones: z.array(MilestoneOut),
    }),
  }),
  async run(ctx, input) {
    const fields: Record<string, unknown> = Object.fromEntries(
      (["name", "targetAmount", "currentAmount", "priority", "targetDate", "active", "notes"] as const).filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
    );
    const fundingIds = input.fundingAccountIds ?? (input.fundingAccountId !== undefined ? (input.fundingAccountId ? [input.fundingAccountId] : []) : undefined);
    const accounts = await listAccounts(ctx.client);
    if (fundingIds) {
      const unknown = fundingIds.filter((id) => !accounts.some((a) => a.id === id));
      if (unknown.length) throw new OpError(`No account ${unknown.join(", ")}. Accounts: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ") || "none"}`);
      // The list is the source of truth from now on; clear the older single field.
      fields.fundingAccountIds = [...new Set(fundingIds)];
      fields.fundingAccountId = null;
    }
    // Validate milestones before writing anything.
    const existing = input.goalId ? (await ctx.client.models.homeFinanceSavingsGoal.get({ id: input.goalId })).data : null;
    if (input.goalId && !existing) throw new OpError(`No goal ${input.goalId}`);
    const stored = input.goalId ? (await listGoalMilestones(ctx.client)).filter((m) => m.goalId === input.goalId) : [];
    if (input.milestones) {
      const target = input.targetAmount ?? existing?.targetAmount ?? 0;
      for (const m of input.milestones) {
        if (m.id && !stored.some((x) => x.id === m.id)) throw new OpError(`Milestone ${m.id} isn't on this goal`);
        if (m.targetAmount > target) throw new OpError(`Milestone ${fmtUsd(m.targetAmount)} is above the goal's target (${fmtUsd(target)})`);
      }
    }

    let saved: any;
    let action: "created" | "updated";
    if (input.goalId) {
      if (!Object.keys(fields).length && !input.milestones) throw new OpError("Nothing to change");
      if (Object.keys(fields).length) {
        const r = await ctx.client.models.homeFinanceSavingsGoal.update({ id: input.goalId, ...fields });
        if (r.errors?.length || !r.data) throw new OpError(r.errors?.[0]?.message ?? `No goal ${input.goalId}`);
        saved = r.data;
      } else saved = existing;
      action = "updated";
    } else {
      if (!input.name?.trim() || input.targetAmount == null) throw new OpError("name and targetAmount are required");
      const r = await ctx.client.models.homeFinanceSavingsGoal.create({ active: true, priority: 100, currentAmount: 0, ...fields, name: input.name.trim() });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      saved = r.data;
      action = "created";
    }
    if (input.milestones) {
      const keep = new Set(input.milestones.map((m) => m.id).filter(Boolean));
      for (const m of stored.filter((x) => !keep.has(x.id))) {
        const r = await ctx.client.models.homeFinanceGoalMilestone.delete({ id: m.id });
        if (r.errors?.length) throw new Error(`Removing milestone: ${r.errors[0].message}`);
      }
      for (const m of input.milestones) {
        const row = { goalId: saved.id, targetAmount: m.targetAmount, targetDate: m.targetDate, label: m.label?.trim() || null, notes: m.notes?.trim() || null };
        const r = m.id ? await ctx.client.models.homeFinanceGoalMilestone.update({ id: m.id, ...row }) : await ctx.client.models.homeFinanceGoalMilestone.create(row);
        if (r.errors?.length) throw new Error(`Saving milestone: ${r.errors[0].message}`);
      }
    }

    const today = todayIso();
    const [goals, milestones] = await Promise.all([listGoals(ctx.client), listGoalMilestones(ctx.client)]);
    const p = goalProgress(goals, accounts, today).find((g) => g.goal.id === saved.id);
    const current = p?.current ?? saved.currentAmount ?? 0;
    return {
      action,
      goal: {
        id: saved.id,
        name: saved.name,
        targetAmount: saved.targetAmount,
        current: r2(p?.current ?? saved.currentAmount ?? 0),
        pct: Math.round((p?.pct ?? 0) * 100) / 100,
        targetDate: saved.targetDate ?? null,
        accounts: goalAccountIds(saved).map((id) => accounts.find((a) => a.id === id)?.name ?? id),
        milestones: milestoneOut(milestones.filter((m) => m.goalId === saved.id), current, today),
      },
    };
  },
});

// ── list_finance_goals ────────────────────────────────────────────────────────

export const listFinanceGoals = defineOp({
  name: "list_finance_goals",
  domain: "finance",
  access: "read",
  description:
    "The household's savings goals with progress (tracked by hand, or following one or more accounts' balances, filled in priority order), the monthly saving needed to hit the target date, and each goal's milestones (HIT / MISSED / PENDING). Archived goals only with includeInactive. Answers 'how are our goals doing?', 'how much do we need to save a month for the baby fund?'. Use the goalId (and milestone ids) with save_finance_goal.",
  input: z.object({ includeInactive: z.boolean().optional() }),
  output: z.object({
    goals: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        active: z.boolean(),
        current: z.number(),
        target: z.number(),
        pct: z.number().describe("0..1"),
        targetDate: z.string().nullable(),
        monthlyNeeded: z.number().nullable(),
        funded: z.enum(["manual", "account"]).describe("account = follows fundingAccountIds' balances; manual = currentAmount"),
        currentAmount: z.number().nullable().describe("The hand-tracked amount (used when funded is manual)"),
        fundingAccountIds: z.array(z.string()),
        fundedBy: z.array(z.string()).describe("Names of fundingAccountIds"),
        priority: z.number().nullable(),
        notes: z.string().nullable(),
        milestones: z.array(MilestoneOut.extend({ notes: z.string().nullable() })),
      }),
    ),
  }),
  async run(ctx, input) {
    const today = todayIso();
    const [goals, accounts, milestones] = await Promise.all([listGoals(ctx.client), listAccounts(ctx.client), listGoalMilestones(ctx.client)]);
    const progress = goalProgress(goals, accounts, today)
      .filter((g) => input.includeInactive || g.goal.active !== false)
      .sort((a, b) => Number(b.goal.active !== false) - Number(a.goal.active !== false) || (a.goal.priority ?? 100) - (b.goal.priority ?? 100) || a.goal.name.localeCompare(b.goal.name));
    return {
      goals: progress.map((g) => {
        const raw: any = g.goal;
        const mine = milestones.filter((m) => m.goalId === g.goal.id);
        return {
          id: g.goal.id,
          name: g.goal.name,
          active: g.goal.active !== false,
          current: r2(g.current),
          target: r2(g.target),
          pct: Math.round(g.pct * 1000) / 1000,
          targetDate: g.goal.targetDate ?? null,
          monthlyNeeded: g.monthlyNeeded == null ? null : r2(g.monthlyNeeded),
          funded: g.funded,
          currentAmount: g.goal.currentAmount ?? null,
          fundingAccountIds: goalAccountIds(g.goal),
          fundedBy: goalAccountIds(g.goal).map((id) => accounts.find((a) => a.id === id)?.name ?? id),
          priority: g.goal.priority ?? null,
          notes: raw.notes ?? null,
          milestones: milestoneOut(mine, g.current, today).map((m) => ({ ...m, notes: mine.find((x) => x.id === m.id)?.notes ?? null })),
        };
      }),
    };
  },
});

// ── list_finance_categories ───────────────────────────────────────────────────

export const listFinanceCategories = defineOp({
  name: "list_finance_categories",
  domain: "finance",
  access: "read",
  description:
    "The category names in use (from the rules, existing budgets and categories created by hand), for picking a category in update_finance_transaction or save_finance_budget. A new name given to update_finance_transaction is created and joins this list. Sub-categories are \"Parent: Child\".",
  input: z.object({}),
  output: z.object({ categories: z.array(z.string()) }),
  async run(ctx) {
    return { categories: (await loadCategoryVocabulary(ctx.client)).categories };
  },
});

// ── list_finance_spend_groups / save_finance_spend_group ──────────────────────

const SpendGroupOut = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string().nullable(),
  budget: z.number().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  tripId: z.string().nullable(),
  notes: z.string().nullable(),
  keepOutOfBudget: z.boolean().describe("True: its transactions don't count in the monthly budget"),
});

function spendGroupOut(g: any): z.infer<typeof SpendGroupOut> {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind ?? null,
    budget: g.budget ?? null,
    startDate: g.startDate ?? null,
    endDate: g.endDate ?? null,
    tripId: g.tripId ?? null,
    notes: g.notes ?? null,
    keepOutOfBudget: g.keepOutOfBudget === true,
  };
}

/** Copy a group's keepOutOfBudget onto its tagged transactions; returns how many changed. */
async function syncGroupBudgetFlag(client: any, groupId: string, keepOut: boolean): Promise<number> {
  const want = keepOut ? true : null;
  let changed = 0;
  let nextToken: string | null | undefined;
  do {
    const r = await txIndexQuery(client, "SpendGroupId")({ spendGroupId: groupId }, { limit: 500, nextToken });
    for (const t of r.data ?? []) {
      if ((t.outOfBudget === true ? true : null) === want) continue;
      const u = await client.models.homeFinanceTransaction.update({ id: t.id, outOfBudget: want });
      if (u.errors?.length) throw new Error(u.errors[0].message);
      changed++;
    }
    nextToken = r.nextToken;
  } while (nextToken);
  return changed;
}

export const listFinanceSpendGroups = defineOp({
  name: "list_finance_spend_groups",
  domain: "finance",
  access: "read",
  description:
    "Spend groups (a trip, the nursery, a remodel), newest first. Transactions tagged with one (update_finance_transaction spendGroupId) add up to the group's total and still count in the monthly budget under their category, unless the group is keepOutOfBudget.",
  input: z.object({}),
  output: z.object({ groups: z.array(SpendGroupOut) }),
  async run(ctx) {
    return { groups: sortSpendGroups(await listSpendGroups(ctx.client)).map(spendGroupOut) };
  },
});

export const saveFinanceSpendGroup = defineOp({
  name: "save_finance_spend_group",
  domain: "finance",
  access: "write",
  description:
    "Create a spend group (a trip, a project like the nursery, an event), or change one when id is given. Tag transactions with it through update_finance_transaction spendGroupId: they add up to the group's total (against its own budget, if set) and still count in the monthly budget under their category. keepOutOfBudget takes them out of the monthly budget (a remodel paid from savings).",
  input: z.object({
    id: z.string().optional(),
    name: z.string(),
    kind: z.enum(SPEND_GROUP_KINDS).optional().describe("Default PROJECT"),
    budget: z.number().nullable().optional().describe("What the whole group may cost"),
    startDate: DATE.nullable().optional(),
    endDate: DATE.nullable().optional(),
    tripId: z.string().nullable().optional().describe("The trip it's for (list_trips)"),
    notes: z.string().nullable().optional(),
    keepOutOfBudget: z.boolean().optional().describe("Default false: tagged transactions count in the monthly budget too"),
  }),
  output: z.object({ group: SpendGroupOut, created: z.boolean(), transactionsUpdated: z.number() }),
  async run(ctx, input) {
    const checked = spendGroupFields({
      name: input.name,
      kind: input.kind ?? "PROJECT",
      budget: input.budget == null ? "" : String(input.budget),
      startDate: input.startDate ?? "",
      endDate: input.endDate ?? "",
    });
    if ("error" in checked) throw new OpError(checked.error);
    const { fields } = checked;
    if (input.id) {
      const patch: Record<string, unknown> = { name: fields.name };
      if (input.kind !== undefined) patch.kind = fields.kind;
      if (input.budget !== undefined) patch.budget = fields.budget;
      if (input.startDate !== undefined) patch.startDate = fields.startDate;
      if (input.endDate !== undefined) patch.endDate = fields.endDate;
      if (input.tripId !== undefined) patch.tripId = input.tripId || null;
      if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
      if (input.keepOutOfBudget !== undefined) patch.keepOutOfBudget = input.keepOutOfBudget;
      const r = await ctx.client.models.homeFinanceSpendGroup.update({ id: input.id, ...patch });
      if (r.errors?.length || !r.data) throw new OpError(r.errors?.[0]?.message ?? `No spend group ${input.id}`);
      // Every save re-copies the switch, so a row tagged some other way is fixed too.
      const transactionsUpdated = await syncGroupBudgetFlag(ctx.client, r.data.id, r.data.keepOutOfBudget === true);
      return { group: spendGroupOut(r.data), created: false, transactionsUpdated };
    }
    const existing = (await listSpendGroups(ctx.client)).find((g) => g.name.toLowerCase() === fields.name.toLowerCase());
    if (existing) throw new OpError(`There's already a spend group named "${existing.name}" (id ${existing.id})`);
    const r = await ctx.client.models.homeFinanceSpendGroup.create({
      ...fields,
      tripId: input.tripId || null,
      notes: input.notes?.trim() || null,
      keepOutOfBudget: input.keepOutOfBudget === true,
    });
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
    return { group: spendGroupOut(r.data), created: true, transactionsUpdated: 0 };
  },
});

// ── list_finance_holdings ─────────────────────────────────────────────────────

export const listFinanceHoldings = defineOp({
  name: "list_finance_holdings",
  domain: "finance",
  access: "read",
  description:
    "Invested accounts (401k, IRA, brokerage) with their value and positions (fund or ticker, shares, market value, cost basis and gain where known), as SimpleFIN last reported them. Answers 'how much is in the 401k?', 'what funds are we in?', 'how much do we have invested?'.",
  input: z.object({
    accountId: z.string().optional(),
    accountName: z.string().optional(),
  }),
  output: z.object({
    total: z.number().describe("Sum of the invested accounts' balances"),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        owners: z.array(z.string()).describe("Empty = joint"),
        balance: z.number().describe("Total value, cash + positions"),
        cash: z.number().describe("Balance minus the positions' value"),
        updatedAt: z.string().nullable(),
        holdings: z.array(
          z.object({
            ticker: z.string().nullable(),
            description: z.string().nullable(),
            quantity: z.number(),
            marketValue: z.number().nullable(),
            costBasis: z.number().nullable(),
            gain: z.number().nullable(),
            asOf: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
  async run(ctx, input) {
    const [accounts, folks] = await Promise.all([listAccounts(ctx.client), people(ctx)]);
    const want = input.accountName?.trim().toLowerCase();
    const invested = accounts.filter(
      (a) => a.active !== false && isInvested(a.type) && (!input.accountId || a.id === input.accountId) && (!want || a.name.toLowerCase() === want),
    );
    if ((input.accountId || want) && !invested.length) {
      throw new OpError(`No investment account ${input.accountId ?? input.accountName}. Investment accounts: ${accounts.filter((a) => isInvested(a.type)).map((a) => a.name).join(", ") || "none"}`);
    }
    const holdings = await listHoldings(ctx.client);
    const out = invested.map((a) => {
      const mine = holdings.filter((h) => h.accountId === a.id);
      const positions = mine.reduce((s, h) => s + (h.marketValue ?? 0), 0);
      return {
        id: a.id,
        name: a.name,
        type: accountTypeLabel(a),
        owners: (a.ownerPersonIds ?? []).map((id: string) => nameOf(folks, id) ?? id),
        balance: r2(a.currentBalance ?? 0),
        cash: r2((a.currentBalance ?? 0) - positions),
        updatedAt: a.balanceUpdatedAt ?? null,
        holdings: mine.map((h) => ({
          ticker: h.ticker ?? null,
          description: h.description ?? null,
          quantity: h.quantity,
          marketValue: h.marketValue == null ? null : r2(h.marketValue),
          costBasis: h.costBasisTotal == null ? null : r2(h.costBasisTotal),
          gain: h.marketValue != null && h.costBasisTotal != null ? r2(h.marketValue - h.costBasisTotal) : null,
          asOf: h.asOf ?? null,
        })),
      };
    });
    return { total: r2(out.reduce((s, a) => s + a.balance, 0)), accounts: out };
  },
});

export const importFinanceTransactions = defineOp({
  name: "import_finance_transactions",
  domain: "finance",
  access: "write",
  description:
    "Import a bank or card CSV export into an account SimpleFIN doesn't sync (the H-E-B card's Activity export; Chase, Bank of America, American Express and generic date/amount CSVs are read too). Rows already in the account are skipped, so overlapping exports can be imported again safely. New rows are categorized by the category rules (a card payment or reward by the export's own type) and linked to their scheduled transactions like synced ones. dryRun previews the format, what's new and what's a duplicate without saving.",
  input: z.object({
    accountId: z.string().optional(),
    accountName: z.string().optional().describe("Instead of accountId."),
    csv: z.string().min(1).max(3_000_000).describe("The export file's text."),
    format: z.string().optional().describe("Force a format by name; default detected from the header row."),
    dryRun: z.boolean().optional(),
    setBalance: z
      .boolean()
      .optional()
      .describe("Default true: the account's balance becomes the sum of all its rows (a running total from zero), right when the exports go back to when the account was opened. false keeps the balance as it is."),
  }),
  output: z.object({
    account: z.string(),
    format: z.string(),
    parsed: z.number(),
    skipped: z.number().describe("Lines with no readable date or amount"),
    duplicates: z.number(),
    created: z.number().describe("New rows (would be created, on a dry run)"),
    from: z.string().nullable(),
    to: z.string().nullable(),
    rows: z.array(z.object({ date: z.string(), description: z.string(), amount: z.number(), category: z.string().nullable() })).describe("The new rows, oldest first (first 200)"),
    linked: z.array(z.object({ date: z.string(), description: z.string().nullable(), amount: z.number(), schedule: z.string() })),
    balance: z.object({ before: z.number(), after: z.number() }).nullable().describe("The balance from the running total (would be, on a dry run); null when setBalance is false"),
    dryRun: z.boolean(),
  }),
  async run(ctx, input) {
    const accounts = await listAccounts(ctx.client);
    const want = input.accountName?.trim().toLowerCase();
    const account = accounts.find((a) => (input.accountId ? a.id === input.accountId : want && a.name?.toLowerCase() === want));
    if (!account) throw new OpError(input.accountId || input.accountName ? "No such account" : "Pass accountId or accountName", { accounts: accounts.map((a) => ({ id: a.id, name: a.name })) });
    if (account.simplefinAccountId) throw new OpError(`${account.name} syncs from SimpleFIN; importing a CSV too would duplicate its rows`);
    const { format, rows, skipped } = parseBankCsv(input.csv, input.format);
    if (format === "Unknown") throw new OpError(`Couldn't read this file: the first line needs column names with a date and an amount. Known formats: ${CSV_FORMATS.join(", ")}`);
    const from = rows[0]?.date ?? null;
    const to = rows[rows.length - 1]?.date ?? null;
    // Every row (manual accounts are small): the range for duplicates, all of it for the running balance.
    const all = await listAccountTransactions(ctx.client, account.id);
    const stored = from && to ? all.filter((t: any) => t.date >= from && t.date <= to) : [];
    const { fresh, duplicates } = newCsvRows(rows, stored.map((t: any) => t.importHash ?? importHash(t.date, t.amount, t.description ?? "")));
    const rules = rulesFromDbRows(await listCategoryRules(ctx.client));
    const drafts = fresh.map((r) => {
      const type = r.amount >= 0 ? "INCOME" : "EXPENSE";
      const category = r.category ?? classify({ type, description: r.description, amount: r.amount }, rules).category;
      return { ...r, type, category };
    });

    let linked: Array<{ date: string; description: string | null; amount: number; schedule: string }> = [];
    const storedSum = all.reduce((n: number, t: any) => n + (t.amount ?? 0), 0);
    const created: any[] = [];
    let balance = input.setBalance === false ? null : { before: r2(account.currentBalance ?? 0), after: r2(storedSum + drafts.reduce((n, d) => n + d.amount, 0)) };
    if (!input.dryRun && drafts.length) {
      // In parallel, a batch at a time: one by one, a year of card activity
      // outlasts the 30 s AppSync limit.
      const save = async (d: (typeof drafts)[number]) => {
        const row = {
          // Stable per file row: the same export imported twice can't double up.
          id: `csv-${account.id}-${d.hash}-${d.occurrence}`,
          accountId: account.id,
          amount: d.amount,
          type: d.type,
          category: d.category,
          categorySource: d.category ? "RULE" : null,
          description: d.description,
          date: d.date,
          status: "POSTED",
          importHash: d.hash,
        };
        const r = await ctx.client.models.homeFinanceTransaction.create(row);
        if (r.errors?.length) {
          if (/conditional/i.test(`${r.errors[0].errorType ?? ""} ${r.errors[0].message ?? ""}`)) return; // already imported
          throw new OpError(`Saving ${d.date} ${d.description}: ${r.errors[0].message}`);
        }
        created.push(row);
      };
      for (let i = 0; i < drafts.length; i += 25) await Promise.all(drafts.slice(i, i + 25).map(save));
      const schedules = (await listSchedules(ctx.client)).filter((s: any) => s.active !== false && s.accountId === account.id);
      if (schedules.length && created.length) {
        const plan = planScheduleLinks(created.sort((a, b) => a.date.localeCompare(b.date)), schedules);
        await applyScheduleLinks(ctx, plan, accounts);
        linked = plan.map((l) => ({ date: l.tx.date ?? "", description: l.tx.description ?? null, amount: l.tx.amount ?? 0, schedule: l.rule.description ?? "" }));
      }
    }
    if (!input.dryRun && balance) {
      balance = { ...balance, after: r2(storedSum + created.reduce((n, t) => n + t.amount, 0)) };
      if (Math.abs(balance.after - balance.before) >= 0.005) {
        const r = await ctx.client.models.homeFinanceAccount.update({ id: account.id, currentBalance: balance.after, balanceUpdatedAt: new Date().toISOString() });
        if (r.errors?.length) throw new OpError(`Rows saved, but setting the balance failed: ${r.errors[0].message}`);
      }
    }
    return {
      account: account.name ?? "",
      format,
      parsed: rows.length,
      skipped,
      duplicates,
      created: drafts.length,
      from,
      to,
      rows: drafts.slice(0, 200).map((d) => ({ date: d.date, description: d.description, amount: d.amount, category: d.category ?? null })),
      linked,
      balance,
      dryRun: !!input.dryRun,
    };
  },
});

export const financeOps = [
  getFinanceSummary,
  getFinanceBudget,
  listFinanceGoals,
  listFinanceHoldings,
  listFinanceTransactions,
  updateFinanceTransaction,
  saveFinanceBudget,
  listFinanceSchedules,
  saveFinanceSchedule,
  linkFinanceSchedules,
  importFinanceTransactions,
  saveFinanceGoal,
  listFinanceCategories,
  listFinanceSpendGroups,
  saveFinanceSpendGroup,
] as const;
