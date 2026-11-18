import { describe, expect, it } from "vitest";
import { householdAccounts, isOutsideCashFlow } from "./accounts";

describe("household cash flow", () => {
  it("leaves out invested accounts, loans and inactive accounts", () => {
    const accounts = [
      { id: "chk", type: "CHECKING" },
      { id: "card", type: "CREDIT" },
      { id: "401k", type: "RETIREMENT" },
      { id: "schwab", type: "BROKERAGE" },
      { id: "mortgage", type: "LOAN" },
      { id: "old", type: "SAVINGS", active: false },
    ];
    expect(householdAccounts(accounts).map((a) => a.id)).toEqual(["chk", "card"]);
    expect(["LOAN", "RETIREMENT", "BROKERAGE", "CREDIT", "CHECKING", null].map(isOutsideCashFlow)).toEqual([true, true, true, false, false, false]);
  });
});

describe("accounts grouped by type", () => {
  it("keeps the section order, totals each, drops empty ones and files unknown types under Other", async () => {
    const { groupAccountsByType } = await import("./accounts");
    const g = groupAccountsByType([
      { id: "m", type: "LOAN", currentBalance: -400000 },
      { id: "c1", type: "CHECKING", currentBalance: 120 },
      { id: "cc", type: "CREDIT", currentBalance: -1590.76 },
      { id: "c2", type: "CHECKING", currentBalance: 80 },
      { id: "x", type: "WEIRD", currentBalance: 5 },
    ]);
    expect(g.map((s) => [s.label, s.accounts.map((a) => a.id), s.total])).toEqual([
      ["Checking", ["c1", "c2"], 200],
      ["Credit cards", ["cc"], -1590.76],
      ["Loans", ["m"], -400000],
      ["Other", ["x"], 5],
    ]);
  });
});
