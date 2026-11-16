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
