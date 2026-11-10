import { describe, expect, it } from "vitest";
import type { OpContext } from "./context";
import { runOp } from "./registry";
import { todayIso, monthStart, previousDay, addDays } from "../finance/dates";

/* eslint-disable @typescript-eslint/no-explicit-any */

// In-memory stand-in for the Amplify data client: list/get/create/update
// per model, plus the transaction accountId+date index query.
function setup(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {};
  let n = 0;
  const model = (name: string) => {
    tables[name] = (seed[name] ?? []).map((r) => ({ ...r }));
    const rows = tables[name];
    return {
      list: async () => ({ data: rows, nextToken: null }),
      get: async ({ id }: any) => ({ data: rows.find((r) => r.id === id) ?? null }),
      delete: async ({ id }: any) => {
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
        return { data: { id } };
      },
      create: async (row: any) => {
        const saved = { id: `${name}-${++n}`, ...row };
        rows.push(saved);
        return { data: saved };
      },
      update: async ({ id, ...patch }: any) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return { data: null, errors: [{ message: "not found" }] };
        Object.assign(row, patch);
        return { data: row };
      },
      // Runtime name (capital H), not the typed one: see txIndexQuery.
      listHomeFinanceTransactionByAccountIdAndDate: async ({ accountId, date }: any) => ({
        data: rows.filter((r) => {
          if (r.accountId !== accountId) return false;
          if (date?.between) return r.date >= date.between[0] && r.date <= date.between[1];
          if (date?.ge) return r.date >= date.ge;
          return true;
        }),
        nextToken: null,
      }),
    };
  };
  const names = ["homePerson", "homeFinanceAccount", "homeFinanceTransaction", "homeFinanceRecurring", "homeFinanceBudget", "homeFinanceSavingsGoal", "homeFinanceSpendGroup", "homeFinanceCategoryRule", "homeFinanceHolding", "homeFinanceGoalMilestone"];
  const models = Object.fromEntries(names.map((m) => [m, model(m)]));
  const ctx: OpContext = {
    client: { models },
    storage: { storeFromUrl: async () => "", copyUpload: async () => "" },
    actor: { via: "whatsapp", personName: "Gennaro" },
  };
  return { ctx, tables };
}

const today = todayIso();
const thisMonth = monthStart(today);
const people = [
  { id: "gen", name: "Gennaro", groups: ["home-users"] },
  { id: "cris", name: "Cristine", groups: ["home-users"] },
];
const joint = { id: "joint", name: "Joint checking", type: "CHECKING", currentBalance: 6000, minBalance: 1000, active: true };

describe("get_finance_summary", () => {
  it("reports contributions, lines, upcoming debits and the low point", async () => {
    const { ctx } = setup({
      homePerson: people,
      homeFinanceAccount: [joint],
      homeFinanceBudget: [
        { id: "b1", seriesId: "c", name: "Cristine", kind: "INCOME", personId: "cris", amount: 3000, period: "MONTHLY", effectiveFrom: "2026-01-01" },
        { id: "b2", seriesId: "food", name: "Food", kind: "EXPENSE", categories: ["Groceries"], amount: 900, period: "MONTHLY", effectiveFrom: "2026-01-01" },
      ],
      homeFinanceTransaction: [
        { id: "t1", accountId: "joint", amount: 3000, category: "Contribution", personId: "cris", date: thisMonth, status: "POSTED" },
        { id: "t2", accountId: "joint", amount: -120, category: "Groceries", date: thisMonth, status: "POSTED" },
        { id: "t3", accountId: "joint", amount: -15, description: "zzz mystery", date: thisMonth, status: "POSTED" },
      ],
      homeFinanceRecurring: [
        { id: "m", accountId: "joint", amount: -5500, type: "EXPENSE", description: "Mortgage", cadence: "MONTHLY", startDate: addDays(today, 3), nextDate: addDays(today, 3), active: true },
      ],
    });
    const out: any = await runOp(ctx, "get_finance_summary", {});
    expect(out.error).toBeUndefined();
    const s = out.result;
    expect(s.contributions).toEqual([{ name: "Cristine", person: "Cristine", period: "MONTHLY", planned: 3000, received: 3000 }]);
    expect(s.budget.lines[0]).toMatchObject({ name: "Food", spent: 120, budgeted: 900 });
    expect(s.upcoming).toEqual([{ date: addDays(today, 3), description: "Mortgage", amount: -5500, account: "Joint checking" }]);
    expect(s.lowPoint).toMatchObject({ balance: 500, belowBuffer: true });
    expect(s.uncategorizedCount).toBe(1);
  });
});

