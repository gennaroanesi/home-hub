import { describe, expect, it } from "vitest";
import { categoriesOutside, categoryUseCount, deleteNeedsTarget, rewrittenNote, type CategoryManagerNode } from "./category-manager";

const nodes: CategoryManagerNode[] = [
  { id: "food", name: "Food", parentId: null, path: "Food", depth: 0, transactions: 3 },
  { id: "groc", name: "Groceries", parentId: "food", path: "Food: Groceries", depth: 1, transactions: 5 },
  { id: "car", name: "Car", parentId: null, path: "Car", depth: 0, transactions: 0 },
];

describe("category manager", () => {
  it("counts sub-categories in", () => {
    expect(categoryUseCount("food", nodes)).toBe(8);
    expect(categoryUseCount("groc", nodes)).toBe(5);
  });
  it("only offers categories outside the one being moved", () => {
    expect(categoriesOutside("food", nodes).map((n) => n.id)).toEqual(["car"]);
    expect(categoriesOutside(null, nodes)).toHaveLength(3);
  });
  it("needs a target for a top-level category in use", () => {
    expect(deleteNeedsTarget("food", nodes)).toBe(true);
    expect(deleteNeedsTarget("groc", nodes)).toBe(false);
    expect(deleteNeedsTarget("car", nodes)).toBe(false);
  });
  it("describes what was rewritten", () => {
    expect(rewrittenNote({ transactions: 1, rules: 2, budgetLines: 0, schedules: 0, invoices: 0 })).toBe("Updated 1 transaction, 2 rules");
    expect(rewrittenNote({ transactions: 0, rules: 0, budgetLines: 0, schedules: 0, invoices: 0 })).toBeUndefined();
  });
});
