import { describe, expect, it } from "vitest";
import { categoryParts, classify, effectiveCategory, parseLineItems, rulesFromDbRows, CATEGORY_RULES } from "./categories";
import { addMonthsAnchored, monthRange, occurrencesBetween, todayIso } from "./dates";
import { budgetTransactions, spendByCategory, totalOutflow, filterBudgetView, householdBudget, planBudgetChange, resolveBudgetLines, validateBudgetHistory, budgetedForRange, type BudgetLine } from "./budget";
import { findScheduleMatches, lowestPoint, nextDateAfter, projectBalance, upcomingEvents } from "./recurring";
import { goalProgress, milestoneViews } from "./goals";
import { buildDedupIndex, desiredHoldingsFromSf, diffHoldings, holdingKeyOf, markSelfTransfers, reconcileDraft, sfTxToDraft, syncedTransactionId, type TxDraft } from "./sync-engine";
import type { SfAccount } from "./simplefin";
import type { RecurringLike, TxLike } from "./types";

describe("categories", () => {
  it("files household merchants from the bundled rules", () => {
    expect(classify({ description: "H-E-B #123 AUSTIN TX", amount: -84.1 }).category).toBe("Groceries");
    expect(classify({ description: "ROCKET MORTGAGE MORTGAGE PMT", amount: -2400 }).category).toBe("Mortgage Payment");
  });

  it("turns money in under a transfer rule into a Contribution, and spend rules into Refund", () => {
    expect(classify({ description: "ONLINE TRANSFER FROM CHK 1234", amount: 2500 }).category).toBe("Contribution");
    expect(classify({ description: "ONLINE TRANSFER TO SAV 9876", amount: -500 }).category).toBe("Transfers");
    expect(classify({ description: "H-E-B #123", amount: 12 }).category).toBe("Refund");
  });

  it("lets person rules sit beside category rules", () => {
    const rules = rulesFromDbRows([
      { pattern: "/transfer from chk 1234/i", personId: "gennaro", sortOrder: 1 },
      { pattern: "/transfer from/i", category: "Transfers", sortOrder: 2 },
    ]);
    expect(classify({ description: "Online Transfer from CHK 1234", amount: 3000 }, rules)).toEqual({ category: "Contribution", personId: "gennaro" });
    expect(classify({ description: "Online Transfer from CHK 5555", amount: 3000 }, rules)).toEqual({ category: "Contribution", personId: null });
  });

  it("falls back to the bundled rules when the table is empty and keeps a stored category", () => {
    expect(rulesFromDbRows([])).toBe(CATEGORY_RULES);
    expect(effectiveCategory({ category: "Baby", description: "H-E-B" })).toBe("Baby");
    expect(effectiveCategory({ description: "zzz unknown merchant", amount: -5 })).toBe("Uncategorized");
  });
});

describe("dates", () => {
  it("keeps the anchor day across short months", () => {
    expect(addMonthsAnchored("2027-01-31", 1, 31)).toBe("2027-02-28");
    expect(addMonthsAnchored("2027-02-28", 1, 31)).toBe("2027-03-31");
  });

  it("lists occurrences in a window and stops at endDate", () => {
    expect(occurrencesBetween({ cadence: "MONTHLY", startDate: "2026-01-15", nextDate: "2026-11-15" }, "2026-11-01", "2027-01-31")).toEqual([
      "2026-11-15",
      "2026-12-15",
      "2027-01-15",
    ]);
    expect(occurrencesBetween({ cadence: "BIWEEKLY", nextDate: "2026-11-06", endDate: "2026-11-25" }, "2026-11-01", "2026-12-31")).toEqual(["2026-11-06", "2026-11-20"]);
    expect(occurrencesBetween({ cadence: "ONCE", nextDate: "2026-11-06" }, "2026-11-01", "2026-12-31")).toEqual(["2026-11-06"]);
  });

  it("gives today in Chicago, not UTC", () => {
    expect(todayIso("America/Chicago", new Date("2026-11-10T03:00:00Z"))).toBe("2026-11-09");
  });
});

const nov = monthRange("2026-11-15");
const line = (over: Partial<BudgetLine>): BudgetLine => ({ id: "x", seriesId: "s", name: "x", amount: 0, period: "MONTHLY", effectiveFrom: "2026-01-01", ...over });
const tx = (over: Partial<TxLike>): TxLike => ({ id: Math.random().toString(36), accountId: "joint", status: "POSTED", date: "2026-11-05", ...over });

