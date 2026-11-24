import { describe, expect, it } from "vitest";
import { loanOutlook } from "./loans";
import {
  NEW_SCHEDULE,
  NO_SCHEDULE,
  estimatePaymentSplit,
  formContractualPayment,
  loanTermsFormFrom,
  loanTermsOf,
  loanTermsSaveInput,
  newPaymentDraft,
  payoffSeries,
  payoffWhatIf,
  paymentsByYear,
  planByPayment,
  ratePct,
  yearEndBalances,
} from "./loan-detail";

const mortgage = { originalPrincipal: 449577, interestRate: 0.045, termMonths: 360, firstPaymentDate: "2022-12-01" };
const today = "2026-11-24";

describe("payments", () => {
  const payments = [
    { id: "p2", date: "2026-01-01", totalAmount: 3000, principal: 700, interest: 1600, escrow: 700 },
    { id: "p1", date: "2025-12-01", totalAmount: 3000, principal: 690, interest: 1610, escrow: 700 },
    { id: "x", date: "2026-02-15", totalAmount: 1000, principal: 1000, interest: 0, isExtra: true },
  ];

  it("groups by year, newest first, with the year's totals", () => {
    const years = paymentsByYear(payments);
    expect(years.map((y) => y.year)).toEqual(["2026", "2025"]);
    expect(years[0]).toMatchObject({ principal: 1700, interest: 1600, escrow: 700, total: 4000 });
    expect(years[0].rows).toHaveLength(2);
  });

  it("maps each payment to its plan row and the running principal ahead", () => {
    const plan = planByPayment(mortgage, payments);
    expect(plan.byId.get("x")?.delta).toBe(1000);
    expect(plan.byId.size).toBe(3);
    expect(plan.ahead).toBeCloseTo([...plan.byId.values()].reduce((s, r) => s + r.delta, 0), 2);
  });

  it("formats rates", () => {
    expect(ratePct(0.045)).toBe("4.5%");
    expect(ratePct(0.06125)).toBe("6.125%");
    expect(ratePct(0.05)).toBe("5%");
  });
});

describe("payoff what-if", () => {
  const o = loanOutlook(mortgage, 400000, [], today);

  it("runs extra / lump / target only when given", () => {
    expect(payoffWhatIf(mortgage, o, {})).toMatchObject({ scenario: null, byTarget: null, targetTooEarly: false });
    const w = payoffWhatIf(mortgage, o, { extra: "500", lump: "" });
    expect(w.extra).toBe(500);
    expect(w.scenario!.months).toBeLessThan(o.projected.months);
    expect(payoffWhatIf(mortgage, o, { by: "2026-11-30" }).targetTooEarly).toBe(true);
    const t = payoffWhatIf(mortgage, o, { by: "2036-12-01" });
    expect(t.byTarget!.n).toBe(121);
    expect(t.byTarget!.extra).toBeGreaterThan(0);
  });

  it("builds the three balance lines and reads them at each year's end", () => {
    const w = payoffWhatIf(mortgage, o, { lump: "100000", extra: "1000" });
    const series = payoffSeries(mortgage, o, w.scenario, w.lump, today);
    expect(series[0]).toEqual({ date: today, contract: o.contractBalance, pace: 400000, scenario: 300000 });
    const years = yearEndBalances(series);
    expect(years[0].year).toBe("2026");
    expect(years[0].pace).toBeLessThan(400000);
    // The what-if is paid off long before the contract: it stays at zero after.
    const done = years.findIndex((y) => y.scenario === 0);
    expect(done).toBeGreaterThan(0);
    expect(years[done + 1].scenario).toBe(0);
    expect(years[years.length - 1].contract).toBeLessThan(1);
  });
});

