import { describe, expect, it } from "vitest";
import type { OpContext } from "./context";
import { runOp } from "./registry";
import { todayIso } from "../finance/dates";

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {};
  let n = 0;
  const model = (name: string) => {
    tables[name] = (seed[name] ?? []).map((r) => ({ ...r }));
    const rows = tables[name];
    return {
      list: async () => ({ data: rows, nextToken: null }),
      get: async ({ id }: any) => ({ data: rows.find((r) => r.id === id) ?? null }),
      delete: async ({ id }: any) => {
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
        return { data: { id } };
      },
      create: async (row: any) => {
        const saved = { id: `${name}-${++n}`, ...row };
        rows.push(saved);
        return { data: saved };
      },
      update: async ({ id, ...patch }: any) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return { data: null, errors: [{ message: "not found" }] };
        Object.assign(row, patch);
        return { data: row };
      },
    };
  };
  const names = ["homePerson", "homeFinanceAccount", "homeFinanceAccountSnapshot", "homeFinanceAsset", "homeFinanceAssetValuation", "homeFinanceLoan", "homeFinanceLoanPayment", "homeFinanceRecurring"];
  const ctx: OpContext = {
    client: { models: Object.fromEntries(names.map((m) => [m, model(m)])) },
    storage: { storeFromUrl: async () => "", copyUpload: async () => "" },
    actor: { via: "whatsapp", personName: "Gennaro" },
  };
  const run = async (op: string, input: any) => {
    const r: any = await runOp(ctx, op, input);
    if ("error" in r) throw new Error(r.error);
    return r.result;
  };
  const fail = async (op: string, input: any) => {
    const r: any = await runOp(ctx, op, input);
    return r.error as string | undefined;
  };
  return { ctx, tables, run, fail };
}

const today = todayIso();
const synced = { id: "mort", name: "Mortgage", type: "LOAN", currentBalance: -418505.21, simplefinAccountId: "ACT-1", active: true };
const checking = { id: "chk", name: "Joint checking", type: "CHECKING", currentBalance: 6000, active: true };

describe("assets", () => {
  it("creates an asset with its purchase and today's value, and corrects a same-day value", async () => {
    const { run, tables } = setup();
    const r = await run("save_finance_asset", { name: "Home", type: "REAL_ESTATE", purchaseValue: 499900, purchaseDate: "2022-10-14", value: 515000, valueNotes: "Zillow" });
    expect(r).toMatchObject({ action: "created", asset: { name: "Home", value: 515000, valuedOn: today, purchaseValue: 499900 } });
    expect(r.asset.valuations.map((v: any) => [v.date, v.value, v.source])).toEqual([
      [today, 515000, "ESTIMATE"],
      ["2022-10-14", 499900, "PURCHASE"],
    ]);
    const again = await run("save_finance_asset", { assetId: r.asset.id, value: 520000 });
    expect(again.asset.value).toBe(520000);
    expect(tables.homeFinanceAssetValuation).toHaveLength(2);

    const sold = await run("save_finance_asset", { assetId: r.asset.id, soldDate: today, soldValue: 530000 });
    expect(sold.asset).toMatchObject({ active: false, soldValue: 530000, value: 520000 });
  });

  it("removes an asset with its history and unlinks its loans", async () => {
    const { run, tables } = setup({ homeFinanceAccount: [synced] });
    const a = await run("save_finance_asset", { name: "Home", value: 520000 });
    await run("save_finance_loan", { accountId: "mort", loanType: "MORTGAGE", originalPrincipal: 449577, interestRate: 0.045, termMonths: 360, firstPaymentDate: "2022-12-01", assetName: "home" });
    expect(tables.homeFinanceLoan[0].assetId).toBe(a.asset.id);
    await run("save_finance_asset", { assetId: a.asset.id, remove: true });
    expect(tables.homeFinanceAsset).toHaveLength(0);
    expect(tables.homeFinanceAssetValuation).toHaveLength(0);
    expect(tables.homeFinanceLoan[0].assetId).toBeNull();
  });
});