describe("budget", () => {
  it("resolves the version in force and closes the old one the day before", () => {
    const v1 = line({ id: "v1", amount: 800, effectiveFrom: "2026-01-01" });
    const plan = planBudgetChange(v1, { seriesId: "s", name: "Groceries", categories: ["Groceries"], amount: 1000 }, "2026-11-01");
    expect(plan.close).toEqual({ id: "v1", effectiveTo: "2026-10-31" });
    const v2 = { ...plan.insert, id: "v2" };
    const closed = { ...v1, effectiveTo: "2026-10-31" };
    expect(resolveBudgetLines([closed, v2], "2026-10-15")[0].id).toBe("v1");
    expect(resolveBudgetLines([closed, v2], "2026-11-15")[0].id).toBe("v2");
    // A half-applied change (close failed) still resolves to the new version.
    expect(resolveBudgetLines([v1, v2], "2026-11-15")[0].id).toBe("v2");
  });

  it("flags a category in two spending lines", () => {
    const issues = validateBudgetHistory(
      [line({ id: "a", seriesId: "a", name: "Food", categories: ["Groceries", "Dining"] }), line({ id: "b", seriesId: "b", name: "Fun", categories: ["Dining"] })],
      "2026-11-15",
    );
    expect(issues.map((i) => i.kind)).toEqual(["shared-category"]);
  });

  it("scales recurring lines and keeps one-offs in their own period", () => {
    expect(budgetedForRange(line({ amount: 600, period: "QUARTERLY" }), nov)).toBe(200);
    expect(budgetedForRange(line({ amount: 5000, period: "ONCE", effectiveFrom: "2026-11-20" }), nov)).toBe(5000);
    expect(budgetedForRange(line({ amount: 5000, period: "ONCE", effectiveFrom: "2026-12-01" }), nov)).toBe(0);
  });

  it("measures the household month: contributions per person, spending per line, unbudgeted", () => {
    const lines = [
      line({ id: "g", seriesId: "g", name: "Gennaro", kind: "INCOME", personId: "gen", amount: 4000 }),
      line({ id: "c", seriesId: "c", name: "Cristine", kind: "INCOME", personId: "cris", amount: 3000 }),
      line({ id: "h", seriesId: "h", name: "Home", categories: ["Mortgage Payment", "Utilities"], amount: 3000 }),
      line({ id: "f", seriesId: "f", name: "Food", categories: ["Groceries"], amount: 900 }),
    ];
    const txs = [
      tx({ amount: 4000, category: "Contribution", personId: "gen" }),
      tx({ amount: 1500, category: "Contribution", personId: "cris" }),
      tx({ amount: -2400, category: "Mortgage Payment" }),
      tx({ amount: -1000, category: "Groceries" }),
      tx({ amount: -60, category: "Pets" }),
      tx({ amount: -500, category: "Transfers" }), // internal: never counted
      tx({ amount: -200, category: "Groceries", spendGroupId: "trip" }), // counts toward its group, not the budget
      tx({ amount: -99, category: "Groceries", status: "PENDING" }),
    ];
    const schedules: RecurringLike[] = [{ id: "m", accountId: "joint", amount: -2400, type: "EXPENSE", category: "Mortgage Payment", cadence: "MONTHLY", startDate: "2026-01-01", nextDate: "2026-11-01" }];
    const v = householdBudget(lines, txs, schedules, nov, "2026-11-15");
    expect(v.planned).toBe(7000);
    expect(v.received).toBe(5500);
    expect(v.incomeViews.map((x) => [x.line.personId, x.spent])).toEqual([
      ["cris", 1500],
      ["gen", 4000],
    ]);
    expect(v.expenseViews.find((x) => x.line.id === "h")).toMatchObject({ spent: 2400, committed: 2400, variable: 600 });
    expect(v.expenseViews.find((x) => x.line.id === "f")).toMatchObject({ spent: 1000, remaining: -100 });
    expect(v.overspend).toBe(100);
    expect(v.unassigned).toEqual([{ category: "Pets", spent: 60 }]);
    expect(v.spentTotal).toBe(3660);
  });

  it("splits a person's contributions across their lines by what each plans", () => {
    const lines = [
      line({ id: "m", seriesId: "m", name: "Monthly", kind: "INCOME", personId: "gen", amount: 9000 }),
      line({ id: "t", seriesId: "t", name: "Travel", kind: "INCOME", personId: "gen", amount: 3000, period: "QUARTERLY" }),
      line({ id: "c", seriesId: "c", name: "Cris", kind: "INCOME", personId: "cris", amount: 1000 }),
    ];
    const txs = [tx({ amount: 5000, category: "Contribution", personId: "gen" }), tx({ amount: 1000, category: "Contribution", personId: "cris" })];
    const v = householdBudget(lines, txs, [], nov, "2026-11-15");
    // November: Monthly plans 9,000 and Travel 1,000 (3,000 a quarter), so 90% / 10%.
    expect(Object.fromEntries(v.incomeViews.map((x) => [x.line.id, [x.budgeted, x.spent]]))).toEqual({ m: [9000, 4500], t: [1000, 500], c: [1000, 1000] });
    expect(v.received).toBe(6000);
  });

  it("filters lines by how often they repeat without moving shares or unbudgeted spending", () => {
    const lines = [
      line({ id: "m", seriesId: "m", name: "Monthly", kind: "INCOME", personId: "gen", amount: 9000 }),
      line({ id: "t", seriesId: "t", name: "Travel", kind: "INCOME", personId: "gen", amount: 3000, period: "QUARTERLY" }),
      line({ id: "f", seriesId: "f", name: "Food", categories: ["Groceries"], amount: 900 }),
      line({ id: "h", seriesId: "h", name: "Home", categories: ["Home"], amount: 6000, period: "ANNUALLY" }),
    ];
    const txs = [tx({ amount: 5000, category: "Contribution", personId: "gen" }), tx({ amount: -300, category: "Home" }), tx({ amount: -100, category: "Groceries" })];
    const full = householdBudget(lines, txs, [], nov, "2026-11-15");
    const monthly = filterBudgetView(full, new Set(["MONTHLY"]));
    expect(monthly.incomeViews.map((v) => [v.line.id, v.spent])).toEqual([["m", 4500]]);
    expect(monthly.expenseViews.map((v) => v.line.id)).toEqual(["f"]);
    expect(monthly).toMatchObject({ planned: 9000, received: 4500, allocated: 900, spentBudgeted: 100, unallocated: 8100, spentTotal: 400, unassigned: [] });
    const all = filterBudgetView(full, new Set(["MONTHLY", "QUARTERLY", "ANNUALLY", "ONCE"]));
    expect(all.expenseViews.map((v) => v.line.id).sort()).toEqual(["f", "h"]);

    // A one-time line shows only in a period its date falls in.
    const once = [...lines, line({ id: "o", seriesId: "o", name: "Crib", categories: ["Baby"], amount: 800, period: "ONCE", effectiveFrom: "2026-10-01" })];
    const octOnly = (w: typeof nov) => filterBudgetView(householdBudget(once, [], [], w, "2026-11-15"), new Set(["MONTHLY", "ONCE"])).expenseViews.map((v) => v.line.id);
    expect(octOnly(nov)).not.toContain("o");
    expect(octOnly(monthRange("2026-10-10"))).toContain("o");
  });

  it("plans savings into an account and counts what lands there, net of withdrawals, without interest", () => {
    const lines = [
      line({ id: "g", seriesId: "g", name: "Gennaro", kind: "INCOME", personId: "gen", amount: 10000 }),
      line({ id: "s", seriesId: "s", name: "Joint savings", kind: "SAVINGS", accountId: "sav", amount: 1500 }),
      line({ id: "f", seriesId: "f", name: "Food", categories: ["Groceries"], amount: 900 }),
    ];
    const txs = [
      tx({ accountId: "joint", amount: -1200, category: "Transfers" }),
      tx({ accountId: "sav", amount: 1200, category: "Transfers" }),
      tx({ accountId: "sav", amount: 500, category: "Contribution", personId: "cris" }), // straight into savings
      tx({ accountId: "sav", amount: -200, category: "Transfers" }), // moved back out
      tx({ accountId: "sav", amount: 12.5, category: "Interest" }),
      tx({ accountId: "sav", amount: 300, category: "Transfers", status: "PENDING" }),
    ];
    const v = householdBudget(lines, txs, [], nov, "2026-11-15");
    expect(v.savingsViews.map((x) => [x.line.id, x.budgeted, x.spent])).toEqual([["s", 1500, 1500]]);
    expect(v.savingsPlanned).toBe(1500);
    expect(v.saved).toBe(1500);
    expect(v.unallocated).toBe(10000 - 900 - 1500);
    // The transfers are not spending.
    expect(v.spentTotal).toBe(0);
    expect(v.expenseViews.map((x) => x.line.id)).toEqual(["f"]);
  });

  it("flags a savings line without an account", () => {
    const issues = validateBudgetHistory([line({ id: "s", seriesId: "s", name: "Savings", kind: "SAVINGS", accountId: null, categories: [] })]);
    expect(issues.map((i) => i.kind)).toEqual(["missing-account"]);
  });
});

