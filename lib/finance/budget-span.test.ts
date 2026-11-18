import { describe, expect, it } from "vitest";
import { budgetTransactions, budgetTxRange, householdBudget, isSpanLine, type BudgetLine } from "./budget";

const nov = { fromIso: "2026-11-01", toIso: "2026-11-30", label: "Nov" };
const dec = { fromIso: "2026-12-01", toIso: "2026-12-31", label: "Dec" };
const tx = (o: Record<string, unknown>) => ({ id: String(Math.random()), accountId: "a", status: "POSTED", ...o }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const line = (o: Partial<BudgetLine>): BudgetLine => ({ id: String(Math.random()), seriesId: String(Math.random()), name: "x", amount: 0, period: "MONTHLY", effectiveFrom: "2026-01-01", ...o });

describe("sub-categories", () => {
  const txs = [
    tx({ date: "2026-11-05", amount: -300, category: "Baby: Furniture" }),
    tx({ date: "2026-11-06", amount: -50, category: "Baby: Clothing" }),
    tx({ date: "2026-11-07", amount: -20, category: "Baby" }),
    tx({ date: "2026-11-08", amount: -10, category: "Babysitter" }), // not a sub-category
  ];

  it("a line on the parent covers its sub-categories", () => {
    const v = householdBudget([line({ name: "Baby", categories: ["Baby"], amount: 1000 })], txs, [], nov, "2026-11-30");
    expect(v.expenseViews[0].spent).toBe(370);
    expect(v.unassigned).toEqual([{ category: "Babysitter", spent: 10 }]);
    expect(budgetTransactions(txs, nov, ["Baby"]).map((t) => t.amount)).toEqual([-300, -50, -20]);
  });

  it("a line on a sub-category takes it from the parent's line", () => {
    const v = householdBudget(
      [line({ name: "Baby", categories: ["Baby"], amount: 1000 }), line({ name: "Nursery", categories: ["Baby: Furniture"], amount: 500 })],
      txs,
      [],
      nov,
      "2026-11-30",
    );
    expect(Object.fromEntries(v.expenseViews.map((e) => [e.line.name, e.spent]))).toEqual({ Baby: 70, Nursery: 300 });
  });
});

describe("one-off lines for a stretch of dates", () => {
  const furniture = line({ name: "Furniture", categories: ["Baby: Furniture"], amount: 3000, period: "ONCE", effectiveFrom: "2026-11-17", effectiveTo: "2027-05-27" });
  const groceries = line({ name: "Groceries", categories: ["Groceries"], amount: 900 });
  const txs = [
    tx({ date: "2026-11-10", amount: -999, category: "Baby: Furniture" }), // before it starts
    tx({ date: "2026-11-20", amount: -800, category: "Baby: Furniture" }),
    tx({ date: "2026-12-03", amount: -400, category: "Baby: Furniture" }),
    tx({ date: "2026-12-04", amount: -100, category: "Groceries" }),
  ];

  it("is measured over its own dates in any month it overlaps, outside the month's totals", () => {
    expect(isSpanLine(furniture)).toBe(true);
    const v = householdBudget([furniture, groceries], txs, [], dec, "2026-12-15");
    expect(v.expenseViews.map((e) => e.line.name)).toEqual(["Groceries"]);
    expect(v.spanViews.map((e) => [e.line.name, e.budgeted, e.spent, e.remaining, e.pace, e.status])).toEqual([["Furniture", 3000, 1200, 1800, null, "under"]]);
    expect(v.allocated).toBe(900);
    expect(v.spentBudgeted).toBe(100);
    // This month's furniture spending is covered, not "not budgeted".
    expect(v.unassigned).toEqual([]);
  });

  it("is over only once spending passes the amount, and not shown outside its dates", () => {
    const v = householdBudget([{ ...furniture, amount: 1000 }], txs, [], dec, "2026-12-15");
    expect(v.spanViews[0].status).toBe("over");
    expect(householdBudget([furniture], txs, [], { fromIso: "2027-06-01", toIso: "2027-06-30", label: "Jun" }, "2027-06-15").spanViews).toEqual([]);
  });

  it("asks for transactions back to the start of the lines shown", () => {
    expect(budgetTxRange([furniture, groceries], dec)).toEqual({ fromIso: "2026-11-17", toIso: "2027-05-27" });
    expect(budgetTxRange([groceries], dec)).toEqual({ fromIso: "2026-12-01", toIso: "2026-12-31" });
  });

  it("a one-off line without an end date still belongs to its month", () => {
    const crib = line({ name: "Crib", categories: ["Baby"], amount: 800, period: "ONCE", effectiveFrom: "2026-11-05" });
    expect(isSpanLine(crib)).toBe(false);
    expect(householdBudget([crib], txs, [], nov, "2026-11-30").expenseViews.map((e) => e.line.name)).toEqual(["Crib"]);
  });
});