describe("loans", () => {
  it("attaches terms to the synced mortgage and shows equity", async () => {
    const { run, fail } = setup({ homeFinanceAccount: [synced, checking] });
    await run("save_finance_asset", { name: "Home", type: "REAL_ESTATE", value: 520000 });
    const r = await run("save_finance_loan", { accountId: "mort", loanType: "MORTGAGE", lender: "Chase", originalPrincipal: 449577, interestRate: 0.045, termMonths: 360, firstPaymentDate: "2022-12-01", escrowMonthly: 1341.46, assetName: "Home" });
    expect(r.loan).toMatchObject({ name: "Mortgage", synced: true, owed: 418505.21, payment: 2277.94, contractEnd: "2052-11-01", asset: { name: "Home", equity: 101494.79 } });
    expect(await fail("save_finance_loan", { accountId: "chk", originalPrincipal: 1, interestRate: 0.01, termMonths: 1, firstPaymentDate: "2027-01-01" })).toMatch(/needs a LOAN account/);
    expect(await fail("save_finance_loan", { accountId: "mort", originalPrincipal: 1, interestRate: 0.01, termMonths: 1, firstPaymentDate: "2027-01-01" })).toMatch(/already has a loan/);
    expect(await fail("save_finance_loan", { loanName: "mortgage", owed: 1 })).toMatch(/synced from SimpleFIN/);
    expect(await fail("save_finance_loan", { loanName: "mortgage", startDate: "2026-04-19" })).toMatch(/after the first payment/);
  });

  it("creates a manual car loan whose balance moves with payments", async () => {
    const { run, tables } = setup();
    const r = await run("save_finance_loan", { newAccountName: "BMW M850i", owed: 36409.33, loanType: "AUTO", originalPrincipal: 106622.78, interestRate: 0.0549, termMonths: 72, firstPaymentDate: "2023-01-30" });
    expect(r.loan).toMatchObject({ synced: false, owed: 36409.33, nextPaymentDate: expect.stringMatching(/-(28|29|30)$/) });
    const acct = tables.homeFinanceAccount[0];
    expect(acct).toMatchObject({ type: "LOAN", currentBalance: -36409.33, apr: 0.0549 });

    // Split estimated: a month of interest on 36,409.33 at 5.49% = 166.57.
    const p = await run("record_loan_payment", { loanName: "car", totalAmount: 2000, date: "2026-11-28" });
    expect(p).toMatchObject({ action: "created", balanceMoved: true, payment: { interest: 166.57, principal: 1833.43 }, owed: 34575.9 });
    expect(acct.currentBalance).toBe(-34575.9);

    // Correcting the split moves the balance by the difference.
    const e = await run("record_loan_payment", { paymentId: p.payment.id, principal: 1840, interest: 160 });
    expect(e.owed).toBe(34569.33);
    expect(acct.currentBalance).toBe(-34569.33);

    const x = await run("record_loan_payment", { loanName: "car", totalAmount: 5000, isExtra: true });
    expect(x.payment).toMatchObject({ principal: 5000, interest: 0, isExtra: true });
    expect(acct.currentBalance).toBe(-29569.33);

    await run("record_loan_payment", { paymentId: x.payment.id, remove: true });
    expect(acct.currentBalance).toBe(-34569.33);

    // Fixing the balance by hand.
    await run("save_finance_loan", { loanName: "BMW", owed: 34000 });
    expect(acct.currentBalance).toBe(-34000);
  });

  it("leaves a synced loan's balance to the bank and checks the split adds up", async () => {
    const { run, fail, tables } = setup({ homeFinanceAccount: [synced] });
    await run("save_finance_loan", { accountId: "mort", originalPrincipal: 449577, interestRate: 0.045, termMonths: 360, firstPaymentDate: "2022-12-01" });
    const p = await run("record_loan_payment", { totalAmount: 3619.4, principal: 703.26, interest: 1574.68, escrow: 1341.46, date: "2026-10-01" });
    expect(p).toMatchObject({ balanceMoved: false, owed: 418505.21 });
    expect(tables.homeFinanceAccount[0].currentBalance).toBe(-418505.21);
    expect(await fail("record_loan_payment", { totalAmount: 3619.4, principal: 703.26, interest: 1500, escrow: 1341.46 })).toMatch(/but the total is 3619.4/);

    const list = await run("list_finance_loans", { loanName: "mortgage" });
    expect(list.loans[0].payments).toHaveLength(1);
    expect(list.loans[0]).toMatchObject({ interestPaid: 1574.68, recentAverage: 3619.4 });
  });

  it("simulates paying faster", async () => {
    const { run } = setup();
    await run("save_finance_loan", { newAccountName: "Car", owed: 36409.33, loanType: "AUTO", originalPrincipal: 106622.78, interestRate: 0.0549, termMonths: 72, firstPaymentDate: "2023-01-30", monthlyPayment: 2000 });
    const s = await run("simulate_loan_payoff", { loanName: "car", extraMonthly: 500 });
    expect(s.baseline).toMatchObject({ payment: 2000, months: 20 });
    expect(s.scenario.payment).toBe(2500);
    expect(s.monthsSaved).toBeGreaterThan(3);
    expect(s.interestSaved).toBeGreaterThan(0);

    const by = await run("simulate_loan_payoff", { loanName: "car", payoffBy: s.baseline.payoffDate });
    expect(by.payoffBy.payment).toBeLessThanOrEqual(2000.01);
  });
});