describe("update_finance_transaction", () => {
  it("sets a manual category and person, and remembers a rule on top of the seeded table", async () => {
    const { ctx, tables } = setup({
      homePerson: people,
      homeFinanceAccount: [joint],
      homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: -30, description: "SQ *BLUE BOTTLE AUSTIN", date: today, category: null }],
    });
    const out: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t", category: "Dining", personName: "Cristine", rememberPattern: "BLUE BOTTLE" });
    expect(out.result).toMatchObject({ category: "Dining", personId: "cris", ruleCreated: true });
    expect(tables.homeFinanceTransaction[0]).toMatchObject({ categorySource: "MANUAL", personSource: "MANUAL" });
    const rules = tables.homeFinanceCategoryRule;
    expect(rules.length).toBeGreaterThan(10); // bundled rules copied in first
    const top = [...rules].sort((a, b) => a.sortOrder - b.sortOrder)[0];
    expect(top).toMatchObject({ pattern: "BLUE BOTTLE", category: "Dining", personId: "cris" });
  });

  it("refuses a pattern that doesn't match the transaction", async () => {
    const { ctx } = setup({ homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: -30, description: "COSTCO", date: today }] });
    const out: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t", category: "Groceries", rememberPattern: "HEB" });
    expect(out.error).toMatch(/doesn't match/);
  });
});

