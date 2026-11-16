import { describe, expect, it } from "vitest";
import { planLoanCapture } from "./loan-capture";

const bmw = { id: "loan-bmw", accountId: "acct-bmw", recurringId: "rule-bmw", originalPrincipal: 106622.78, interestRate: 0.0549, termMonths: 72, firstPaymentDate: "2023-01-18", monthlyPayment: 1745.48, interestAccrual: "DAILY" as const };
const mortgage = { id: "loan-m", accountId: "acct-m", recurringId: "rule-m", originalPrincipal: 449577, interestRate: 0.045, termMonths: 360, firstPaymentDate: "2022-12-01", escrowMonthly: 1341.46 };
const accounts = [
  { id: "acct-bmw", currentBalance: -36409.33 },
  { id: "acct-m", currentBalance: -418505.21, simplefinAccountId: "ACT-1" },
];

describe("planLoanCapture", () => {
  it("records a linked bank transaction as an estimated payment and moves a manual balance", () => {
    const plan = planLoanCapture({
      transactions: [
        { id: "tx1", date: "2026-11-20", amount: -2000, recurringId: "rule-bmw" },
        { id: "tx2", date: "2026-11-20", amount: -80, recurringId: "rule-electric" }, // not a loan
        { id: "tx3", date: "2026-11-21", amount: 2000, recurringId: "rule-bmw" }, // a refund, ignored
      ],
      loans: [bmw, mortgage],
      accounts,
      payments: [{ id: "p45", loanId: "loan-bmw", date: "2026-10-23", totalAmount: 2000, principal: 1838.91, interest: 161.09 }],
    });
    expect(plan.creates).toHaveLength(1);
    const c = plan.creates[0];
    // 28 days of daily interest on 36,409.33 at 5.49%.
    expect(c).toMatchObject({ loanId: "loan-bmw", date: "2026-11-20", totalAmount: 2000, interest: 153.34, principal: 1846.66, transactionId: "tx1", source: "BANK", estimated: true, escrow: null });
    expect(c.notes).toMatch(/28 days/);
    expect(plan.balanceMoves).toEqual([{ accountId: "acct-bmw", principalDelta: 1846.66 }]);
    expect(plan.links).toEqual([]);
  });

  it("links instead of duplicating when that date is already recorded, and leaves a synced balance alone", () => {
    const plan = planLoanCapture({
      transactions: [
        { id: "tx1", date: "2026-12-01", amount: -3619.4, recurringId: "rule-m" },
        { id: "tx2", date: "2026-11-20", amount: -2000, recurringId: "rule-bmw" },
      ],
      loans: [bmw, mortgage],
      accounts,
      payments: [{ id: "p46", loanId: "loan-bmw", date: "2026-11-20", totalAmount: 2000, principal: 1846.66, interest: 153.34, transactionId: null }],
    });
    expect(plan.links).toEqual([{ paymentId: "p46", transactionId: "tx2" }]);
    expect(plan.creates).toHaveLength(1);
    // Escrow comes off first; a month of interest on what's owed.
    expect(plan.creates[0]).toMatchObject({ loanId: "loan-m", escrow: 1341.46, interest: 1569.39, principal: 708.55 });
    expect(plan.balanceMoves).toEqual([]);
  });

  it("does nothing when no loan has a schedule", () => {
    const plan = planLoanCapture({ transactions: [{ id: "t", date: "2026-11-20", amount: -2000, recurringId: "rule-bmw" }], loans: [{ ...bmw, recurringId: null }], accounts, payments: [] });
    expect(plan).toEqual({ creates: [], links: [], balanceMoves: [] });
  });
});
