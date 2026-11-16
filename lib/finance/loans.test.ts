import { describe, expect, it } from "vitest";
import {
  compareToPlan,
  contractRow,
  contractualPayment,
  fmtDuration,
  interestDays,
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

// The BMW: $106,622.78 at 5.49% over 72 months, daily simple interest, first payment Jan 18 2023.
const bmw = { originalPrincipal: 106622.78, interestRate: 0.0549, termMonths: 72, firstPaymentDate: "2023-01-18", monthlyPayment: 1745.48, interestAccrual: "DAILY" as const };

describe("daily simple interest", () => {
  it("matches the lender's schedule to the cent given the days", () => {
    // Row 1: 32 days on the original principal; row 2: 28 days on the balance after it.
    expect(suggestSplit(106622.78, 0.0549, 1745.48, 0, 0, 32)).toEqual({ interest: 513.19, principal: 1232.29 });
    expect(suggestSplit(105390.49, 0.0549, 1745.48, 0, 0, 28)).toEqual({ interest: 443.85, principal: 1301.63 });
    // No days → a month, as before.
    expect(suggestSplit(105390.49, 0.0549, 1745.48)).toEqual({ interest: 482.16, principal: 1263.32 });
  });

  it("counts the days since the last payment, or from the month before the first", () => {
    expect(interestDays(bmw, [], "2023-01-18")).toBe(31);
    expect(interestDays(bmw, [{ date: "2023-01-18" }], "2023-02-15")).toBe(28);
    expect(interestDays(bmw, [{ date: "2023-01-18" }, { date: "2023-02-15" }], "2023-03-29")).toBe(42);
    // Only earlier payments count; a later one doesn't.
    expect(interestDays(bmw, [{ date: "2023-02-15" }], "2023-01-18")).toBe(31);
    expect(interestDays({ ...bmw, interestAccrual: "MONTHLY" }, [], "2023-02-15")).toBeNull();
    expect(interestDays({ ...bmw, interestAccrual: null }, [], "2023-02-15")).toBeNull();
  });
});

describe("against the contract", () => {
  it("splits each contract payment", () => {
    expect(contractRow(mortgage, 1)).toEqual({ principal: 592.03, interest: 1685.91 });
    const r2 = contractRow(mortgage, 2);
    expect(r2.principal + r2.interest).toBeCloseTo(2277.94, 1);
    expect(r2.principal).toBeGreaterThan(592.03);
  });

  it("tracks principal paid ahead of the contract, by payment number or position", () => {
    const rows = compareToPlan(bmw, [
      { id: "a", date: "2023-01-18", totalAmount: 1745.48, principal: 1232.29, interest: 513.19, paymentNumber: 1 },
      { id: "b", date: "2023-02-15", totalAmount: 1745.48, principal: 1301.63, interest: 443.85, paymentNumber: 2 },
      { id: "c", date: "2023-03-29", totalAmount: 2000, principal: 1342.44, interest: 657.56, paymentNumber: 3 },
    ]);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(rows[0].contractPrincipal).toBe(contractRow(bmw, 1).principal);
    expect(rows[2].cumulative).toBeCloseTo(rows[0].delta + rows[1].delta + rows[2].delta, 2);
    // Without numbers, position in date order; an extra payment adds to the running total.
    const unnumbered = compareToPlan(mortgage, [
      { id: "x", date: "2022-12-01", totalAmount: 2277.94, principal: 592.03, interest: 1685.91 },
      { id: "e", date: "2022-12-15", totalAmount: 1000, principal: 1000, interest: 0, isExtra: true },
      { id: "y", date: "2023-01-01", totalAmount: 2277.94, principal: 600, interest: 1677.94 },
    ]);
    expect(unnumbered.map((r) => [r.n, r.delta])).toEqual([
      [1, 0],
      [1, 1000],
      [2, Math.round((600 - contractRow(mortgage, 2).principal) * 100) / 100],
    ]);
    expect(unnumbered[2].cumulative).toBeCloseTo(1000 + 600 - contractRow(mortgage, 2).principal, 2);
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
