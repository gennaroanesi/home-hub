import { describe, expect, it } from "vitest";
import { classify, effectiveCategory, rulesFromDbRows, CATEGORY_RULES } from "./categories";
import { addMonthsAnchored, monthRange, occurrencesBetween, todayIso } from "./dates";
import { householdBudget, planBudgetChange, resolveBudgetLines, validateBudgetHistory, budgetedForRange, type BudgetLine } from "./budget";
import { findScheduleMatches, lowestPoint, nextDateAfter, projectBalance, upcomingEvents } from "./recurring";
import { goalProgress } from "./goals";
import { buildDedupIndex, markSelfTransfers, reconcileDraft, sfTxToDraft, syncedTransactionId, type TxDraft } from "./sync-engine";
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