describe("scheduled transactions", () => {
  const mortgage: RecurringLike = { id: "m", accountId: "joint", amount: -2400, type: "EXPENSE", description: "Mortgage", cadence: "MONTHLY", startDate: "2026-01-01", nextDate: "2026-11-01", matchPattern: "ROCKET MORTGAGE" };

  it("matches a posted row by pattern and rolls the due date forward", () => {
    const t = tx({ amount: -2400, description: "ROCKET MORTGAGE PMT 1234", date: "2026-11-02" });
    expect(findScheduleMatches(t, [mortgage], 65)[0]?.rule.id).toBe("m");
    expect(findScheduleMatches({ ...t, description: "H-E-B" }, [mortgage])).toEqual([]);
    expect(nextDateAfter(mortgage, "2026-11-02")).toBe("2026-12-01");
  });

  it("projects the balance through upcoming debits and finds the low point", () => {
    const pay: RecurringLike = { id: "p", accountId: "joint", amount: 3000, type: "INCOME", description: "Contribution", cadence: "MONTHLY", startDate: "2026-11-15", nextDate: "2026-11-15" };
    const events = upcomingEvents("joint", [{ ...mortgage, nextDate: "2026-12-01" }, pay], "2026-11-09", "2026-12-05");
    expect(events.map((e) => [e.date, e.amount])).toEqual([
      ["2026-11-15", 3000],
      ["2026-12-01", -2400],
    ]);
    const lo = lowestPoint(projectBalance(500, [{ date: "2026-11-12", amount: -800, description: "", recurringId: "x" }, ...events]));
    expect(lo).toMatchObject({ date: "2026-11-12", balance: -300 });
  });
});

