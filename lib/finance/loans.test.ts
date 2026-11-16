import { describe, expect, it } from "vitest";
import {
  contractualPayment,
  fmtDuration,
  loanOutlook,
  monthlyPaymentFor,
  nextPaymentDate,
  paymentDate,
  paymentsBetween,
  paymentsDueBy,
  paymentToFinishIn,
  scheduledBalance,
  simulatePayoff,
  suggestSplit,
} from "./loans";

// The household mortgage's terms: $449,577 at 4.5% over 30 years, first payment Dec 1 2022.
const mortgage = { originalPrincipal: 449577, interestRate: 0.045, termMonths: 360, firstPaymentDate: "2022-12-01" };

describe("payments", () => {
  it("matches the lender's principal + interest", () => {
    expect(monthlyPaymentFor(449577, 0.045, 360)).toBeCloseTo(2277.94, 2);
    expect(contractualPayment(mortgage)).toBe(2277.94);
    expect(contractualPayment({ ...mortgage, monthlyPayment: 2300 })).toBe(2300);
    expect(monthlyPaymentFor(1200, 0, 12)).toBe(100);
  });

  it("counts payment dates on the loan's day of the month, clamped in short months", () => {
    expect(paymentsDueBy(mortgage, "2022-11-30")).toBe(0);
    expect(paymentsDueBy(mortgage, "2022-12-01")).toBe(1);
    expect(paymentsDueBy(mortgage, "2026-11-16")).toBe(48);
    expect(nextPaymentDate(mortgage, "2026-11-16")).toBe("2026-12-01");
    expect(nextPaymentDate(mortgage, "2026-12-01")).toBe("2027-01-01");
    const car = { firstPaymentDate: "2023-01-30" };
    expect([1, 2, 3].map((n) => paymentDate(car, n))).toEqual(["2023-01-30", "2023-02-28", "2023-03-30"]);
    expect(paymentsDueBy(car, "2023-02-28")).toBe(2);
    expect(paymentsBetween("2026-12-01", "2027-11-30")).toBe(12);
  });

  it("follows the contract's balance down to zero", () => {
    expect(scheduledBalance(mortgage, 0)).toBe(449577);
    expect(scheduledBalance(mortgage, 1)).toBeCloseTo(449577 - (2277.94 - 449577 * 0.00375), 0);
    expect(scheduledBalance(mortgage, 360)).toBeLessThan(1);
  });
});

describe("simulatePayoff", () => {
  it("pays down with extra monthly and a lump sum", () => {
    expect(simulatePayoff({ balance: 1000, annualRate: 0, payment: 100, firstDate: "2027-01-15" })).toMatchObject({ months: 10, payoffDate: "2027-10-15", totalInterest: 0, totalPaid: 1000 });
    expect(simulatePayoff({ balance: 1000, annualRate: 0, payment: 100, firstDate: "2027-01-15", lumpSum: 500 }).months).toBe(5);
    expect(simulatePayoff({ balance: 1000, annualRate: 0, payment: 100, firstDate: "2027-01-15", extraMonthly: 100 }).months).toBe(5);
    expect(simulatePayoff({ balance: 1000, annualRate: 0, payment: 100, firstDate: "2027-01-15", lumpSum: 5000 })).toMatchObject({ months: 0, totalPaid: 1000 });
  });

  it("saves interest when paying more, and says when a payment never gets there", () => {
    const base = simulatePayoff({ balance: 36409.33, annualRate: 0.0549, payment: 2000, firstDate: "2026-11-30" });
    const more = simulatePayoff({ balance: 36409.33, annualRate: 0.0549, payment: 2000, firstDate: "2026-11-30", extraMonthly: 500 });
    expect(base.months).toBe(20);
    expect(more.months).toBeLessThan(base.months);
    expect(more.totalInterest).toBeLessThan(base.totalInterest);
    expect(base.rows.at(-1)!.balance).toBe(0);
    expect(simulatePayoff({ balance: 100000, annualRate: 0.12, payment: 500, firstDate: "2027-01-01" })).toMatchObject({ stalls: true, months: Infinity });
  });

  it("finds the payment for a target", () => {
    const pmt = paymentToFinishIn(36409.33, 0.0549, 12);
    expect(simulatePayoff({ balance: 36409.33, annualRate: 0.0549, payment: pmt, firstDate: "2026-11-30" }).months).toBe(12);
  });
});

describe("suggestSplit", () => {
  it("takes a month of interest on what's owed, the rest after escrow to principal", () => {
    // The October 2026 mortgage payment: $3,619.40 with $1,341.46 escrow.
    expect(suggestSplit(418505.21, 0.045, 3619.4, 1341.46)).toEqual({ interest: 1569.39, principal: 708.55 });
    expect(suggestSplit(1000, 0.12, 5)).toEqual({ interest: 5, principal: 0 });
  });
});

describe("loanOutlook", () => {
  it("is on schedule when the balance matches the contract, ahead when lower", () => {
    const today = "2026-11-16";
    const onTrack = loanOutlook(mortgage, scheduledBalance(mortgage, 48), [], today);
    expect(onTrack).toMatchObject({ paymentsMade: 48, nextPaymentDate: "2026-12-01", contractEnd: "2052-11-01", payment: 2277.94 });
    expect(onTrack.monthsAhead).toBe(0);
    expect(onTrack.projected.months).toBe(312);

    // The real balance today is right on the contract.
    expect(Math.abs(onTrack.owed - 418505.21)).toBeLessThan(5);

    const ahead = loanOutlook(mortgage, 400000, [], today);
    expect(ahead.monthsAhead).toBeGreaterThan(6);
    expect(ahead.paidOffPct).toBeCloseTo((449577 - 400000) / 449577, 6);
    expect(ahead.principalPaid).toBe(49577);
  });

  it("sums recorded interest and averages the recent regular payments", () => {
    const pays = [
      { date: "2026-09-01", totalAmount: 3600, principal: 700, interest: 1580, escrow: 1320 },
      { date: "2026-10-01", totalAmount: 3620, principal: 703, interest: 1575, escrow: 1342 },
      { date: "2026-10-15", totalAmount: 5000, principal: 5000, interest: 0, isExtra: true },
    ];
    const o = loanOutlook(mortgage, 418505.21, pays, "2026-11-16");
    expect(o.interestPaid).toBe(3155);
    expect(o.recentAverage).toBe(3610);
    expect(o.lastPayment?.date).toBe("2026-10-15");
  });
});

describe("fmtDuration", () => {
  it("reads naturally", () => {
    expect(fmtDuration(75)).toBe("6 years 3 months");
    expect(fmtDuration(12)).toBe("1 year");
    expect(fmtDuration(0)).toBe("paid off");
    expect(fmtDuration(Infinity)).toBe("never at this payment");
  });
});