describe("save_finance_budget", () => {
  it("creates, versions on change, and corrects a same-day change in place", async () => {
    const { ctx, tables } = setup({ homePerson: people });
    const created: any = await runOp(ctx, "save_finance_budget", { name: "Food", categories: ["Groceries", "Dining"], amount: 1000, effectiveFrom: "2026-01-01" });
    expect(created.result.action).toBe("created");
    const seriesId = created.result.budget.seriesId;

    const changed: any = await runOp(ctx, "save_finance_budget", { seriesId, amount: 1200, effectiveFrom: "2026-06-01", label: "raise" });
    expect(changed.result.action).toBe("changed");
    expect(tables.homeFinanceBudget.map((b) => [b.amount, b.effectiveFrom, b.effectiveTo ?? null])).toEqual([
      [1000, "2026-01-01", previousDay("2026-06-01")],
      [1200, "2026-06-01", null],
    ]);

    const corrected: any = await runOp(ctx, "save_finance_budget", { seriesId, amount: 1250, effectiveFrom: "2026-06-01" });
    expect(corrected.result.action).toBe("corrected");
    expect(tables.homeFinanceBudget).toHaveLength(2);
  });

  it("changes any version: December while January is staged, a bounded period, a split, and removing one", async () => {
    const car = (o: any) => ({ seriesId: "car", name: "Car", kind: "EXPENSE", categories: ["Car"], period: "MONTHLY", active: true, ...o });
    const { ctx, tables } = setup({
      homeFinanceBudget: [car({ id: "dec", amount: 4000, effectiveFrom: "2026-12-01", effectiveTo: "2026-12-31" }), car({ id: "jan", amount: 3950, effectiveFrom: "2027-01-01" })],
    });
    const rows = () =>
      tables.homeFinanceBudget
        .filter((b) => b.active !== false)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
        .map((b) => [b.amount, b.effectiveFrom, b.effectiveTo ?? null]);

    // December alone, by version id: corrected in place, January untouched.
    const dec: any = await runOp(ctx, "save_finance_budget", { seriesId: "car", versionId: "dec", amount: 4100 });
    expect(dec.result.action).toBe("corrected");
    expect(rows()).toEqual([[4100, "2026-12-01", "2026-12-31"], [3950, "2027-01-01", null]]);

    // A change from Dec 15 with no end stops where December's version stops.
    await runOp(ctx, "save_finance_budget", { seriesId: "car", amount: 4200, effectiveFrom: "2026-12-15" });
    expect(rows()).toEqual([[4100, "2026-12-01", "2026-12-14"], [4200, "2026-12-15", "2026-12-31"], [3950, "2027-01-01", null]]);

    // A bounded period inside January's open version splits it.
    await runOp(ctx, "save_finance_budget", { seriesId: "car", amount: 5000, effectiveFrom: "2027-03-01", effectiveTo: "2027-03-31" });
    expect(rows()).toEqual([
      [4100, "2026-12-01", "2026-12-14"],
      [4200, "2026-12-15", "2026-12-31"],
      [3950, "2027-01-01", "2027-02-28"],
      [5000, "2027-03-01", "2027-03-31"],
      [3950, "2027-04-01", null],
    ]);

    // Removing March gives its days back and rejoins January's two halves.
    const march = tables.homeFinanceBudget.find((b) => b.amount === 5000);
    const removed: any = await runOp(ctx, "save_finance_budget", { seriesId: "car", removeVersionId: march.id });
    expect(removed.result.action).toBe("removed");
    expect(rows()).toEqual([[4100, "2026-12-01", "2026-12-14"], [4200, "2026-12-15", "2026-12-31"], [3950, "2027-01-01", null]]);

    // Removing the Dec 15 split gives its days to Dec 1's version.
    const mid = tables.homeFinanceBudget.find((b) => b.amount === 4200);
    await runOp(ctx, "save_finance_budget", { seriesId: "car", removeVersionId: mid.id });
    expect(rows()).toEqual([[4100, "2026-12-01", "2026-12-31"], [3950, "2027-01-01", null]]);

    // Open-ended from a date replaces everything after it.
    await runOp(ctx, "save_finance_budget", { seriesId: "car", amount: 3000, effectiveFrom: "2026-12-01", effectiveTo: null });
    expect(rows()).toEqual([[3000, "2026-12-01", null]]);
  });

  it("ends a series that has a change staged for later by cancelling the staged version", async () => {
    const { ctx, tables } = setup({
      homeFinanceBudget: [
        { id: "now", seriesId: "s", name: "Food", kind: "EXPENSE", categories: ["Groceries"], amount: 900, effectiveFrom: "2026-01-01", effectiveTo: "2027-01-31", active: true },
        { id: "later", seriesId: "s", name: "Food", kind: "EXPENSE", categories: ["Groceries"], amount: 1100, effectiveFrom: "2027-02-01", active: true },
      ],
    });
    const out: any = await runOp(ctx, "save_finance_budget", { seriesId: "s", endOn: "2026-11-30" });
    expect(out.result).toMatchObject({ action: "ended", budget: { id: "now", effectiveTo: "2026-11-30" } });
    expect(tables.homeFinanceBudget.find((b) => b.id === "later").active).toBe(false);
  });

  it("refuses a category already in another spending line, and an income line without a person", async () => {
    const { ctx } = setup({
      homePerson: people,
      homeFinanceBudget: [{ id: "b", seriesId: "food", name: "Food", kind: "EXPENSE", categories: ["Groceries"], amount: 900, effectiveFrom: "2026-01-01" }],
    });
    const clash: any = await runOp(ctx, "save_finance_budget", { name: "Shopping", categories: ["groceries"], amount: 100 });
    expect(clash.error).toMatch(/already in "Food"/);
    const income: any = await runOp(ctx, "save_finance_budget", { name: "Contribution", kind: "INCOME", amount: 3000 });
    expect(income.error).toMatch(/person/);
    const ok: any = await runOp(ctx, "save_finance_budget", { name: "Gennaro", kind: "INCOME", personName: "gennaro", amount: 4000 });
    expect(ok.result.budget).toMatchObject({ person: "Gennaro", kind: "INCOME" });
  });
});