describe("goals", () => {
  it("fills goals on one account in priority order, each capped at its target", () => {
    const out = goalProgress(
      [
        { id: "e", name: "Emergency", targetAmount: 10000, fundingAccountId: "sav", priority: 1 },
        { id: "b", name: "Baby", targetAmount: 8000, fundingAccountId: "sav", priority: 2 },
        { id: "t", name: "Trip", targetAmount: 2000, currentAmount: 500 },
      ],
      [{ id: "sav", name: "Savings", currentBalance: 12000 }],
      "2026-11-09",
    );
    expect(out.map((g) => [g.goal.id, g.current])).toEqual([
      ["e", 10000],
      ["b", 2000],
      ["t", 500],
    ]);
  });

  it("draws a goal from several accounts in order, sharing them with other goals", () => {
    const out = goalProgress(
      [
        { id: "house", name: "House", targetAmount: 50000, fundingAccountIds: ["brk"], priority: 1 },
        { id: "ret", name: "Retirement", targetAmount: 1000000, fundingAccountIds: ["k1", "k2", "brk"], priority: 2 },
        // Older single-account field still works.
        { id: "old", name: "Old", targetAmount: 1000, fundingAccountId: "k2", priority: 3 },
      ],
      [
        { id: "k1", name: "401k", currentBalance: 300000 },
        { id: "k2", name: "401k 2", currentBalance: 100000 },
        { id: "brk", name: "Brokerage", currentBalance: 80000 },
      ],
      "2026-11-09",
    );
    expect(out.map((g) => [g.goal.id, g.current])).toEqual([
      ["house", 50000],
      ["ret", 430000],
      ["old", 0],
    ]);
  });
});