describe("the lender's schedule and the scheduled transaction", () => {
  const bmwTerms = { loanType: "AUTO", lender: "BMW Financial Services", originalPrincipal: 106622.78, interestRate: 0.0549, termMonths: 72, firstPaymentDate: "2023-01-18", monthlyPayment: 1745.48, interestAccrual: "DAILY" };

  it("estimates a daily-interest split from the days since the last payment and flags it", async () => {
    const { run, tables } = setup();
    const r = await run("save_finance_loan", { newAccountName: "BMW", owed: 106622.78, ...bmwTerms });
    expect(r.loan.interestAccrual).toBe("DAILY");
    await run("record_loan_payment", { loanId: r.loan.id, date: "2023-01-18", totalAmount: 1745.48, principal: 1232.29, interest: 513.19, paymentNumber: 1 });
    // 28 days later, no split given: the lender's row 2 to the cent.
    const p2 = await run("record_loan_payment", { loanId: r.loan.id, date: "2023-02-15", totalAmount: 1745.48 });
    expect(p2.payment).toMatchObject({ interest: 443.85, principal: 1301.63, estimated: true, source: "MANUAL" });
    expect(tables.homeFinanceLoanPayment[0]).toMatchObject({ paymentNumber: 1, estimated: false });
    expect(p2.owed).toBe(104088.86);
  });

  it("imports the lender's rows: new ones added, an estimated one corrected, the balance set", async () => {
    const { run, tables } = setup();
    const r = await run("save_finance_loan", { newAccountName: "BMW", owed: 106622.78, ...bmwTerms });
    const loanId = r.loan.id;
    // A bank capture with an estimated split, and a hand-typed one that's already right.
    await run("record_loan_payment", { loanId, date: "2023-02-15", totalAmount: 1745.48 });
    await run("record_loan_payment", { loanId, date: "2023-03-29", totalAmount: 2000, principal: 1342.44, interest: 657.56 });
    const imp = await run("import_loan_payments", {
      loanId,
      source: "BMW FS schedule 2026-11-15",
      rows: [
        { number: 1, date: "2023-01-18", total: 1745.48, principal: 1232.29, interest: 513.19, balance: 105390.49 },
        { number: 2, date: "2023-02-15", total: 1745.48, principal: 1301.63, interest: 443.85, balance: 104088.86 },
        { number: 3, date: "2023-03-29", total: 2000, principal: 1342.44, interest: 657.56, balance: 102746.42 },
        { number: 4, date: "2023-04-26", total: 2000, principal: 1567.28, interest: 432.72, balance: 101179.14 },
        { number: 5, date: "2023-05-24", total: 2000, principal: 1573.89, interest: 400, balance: 99605.25 }, // doesn't add up
      ],
    });
    expect(imp).toMatchObject({ created: 2, updated: 2, unchanged: 0, owed: 101179.14, balanceMoved: true });
    expect(imp.problems).toHaveLength(1);
    const rows = tables.homeFinanceLoanPayment.sort((a: any, b: any) => a.date.localeCompare(b.date));
    expect(rows.map((p: any) => [p.paymentNumber, p.principal, p.source, p.estimated])).toEqual([
      [1, 1232.29, "LENDER", false],
      [2, 1301.63, "LENDER", false],
      [3, 1342.44, "LENDER", false],
      [4, 1567.28, "LENDER", false],
    ]);
    expect(rows[1].notes).toMatch(/BMW FS schedule/);
    // Re-running the same file changes nothing.
    const again = await run("import_loan_payments", { loanId, rows: [{ number: 4, date: "2023-04-26", total: 2000, principal: 1567.28, interest: 432.72, balance: 101179.14 }] });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1, balanceMoved: false });
    expect((await run("list_finance_loans", { loanId })).loans[0].principalAhead).toBeGreaterThan(0);
  });

  it("creates the scheduled transaction from the terms and links it; a schedule pays one loan", async () => {
    const { run, fail, tables } = setup({ homeFinanceAccount: [checking, synced] });
    const r = await run("save_finance_loan", { newAccountName: "BMW", owed: 36409.33, ...bmwTerms, newSchedule: { matchPattern: "BMW FINANCIAL" } });
    expect(tables.homeFinanceRecurring).toHaveLength(1);
    const s = tables.homeFinanceRecurring[0];
    expect(s).toMatchObject({ accountId: "chk", description: "BMW", amount: -1745.48, type: "EXPENSE", cadence: "MONTHLY", matchPattern: "BMW FINANCIAL", autopay: true, nextDate: r.loan.nextPaymentDate, endDate: r.loan.contractEnd });
    expect(r.loan.schedule).toMatchObject({ id: s.id, description: "BMW", account: "Joint checking" });
    expect(tables.homeFinanceLoan[0].recurringId).toBe(s.id);

    // The actual payment and the month's last day, when asked.
    await run("save_finance_loan", { loanId: r.loan.id, recurringId: null });
    const custom = await run("save_finance_loan", { loanId: r.loan.id, newSchedule: { accountId: "chk", amount: 2000, nextDate: "2026-11-20", lastDayOfMonth: true } });
    expect(tables.homeFinanceRecurring[1]).toMatchObject({ amount: -2000, nextDate: "2026-11-30", startDate: "2026-11-30", lastDayOfMonth: true });
    expect(custom.loan.schedule).toMatchObject({ amount: -2000, nextDate: "2026-11-30" });
    await run("save_finance_loan", { loanId: r.loan.id, recurringId: s.id });

    const m = await run("save_finance_loan", { accountId: "mort", loanType: "MORTGAGE", originalPrincipal: 449577, interestRate: 0.045, termMonths: 360, firstPaymentDate: "2022-12-01" });
    expect(await fail("save_finance_loan", { loanId: m.loan.id, recurringId: s.id })).toMatch(/already pays/);
    const unlinked = await run("save_finance_loan", { loanId: r.loan.id, recurringId: null });
    expect(unlinked.loan.schedule).toBeNull();
    expect(await fail("save_finance_loan", { loanId: r.loan.id, recurringId: "nope" })).toMatch(/No scheduled transaction/);
  });
});

describe("get_net_worth", () => {
  it("adds accounts and assets, with each asset's equity", async () => {
    const { run } = setup({
      homeFinanceAccount: [synced, checking, { id: "k", name: "401(k)", type: "RETIREMENT", currentBalance: 300000, active: true }],
      homeFinanceAccountSnapshot: [{ accountId: "chk", date: "2026-11-14", balance: 5000 }],
    });
    await run("save_finance_asset", { name: "Home", type: "REAL_ESTATE", value: 520000 });
    await run("save_finance_loan", { accountId: "mort", originalPrincipal: 449577, interestRate: 0.045, termMonths: 360, firstPaymentDate: "2022-12-01", assetName: "home" });
    const r = await run("get_net_worth", { includeHistory: true });
    expect(r.totals).toMatchObject({ total: 407494.79, cash: 6000, invested: 300000, property: 520000, debt: -418505.21 });
    expect(r.assets[0]).toMatchObject({ name: "Home", owed: 418505.21, equity: 101494.79 });
    expect(r.loans[0]).toMatchObject({ name: "Mortgage", asset: "Home" });
    expect(r.history.at(-1).total).toBe(407494.79);
  });
});