describe("savings lines", () => {
  it("creates a savings line by account name, refuses one without an account, and reports it in the summary", async () => {
    const sav = { id: "sav", name: "Joint savings", type: "SAVINGS", currentBalance: 20000, active: true };
    const k401 = { id: "k1", name: "Gennaro 401k", type: "RETIREMENT", currentBalance: 300000, active: true };
    const { ctx } = setup({
      homePerson: people,
      homeFinanceAccount: [joint, sav, k401],
      homeFinanceBudget: [{ id: "c", seriesId: "c", name: "Gennaro", kind: "INCOME", personId: "gen", amount: 10000, period: "MONTHLY", effectiveFrom: "2026-01-01" }],
      homeFinanceTransaction: [
        { id: "t1", accountId: "joint", amount: -1000, category: "Transfers", type: "TRANSFER", toAccountId: "sav", date: thisMonth, status: "POSTED" },
        { id: "t2", accountId: "sav", amount: 1000, category: "Transfers", type: "TRANSFER", date: thisMonth, status: "POSTED" },
      ],
    });
    const missing: any = await runOp(ctx, "save_finance_budget", { name: "Savings", kind: "SAVINGS", amount: 2000 });
    expect(missing.error).toMatch(/account/);
    const unknown: any = await runOp(ctx, "save_finance_budget", { name: "Savings", kind: "SAVINGS", accountName: "Nope", amount: 2000 });
    expect(unknown.error).toMatch(/No account Nope/);
    const invested: any = await runOp(ctx, "save_finance_budget", { name: "Savings", kind: "SAVINGS", accountId: "k1", amount: 2000 });
    expect(invested.error).toMatch(/investment account/);
    const ok: any = await runOp(ctx, "save_finance_budget", { name: "Savings", kind: "SAVINGS", accountName: "joint SAVINGS", amount: 2000, effectiveFrom: "2026-01-01" });
    expect(ok.result.budget).toMatchObject({ kind: "SAVINGS", account: "Joint savings", categories: [], person: null });

    const s = ((await runOp(ctx, "get_finance_summary", {})) as any).result;
    expect(s.savings).toEqual([{ name: "Savings", account: "Joint savings", planned: 2000, saved: 1000 }]);
    expect(s.budget).toMatchObject({ savingsPlanned: 2000, saved: 1000, unallocated: 8000, spentTotal: 0 });
  });
});

describe("save_finance_schedule", () => {
  it("puts a new bill on the household checking account with a negative amount", async () => {
    const { ctx, tables } = setup({ homeFinanceAccount: [{ ...joint, id: "personal", ownerPersonIds: ["gen"] }, joint] });
    const out: any = await runOp(ctx, "save_finance_schedule", { description: "Car payment", amount: 650, nextDate: "2026-12-05", category: "Car Payment", matchPattern: "TOYOTA" });
    expect(out.result).toMatchObject({ action: "created", schedule: { account: "Joint checking", amount: -650, cadence: "MONTHLY", autopay: true } });
    expect(tables.homeFinanceRecurring[0]).toMatchObject({ accountId: "joint", startDate: "2026-12-05" });

    const upd: any = await runOp(ctx, "save_finance_schedule", { recurringId: tables.homeFinanceRecurring[0].id, amount: 700 });
    expect(upd.result.schedule.amount).toBe(-700);
  });

  it("lists what's due soon with a monthly total", async () => {
    const { ctx } = setup({
      homeFinanceAccount: [joint],
      homeFinanceRecurring: [
        { id: "a", accountId: "joint", amount: -100, type: "EXPENSE", description: "Water", cadence: "MONTHLY", startDate: addDays(today, 2), nextDate: addDays(today, 2), active: true },
        { id: "b", accountId: "joint", amount: -1200, type: "EXPENSE", description: "Insurance", cadence: "ANNUALLY", startDate: addDays(today, 60), nextDate: addDays(today, 60), active: true },
      ],
    });
    const out: any = await runOp(ctx, "list_finance_schedules", { dueWithinDays: 7 });
    expect(out.result.schedules.map((s: any) => s.description)).toEqual(["Water"]);
    expect(out.result.monthlyOut).toBe(200);
  });
});

