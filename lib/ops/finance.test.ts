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
      // homeFinanceSetting is keyed by `key`, not id.
      get: async ({ id, key }: any) => ({ data: rows.find((r) => (key !== undefined ? r.key === key : r.id === id)) ?? null }),
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
        const row = rows.find((r) => (id !== undefined ? r.id === id : r.key === patch.key));
        if (!row) return { data: null, errors: [{ message: "not found" }] };
        Object.assign(row, patch);
        return { data: row };
      },
      listHomeFinanceTransactionBySpendGroupId: async ({ spendGroupId }: any) => ({ data: rows.filter((r) => r.spendGroupId === spendGroupId), nextToken: null }),
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
  const names = ["homePerson", "homeFinanceAccount", "homeFinanceTransaction", "homeFinanceRecurring", "homeFinanceBudget", "homeFinanceSavingsGoal", "homeFinanceSpendGroup", "homeFinanceCategoryRule", "homeFinanceHolding", "homeFinanceGoalMilestone", "homeFinanceSyncLog", "homeFinanceSetting", "homeFinanceCategory", "homeInvoice"];
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

  it("narrows to one person's accounts, budget and goals with ledger", async () => {
    const { ctx } = setup({
      homePerson: people.map((p) => ({ ...p, cognitoUsername: p.id })),
      homeFinanceAccount: [joint, { id: "gchk", name: "Gennaro checking", type: "CHECKING", currentBalance: 800, ownerPersonIds: ["gen"], active: true }],
      homeFinanceBudget: [
        { id: "b1", seriesId: "food", name: "Food", kind: "EXPENSE", categories: ["Groceries"], amount: 900, period: "MONTHLY", effectiveFrom: "2026-01-01" },
        { id: "b2", seriesId: "fun", name: "Fun", kind: "EXPENSE", categories: ["Entertainment"], amount: 200, period: "MONTHLY", effectiveFrom: "2026-01-01", ledger: "gen" },
      ],
      homeFinanceTransaction: [
        { id: "t1", accountId: "gchk", amount: -50, category: "Entertainment", date: thisMonth, status: "POSTED" },
        { id: "t2", accountId: "joint", amount: -15, description: "zzz mystery", date: thisMonth, status: "POSTED" },
      ],
      homeFinanceSavingsGoal: [
        { id: "g1", name: "Emergency", targetAmount: 10000, fundingAccountIds: ["joint"], active: true },
        { id: "g2", name: "Gennaro's trip", targetAmount: 2000, fundingAccountIds: ["gchk"], active: true },
        { id: "g3", name: "By hand", targetAmount: 500, currentAmount: 100, active: true },
      ],
    });
    const gen = ((await runOp(ctx, "get_finance_summary", { ledger: "Gennaro" })) as any).result;
    expect(gen).toMatchObject({ ledger: "gen", ledgerName: "Gennaro" });
    expect(gen.accounts.map((a: any) => a.name)).toEqual(["Gennaro checking"]);
    expect(gen.budget.lines.map((l: any) => [l.name, l.spent])).toEqual([["Fun", 50]]);
    expect(gen.goals.map((g: any) => g.name)).toEqual(["Gennaro's trip"]);
    expect(gen.uncategorizedCount).toBe(0);

    const home = ((await runOp(ctx, "get_finance_summary", {})) as any).result;
    expect(home.accounts.map((a: any) => [a.name, a.ledger])).toEqual([["Joint checking", "household"]]);
    expect(home.goals.map((g: any) => g.name)).toEqual(["Emergency", "By hand"]);
    expect(home.ledgers.map((l: any) => l.key)).toEqual(["household", "gen", "cris", "all"]);

    const all = ((await runOp(ctx, "get_finance_summary", { ledger: "all" })) as any).result;
    expect(all.accounts).toHaveLength(2);
    expect(all.goals).toHaveLength(3);
  });
});

describe("update_finance_transaction", () => {
  it("sets a manual category and contributor, and remembers a rule on top of the seeded table", async () => {
    const { ctx, tables } = setup({
      homePerson: people,
      homeFinanceAccount: [joint],
      homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: 500, description: "ZELLE FROM CRISTINE R", date: today, category: null }],
    });
    const out: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t", category: "Contribution", personName: "Cristine", rememberPattern: "ZELLE FROM CRISTINE" });
    expect(out.result).toMatchObject({ category: "Contribution", personId: "cris", ruleCreated: true });
    expect(tables.homeFinanceTransaction[0]).toMatchObject({ categorySource: "MANUAL", personSource: "MANUAL" });
    const rules = tables.homeFinanceCategoryRule;
    expect(rules.length).toBeGreaterThan(10); // bundled rules copied in first
    const top = [...rules].sort((a, b) => a.sortOrder - b.sortOrder)[0];
    expect(top).toMatchObject({ pattern: "ZELLE FROM CRISTINE", category: "Contribution", personId: "cris" });
  });

  it("refuses a pattern that doesn't match the transaction", async () => {
    const { ctx } = setup({ homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: -30, description: "COSTCO", date: today }] });
    const out: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t", category: "Groceries", rememberPattern: "HEB" });
    expect(out.error).toMatch(/doesn't match/);
  });
});

