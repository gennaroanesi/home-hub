// Household finance: the joint account's balance, budget, transactions,
// scheduled transactions (mortgage, car, contributions) and savings goals.
// Computation lives in lib/finance/; these ops are the surface Janet, the
// API, the CLI and the finance pages' writes share.

import { z } from "zod/v4";
import { listAllPages } from "../list-all";
import { householdBudget, bucketCategories, planBudgetChange, resolveBudgetLines, budgetKind, type BudgetLine } from "../finance/budget";
import { allCategories, CATEGORY_RULES, effectiveCategory, patternMatches, rulesFromDbRows, UNCATEGORIZED } from "../finance/categories";
import { addDays, CADENCE_MONTHLY_FACTOR, CADENCES, monthRange, monthStart, normalizeAmountSign, todayIso, type Cadence } from "../finance/dates";
import { listAccounts, listBudgetLines, listCategoryRules, listGoals, listSchedules, listTransactions } from "../finance/data";
import { goalProgress } from "../finance/goals";
import { isScheduleLive, lowestPoint, projectBalance, upcomingEvents } from "../finance/recurring";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const r2 = (n: number) => Math.round(n * 100) / 100;

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

function nameOf(all: Person[], id: string | null | undefined): string | null {
  return id ? all.find((p) => p.id === id)?.name ?? null : null;
}

// ── get_finance_summary ───────────────────────────────────────────────────────

export const getFinanceSummary = defineOp({
  name: "get_finance_summary",
  domain: "finance",
  access: "read",
  description:
    "The household's money at a glance for one month (default: this month): joint account balances, the budget (what each person planned to contribute vs what came in, and each budget line's spending vs its amount), the scheduled debits coming up in the next 14 days with the projected low balance, savings goals, and how many transactions still need a category. Answers 'how are we doing this month?', 'how much have we spent on groceries?', 'did Cristine's contribution come in?', 'will we have enough for the mortgage?', 'how close are we to the emergency fund goal?'.",
  input: z.object({
    month: MONTH.optional().describe("YYYY-MM; default this month."),
  }),
  output: z.object({
    month: z.string(),
    accounts: z.array(z.object({ id: z.string(), name: z.string(), type: z.string().nullable(), balance: z.number(), updatedAt: z.string().nullable() })),
    contributions: z.array(z.object({ person: z.string().nullable(), planned: z.number(), received: z.number() })),
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
        }),
      ),
      unbudgeted: z.array(z.object({ category: z.string(), spent: z.number() })),
    }),
    upcoming: z.array(z.object({ date: z.string(), description: z.string(), amount: z.number(), account: z.string() })),
    lowPoint: z.object({ account: z.string(), date: z.string(), balance: z.number(), belowBuffer: z.boolean() }).nullable(),
    goals: z.array(z.object({ name: z.string(), current: z.number(), target: z.number(), pct: z.number(), targetDate: z.string().nullable(), monthlyNeeded: z.number().nullable() })),
    uncategorizedCount: z.number(),
  }),
  async run(ctx, input) {
    const today = todayIso();
    const window = monthRange(input.month ? `${input.month}-01` : today);
    const [accounts, lines, schedules, goals, folks] = await Promise.all([
      listAccounts(ctx.client),
      listBudgetLines(ctx.client),
      listSchedules(ctx.client),
      listGoals(ctx.client),
      people(ctx),
    ]);
    const active = accounts.filter((a) => a.active !== false);
    const txs = await listTransactions(ctx.client, { ...window, accountIds: active.map((a) => a.id) });
    const view = householdBudget(lines, txs, schedules, window, today);

    // Next 14 days of scheduled money movement on cash accounts.
    const horizon = addDays(today, 14);
    const upcoming: Array<{ date: string; description: string; amount: number; account: string }> = [];
    let lowPoint: { account: string; date: string; balance: number; belowBuffer: boolean } | null = null;
    for (const a of active.filter((x) => x.type === "CHECKING" || x.type === "SAVINGS" || x.type === "CASH")) {
      const events = upcomingEvents(a.id, schedules, today, horizon);
      upcoming.push(...events.map((e) => ({ date: e.date, description: e.description, amount: r2(e.amount), account: a.name })));
      const lo = lowestPoint(projectBalance(a.currentBalance ?? 0, events));
      if (lo && (!lowPoint || lo.balance < lowPoint.balance)) {
        lowPoint = { account: a.name, date: lo.date, balance: r2(lo.balance), belowBuffer: lo.balance < (a.minBalance ?? 0) };
      }
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date));

    return {
      month: window.label,
      accounts: active.map((a) => ({ id: a.id, name: a.name, type: a.type ?? null, balance: r2(a.currentBalance ?? 0), updatedAt: a.balanceUpdatedAt ?? null })),
      contributions: view.incomeViews.map((v) => ({ person: nameOf(folks, v.line.personId) ?? v.line.name, planned: r2(v.budgeted), received: r2(v.spent) })),
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
        })),
        unbudgeted: view.unassigned.map((u) => ({ category: u.category, spent: r2(u.spent) })),
      },
      upcoming,
      lowPoint,
      goals: goalProgress(goals, accounts, today)
        .filter((g) => g.goal.active !== false)
        .map((g) => ({ name: g.goal.name, current: r2(g.current), target: r2(g.target), pct: Math.round(g.pct * 100) / 100, targetDate: g.goal.targetDate ?? null, monthlyNeeded: g.monthlyNeeded == null ? null : r2(g.monthlyNeeded) })),
      uncategorizedCount: txs.filter((t) => effectiveCategory(t) === UNCATEGORIZED).length,
    };
  },
});