describe("save_finance_goal", () => {
  it("creates an account-funded goal and reports its progress", async () => {
    const { ctx } = setup({ homeFinanceAccount: [{ id: "sav", name: "Savings", type: "SAVINGS", currentBalance: 4000 }] });
    const out: any = await runOp(ctx, "save_finance_goal", { name: "Emergency fund", targetAmount: 10000, fundingAccountId: "sav" });
    expect(out.result).toMatchObject({ action: "created", goal: { current: 4000, pct: 0.4 } });
  });

  it("funds a goal from several accounts and switches it back to manual", async () => {
    const { ctx, tables } = setup({
      homeFinanceAccount: [
        { id: "k1", name: "Gennaro 401k", type: "RETIREMENT", retirementType: "_401K", currentBalance: 300000 },
        { id: "k2", name: "Cristine 401k", type: "RETIREMENT", retirementType: "_401K", currentBalance: 150000 },
      ],
    });
    const out: any = await runOp(ctx, "save_finance_goal", { name: "Retirement", targetAmount: 2000000, fundingAccountIds: ["k1", "k2"] });
    expect(out.result.goal).toMatchObject({ current: 450000, accounts: ["Gennaro 401k", "Cristine 401k"] });
    expect(tables.homeFinanceSavingsGoal[0]).toMatchObject({ fundingAccountIds: ["k1", "k2"], fundingAccountId: null });

    const manual: any = await runOp(ctx, "save_finance_goal", { goalId: out.result.goal.id, fundingAccountIds: [], currentAmount: 10 });
    expect(manual.result.goal).toMatchObject({ current: 10, accounts: [] });
    expect((await runOp(ctx, "save_finance_goal", { name: "X", targetAmount: 1, fundingAccountIds: ["nope"] }) as any).error).toMatch(/No account nope/);
  });
});

describe("itemizing a transaction", () => {
  it("saves line items, filters by an item's category, and removes them", async () => {
    const { ctx, tables } = setup({
      homeFinanceAccount: [joint],
      homeFinanceTransaction: [{ id: "amz", accountId: "joint", amount: -60, description: "AMAZON MKTPL", date: thisMonth, status: "POSTED", category: "Shopping" }],
    });
    const saved: any = await runOp(ctx, "update_finance_transaction", {
      transactionId: "amz",
      lineItems: [
        { name: "Diapers", amount: 30, category: "Baby" },
        { name: " Bulbs ", amount: 30, category: "Home", quantity: 2 },
      ],
    });
    expect(saved.error).toBeUndefined();
    expect(JSON.parse(tables.homeFinanceTransaction[0].lineItems)).toEqual([
      { name: "Diapers", amount: 30, category: "Baby" },
      { name: "Bulbs", amount: 30, category: "Home", quantity: 2 },
    ]);
    const home: any = await runOp(ctx, "list_finance_transactions", { from: thisMonth, category: "home" });
    expect(home.result.transactions[0].items).toHaveLength(2);
    const s = ((await runOp(ctx, "get_finance_summary", {})) as any).result;
    expect(s.budget.unbudgeted).toEqual(expect.arrayContaining([{ category: "Baby", spent: 30 }, { category: "Home", spent: 30 }]));

    await runOp(ctx, "update_finance_transaction", { transactionId: "amz", lineItems: null });
    expect(tables.homeFinanceTransaction[0].lineItems).toBeNull();
    expect(((await runOp(ctx, "update_finance_transaction", { transactionId: "amz", lineItems: [{ amount: 5, category: "" }] })) as any).error).toBeDefined();
  });
});

describe("invested accounts' transactions", () => {
  it("stay out of the summary and the default transaction search", async () => {
    const k401 = { id: "k1", name: "Gennaro 401k", type: "RETIREMENT", currentBalance: 300000, active: true };
    const { ctx } = setup({
      homePerson: people,
      homeFinanceAccount: [joint, k401],
      homeFinanceBudget: [{ id: "c", seriesId: "c", name: "Gennaro", kind: "INCOME", personId: "gen", amount: 10000, period: "MONTHLY", effectiveFrom: "2026-01-01" }],
      homeFinanceTransaction: [
        { id: "t1", accountId: "joint", amount: 10000, category: "Contribution", personId: "gen", date: thisMonth, status: "POSTED" },
        { id: "t2", accountId: "k1", amount: 1500, category: "Contribution", personId: "gen", description: "EMPLOYEE CONTRIBUTION", date: thisMonth, status: "POSTED" },
        { id: "t3", accountId: "k1", amount: -40, description: "mystery fee", date: thisMonth, status: "POSTED" },
      ],
    });
    const s = ((await runOp(ctx, "get_finance_summary", {})) as any).result;
    expect(s.budget.received).toBe(10000);
    expect(s.uncategorizedCount).toBe(0);
    const all = ((await runOp(ctx, "list_finance_transactions", {})) as any).result;
    expect(all.transactions.map((t: any) => t.id)).toEqual(["t1"]);
    const k = ((await runOp(ctx, "list_finance_transactions", { accountId: "k1" })) as any).result;
    expect(k.count).toBe(2);
  });
});