describe("itemized transactions", () => {
  const amazon = {
    id: "amz",
    accountId: "card",
    amount: -110,
    date: "2026-11-05",
    status: "POSTED",
    description: "AMAZON MKTPL*AB12",
    category: "Shopping",
    // $100 of items; tax and shipping make the charge $110.
    lineItems: JSON.stringify([
      { name: "Diapers", amount: 40, category: "Baby" },
      { name: "Wipes", amount: 20, category: "Baby" },
      { name: "Patio cover", amount: 40, category: "Home" },
      { name: "junk row" },
    ]),
  };
  const window = { fromIso: "2026-11-01", toIso: "2026-11-30", label: "Nov" };

  it("splits the charge by item category, scaled to the charge, ignoring bad rows", () => {
    expect(parseLineItems(amazon)).toHaveLength(3);
    expect(categoryParts(amazon)).toEqual([
      { category: "Baby", amount: 66 },
      { category: "Home", amount: 44 },
    ]);
    expect(effectiveCategory(amazon)).toBe("Baby");
    expect(parseLineItems({ lineItems: "not json" })).toBeNull();
    expect(categoryParts({ amount: -5, category: "Fuel" })).toEqual([{ category: "Fuel", amount: 5 }]);
  });

  it("counts in the budget per item, and lists the charge under each line it touches", () => {
    const txs = [amazon, { id: "g", accountId: "card", amount: -30, date: "2026-11-06", status: "POSTED", category: "Groceries" }];
    expect(Object.fromEntries(spendByCategory(txs, window))).toEqual({ Baby: 66, Home: 44, Groceries: 30 });
    expect(totalOutflow(txs, window)).toBe(140);
    expect(budgetTransactions(txs, window, ["Home"]).map((t) => t.id)).toEqual(["amz"]);
    expect(budgetTransactions(txs, window, ["Shopping"])).toEqual([]);
  });
});

describe("goal milestones", () => {
  it("marks hit, missed and pending by date, with the monthly pace only for the next one", () => {
    const m = (id: string, targetAmount: number, targetDate: string) => ({ id, goalId: "g", targetAmount, targetDate });
    const out = milestoneViews([m("c", 30000, "2027-11-09"), m("a", 5000, "2026-06-01"), m("b", 20000, "2026-10-01"), m("d", 40000, "2028-01-01")], 12000, "2026-11-09");
    expect(out.map((v) => [v.milestone.id, v.status])).toEqual([
      ["a", "HIT"],
      ["b", "MISSED"],
      ["c", "PENDING"],
      ["d", "PENDING"],
    ]);
    // $18k to go over ~12 months.
    expect(out[2].monthlyNeeded!).toBeCloseTo(1500, -1);
    expect(out[3].monthlyNeeded).toBeNull();
  });
});

describe("holdings", () => {
  const acc = (holdings: SfAccount["holdings"]): SfAccount => ({ id: "ACT-1", orgName: "Fidelity", name: "401k", currency: "USD", balance: 0, availableBalance: null, balanceDate: "2026-11-09", transactions: [], holdings });
  const h = (over: object) => ({ id: "h", symbol: "", description: "", shares: null, marketValue: null, purchasePrice: null, costBasis: null, ...over });

  it("keys funds without a ticker by description and merges repeated rows", () => {
    expect(holdingKeyOf({ symbol: " vti ", description: "x" })).toBe("VTI");
    expect(holdingKeyOf({ symbol: "", description: "Target  Date 2055 Trust" })).toBe("FUND:TARGET DATE 2055 TRUST");
    expect(holdingKeyOf({ symbol: "", description: "" })).toBeNull();
    const d = desiredHoldingsFromSf(
      acc([
        h({ symbol: "VTI", shares: 10, marketValue: 3000, costBasis: 2500 }),
        h({ symbol: "vti", shares: 5, marketValue: 1500, costBasis: 0 }),
        h({ symbol: "VOO", shares: 0, marketValue: 0 }),
        h({ description: "Target 2055", shares: null, marketValue: 7000, costBasis: 0 }),
      ]),
    );
    expect([...d.keys()]).toEqual(["VTI", "FUND:TARGET 2055"]);
    expect(d.get("VTI")).toMatchObject({ shares: 15, marketValue: 4500, costBasis: 2500, hasCost: true });
    expect(d.get("FUND:TARGET 2055")).toMatchObject({ ticker: null, hasCost: false, marketValue: 7000 });
  });

  it("creates, updates, skips unchanged, deletes sold-out SimpleFIN rows and leaves manual ones", () => {
    const desired = desiredHoldingsFromSf(
      acc([
        h({ symbol: "VTI", shares: 10, marketValue: 3000, costBasis: 2500 }),
        h({ symbol: "VXUS", shares: 4, marketValue: 260 }),
        h({ symbol: "SCHD", shares: 2, marketValue: 160 }),
        h({ symbol: "BND", shares: 1, marketValue: 70 }),
      ]),
    );
    const diff = diffHoldings(
      desired,
      [
        { holdingKey: "VTI", quantity: 10, marketValue: 3000, costBasisTotal: 2500, description: null, source: "SIMPLEFIN" },
        { holdingKey: "VXUS", quantity: 4, marketValue: 250, costBasisTotal: null, description: null, source: "SIMPLEFIN" },
        { holdingKey: "BND", quantity: 9, marketValue: 600, source: "MANUAL" },
        { holdingKey: "AAPL", quantity: 3, marketValue: 600, source: "SIMPLEFIN" },
        { holdingKey: "GOLD", quantity: 1, marketValue: 2000, source: "MANUAL" },
      ],
      "2026-11-09",
    );
    expect(diff.creates.map((c) => c.holdingKey)).toEqual(["SCHD"]);
    expect(diff.updates.map((u) => [u.holdingKey, u.fields.marketValue])).toEqual([["VXUS", 260]]);
    expect(diff.deletes).toEqual(["AAPL"]);
    expect(diff.creates[0].fields).toMatchObject({ ticker: "SCHD", quantity: 2, costBasisTotal: null, avgCostBasis: null, source: "SIMPLEFIN", asOf: "2026-11-09" });
  });
});