describe("payment form", () => {
  it("starts from the contractual payment + escrow with an estimated split", () => {
    const d = newPaymentDraft({ ...mortgage, escrowMonthly: 700 }, 400000, [], today);
    expect(d.total).toBe(2977.94);
    expect(d.escrow).toBe(700);
    expect(d.interest).toBe(1500);
    expect(d.principal).toBe(777.94);
  });

  it("re-estimates on edit with the old principal added back, all principal when extra", () => {
    const s = estimatePaymentSplit({ loan: mortgage, owed: 399000, payments: [{ id: "a", date: "2026-11-01" }], editing: { id: "a", principal: 1000 }, total: 2277.94, escrow: 0, fees: 0, isExtra: false, date: "2026-11-01" });
    expect(s.interest).toBe(1500);
    expect(estimatePaymentSplit({ loan: mortgage, owed: 1, payments: [], total: 500, escrow: 0, fees: 10, isExtra: true, date: today })).toMatchObject({ principal: 490, interest: 0 });
    const daily = estimatePaymentSplit({ loan: { ...mortgage, interestAccrual: "DAILY" }, owed: 36500, payments: [{ date: "2026-10-24" }], total: 1000, escrow: 0, fees: 0, isExtra: false, date: today });
    expect(daily.days).toBe(31);
  });
});

describe("terms form", () => {
  const loan = { id: "L", ...mortgage, loanType: "MORTGAGE", lender: "Bank", monthlyPayment: null, escrowMonthly: 700, recurringId: "s1", assetId: "h", notes: "n" };
  const manual = { id: "A", currentBalance: -400000 };
  const accounts = [
    { id: "c2", type: "CHECKING", ownerPersonIds: ["p"] },
    { id: "c1", type: "CHECKING", ownerPersonIds: [] },
  ];

  it("round-trips an unchanged loan", () => {
    const f = loanTermsFormFrom(loan, manual, accounts);
    expect(f).toMatchObject({ owed: "400000", ratePct: "4.5", recurringId: "s1", payFromId: "c1" });
    expect(formContractualPayment(f)).toBe(2277.94);
    const r = loanTermsSaveInput(f, loan, manual);
    expect("input" in r && r.input).toMatchObject({ loanId: "L", interestRate: 0.045, termMonths: 360, assetId: "h", escrowMonthly: 700, monthlyPayment: null });
    // Unchanged schedule and balance aren't sent.
    expect("input" in r && "recurringId" in r.input).toBe(false);
    expect("input" in r && "owed" in r.input).toBe(false);
    expect(loanTermsOf(loan).escrowMonthly).toBe(700);
  });

  it("sends a corrected balance, an unlinked or new schedule, and refuses missing terms", () => {
    const f = loanTermsFormFrom(loan, manual, accounts);
    const r1 = loanTermsSaveInput({ ...f, owed: "399000", recurringId: NO_SCHEDULE }, loan, manual);
    expect("input" in r1 && r1.input).toMatchObject({ owed: 399000, recurringId: null });
    const r2 = loanTermsSaveInput({ ...f, recurringId: NEW_SCHEDULE, payAmount: "3000" }, loan, manual);
    expect("input" in r2 && r2.input.newSchedule).toEqual({ accountId: "c1", matchPattern: "Bank", amount: 3000, lastDayOfMonth: false });
    // A synced account's balance is the bank's.
    const r3 = loanTermsSaveInput({ ...f, owed: "1" }, loan, { ...manual, simplefinAccountId: "sf" });
    expect("input" in r3 && "owed" in r3.input).toBe(false);
    expect("error" in loanTermsSaveInput({ ...f, ratePct: "" }, loan, manual)).toBe(true);
  });

  it("a new loan: a blank mortgage form, and no loanId / owed in its input", () => {
    const f = loanTermsFormFrom(null, null, accounts);
    expect(f).toMatchObject({ loanType: "MORTGAGE", termMonths: "360", ratePct: "", originalPrincipal: "", recurringId: NO_SCHEDULE, matchPattern: "", payFromId: "c1" });
    expect("error" in loanTermsSaveInput(f, null, null)).toBe(true);
    const r = loanTermsSaveInput({ ...f, originalPrincipal: "30000", ratePct: "6", firstPaymentDate: "2026-12-01", owed: "30000" }, null, null);
    expect("input" in r && r.input).toMatchObject({ loanType: "MORTGAGE", originalPrincipal: 30000, interestRate: 0.06, termMonths: 360 });
    expect("input" in r && ("loanId" in r.input || "owed" in r.input || "recurringId" in r.input)).toBe(false);
  });

  it("an existing loan with no kind reads as OTHER, like the op's default", () => {
    expect(loanTermsFormFrom({ ...loan, loanType: null }, manual, accounts).loanType).toBe("OTHER");
  });
});