describe("goal milestones", () => {
  it("adds, edits in place, removes, and refuses one above the target", async () => {
    const { ctx, tables } = setup({ homeFinanceAccount: [{ id: "sav", name: "Savings", type: "SAVINGS", currentBalance: 12000 }] });
    const created: any = await runOp(ctx, "save_finance_goal", {
      name: "Emergency fund",
      targetAmount: 30000,
      fundingAccountIds: ["sav"],
      milestones: [
        { targetAmount: 10000, targetDate: "2026-06-01", label: "Cushion" },
        { targetAmount: 20000, targetDate: "2099-01-01" },
      ],
    });
    expect(created.error).toBeUndefined();
    const goal = created.result.goal;
    expect(goal.milestones.map((m: any) => [m.label, m.status])).toEqual([
      ["Cushion", "HIT"],
      [null, "PENDING"],
    ]);
    const [cushion, second] = goal.milestones;

    const edited: any = await runOp(ctx, "save_finance_goal", { goalId: goal.id, milestones: [{ id: second.id, targetAmount: 25000, targetDate: "2099-01-01", label: "Most of it" }] });
    expect(edited.result.goal.milestones).toMatchObject([{ id: second.id, targetAmount: 25000, label: "Most of it" }]);
    expect(tables.homeFinanceGoalMilestone.map((m) => m.id)).toEqual([second.id]);
    expect(tables.homeFinanceGoalMilestone.some((m) => m.id === cushion.id)).toBe(false);

    expect(((await runOp(ctx, "save_finance_goal", { goalId: goal.id, milestones: [{ targetAmount: 40000, targetDate: "2099-01-01" }] })) as any).error).toMatch(/above the goal's target/);
    expect(((await runOp(ctx, "save_finance_goal", { goalId: goal.id, milestones: [{ id: "elsewhere", targetAmount: 1, targetDate: "2099-01-01" }] })) as any).error).toMatch(/isn't on this goal/);
    const s = ((await runOp(ctx, "get_finance_summary", {})) as any).result;
    expect(s.goals[0].milestones).toHaveLength(1);
  });
});

describe("list_finance_holdings", () => {
  it("lists invested accounts with positions, cash and gains", async () => {
    const { ctx } = setup({
      homePerson: people,
      homeFinanceAccount: [
        joint,
        { id: "k1", name: "Gennaro 401k", type: "RETIREMENT", retirementType: "_401K", currentBalance: 10500, ownerPersonIds: ["gen"], active: true },
        { id: "old", name: "Closed IRA", type: "RETIREMENT", currentBalance: 0, active: false },
      ],
      homeFinanceHolding: [
        { accountId: "k1", holdingKey: "VTI", ticker: "VTI", quantity: 20, marketValue: 6000, costBasisTotal: 5000 },
        { accountId: "k1", holdingKey: "FUND:TARGET 2055", description: "Target 2055", quantity: 100, marketValue: 4000, costBasisTotal: null },
      ],
    });
    const out: any = await runOp(ctx, "list_finance_holdings", {});
    expect(out.error).toBeUndefined();
    expect(out.result.total).toBe(10500);
    expect(out.result.accounts).toHaveLength(1);
    expect(out.result.accounts[0]).toMatchObject({ name: "Gennaro 401k", type: "401(k)", owners: ["Gennaro"], cash: 500 });
    expect(out.result.accounts[0].holdings.map((h: any) => h.gain)).toEqual([1000, null]);
    expect((await runOp(ctx, "list_finance_holdings", { accountName: "Joint checking" }) as any).error).toMatch(/No investment account/);
  });
});