describe("sync engine", () => {
  const sf = (over: object) => ({ id: "TRN-1", posted: "2026-11-05", transactedAt: null, amount: -42, description: "H-E-B #12", payee: "", memo: "", pending: false, ...over });

  it("drafts a classified row and pairs transfers between tracked accounts", () => {
    const a = sfTxToDraft(sf({ id: "TRN-a", amount: -500, description: "TRANSFER TO SAV" }), "joint")!;
    const b = sfTxToDraft(sf({ id: "TRN-b", amount: 500, description: "TRANSFER FROM CHK" }), "savings")!;
    expect(b.category).toBe("Contribution");
    expect(markSelfTransfers([a, b])).toBe(1);
    expect([a.type, a.toAccountId, b.category]).toEqual(["TRANSFER", "savings", "Transfers"]);
    expect(sfTxToDraft(sf({ posted: null }), "joint")).toBeNull();
  });

  it("updates a settling pending row in place and never overwrites a manual category", () => {
    const draft = sfTxToDraft(sf({ description: "H-E-B #12 AUSTIN TX" }), "joint") as TxDraft;
    const idx = buildDedupIndex([{ id: "row", sfTransactionId: "TRN-1", date: "2026-11-04", amount: -42, description: "HEB", status: "PENDING", category: "Baby", categorySource: "MANUAL" }]);
    const r = reconcileDraft(draft, idx, (d) => classify({ description: d, amount: -1 }).category);
    expect(r.action).toBe("update");
    if (r.action === "update") {
      expect(r.patch).toMatchObject({ date: "2026-11-05", status: "POSTED", description: "H-E-B #12 AUSTIN TX" });
      expect(r.patch.category).toBeUndefined();
    }
  });

  it("takes the settled amount and refreshes the fingerprint", () => {
    const draft = sfTxToDraft(sf({ amount: -60, description: "TACO SPOT" }), "joint")!;
    const idx = buildDedupIndex([{ id: "row", sfTransactionId: "TRN-1", date: "2026-11-05", amount: -50, description: "TACO SPOT", status: "PENDING" }]);
    const r = reconcileDraft(draft, idx);
    expect(r.action).toBe("update");
    if (r.action === "update") expect(r.patch).toMatchObject({ amount: -60, status: "POSTED", importHash: draft.importHash });
    // Same amount: nothing about it changes.
    const same = reconcileDraft(sfTxToDraft(sf({ amount: -50, description: "TACO SPOT" }), "joint")!, idx);
    if (same.action === "update") expect(same.patch.amount).toBeUndefined();
  });

  it("gives a synced row an id built from its SimpleFIN id", () => {
    expect(syncedTransactionId("joint", "TRN-1")).toBe("sf-joint-TRN-1");
    expect(syncedTransactionId("joint", "TRN-1")).not.toBe(syncedTransactionId("savings", "TRN-1"));
  });

  it("creates two same-day same-amount charges that each have their own SimpleFIN id", () => {
    const first = sfTxToDraft(sf({ id: "TRN-x", amount: -3, description: "TOLL" }), "joint")!;
    const idx = buildDedupIndex([{ id: "row", sfTransactionId: "TRN-y", date: "2026-11-05", amount: -3, description: "TOLL", importHash: first.importHash }]);
    expect(reconcileDraft(first, idx).action).toBe("create");
  });
});