describe("creating categories and spend groups while editing", () => {
  it("remembers a new category (and its parent) so list_finance_categories offers it", async () => {
    const { ctx, tables } = setup({ homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: -80, description: "TARGET", date: today }] });
    const out: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t", category: "Nursery:  Paint" });
    expect(out.result.newCategories).toEqual(["Nursery", "Nursery: Paint"]);
    expect(tables.homeFinanceTransaction[0].category).toBe("Nursery: Paint");
    expect(tables.homeFinanceCategory.map((c: any) => c.name)).toEqual(["Nursery", "Paint"]);
    const cats: any = await runOp(ctx, "list_finance_categories", {});
    expect(cats.result.categories).toEqual(expect.arrayContaining(["Nursery", "Nursery: Paint", "Groceries"]));
    // Known already (any case): nothing new.
    const again: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t", category: "groceries" });
    expect(again.result.newCategories).toEqual([]);
  });

  it("remembers itemized categories too", async () => {
    const { ctx } = setup({ homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: -100, description: "AMAZON", date: today }] });
    const out: any = await runOp(ctx, "update_finance_transaction", {
      transactionId: "t",
      lineItems: [
        { name: "Crib sheets", amount: 40, category: "Groceries" },
        { name: "Patio cover", amount: 60, category: "Backyard" },
      ],
    });
    expect(out.result.newCategories).toEqual(["Backyard"]);
  });

  it("creates a spend group, refuses a duplicate name, and tags with it", async () => {
    const { ctx, tables } = setup({ homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: -300, description: "AIRBNB", date: today }] });
    const made: any = await runOp(ctx, "save_finance_spend_group", { name: " Lake  Travis ", kind: "TRIP", budget: 900 });
    expect(made.result).toMatchObject({ created: true, group: { name: "Lake Travis", kind: "TRIP", budget: 900 } });
    const dup: any = await runOp(ctx, "save_finance_spend_group", { name: "lake travis" });
    expect(dup.error).toMatch(/already a spend group/);
    const bad: any = await runOp(ctx, "save_finance_spend_group", { name: "Trip", startDate: "2026-05-02", endDate: "2026-05-01" });
    expect(bad.error).toMatch(/end is before/);
    const listed: any = await runOp(ctx, "list_finance_spend_groups", {});
    expect(listed.result.groups.map((g: any) => g.name)).toEqual(["Lake Travis"]);
    await runOp(ctx, "update_finance_transaction", { transactionId: "t", spendGroupId: made.result.group.id });
    expect(tables.homeFinanceTransaction[0].spendGroupId).toBe(made.result.group.id);
    const missing: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t", spendGroupId: "nope" });
    expect(missing.error).toMatch(/No spend group/);
  });
});

