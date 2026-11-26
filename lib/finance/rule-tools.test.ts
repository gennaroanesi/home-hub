import { describe, expect, it } from "vitest";
import { moveRuleUpdates, newRuleSortOrder, planRuleChange, reapplyDays, ruleChangePatch, rulePatternError, ruleSaveError, testRules } from "./rule-tools";
import { HOUSEHOLD } from "./ledger";

const rules = [
  { pattern: "COSTCO", category: "Groceries", personId: null, ledger: null },
  { pattern: "/transfer from .*1234/i", category: null, personId: "g", ledger: null },
  { pattern: "AMAZON", category: "Shopping", personId: null, ledger: "g" },
];
const ledgerOf = (id: string) => (id === "gCard" ? "g" : HOUSEHOLD);

describe("rule tools", () => {
  it("checks patterns", () => {
    expect(rulePatternError("costco")).toBeNull();
    expect(rulePatternError("/(/")).toBeTruthy();
    expect(ruleSaveError({ pattern: " " })).toBe("A pattern is required");
    expect(ruleSaveError({ pattern: "x" })).toBe("Set a category, a person or a budget");
    expect(ruleSaveError({ pattern: "x", ledger: "g" })).toBeNull();
  });

  it("tests a description and names the deciding rules", () => {
    const r = testRules("SQ *AMAZON MKTPL", "out", rules)!;
    expect(r.category).toBe("Shopping");
    expect(r.catRule?.n).toBe(3);
    expect(r.ledger).toBe("g");
    expect(r.personRule).toBeNull();
    expect(testRules("COSTCO", "in", rules)!.category).toBe("Groceries");
    expect(testRules("  ", "out", rules)).toBeNull();
  });

  it("re-apply keeps manual fields, transfers and a bill's ledger", () => {
    expect(planRuleChange({ type: "TRANSFER", description: "COSTCO", amount: -5 }, rules, ledgerOf)).toBeNull();
    expect(planRuleChange({ description: "COSTCO", amount: -5, category: "Gas", categorySource: "MANUAL", accountId: "joint" }, rules, ledgerOf)).toBeNull();
    const c = planRuleChange({ description: "COSTCO", amount: -5, category: "Gas", categorySource: "LLM", accountId: "joint" }, rules, ledgerOf);
    expect(c?.category).toBe("Groceries");
    // Spending never gets a person; money in does.
    expect(planRuleChange({ description: "Transfer from x1234", amount: -5, category: "Transfers", accountId: "joint" }, rules, ledgerOf)).toBeNull();
    expect(planRuleChange({ description: "Transfer from x1234", amount: 5, category: "Contribution", accountId: "joint" }, rules, ledgerOf)?.personId).toBe("g");
    // A schedule's or hand-picked budget wins over the rule's.
    expect(planRuleChange({ description: "AMAZON", amount: -5, category: "Shopping", ledger: HOUSEHOLD, ledgerSource: "SCHEDULE", accountId: "joint" }, rules, ledgerOf)).toBeNull();
    expect(planRuleChange({ description: "AMAZON", amount: -5, category: "Shopping", accountId: "joint" }, rules, ledgerOf)?.ledger).toBe("g");
    expect(ruleChangePatch({ tx: {}, category: "A", ledger: "g" })).toEqual({ category: "A", categorySource: "RULE", ledger: "g", ledgerSource: "RULE" });
  });

  it("orders", () => {
    expect(reapplyDays("")).toBe(90);
    expect(reapplyDays("99999")).toBe(3650);
    expect(newRuleSortOrder([], "top")).toBe(100);
    expect(newRuleSortOrder([{ sortOrder: 100 }, { sortOrder: 300 }], "top")).toBe(90);
    expect(newRuleSortOrder([{ sortOrder: 100 }, { sortOrder: 300 }], "bottom")).toBe(400);
    expect(moveRuleUpdates([{ id: "a", sortOrder: 100 }, { id: "b", sortOrder: 200 }], 0, 1)).toEqual([
      { id: "a", sortOrder: 200 },
      { id: "b", sortOrder: 100 },
    ]);
    expect(moveRuleUpdates([{ id: "a", sortOrder: 0 }, { id: "b", sortOrder: 0 }], 1, -1)).toEqual([
      { id: "b", sortOrder: 100 },
      { id: "a", sortOrder: 200 },
    ]);
    expect(moveRuleUpdates([{ id: "a" }], 0, -1)).toEqual([]);
  });
});