// ── list_finance_transactions ─────────────────────────────────────────────────

const TxOut = z.object({
  id: z.string(),
  date: z.string(),
  description: z.string().nullable(),
  amount: z.number().describe("Positive = money in, negative = money out"),
  category: z.string(),
  categorySource: z.string().nullable().describe("RULE, LLM (guessed) or MANUAL"),
  person: z.string().nullable(),
  account: z.string().nullable(),
  status: z.string().nullable(),
  spendGroupId: z.string().nullable(),
  recurringId: z.string().nullable(),
  notes: z.string().nullable(),
});

export const listFinanceTransactions = defineOp({
  name: "list_finance_transactions",
  domain: "finance",
  access: "read",
  description:
    "Search the household account transactions, newest first. Default: the last 30 days. Filter by words in the description or notes, category, person, account or spend group, or only uncategorized ones. Returns the matching count and their total. Answers 'what did we spend at Costco this month?', 'show the uncategorized transactions', 'when did the mortgage go out?'. Use it to get a transactionId for update_finance_transaction.",
  input: z.object({
    from: DATE.optional(),
    to: DATE.optional(),
    query: z.string().optional().describe("Words that must all appear in the description or notes."),
    category: z.string().optional(),
    uncategorized: z.boolean().optional(),
    personId: z.string().optional(),
    personName: z.string().optional(),
    accountId: z.string().optional(),
    spendGroupId: z.string().optional(),
    direction: z.enum(["in", "out"]).optional(),
    limit: z.number().int().min(1).max(500).optional().describe("Default 50."),
  }),
  output: z.object({ count: z.number(), total: z.number(), transactions: z.array(TxOut) }),
  async run(ctx, input) {
    const today = todayIso();
    const fromIso = input.from ?? addDays(today, -30);
    const toIso = input.to ?? today;
    const personId = await personRef(ctx, input);
    const [accounts, folks, ruleRows] = await Promise.all([listAccounts(ctx.client), people(ctx), listCategoryRules(ctx.client)]);
    const rules = rulesFromDbRows(ruleRows);
    const accName = new Map(accounts.map((a) => [a.id, a.name]));
    const txs = await listTransactions(ctx.client, { fromIso, toIso, accountIds: input.accountId ? [input.accountId] : accounts.map((a) => a.id) });
    const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const matched = txs.filter((t) => {
      const cat = effectiveCategory(t, rules);
      if (input.uncategorized && cat !== UNCATEGORIZED) return false;
      if (input.category && cat.toLowerCase() !== input.category.toLowerCase()) return false;
      if (personId && t.personId !== personId) return false;
      if (input.spendGroupId && t.spendGroupId !== input.spendGroupId) return false;
      if (input.direction === "in" && (t.amount ?? 0) <= 0) return false;
      if (input.direction === "out" && (t.amount ?? 0) >= 0) return false;
      const hay = `${t.description ?? ""} ${t.notes ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
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
        account: accName.get(t.accountId) ?? null,
        status: t.status ?? null,
        spendGroupId: t.spendGroupId ?? null,
        recurringId: t.recurringId ?? null,
        notes: t.notes ?? null,
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
    "Change a transaction's category, person, spend group, goal or notes (only what's given; null clears). A category set here is MANUAL and never overwritten by the sync. Pass rememberPattern (a word or phrase from the description, e.g. 'BLUE BOTTLE') to also add a rule so future transactions like it get the same category and person automatically. Find the transactionId with list_finance_transactions.",
  input: z.object({
    transactionId: z.string(),
    category: z.string().nullable().optional(),
    personId: z.string().nullable().optional().describe("Who it's attributed to (contributor or spender); null = household."),
    personName: z.string().nullable().optional(),
    spendGroupId: z.string().nullable().optional(),
    goalId: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    rememberPattern: z.string().optional().describe("Substring or /regex/flags; creates a rule at the top of the rule list."),
  }),
  output: z.object({ transactionId: z.string(), category: z.string(), personId: z.string().nullable(), ruleCreated: z.boolean() }),
  async run(ctx, input) {
    const { data: tx } = await ctx.client.models.homeFinanceTransaction.get({ id: input.transactionId });
    if (!tx) throw new OpError(`No transaction ${input.transactionId}. Use list_finance_transactions to find the id.`);
    const personId = await personRef(ctx, input);
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
    if (input.spendGroupId !== undefined) patch.spendGroupId = input.spendGroupId;
    if (input.goalId !== undefined) patch.goalId = input.goalId;
    if (input.notes !== undefined) patch.notes = input.notes;
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
    return { transactionId: saved.id, category: effectiveCategory(saved), personId: saved.personId ?? null, ruleCreated };
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
});

export const saveFinanceBudget = defineOp({
  name: "save_finance_budget",
  domain: "finance",
  access: "write",
  description:
    "Create or change a household budget line. EXPENSE lines cap spending over a set of categories ('Groceries & dining $1,200/month' covering Groceries, Dining, Food Delivery); INCOME lines record what a person plans to contribute to the joint account each month; SAVINGS lines plan what moves into a savings account each month (accountId or accountName), measured by what actually lands there. Budgets are versioned: changing one (pass seriesId) starts a new version on effectiveFrom (default the 1st of this month) and ends the old one the day before, so past months keep the budget they had. Changing a version that starts on that same date corrects it in place. Pass endOn with seriesId to stop a budget. A category can only be in one spending line at a time. Use get_finance_summary to see the lines and their seriesIds.",
  input: z.object({
    seriesId: z.string().optional().describe("Budget to change; leave out to create one."),
    name: z.string().optional(),
    kind: z.enum(["INCOME", "SAVINGS", "EXPENSE"]).optional().describe("Default EXPENSE on create."),
    personId: z.string().optional().describe("INCOME: who contributes."),
    personName: z.string().optional(),
    accountId: z.string().optional().describe("SAVINGS: the account the money goes into."),
    accountName: z.string().optional(),
    categories: z.array(z.string()).optional().describe("EXPENSE: categories the line covers."),
    amount: z.number().positive().optional(),
    period: z.enum(["MONTHLY", "QUARTERLY", "ANNUALLY", "ONCE"]).optional().describe("Default MONTHLY."),
    effectiveFrom: DATE.optional(),
    endOn: DATE.optional().describe("Last day the budget applies; ends the series."),
    label: z.string().optional().describe("Why it changed, e.g. 'baby arrives'."),
    notes: z.string().optional(),
  }),
  output: z.object({ action: z.enum(["created", "changed", "corrected", "ended"]), budget: BudgetOut }),
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

    const personId = await personRef(ctx, input);
    const kind = input.kind ?? (latest ? budgetKind(latest) : "EXPENSE");
    const name = input.name?.trim() || latest?.name;
    const amount = input.amount ?? latest?.amount;
    const categories = (input.categories ?? (latest ? bucketCategories(latest) : [])).map((c) => c.trim()).filter(Boolean);
    if (!name) throw new OpError("name is required");
    if (amount == null) throw new OpError("amount is required");
    if (kind === "EXPENSE" && !categories.length) throw new OpError("A spending line needs at least one category");
    const contributor = personId === undefined ? latest?.personId ?? null : personId;
    if (kind === "INCOME" && !contributor) throw new OpError("An income line needs the person who contributes (personId or personName)");
    let savingsAccount: string | null = latest?.accountId ?? null;
    if (input.accountId || input.accountName) {
      const want = input.accountName?.trim().toLowerCase();
      const acc = accounts.find((a) => (input.accountId ? a.id === input.accountId : a.name.toLowerCase() === want));
      if (!acc) throw new OpError(`No account ${input.accountId ?? input.accountName}. Accounts: ${accounts.map((a) => a.name).join(", ") || "none"}`);
      savingsAccount = acc.id;
    }
    if (kind === "SAVINGS" && !savingsAccount) throw new OpError("A savings line needs the account the money goes into (accountId or accountName)");

    const effectiveFrom = input.effectiveFrom ?? (latest && latest.effectiveFrom! > monthStart(today) ? latest.effectiveFrom! : monthStart(today));

    // A category may sit in only one spending line at a time.
    if (kind === "EXPENSE") {
      const others = resolveBudgetLines(lines, effectiveFrom).filter((l) => l.seriesId !== input.seriesId && budgetKind(l) === "EXPENSE");
      for (const c of categories) {
        const clash = others.find((l) => bucketCategories(l).some((x) => x.toLowerCase() === c.toLowerCase()));
        if (clash) throw new OpError(`"${c}" is already in "${clash.name}". Remove it there first (save_finance_budget with that seriesId and categories), or pick another category.`);
      }
    }

    const next = {
      seriesId: input.seriesId ?? crypto.randomUUID(),
      name,
      kind,
      personId: kind === "INCOME" ? contributor : null,
      accountId: kind === "SAVINGS" ? savingsAccount : null,
      categories: kind === "EXPENSE" ? categories : [],
      amount,
      period: input.period ?? latest?.period ?? "MONTHLY",
      rollover: latest?.rollover ?? false,
      label: input.label ?? null,
      notes: input.notes ?? latest?.notes ?? null,
    };

    if (latest && latest.effectiveFrom === effectiveFrom) {
      const r = await ctx.client.models.homeFinanceBudget.update({ id: latest.id, ...next, label: input.label ?? latest.label ?? null });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      return { action: "corrected" as const, budget: out(r.data) };
    }
    if (latest && latest.effectiveFrom && effectiveFrom < latest.effectiveFrom) {
      throw new OpError(`The latest version starts ${latest.effectiveFrom}; a change has to start on or after it`);
    }
    const plan = planBudgetChange(latest, next, effectiveFrom);
    const created = await ctx.client.models.homeFinanceBudget.create(plan.insert);
    if (created.errors?.length || !created.data) throw new Error(created.errors?.[0]?.message ?? "Save failed");
    if (plan.close) {
      const closed = await ctx.client.models.homeFinanceBudget.update(plan.close);
      if (closed.errors?.length) throw new Error(`New version saved, but closing the old one failed: ${closed.errors[0].message}`);
    }
    return { action: latest ? ("changed" as const) : ("created" as const), budget: out(created.data) };
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
});

export const saveFinanceSchedule = defineOp({
  name: "save_finance_schedule",
  domain: "finance",
  access: "write",
  description:
    "Create or change a scheduled transaction on a household account: the mortgage, car payment, a utility, insurance, or a person's regular contribution into the joint account. Amount is the usual amount (sign is set from type: EXPENSE out, INCOME in). nextDate is the next time it's due; cadence how often. matchPattern (a word from the bank description, e.g. 'ROCKET MORTGAGE') lets the sync link posted transactions and roll nextDate forward. autopay false means someone has to pay it by hand. Set active false to stop one. Without accountId it goes on the household's checking account. With recurringId, only the fields given change.",
  input: z.object({
    recurringId: z.string().optional(),
    description: z.string().optional(),
    amount: z.number().optional(),
    type: z.enum(["INCOME", "EXPENSE", "TRANSFER"]).optional().describe("Default EXPENSE."),
    cadence: z.enum(CADENCES).optional().describe("Default MONTHLY."),
    nextDate: DATE.optional(),
    endDate: DATE.nullable().optional(),
    category: z.string().nullable().optional(),
    accountId: z.string().optional(),
    toAccountId: z.string().nullable().optional().describe("TRANSFER destination."),
    personId: z.string().nullable().optional().describe("INCOME: the contributor."),
    personName: z.string().nullable().optional(),
    matchPattern: z.string().nullable().optional(),
    autopay: z.boolean().optional(),
    active: z.boolean().optional(),
    url: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  }),
  output: z.object({ action: z.enum(["created", "updated"]), schedule: ScheduleOut }),
  async run(ctx, input) {
    const [accounts, folks] = await Promise.all([listAccounts(ctx.client), people(ctx)]);
    const out = (r: any) => ({
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
    });
    const personId = await personRef(ctx, input);
    if (input.accountId && !accounts.some((a) => a.id === input.accountId)) throw new OpError(`No account ${input.accountId}`);
    const pick = (keys: Array<keyof typeof input>) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));

    if (input.recurringId) {
      const { data: existing } = await ctx.client.models.homeFinanceRecurring.get({ id: input.recurringId });
      if (!existing) throw new OpError(`No scheduled transaction ${input.recurringId}`);
      const type = input.type ?? existing.type ?? "EXPENSE";
      const patch: Record<string, unknown> = pick(["description", "cadence", "nextDate", "endDate", "category", "accountId", "toAccountId", "matchPattern", "autopay", "active", "url", "notes"]);
      if (input.type) patch.type = type;
      if (input.amount !== undefined || input.type) patch.amount = normalizeAmountSign(input.amount ?? existing.amount, type);
      if (personId !== undefined) patch.personId = personId;
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
    const r = await ctx.client.models.homeFinanceRecurring.create({
      ...pick(["endDate", "category", "toAccountId", "matchPattern", "url", "notes"]),
      accountId,
      description: input.description.trim(),
      amount: normalizeAmountSign(input.amount, type),
      type,
      cadence: input.cadence ?? "MONTHLY",
      startDate: input.nextDate,
      nextDate: input.nextDate,
      personId: personId ?? null,
      autopay: input.autopay ?? true,
      active: input.active ?? true,
    });
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
    return { action: "created" as const, schedule: out(r.data) };
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
  output: z.object({ monthlyOut: z.number().describe("Monthly equivalent of the live outgoing schedules"), schedules: z.array(ScheduleOut) }),
  async run(ctx, input) {
    const today = todayIso();
    const [rows, accounts, folks] = await Promise.all([listSchedules(ctx.client), listAccounts(ctx.client), people(ctx)]);
    const live = rows.filter((r) => input.includeInactive || isScheduleLive(r, today));
    const within = input.dueWithinDays != null ? addDays(today, input.dueWithinDays) : null;
    const shown = live.filter((r) => !within || (r.nextDate && r.nextDate <= within)).sort((a, b) => (a.nextDate ?? "9").localeCompare(b.nextDate ?? "9"));
    const monthlyOut = rows
      .filter((r) => isScheduleLive(r, today) && (r.amount ?? 0) < 0)
      .reduce((s, r) => s + Math.abs(r.amount) * (CADENCE_MONTHLY_FACTOR[(r.cadence ?? "MONTHLY") as Cadence] ?? 1), 0);
    return {
      monthlyOut: r2(monthlyOut),
      schedules: shown.map((r) => ({
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
      })),
    };
  },
});

// ── save_finance_goal ─────────────────────────────────────────────────────────

export const saveFinanceGoal = defineOp({
  name: "save_finance_goal",
  domain: "finance",
  access: "write",
  description:
    "Create or change a household savings goal (emergency fund, baby, a trip, a new car). Progress is either tracked by hand (currentAmount) or follows an account's balance (fundingAccountId); goals sharing an account are filled in priority order (lower first). With goalId, only the fields given change; active false archives it.",
  input: z.object({
    goalId: z.string().optional(),
    name: z.string().optional(),
    targetAmount: z.number().positive().optional(),
    currentAmount: z.number().min(0).optional(),
    fundingAccountId: z.string().nullable().optional(),
    priority: z.number().int().optional(),
    targetDate: DATE.nullable().optional(),
    active: z.boolean().optional(),
    notes: z.string().nullable().optional(),
  }),
  output: z.object({ action: z.enum(["created", "updated"]), goal: z.object({ id: z.string(), name: z.string(), targetAmount: z.number(), current: z.number(), pct: z.number(), targetDate: z.string().nullable() }) }),
  async run(ctx, input) {
    const fields = Object.fromEntries(
      (["name", "targetAmount", "currentAmount", "fundingAccountId", "priority", "targetDate", "active", "notes"] as const).filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
    );
    let saved: any;
    let action: "created" | "updated";
    if (input.goalId) {
      if (!Object.keys(fields).length) throw new OpError("Nothing to change");
      const r = await ctx.client.models.homeFinanceSavingsGoal.update({ id: input.goalId, ...fields });
      if (r.errors?.length || !r.data) throw new OpError(r.errors?.[0]?.message ?? `No goal ${input.goalId}`);
      saved = r.data;
      action = "updated";
    } else {
      if (!input.name?.trim() || input.targetAmount == null) throw new OpError("name and targetAmount are required");
      const r = await ctx.client.models.homeFinanceSavingsGoal.create({ active: true, priority: 100, currentAmount: 0, ...fields, name: input.name.trim() });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      saved = r.data;
      action = "created";
    }
    const [goals, accounts] = await Promise.all([listGoals(ctx.client), listAccounts(ctx.client)]);
    const p = goalProgress(goals, accounts, todayIso()).find((g) => g.goal.id === saved.id);
    return {
      action,
      goal: { id: saved.id, name: saved.name, targetAmount: saved.targetAmount, current: r2(p?.current ?? saved.currentAmount ?? 0), pct: Math.round((p?.pct ?? 0) * 100) / 100, targetDate: saved.targetDate ?? null },
    };
  },
});

// ── list_finance_categories ───────────────────────────────────────────────────

export const listFinanceCategories = defineOp({
  name: "list_finance_categories",
  domain: "finance",
  access: "read",
  description: "The category names in use (from the rules and existing budgets), for picking a category in update_finance_transaction or save_finance_budget.",
  input: z.object({}),
  output: z.object({ categories: z.array(z.string()) }),
  async run(ctx) {
    const [ruleRows, lines] = await Promise.all([listCategoryRules(ctx.client), listBudgetLines(ctx.client)]);
    const set = new Set(allCategories(rulesFromDbRows(ruleRows)));
    for (const l of lines) for (const c of bucketCategories(l)) set.add(c);
    return { categories: [...set].sort((a, b) => a.localeCompare(b)) };
  },
});

export const financeOps = [
  getFinanceSummary,
  listFinanceTransactions,
  updateFinanceTransaction,
  saveFinanceBudget,
  listFinanceSchedules,
  saveFinanceSchedule,
  saveFinanceGoal,
  listFinanceCategories,
] as const;