describe("finance category tree", () => {
  const seed = () =>
    setup({
      homeFinanceCategory: [
        { id: "travel", name: "Travel", parentId: null, sortOrder: 0 },
        { id: "sea", name: "Seattle", parentId: "travel", sortOrder: 0 },
        { id: "food", name: "Food", parentId: null, sortOrder: 1 },
      ],
      homeFinanceTransaction: [
        { id: "t1", accountId: "joint", amount: -300, category: "Travel: Seattle", date: today },
        { id: "t2", accountId: "joint", amount: -50, category: "Travel", date: today },
        { id: "t3", accountId: "joint", amount: -90, date: today, lineItems: JSON.stringify([{ name: "x", amount: 90, category: "Travel: Seattle" }]) },
        { id: "t4", accountId: "joint", amount: -20, category: "Food", date: today },
      ],
      homeFinanceCategoryRule: [{ id: "r", pattern: "ALASKA AIR", category: "Travel: Seattle", sortOrder: 0, active: true }],
      homeFinanceBudget: [{ id: "b", seriesId: "s", name: "Travel", kind: "EXPENSE", categories: ["Travel", "Travel: Seattle"], amount: 500, period: "MONTHLY", effectiveFrom: "2026-01-01" }],
    });

  it("lists the tree in order with counts", async () => {
    const { ctx } = seed();
    const out: any = await runOp(ctx, "list_finance_categories", { withCounts: true });
    expect(out.result.tree.map((n: any) => [n.path, n.depth, n.transactions])).toEqual([
      ["Travel", 0, 1],
      ["Travel: Seattle", 1, 2],
      ["Food", 0, 1],
    ]);
    expect(out.result.categories.slice(0, 3)).toEqual(["Travel", "Travel: Seattle", "Food"]);
  });

  it("renaming a parent rewrites its sub-categories everywhere", async () => {
    const { ctx, tables } = seed();
    const out: any = await runOp(ctx, "save_finance_category", { categoryId: "travel", name: "Trips" });
    expect(out.result).toMatchObject({ renamedFrom: "Travel", category: { path: "Trips" }, rewritten: { transactions: 3, rules: 1, budgetLines: 1 } });
    expect(tables.homeFinanceTransaction.map((t: any) => t.category)).toEqual(["Trips: Seattle", "Trips", undefined, "Food"]);
    expect(JSON.parse(tables.homeFinanceTransaction[2].lineItems)[0].category).toBe("Trips: Seattle");
    expect(tables.homeFinanceCategoryRule[0].category).toBe("Trips: Seattle");
    expect(tables.homeFinanceBudget[0].categories).toEqual(["Trips", "Trips: Seattle"]);
  });

  it("moves a category under another, and refuses a loop or a clash", async () => {
    const { ctx, tables } = seed();
    const moved: any = await runOp(ctx, "save_finance_category", { categoryId: "sea", parentId: "food" });
    expect(moved.result.category.path).toBe("Food: Seattle");
    expect(tables.homeFinanceTransaction[0].category).toBe("Food: Seattle");
    const loop: any = await runOp(ctx, "save_finance_category", { categoryId: "food", parentId: "sea" });
    expect(loop.error).toMatch(/inside itself/);
    const clash: any = await runOp(ctx, "save_finance_category", { name: "food" });
    expect(clash.error).toMatch(/already a "Food"/);
    const colon: any = await runOp(ctx, "save_finance_category", { name: "A: B" });
    expect(colon.error).toMatch(/can't contain/);
  });

  it("deleting moves its rows and lifts its sub-categories", async () => {
    const { ctx, tables } = seed();
    const refused: any = await runOp(ctx, "delete_finance_category", { categoryId: "travel" });
    expect(refused.error).toMatch(/has 1 transaction/);
    const out: any = await runOp(ctx, "delete_finance_category", { categoryId: "travel", moveToCategoryId: "food" });
    expect(out.result).toMatchObject({ deleted: "Travel", movedTo: "Food", subcategoriesMoved: 1 });
    expect(tables.homeFinanceTransaction.map((t: any) => t.category)).toEqual(["Seattle", "Food", undefined, "Food"]);
    expect(tables.homeFinanceBudget[0].categories).toEqual(["Food", "Seattle"]);
    expect(tables.homeFinanceCategory.find((c: any) => c.id === "sea").parentId).toBeNull();
  });
});

describe("spend groups and the budget", () => {
  it("copies keepOutOfBudget onto tagged transactions", async () => {
    const { ctx, tables } = setup({ homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: -300, description: "LOWES", date: today }] });
    const g: any = await runOp(ctx, "save_finance_spend_group", { name: "Remodel", keepOutOfBudget: true });
    await runOp(ctx, "update_finance_transaction", { transactionId: "t", spendGroupId: g.result.group.id });
    expect(tables.homeFinanceTransaction[0].outOfBudget).toBe(true);
    const off: any = await runOp(ctx, "save_finance_spend_group", { id: g.result.group.id, name: "Remodel", keepOutOfBudget: false });
    expect(off.result.transactionsUpdated).toBe(1);
    expect(tables.homeFinanceTransaction[0].outOfBudget).toBeNull();
    await runOp(ctx, "save_finance_spend_group", { id: g.result.group.id, name: "Remodel", keepOutOfBudget: true });
    await runOp(ctx, "update_finance_transaction", { transactionId: "t", spendGroupId: null });
    expect(tables.homeFinanceTransaction[0].outOfBudget).toBeNull();
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

  it("moves a last-day-of-month bill to the month's end, on create and on edit", async () => {
    const { ctx, tables } = setup({ homeFinanceAccount: [joint] });
    const out: any = await runOp(ctx, "save_finance_schedule", { description: "BMW", amount: 2000, nextDate: "2026-11-20", lastDayOfMonth: true });
    expect(out.result.schedule).toMatchObject({ nextDate: "2026-11-30", startDate: "2026-11-30", lastDayOfMonth: true });
    const upd: any = await runOp(ctx, "save_finance_schedule", { recurringId: tables.homeFinanceRecurring[0].id, nextDate: "2027-02-03" });
    expect(upd.result.schedule.nextDate).toBe("2027-02-28");
    const paid: any = await runOp(ctx, "save_finance_schedule", { recurringId: tables.homeFinanceRecurring[0].id, markPaid: true });
    expect(paid.result.schedule.nextDate).toBe("2027-03-31");
    const off: any = await runOp(ctx, "save_finance_schedule", { recurringId: tables.homeFinanceRecurring[0].id, lastDayOfMonth: false, nextDate: "2027-04-15" });
    expect(off.result.schedule).toMatchObject({ nextDate: "2027-04-15", lastDayOfMonth: false });
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
    expect(out.result.monthlyIn).toBe(0);
  });
});

describe("link_finance_schedules", () => {
  it("links stored rows to a household bill on a personal card, carrying its category and budget", async () => {
    const card = { ...joint, id: "amex", name: "AMEX", type: "CREDIT", ownerPersonIds: ["gen"] };
    const { ctx, tables } = setup({
      homePerson: people,
      homeFinanceAccount: [joint, card],
      homeFinanceRecurring: [],
      homeFinanceTransaction: [
        { id: "t1", accountId: "amex", date: "2026-11-11", amount: -19.65, description: "HBO Max NEW YORK NY", category: "Entertainment", categorySource: "LLM", status: "POSTED" },
        { id: "t2", accountId: "amex", date: "2026-11-12", amount: -75.76, description: "ADOBE", category: "Subscriptions", status: "POSTED" },
      ],
    });
    const made: any = await runOp(ctx, "save_finance_schedule", { description: "HBO Max", amount: 19.65, nextDate: "2026-11-10", accountId: "amex", category: "Streaming", matchPattern: "HBO Max", ledger: "household" });
    expect(made.result.schedule).toMatchObject({ ledger: "household", ledgerName: "Household" });

    const dry: any = await runOp(ctx, "link_finance_schedules", { from: "2026-11-01", to: "2026-11-20", dryRun: true });
    expect(dry.result.linked.map((l: any) => [l.transactionId, l.schedule, l.nextDate])).toEqual([["t1", "HBO Max", "2026-12-10"]]);
    expect(tables.homeFinanceTransaction[0].recurringId).toBeUndefined();

    await runOp(ctx, "link_finance_schedules", { from: "2026-11-01", to: "2026-11-20" });
    expect(tables.homeFinanceTransaction[0]).toMatchObject({ recurringId: made.result.schedule.id, category: "Streaming", categorySource: "RULE", ledger: "household" });
    expect(tables.homeFinanceRecurring[0].nextDate).toBe("2026-12-10");
    // Already linked: nothing more to do.
    expect((await runOp(ctx, "link_finance_schedules", { from: "2026-11-01", to: "2026-11-20" }) as any).result.linked).toEqual([]);
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

describe("summary extras for the phone", () => {
  it("adds each account's buffer and projected low, goal ids, the line cadence and the last sync", async () => {
    const { ctx } = setup({
      homeFinanceAccount: [{ ...joint, institution: "Chase" }],
      homeFinanceRecurring: [
        { id: "m", accountId: "joint", amount: -5500, type: "EXPENSE", description: "Mortgage", cadence: "MONTHLY", startDate: addDays(today, 3), nextDate: addDays(today, 3), active: true },
      ],
      homeFinanceSavingsGoal: [{ id: "g", name: "Baby", targetAmount: 1000, currentAmount: 250, active: true }],
      homeFinanceBudget: [{ id: "b", seriesId: "food", name: "Food", kind: "EXPENSE", categories: ["Groceries"], amount: 900, period: "MONTHLY", effectiveFrom: "2026-01-01" }],
      homeFinanceSyncLog: [
        { id: "l1", startedAt: "2026-11-01T10:00:00Z", status: "ERROR" },
        { id: "l2", startedAt: "2026-11-02T10:00:00Z", finishedAt: "2026-11-02T10:01:00Z", status: "OK", txInserted: 4 },
      ],
    });
    const s = ((await runOp(ctx, "get_finance_summary", {})) as any).result;
    expect(s.accounts[0]).toMatchObject({ institution: "Chase", minBalance: 1000, invested: false, lowPoint: { date: addDays(today, 3), balance: 500 } });
    expect(s.goals[0]).toMatchObject({ id: "g", current: 250 });
    expect(s.budget.lines[0].period).toBe("MONTHLY");
    expect(s.budget.elapsed).toBeGreaterThan(0);
    expect(s.lastSync).toEqual({ status: "OK", at: "2026-11-02T10:01:00Z", txInserted: 4 });
  });
});

describe("get_finance_budget", () => {
  const lines = [
    { id: "c", seriesId: "c", name: "Cristine", kind: "INCOME", personId: "cris", amount: 3000, period: "MONTHLY", effectiveFrom: "2026-01-01" },
    { id: "f", seriesId: "food", name: "Food", kind: "EXPENSE", categories: ["Groceries"], amount: 900, period: "MONTHLY", effectiveFrom: "2026-01-01" },
    { id: "t", seriesId: "travel", name: "Travel", kind: "EXPENSE", categories: ["Travel"], amount: 1500, period: "QUARTERLY", effectiveFrom: "2026-01-01" },
  ];
  const txs = [
    { id: "t1", accountId: "joint", amount: 3000, category: "Contribution", personId: "cris", date: "2026-11-02", status: "POSTED" },
    { id: "t2", accountId: "joint", amount: -300, category: "Groceries", date: "2026-11-03", status: "POSTED" },
    { id: "t3", accountId: "joint", amount: -50, category: "Pets", date: "2026-11-04", status: "POSTED" },
  ];

  it("shows a month's monthly lines by default and adds quarterly ones for a quarter", async () => {
    const { ctx } = setup({ homePerson: people, homeFinanceAccount: [joint], homeFinanceBudget: lines, homeFinanceTransaction: txs });
    const month: any = await runOp(ctx, "get_finance_budget", { period: "2026-11" });
    expect(month.error).toBeUndefined();
    expect(month.result).toMatchObject({ period: "2026-11", label: "November 2026", include: ["MONTHLY", "ONCE"], planned: 3000, received: 3000 });
    expect(month.result.lines.map((l: any) => [l.name, l.spent, l.remaining])).toEqual([["Food", 300, 600]]);
    expect(month.result.contributions[0]).toMatchObject({ seriesId: "c", person: "Cristine", personId: "cris", spent: 3000 });
    expect(month.result.unbudgeted).toEqual([{ category: "Pets", spent: 50 }]);

    const quarter: any = await runOp(ctx, "get_finance_budget", { period: "2026-Q4" });
    expect(quarter.result.include).toEqual(["MONTHLY", "QUARTERLY", "ONCE"]);
    expect(quarter.result.lines.map((l: any) => [l.name, l.budgeted, l.amount])).toEqual([
      ["Food", 2700, 900],
      ["Travel", 1500, 1500],
    ]);

    const onlyQuarterly: any = await runOp(ctx, "get_finance_budget", { period: "2026-Q4", include: ["QUARTERLY"] });
    expect(onlyQuarterly.result.lines.map((l: any) => l.name)).toEqual(["Travel"]);
    expect((await runOp(ctx, "get_finance_budget", { period: "Nov" }) as any).error).toMatch(/YYYY-MM/);
  });
});

describe("list_finance_transactions for the phone", () => {
  it("filters by any of a line's categories and returns the ids an edit needs", async () => {
    const { ctx } = setup({
      homePerson: people,
      homeFinanceAccount: [joint],
      homeFinanceTransaction: [
        { id: "a", accountId: "joint", amount: -10, category: "Groceries", personId: "gen", date: thisMonth, status: "POSTED" },
        { id: "b", accountId: "joint", amount: -20, category: "Dining", date: thisMonth, status: "POSTED" },
        { id: "c", accountId: "joint", amount: -30, category: "Gas", date: thisMonth, status: "POSTED" },
      ],
    });
    const out: any = await runOp(ctx, "list_finance_transactions", { from: thisMonth, categories: ["groceries", "Dining"] });
    expect(out.result.transactions.map((t: any) => t.id).sort()).toEqual(["a", "b"]);
    expect(out.result.transactions.find((t: any) => t.id === "a")).toMatchObject({ personId: "gen", person: "Gennaro", accountId: "joint" });
  });
});

describe("list_finance_transactions: several accounts and contributors, sorted", () => {
  it("matches any picked account or contributor and sorts by date, size or description", async () => {
    const card = { id: "card", name: "Card", type: "CREDIT", currentBalance: -100, active: true };
    const other = { id: "other", name: "Other", type: "CHECKING", currentBalance: 0, active: true };
    const day = (n: number) => `${thisMonth.slice(0, 8)}0${n}`;
    const { ctx } = setup({
      homePerson: people,
      homeFinanceAccount: [joint, card, other],
      homeFinanceTransaction: [
        { id: "a", accountId: "joint", amount: -10, description: "Coffee", category: "Dining", date: day(1), status: "POSTED" },
        { id: "b", accountId: "card", amount: -500, description: "Bed", category: "Home", date: day(2), status: "POSTED" },
        { id: "c", accountId: "other", amount: -50, description: "Gas", category: "Fuel", date: day(3), status: "POSTED" },
        { id: "d", accountId: "joint", amount: 200, description: "Zelle", category: "Contribution", personId: "cris", date: day(4), status: "POSTED" },
        { id: "e", accountId: "joint", amount: 100, description: "Zelle", category: "Contribution", personId: "gen", date: day(5), status: "POSTED" },
      ],
    });
    const ids = async (input: Record<string, unknown>) => ((await runOp(ctx, "list_finance_transactions", { from: thisMonth, ...input })) as any).result.transactions.map((t: any) => t.id);
    expect(await ids({ accountIds: ["joint", "card"] })).toEqual(["e", "d", "b", "a"]);
    expect(await ids({ personIds: ["cris", "gen"], sort: "oldest" })).toEqual(["d", "e"]);
    expect(await ids({ sort: "largest" })).toEqual(["b", "d", "e", "c", "a"]);
    expect(await ids({ sort: "smallest" })).toEqual(["a", "c", "e", "d", "b"]);
    expect(await ids({ sort: "description" })).toEqual(["b", "a", "c", "e", "d"]);
  });
});

describe("marking a schedule paid", () => {
  it("rolls nextDate one step, switches a one-time one off, and lists the fields an edit needs", async () => {
    const { ctx, tables } = setup({
      homeFinanceAccount: [joint],
      homeFinanceRecurring: [
        { id: "w", accountId: "joint", amount: -80, type: "EXPENSE", description: "Water", cadence: "MONTHLY", startDate: "2026-01-15", nextDate: "2026-11-15", matchPattern: "CITY WATER", autopay: false, active: true },
        { id: "o", accountId: "joint", amount: -500, type: "EXPENSE", description: "Deposit", cadence: "ONCE", startDate: "2026-11-20", nextDate: "2026-11-20", active: true },
      ],
    });
    const paid: any = await runOp(ctx, "save_finance_schedule", { recurringId: "w", markPaid: true });
    expect(paid.result.schedule).toMatchObject({ nextDate: "2026-12-15", matchPattern: "CITY WATER", accountId: "joint", autopay: false });
    await runOp(ctx, "save_finance_schedule", { recurringId: "o", markPaid: true });
    expect(tables.homeFinanceRecurring.find((r) => r.id === "o")?.active).toBe(false);
    expect((await runOp(ctx, "save_finance_schedule", { markPaid: true }) as any).error).toMatch(/recurringId/);
  });
});

describe("list_finance_goals", () => {
  it("lists active goals by priority with funding, milestones and notes; archived ones on request", async () => {
    const { ctx } = setup({
      homeFinanceAccount: [{ id: "sav", name: "Savings", type: "SAVINGS", currentBalance: 5000 }],
      homeFinanceSavingsGoal: [
        { id: "trip", name: "Trip", targetAmount: 2000, currentAmount: 500, priority: 200, active: true, notes: "Japan" },
        { id: "ef", name: "Emergency fund", targetAmount: 10000, fundingAccountIds: ["sav"], priority: 10, active: true },
        { id: "old", name: "Old car", targetAmount: 100, active: false },
      ],
      homeFinanceGoalMilestone: [{ id: "m1", goalId: "ef", targetAmount: 4000, targetDate: "2099-01-01", label: "Half", notes: "by spring" }],
    });
    const out: any = await runOp(ctx, "list_finance_goals", {});
    expect(out.result.goals.map((g: any) => g.id)).toEqual(["ef", "trip"]);
    expect(out.result.goals[0]).toMatchObject({ funded: "account", current: 5000, pct: 0.5, fundedBy: ["Savings"], fundingAccountIds: ["sav"] });
    expect(out.result.goals[0].milestones[0]).toMatchObject({ id: "m1", status: "HIT", notes: "by spring" });
    expect(out.result.goals[1]).toMatchObject({ funded: "manual", currentAmount: 500, notes: "Japan" });
    const all: any = await runOp(ctx, "list_finance_goals", { includeInactive: true });
    expect(all.result.goals.map((g: any) => g.id)).toEqual(["ef", "trip", "old"]);
  });
});

describe("ledgers (household vs personal budgets)", () => {
  const folks = [
    { id: "gen", name: "Gennaro Anesi", groups: ["home-users"], cognitoUsername: "g" },
    { id: "cris", name: "Cristine", groups: ["home-users"], cognitoUsername: "c" },
    { id: "guest", name: "Guest", groups: [], cognitoUsername: "x" },
  ];
  const cCard = { id: "ccard", name: "Cristine card", type: "CREDIT", ownerPersonIds: ["cris"], active: true };
  const seed = () => ({
    homePerson: folks,
    homeFinanceAccount: [joint, cCard],
    homeFinanceBudget: [
      { id: "b1", seriesId: "c", name: "Cristine → household", kind: "INCOME", personId: "cris", amount: 2000, period: "MONTHLY", effectiveFrom: "2026-01-01" },
      { id: "b2", seriesId: "food", name: "Food", kind: "EXPENSE", categories: ["Groceries"], amount: 900, period: "MONTHLY", effectiveFrom: "2026-01-01" },
    ],
    homeFinanceTransaction: [
      { id: "t1", accountId: "joint", amount: 1500, category: "Contribution", personId: "cris", date: thisMonth, status: "POSTED" },
      { id: "t2", accountId: "ccard", amount: -100, description: "TARGET", category: "Groceries", date: thisMonth, status: "POSTED" },
      { id: "t3", accountId: "ccard", amount: -40, description: "SEPHORA", category: "Shopping", date: thisMonth, status: "POSTED" },
    ],
  });

  it("moves a personal-card charge into the household budget, where it counts as her contribution", async () => {
    const { ctx, tables } = setup(seed());
    const before: any = await runOp(ctx, "get_finance_budget", {});
    expect(before.result.lines[0]).toMatchObject({ name: "Food", spent: 0 });
    expect(before.result.ledgers.map((l: any) => l.name)).toEqual(["Household", "Gennaro Anesi", "Cristine", "Everything"]);

    const upd: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t2", ledger: "household" });
    expect(upd.error).toBeUndefined();
    expect(tables.homeFinanceTransaction.find((t) => t.id === "t2").ledger).toBe("household");

    const after: any = await runOp(ctx, "get_finance_budget", {});
    expect(after.result.lines[0]).toMatchObject({ name: "Food", spent: 100 });
    expect(after.result.contributions[0]).toMatchObject({ person: "Cristine", spent: 1600 });
    expect(after.result.paidDirectly).toEqual([{ personId: "cris", person: "Cristine", amount: 100 }]);

    const hers: any = await runOp(ctx, "get_finance_budget", { ledger: "cristine" });
    expect(hers.result).toMatchObject({ ledger: "cris", ledgerName: "Cristine", spentTotal: 40, toHousehold: { planned: 2000, sent: 1600 } });

    const listed: any = await runOp(ctx, "list_finance_transactions", { ledger: "Cristine" });
    expect(listed.result.transactions.map((t: any) => [t.id, t.ledgerName, t.ledgerSet])).toEqual([["t3", "Cristine", false]]);
  });

  it("itemizes one charge across budgets", async () => {
    const { ctx, tables } = setup(seed());
    const out: any = await runOp(ctx, "update_finance_transaction", {
      transactionId: "t2",
      lineItems: [
        { name: "groceries", amount: 70, category: "Groceries", ledger: "household" },
        { name: "lipstick", amount: 30, category: "Shopping" },
      ],
    });
    expect(out.error).toBeUndefined();
    expect(JSON.parse(tables.homeFinanceTransaction.find((t) => t.id === "t2").lineItems)).toEqual([
      { name: "groceries", amount: 70, category: "Groceries", ledger: "household" },
      { name: "lipstick", amount: 30, category: "Shopping" },
    ]);
    const hh: any = await runOp(ctx, "get_finance_budget", {});
    expect(hh.result.lines[0]).toMatchObject({ name: "Food", spent: 70 });
    const hers: any = await runOp(ctx, "get_finance_budget", { ledger: "Cristine" });
    expect(hers.result.spentTotal).toBe(70); // $30 lipstick + $40 Sephora
  });

  it("keeps a personal line's categories apart from the household's, and a personal income line is the owner's", async () => {
    const { ctx } = setup(seed());
    const groceries: any = await runOp(ctx, "save_finance_budget", { name: "My groceries", categories: ["Groceries"], amount: 100, ledger: "Cristine" });
    expect(groceries.error).toBeUndefined();
    expect(groceries.result.budget.ledger).toBe("cris");
    const pay: any = await runOp(ctx, "save_finance_budget", { name: "Pay", kind: "INCOME", amount: 5000, ledger: "cristine" });
    expect(pay.result.budget).toMatchObject({ person: "Cristine", ledger: "cris" });
    const nick: any = await runOp(ctx, "get_finance_budget", { ledger: "Cris" });
    expect(nick.result.ledger).toBe("cris");
    const guest: any = await runOp(ctx, "get_finance_budget", { ledger: "nobody" });
    expect(guest.error).toMatch(/No ledger/);
  });
});

describe("a transaction's person is only a contributor", () => {
  it("refuses a person on money out and points at the ledger", async () => {
    const { ctx } = setup({ homePerson: people, homeFinanceAccount: [joint], homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: -30, description: "HEB", date: today }] });
    const out: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t", personName: "Cristine" });
    expect(out.error).toMatch(/only set on money in[\s\S]*ledger/);
  });
});

describe("budget (ledger) from rules", () => {
  it("remember for similar saves the budget picked in the same edit, and marks it MANUAL on the row", async () => {
    const { ctx, tables } = setup({ homePerson: people, homeFinanceAccount: [joint], homeFinanceTransaction: [{ id: "t", accountId: "joint", amount: -15, description: "NETFLIX.COM", date: today }] });
    const out: any = await runOp(ctx, "update_finance_transaction", { transactionId: "t", category: "Streaming", ledger: "Gennaro", rememberPattern: "NETFLIX" });
    expect(out.error).toBeUndefined();
    expect(tables.homeFinanceTransaction[0]).toMatchObject({ ledger: "gen", ledgerSource: "MANUAL" });
    const rule = tables.homeFinanceCategoryRule.find((r: any) => r.pattern === "NETFLIX");
    expect(rule).toMatchObject({ category: "Streaming", ledger: "gen" });
  });

  it("CSV import applies a rule's budget", async () => {
    const heb = { id: "heb", name: "H-E-B Card", type: "CREDIT", active: true, ownerPersonIds: ["cris"] };
    const { ctx, tables } = setup({
      homePerson: people,
      homeFinanceAccount: [heb],
      homeFinanceCategoryRule: [{ id: "r", pattern: "H-E-B", category: "Groceries", ledger: "household", sortOrder: 0, active: true }],
    });
    await runOp(ctx, "import_finance_transactions", { accountId: "heb", csv: 'Date,Amount,Type,Merchant,Category,Method\n"2026/11/02, 10:11:12",84.10,PURCHASE,H-E-B #123,Groceries,Card' });
    expect(tables.homeFinanceTransaction[0]).toMatchObject({ category: "Groceries", ledger: "household", ledgerSource: "RULE" });
  });
});

describe("import_finance_transactions", () => {
  const HEB = [
    "Date,Amount,Type,Merchant,Category,Method",
    '"2026/11/02, 10:11:12",84.10,PURCHASE,H-E-B #123,Groceries,Card',
    '"2026/11/02, 18:01:00",4.99,PURCHASE,H-E-B #123,Groceries,Card',
    '"2026/11/02, 18:02:00",4.99,PURCHASE,H-E-B #123,Groceries,Card',
    '"2026/11/05, 09:00:00",-500.00,PAYMENT,,,ACH',
    '"2026/11/09, 12:00:00",-12.00,RETURN,H-E-B #123,Groceries,Card',
  ].join("\n");
  const heb = { id: "heb", name: "H-E-B Card", type: "CREDIT", active: true };

  it("previews, imports with categories, and skips what's already there on a re-import", async () => {
    const { ctx, tables } = setup({ homeFinanceAccount: [heb, { ...joint, simplefinAccountId: "sf1" }] });
    const dry: any = await runOp(ctx, "import_finance_transactions", { accountName: "H-E-B Card", csv: HEB, dryRun: true });
    expect(dry.error).toBeUndefined();
    expect(dry.result).toMatchObject({ format: "H-E-B Card", parsed: 5, duplicates: 0, created: 5, from: "2026-11-02", to: "2026-11-09" });
    expect(tables.homeFinanceTransaction).toHaveLength(0);
    expect(dry.result.rows.map((r: any) => [r.amount, r.category])).toEqual([
      [-84.1, "Groceries"],
      [-4.99, "Groceries"],
      [-4.99, "Groceries"],
      [500, "Credit Card Payment"],
      [12, "Groceries"], // a return: keeps the store's category and nets against it
    ]);

    await runOp(ctx, "import_finance_transactions", { accountId: "heb", csv: HEB });
    expect(tables.homeFinanceTransaction).toHaveLength(5);
    // The same file again plus one new row: only the new row goes in.
    const again: any = await runOp(ctx, "import_finance_transactions", { accountId: "heb", csv: HEB + '\n"2026/11/10, 08:00:00",3.50,PURCHASE,H-E-B #9,Groceries,Card' });
    expect(again.result).toMatchObject({ duplicates: 5, created: 1 });
    expect(tables.homeFinanceTransaction).toHaveLength(6);
    // The balance is the running total of every row.
    expect(again.result.balance).toEqual({ before: 417.92, after: 414.42 });
    expect(tables.homeFinanceAccount.find((x: any) => x.id === "heb").currentBalance).toBe(414.42);
    // Kept as set by hand when asked.
    await runOp(ctx, "import_finance_transactions", { accountId: "heb", csv: 'Date,Amount,Type,Merchant,Category,Method\n"2026/11/11, 08:00:00",1.00,PURCHASE,H-E-B #9,Groceries,Card', setBalance: false });
    expect(tables.homeFinanceAccount.find((x: any) => x.id === "heb").currentBalance).toBe(414.42);

    const synced: any = await runOp(ctx, "import_finance_transactions", { accountId: "joint", csv: HEB });
    expect(synced.error).toMatch(/SimpleFIN/);
  });
});
