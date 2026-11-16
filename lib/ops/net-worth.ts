// Net worth: assets (house, cars), loans (their terms, payments and payoff
// what-ifs) and the household total. Math lives in lib/finance/loans.ts and
// lib/finance/net-worth.ts; these ops are what Janet, the API, the CLI and
// the /finance/net-worth and loan pages' writes share.
//
// A loan's balance is its LOAN account's: a SimpleFIN-synced account owns
// it (recording a payment doesn't move it), a manual one moves by each
// recorded payment's principal.

import { z } from "zod/v4";
import { listAccounts, listAssetValuations, listAssets, listLoanPayments, listLoans, listSchedules, listSnapshots } from "../finance/data";
import { monthEnd, round2, todayIso } from "../finance/dates";
import { INTEREST_ACCRUALS, LOAN_TYPES, LOAN_TYPE_LABELS, compareToPlan, contractualPayment, interestDays, loanOutlook, paymentsBetween, paymentToFinishIn, simulatePayoff, suggestSplit, type LoanTerms } from "../finance/loans";
import { ASSET_TYPES, GROUP_LABELS, accountGroup, assetEquity, changeSince, netWorthHistory, netWorthNow, type NetWorthGroup } from "../finance/net-worth";
import { VALUE_PROVIDERS } from "../finance/asset-values";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const RATE = z.number().min(0).max(0.5).describe("Annual rate as a decimal: 0.045 for 4.5%");
const finite = (n: number) => (Number.isFinite(n) ? n : null);

// ── Loading ────────────────────────────────────────────────────────────────

type Loaded = { accounts: any[]; assets: any[]; loans: any[]; payments: any[]; schedules: any[] };

async function loadAll(ctx: OpContext): Promise<Loaded> {
  const [accounts, assets, loans, payments, schedules] = await Promise.all([listAccounts(ctx.client), listAssets(ctx.client), listLoans(ctx.client), listLoanPayments(ctx.client), listSchedules(ctx.client)]);
  return { accounts, assets, loans, payments, schedules };
}

const owedOn = (account: any) => round2(Math.max(0, -(account?.currentBalance ?? 0)));
const isSynced = (account: any) => !!account?.simplefinAccountId;
const termsOf = (l: any): LoanTerms => ({
  originalPrincipal: l.originalPrincipal,
  interestRate: l.interestRate,
  termMonths: l.termMonths,
  firstPaymentDate: l.firstPaymentDate,
  monthlyPayment: l.monthlyPayment,
  escrowMonthly: l.escrowMonthly,
  interestAccrual: l.interestAccrual ?? null,
});

function loanName(l: any, d: Loaded): string {
  return d.accounts.find((a) => a.id === l.accountId)?.name ?? LOAN_TYPE_LABELS[l.loanType as keyof typeof LOAN_TYPE_LABELS] ?? "Loan";
}

/** loanId, or a name: the account's, the asset's, the lender's, or the kind ("mortgage", "car"). */
function findLoan(d: Loaded, input: { loanId?: string; loanName?: string }): any {
  if (input.loanId) {
    const l = d.loans.find((x) => x.id === input.loanId);
    if (!l) throw new OpError(`No loan ${input.loanId}`);
    return l;
  }
  const q = input.loanName?.trim().toLowerCase();
  const list = () => d.loans.map((l) => `${loanName(l, d)} (${l.id})`).join(", ") || "none";
  if (!q) {
    if (d.loans.length === 1) return d.loans[0];
    throw new OpError(`Which loan? Loans: ${list()}`);
  }
  const alias: Record<string, string> = { car: "AUTO", auto: "AUTO", house: "MORTGAGE", home: "MORTGAGE", mortgage: "MORTGAGE" };
  const hits = d.loans.filter((l) => {
    const asset = d.assets.find((a) => a.id === l.assetId);
    const hay = [loanName(l, d), asset?.name, l.lender].filter(Boolean).map((s: string) => s.toLowerCase());
    return hay.some((h) => h.includes(q)) || alias[q] === l.loanType || (l.loanType ?? "").toLowerCase() === q;
  });
  if (hits.length === 1) return hits[0];
  throw new OpError(hits.length ? `"${input.loanName}" matches several loans: ${hits.map((l) => loanName(l, d)).join(", ")}` : `No loan matching "${input.loanName}". Loans: ${list()}`);
}

function findAsset(d: Loaded, input: { assetId?: string | null; assetName?: string | null }): any | null | undefined {
  if (input.assetId === null || input.assetName === null) return null;
  if (input.assetId) {
    const a = d.assets.find((x) => x.id === input.assetId);
    if (!a) throw new OpError(`No asset ${input.assetId}`);
    return a;
  }
  if (input.assetName) {
    const q = input.assetName.trim().toLowerCase();
    const hits = d.assets.filter((a) => a.active !== false && (a.name ?? "").toLowerCase().includes(q));
    if (hits.length !== 1) {
      throw new OpError(hits.length ? `"${input.assetName}" matches several assets: ${hits.map((a) => a.name).join(", ")}` : `No asset matching "${input.assetName}". Assets: ${d.assets.map((a) => a.name).join(", ") || "none"}`);
    }
    return hits[0];
  }
  return undefined;
}

// ── Output shapes ──────────────────────────────────────────────────────────

const PaymentOut = z.object({
  id: z.string(),
  date: z.string(),
  total: z.number(),
  principal: z.number(),
  interest: z.number(),
  escrow: z.number().nullable(),
  fees: z.number().nullable(),
  isExtra: z.boolean(),
  paymentNumber: z.number().nullable().describe("The lender's payment number"),
  source: z.string().nullable().describe("MANUAL, LENDER (imported schedule) or BANK (captured from a transaction)"),
  estimated: z.boolean().describe("The split was estimated, not taken from the lender"),
  notes: z.string().nullable(),
});

const paymentOut = (p: any): z.input<typeof PaymentOut> => ({
  id: p.id,
  date: p.date,
  total: p.totalAmount,
  principal: p.principal,
  interest: p.interest,
  escrow: p.escrow ?? null,
  fees: p.fees ?? null,
  isExtra: !!p.isExtra,
  paymentNumber: p.paymentNumber ?? null,
  source: p.source ?? null,
  estimated: !!p.estimated,
  notes: p.notes ?? null,
});

const ScheduleRef = z.object({
  id: z.string(),
  description: z.string(),
  amount: z.number(),
  nextDate: z.string().nullable(),
  autopay: z.boolean(),
  accountId: z.string(),
  account: z.string().nullable(),
});

const scheduleRef = (s: any, d: Loaded): z.input<typeof ScheduleRef> => ({
  id: s.id,
  description: s.description,
  amount: s.amount,
  nextDate: s.nextDate ?? null,
  autopay: s.autopay !== false,
  accountId: s.accountId,
  account: d.accounts.find((a) => a.id === s.accountId)?.name ?? null,
});

const LoanOut = z.object({
  id: z.string(),
  name: z.string(),
  accountId: z.string(),
  loanType: z.string().nullable(),
  lender: z.string().nullable(),
  synced: z.boolean().describe("Balance comes from SimpleFIN; otherwise it moves with recorded payments"),
  owed: z.number(),
  originalPrincipal: z.number(),
  interestRate: z.number(),
  termMonths: z.number(),
  startDate: z.string().nullable(),
  firstPaymentDate: z.string(),
  payment: z.number().describe("Contractual principal + interest per month"),
  escrowMonthly: z.number().nullable(),
  interestAccrual: z.string().describe("MONTHLY or DAILY (simple interest on the days between payments)"),
  schedule: ScheduleRef.nullable().describe("The scheduled transaction that pays it; a linked bank transaction records the payment automatically"),
  principalAhead: z.number().describe("Principal paid beyond the contract's rows so far (negative = behind)"),
  nextPaymentDate: z.string(),
  contractEnd: z.string().describe("Date of the last payment under the original terms"),
  projectedPayoff: z.string().nullable().describe("When it's paid off at the contractual payment from today's balance"),
  monthsLeft: z.number().nullable(),
  monthsAhead: z.number().nullable().describe("Months ahead of the original schedule (negative = behind)"),
  paidOffPct: z.number(),
  principalPaid: z.number(),
  interestPaid: z.number().describe("Σ interest on recorded payments"),
  interestLeft: z.number().describe("Interest still to pay at the contractual payment"),
  recentAverage: z.number().nullable().describe("Average of the last 6 regular recorded payments (escrow included)"),
  asset: z.object({ id: z.string(), name: z.string(), value: z.number(), equity: z.number() }).nullable(),
  payments: z.array(PaymentOut),
});

function loanOut(l: any, d: Loaded, today: string, paymentLimit: number): z.input<typeof LoanOut> {
  const account = d.accounts.find((a) => a.id === l.accountId);
  const payments = d.payments.filter((p) => p.loanId === l.id);
  const terms = termsOf(l);
  const o = loanOutlook(terms, owedOn(account), payments, today);
  const eq = l.assetId ? assetEquity(d.assets, d.loans, d.accounts).find((e) => e.asset.id === l.assetId) : null;
  const schedule = l.recurringId ? d.schedules.find((s) => s.id === l.recurringId) : null;
  const plan = compareToPlan(terms, payments);
  return {
    id: l.id,
    name: loanName(l, d),
    accountId: l.accountId,
    loanType: l.loanType ?? null,
    lender: l.lender ?? null,
    synced: isSynced(account),
    owed: o.owed,
    originalPrincipal: l.originalPrincipal,
    interestRate: l.interestRate,
    termMonths: l.termMonths,
    startDate: l.startDate ?? null,
    firstPaymentDate: l.firstPaymentDate,
    payment: o.payment,
    escrowMonthly: l.escrowMonthly ?? null,
    interestAccrual: l.interestAccrual ?? "MONTHLY",
    schedule: schedule ? scheduleRef(schedule, d) : null,
    principalAhead: plan.length ? plan[plan.length - 1].cumulative : 0,
    nextPaymentDate: o.nextPaymentDate,
    contractEnd: o.contractEnd,
    projectedPayoff: o.projected.payoffDate,
    monthsLeft: finite(o.projected.months),
    monthsAhead: finite(o.monthsAhead),
    paidOffPct: Math.round(o.paidOffPct * 1000) / 1000,
    principalPaid: o.principalPaid,
    interestPaid: o.interestPaid,
    interestLeft: o.interestLeft,
    recentAverage: o.recentAverage,
    asset: eq ? { id: eq.asset.id, name: eq.asset.name ?? "Asset", value: eq.value, equity: eq.equity } : null,
    payments: payments.slice(0, paymentLimit).map(paymentOut),
  };
}

const AssetOut = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  value: z.number(),
  valuedOn: z.string().nullable(),
  purchaseValue: z.number().nullable(),
  purchaseDate: z.string().nullable(),
  valueProvider: z.string().nullable().describe("RENTCAST, MARKETCHECK or DEPRECIATION: its value is refreshed automatically; null = by hand"),
  address: z.string().nullable(),
  bedrooms: z.number().nullable(),
  bathrooms: z.number().nullable(),
  squareFootage: z.number().nullable(),
  vin: z.string().nullable(),
  mileage: z.number().nullable(),
  mileageDate: z.string().nullable(),
  zip: z.string().nullable(),
  annualDepreciation: z.number().nullable(),
  owed: z.number().describe("What the loans it secures still owe"),
  equity: z.number(),
  ltv: z.number().nullable().describe("Loan-to-value, 0..1"),
  loans: z.array(z.object({ id: z.string(), name: z.string().nullable(), owed: z.number() })),
  active: z.boolean(),
  soldDate: z.string().nullable(),
  soldValue: z.number().nullable(),
  valuations: z.array(z.object({ id: z.string(), date: z.string(), value: z.number(), source: z.string().nullable(), notes: z.string().nullable() })),
});

function assetOut(a: any, d: Loaded, valuations: any[]): z.input<typeof AssetOut> {
  const eq = assetEquity([{ ...a, active: true }], d.loans, d.accounts)[0];
  return {
    id: a.id,
    name: a.name,
    type: a.type ?? null,
    value: a.currentValue ?? 0,
    valuedOn: a.valuedOn ?? null,
    purchaseValue: a.purchaseValue ?? null,
    purchaseDate: a.purchaseDate ?? null,
    valueProvider: a.valueProvider ?? null,
    address: a.address ?? null,
    bedrooms: a.bedrooms ?? null,
    bathrooms: a.bathrooms ?? null,
    squareFootage: a.squareFootage ?? null,
    vin: a.vin ?? null,
    mileage: a.mileage ?? null,
    mileageDate: a.mileageDate ?? null,
    zip: a.zip ?? null,
    annualDepreciation: a.annualDepreciation ?? null,
    owed: eq.owed,
    equity: eq.equity,
    ltv: eq.ltv == null ? null : Math.round(eq.ltv * 1000) / 1000,
    loans: eq.loans.map((l) => ({ id: l.loanId, name: l.name, owed: l.owed })),
    active: a.active !== false,
    soldDate: a.soldDate ?? null,
    soldValue: a.soldValue ?? null,
    valuations: valuations
      .filter((v) => v.assetId === a.id)
      .sort((x, y) => y.date.localeCompare(x.date))
      .map((v) => ({ id: v.id, date: v.date, value: v.value, source: v.source ?? null, notes: v.notes ?? null })),
  };
}

const Totals = z.object({
  total: z.number(),
  assets: z.number().describe("Everything positive: cash, invested, property"),
  liabilities: z.number().describe("Everything owed, as a positive number"),
  cash: z.number(),
  invested: z.number(),
  property: z.number(),
  debt: z.number().describe("Negative"),
  other: z.number(),
});

// ── get_net_worth ──────────────────────────────────────────────────────────

export const getNetWorth = defineOp({
  name: "get_net_worth",
  domain: "finance",
  access: "read",
  description:
    "The household's net worth today: cash, invested accounts (401k, IRA, brokerage), property (the house, cars: their latest value) and debts (mortgage, car loan, cards), each asset's equity against the loans it secures, and how the total changed over the last 30 days (history starts at the first daily account snapshot). Answers 'what's our net worth?', 'how much equity do we have in the house?', 'how much do we still owe on the car?', 'are we up this month?'. includeHistory adds the series for a chart.",
  input: z.object({
    includeHistory: z.boolean().optional().describe("Add the net worth series (daily, then weekly/monthly as it grows)"),
  }),
  output: z.object({
    date: z.string(),
    totals: Totals,
    change30d: z.object({ from: z.string(), amount: z.number() }).nullable(),
    accounts: z.array(z.object({ id: z.string(), name: z.string(), type: z.string().nullable(), group: z.string(), balance: z.number() })),
    assets: z.array(AssetOut.omit({ valuations: true })),
    loans: z.array(z.object({ id: z.string(), name: z.string(), owed: z.number(), interestRate: z.number(), payment: z.number(), projectedPayoff: z.string().nullable(), asset: z.string().nullable() })),
    history: z.array(z.object({ date: z.string(), total: z.number(), cash: z.number(), invested: z.number(), property: z.number(), debt: z.number() })).optional(),
  }),
  async run(ctx, input) {
    const today = todayIso();
    const d = await loadAll(ctx);
    const [valuations, snapshots] = await Promise.all([listAssetValuations(ctx.client), listSnapshots(ctx.client)]);
    const history = netWorthHistory({ accounts: d.accounts, snapshots, assets: d.assets, valuations, today });
    const live = d.accounts.filter((a) => a.active !== false);
    return {
      date: today,
      totals: netWorthNow(d.accounts, d.assets),
      change30d: changeSince(history, 30),
      accounts: live.map((a) => ({ id: a.id, name: a.name, type: a.type ?? null, group: GROUP_LABELS[accountGroup(a.type) as NetWorthGroup], balance: a.currentBalance ?? 0 })),
      assets: d.assets.filter((a) => a.active !== false).map((a) => {
        const { valuations: _v, ...rest } = assetOut(a, d, []);
        return rest;
      }),
      loans: d.loans.map((l) => {
        const o = loanOut(l, d, today, 0);
        return { id: o.id, name: o.name, owed: o.owed, interestRate: o.interestRate, payment: o.payment, projectedPayoff: o.projectedPayoff, asset: o.asset?.name ?? null };
      }),
      ...(input.includeHistory ? { history: history.map((p) => ({ date: p.date, total: p.total, cash: p.cash, invested: p.invested, property: p.property, debt: p.debt })) } : {}),
    };
  },
});

// ── list_finance_loans ─────────────────────────────────────────────────────

export const listFinanceLoans = defineOp({
  name: "list_finance_loans",
  domain: "finance",
  access: "read",
  description:
    "The household's loans (mortgage, car loan…) with where each stands: what's owed, rate, monthly payment, next payment date, the payoff date at the current payment vs the original schedule (months ahead/behind), interest paid and still to pay, and the asset it's secured by with its equity. Recent payments are included (all of them for one loan). Answers 'when will the car be paid off?', 'how much interest have we paid on the mortgage?', 'what's the mortgage payment?'.",
  input: z.object({
    loanId: z.string().optional(),
    loanName: z.string().optional().describe("Account, asset or lender name, or the kind: 'mortgage', 'car'"),
  }),
  output: z.object({ loans: z.array(LoanOut) }),
  async run(ctx, input) {
    const d = await loadAll(ctx);
    const today = todayIso();
    const one = input.loanId || input.loanName ? findLoan(d, input) : null;
    const rows = one ? [one] : d.loans;
    return { loans: rows.map((l) => loanOut(l, d, today, one ? 10_000 : 3)) };
  },
});

// ── simulate_loan_payoff ───────────────────────────────────────────────────

const Plan = z.object({ payment: z.number(), months: z.number().nullable(), payoffDate: z.string().nullable(), totalInterest: z.number(), totalPaid: z.number() });

export const simulateLoanPayoff = defineOp({
  name: "simulate_loan_payoff",
  domain: "finance",
  access: "read",
  description:
    "What-if for paying a loan off faster: extra each month, a one-time lump sum, a different monthly payment, or a target payoff date (returns the payment needed). Compares against keeping the contractual payment: months and interest saved. Answers 'if we pay $500 more a month on the car, when is it done?', 'what if we put $20k on the mortgage?', 'how much a month to pay the car off by next December?'. Changes nothing.",
  input: z.object({
    loanId: z.string().optional(),
    loanName: z.string().optional(),
    extraMonthly: z.number().min(0).optional().describe("On top of the monthly payment"),
    lumpSum: z.number().min(0).optional().describe("Paid once, before the next payment"),
    payment: z.number().positive().optional().describe("Monthly principal + interest instead of the contractual one"),
    payoffBy: DATE.optional().describe("Target payoff date: returns the monthly payment that gets there"),
  }),
  output: z.object({
    loan: z.string(),
    owed: z.number(),
    baseline: Plan,
    scenario: Plan,
    monthsSaved: z.number().nullable(),
    interestSaved: z.number(),
    payoffBy: z.object({ date: z.string(), payment: z.number(), extraMonthly: z.number() }).nullable(),
  }),
  async run(ctx, input) {
    const d = await loadAll(ctx);
    const l = findLoan(d, input);
    const today = todayIso();
    const terms = termsOf(l);
    const o = loanOutlook(terms, owedOn(d.accounts.find((a) => a.id === l.accountId)), [], today);
    const base = o.projected;
    const pay = input.payment ?? o.payment;
    const sc = simulatePayoff({ balance: o.owed, annualRate: l.interestRate, payment: pay, firstDate: o.nextPaymentDate, extraMonthly: input.extraMonthly, lumpSum: input.lumpSum });
    const plan = (p: typeof sc, payment: number) => ({ payment: round2(payment), months: finite(p.months), payoffDate: p.payoffDate, totalInterest: p.totalInterest, totalPaid: p.totalPaid });
    let payoffBy = null;
    if (input.payoffBy) {
      if (input.payoffBy < o.nextPaymentDate) throw new OpError(`The next payment is ${o.nextPaymentDate}; pick a later date (or use lumpSum to pay it off now)`);
      const n = paymentsBetween(o.nextPaymentDate, input.payoffBy);
      const needed = paymentToFinishIn(Math.max(0, o.owed - (input.lumpSum ?? 0)), l.interestRate, n);
      payoffBy = { date: input.payoffBy, payment: needed, extraMonthly: round2(Math.max(0, needed - o.payment)) };
    }
    return {
      loan: loanName(l, d),
      owed: o.owed,
      baseline: plan(base, o.payment),
      scenario: plan(sc, pay + (input.extraMonthly ?? 0)),
      monthsSaved: Number.isFinite(base.months) && Number.isFinite(sc.months) ? base.months - sc.months : null,
      interestSaved: round2(base.totalInterest - sc.totalInterest),
      payoffBy,
    };
  },
});

// ── save_finance_asset ─────────────────────────────────────────────────────

async function syncCurrentValue(ctx: OpContext, assetId: string) {
  const vals = (await listAssetValuations(ctx.client)).filter((v) => v.assetId === assetId && v.source !== "SALE");
  const latest = vals[vals.length - 1];
  if (latest) await ctx.client.models.homeFinanceAsset.update({ id: assetId, currentValue: latest.value, valuedOn: latest.date });
}

export const saveFinanceAsset = defineOp({
  name: "save_finance_asset",
  domain: "finance",
  access: "write",
  description:
    "Add or change something the household owns that isn't an account (the house, a car, a collectible), for net worth. `value` records a new valuation (an estimate like Zillow or KBB, or an appraisal) dated valuedOn (default today) and becomes the current value; history is kept for the net worth chart. Automatic market value: valueProvider RENTCAST (needs address 'Street, City, State, Zip'), MARKETCHECK (needs vin, mileage, zip) or DEPRECIATION (purchase price and date, annualDepreciation default 0.15); refreshed monthly and with refresh_asset_values. Update mileage now and then (mileageDate). Selling: soldDate + soldValue. A loan secured by it is linked from the loan (save_finance_loan assetId). With assetId, only the fields given change. remove deletes it with its valuation history (loans pointing at it are unlinked); removeValuationId drops one wrong valuation.",
  input: z.object({
    assetId: z.string().optional(),
    name: z.string().optional(),
    type: z.enum(ASSET_TYPES).optional(),
    purchaseValue: z.number().min(0).nullable().optional(),
    purchaseDate: DATE.nullable().optional(),
    valueProvider: z.enum(VALUE_PROVIDERS).nullable().optional().describe("null = valued by hand"),
    address: z.string().nullable().optional().describe("Full address for RentCast: 'Street, City, State, Zip'"),
    bedrooms: z.number().int().min(0).nullable().optional().describe("Sent to RentCast so the comps match"),
    bathrooms: z.number().min(0).nullable().optional(),
    squareFootage: z.number().int().min(0).nullable().optional(),
    vin: z.string().nullable().optional(),
    mileage: z.number().int().min(0).nullable().optional(),
    mileageDate: DATE.nullable().optional().describe("Default today when mileage is given"),
    zip: z.string().nullable().optional().describe("5-digit ZIP for the car's market"),
    annualDepreciation: z.number().min(0).max(1).nullable().optional().describe("0.15 = loses 15% a year"),
    value: z.number().min(0).optional().describe("Today's value (or on valuedOn)"),
    valuedOn: DATE.optional(),
    valueSource: z.enum(["ESTIMATE", "APPRAISAL"]).optional().describe("Default ESTIMATE"),
    valueNotes: z.string().optional().describe("Where the value came from: 'Zillow', 'KBB private party'"),
    ownerPersonIds: z.array(z.string()).optional().describe("[] = household"),
    soldDate: DATE.nullable().optional(),
    soldValue: z.number().min(0).nullable().optional(),
    active: z.boolean().optional(),
    notes: z.string().nullable().optional(),
    sortOrder: z.number().int().nullable().optional(),
    removeValuationId: z.string().optional(),
    remove: z.boolean().optional(),
  }),
  output: z.object({ action: z.enum(["created", "updated", "removed"]), asset: AssetOut.nullable() }),
  async run(ctx, input) {
    const M = ctx.client.models;
    const d = await loadAll(ctx);
    const existing = input.assetId ? d.assets.find((a) => a.id === input.assetId) : null;
    if (input.assetId && !existing) throw new OpError(`No asset ${input.assetId}`);

    if (input.remove) {
      if (!existing) throw new OpError("remove needs assetId");
      for (const l of d.loans.filter((x) => x.assetId === existing.id)) await M.homeFinanceLoan.update({ id: l.id, assetId: null });
      for (const v of (await listAssetValuations(ctx.client)).filter((x) => x.assetId === existing.id)) await M.homeFinanceAssetValuation.delete({ id: v.id });
      const r = await M.homeFinanceAsset.delete({ id: existing.id });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      return { action: "removed" as const, asset: null };
    }

    const fields: Record<string, unknown> = Object.fromEntries(
      (["name", "type", "purchaseValue", "purchaseDate", "valueProvider", "address", "bedrooms", "bathrooms", "squareFootage", "vin", "mileage", "mileageDate", "zip", "annualDepreciation", "ownerPersonIds", "soldDate", "soldValue", "active", "notes", "sortOrder"] as const)
        .filter((k) => input[k] !== undefined)
        .map((k) => [k, input[k]]),
    );
    if (typeof fields.name === "string") fields.name = fields.name.trim();
    if (typeof fields.vin === "string") fields.vin = fields.vin.trim().toUpperCase() || null;
    if (typeof fields.address === "string") fields.address = fields.address.trim() || null;
    if (typeof fields.zip === "string") fields.zip = fields.zip.trim() || null;
    if (input.mileage != null && input.mileageDate === undefined && input.mileage !== existing?.mileage) fields.mileageDate = todayIso();
    if (input.soldDate) fields.active = false;
    if (input.soldDate === null && input.active === undefined) fields.active = true;

    let asset: any;
    let action: "created" | "updated";
    if (existing) {
      if (!Object.keys(fields).length && input.value === undefined && !input.removeValuationId) throw new OpError("Nothing to change");
      if (Object.keys(fields).length) {
        const r = await M.homeFinanceAsset.update({ id: existing.id, ...fields });
        if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      }
      asset = existing;
      action = "updated";
    } else {
      if (!input.name?.trim()) throw new OpError("name is required");
      const start = input.value ?? input.purchaseValue;
      if (start == null) throw new OpError("Give its value (value) or what it cost (purchaseValue)");
      const r = await M.homeFinanceAsset.create({ type: "OTHER", active: true, ...fields, name: input.name.trim(), currentValue: start, valuedOn: input.value != null ? input.valuedOn ?? todayIso() : input.purchaseDate ?? todayIso() });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      asset = r.data;
      action = "created";
      // The purchase is the first point of its history.
      if (input.purchaseValue != null && input.purchaseDate) {
        await M.homeFinanceAssetValuation.create({ assetId: asset.id, date: input.purchaseDate, value: input.purchaseValue, source: "PURCHASE" });
      }
    }

    if (input.removeValuationId) {
      const vals = await listAssetValuations(ctx.client);
      if (!vals.some((v) => v.id === input.removeValuationId && v.assetId === asset.id)) throw new OpError(`Valuation ${input.removeValuationId} isn't on this asset`);
      await M.homeFinanceAssetValuation.delete({ id: input.removeValuationId });
    }
    if (input.value !== undefined) {
      const date = input.valuedOn ?? todayIso();
      // One valuation per day: a second one that day corrects the first.
      const same = (await listAssetValuations(ctx.client)).find((v) => v.assetId === asset.id && v.date === date && v.source !== "PURCHASE" && v.source !== "SALE");
      const row = { assetId: asset.id, date, value: input.value, source: input.valueSource ?? "ESTIMATE", notes: input.valueNotes?.trim() || null };
      const r = same ? await M.homeFinanceAssetValuation.update({ id: same.id, ...row }) : await M.homeFinanceAssetValuation.create(row);
      if (r.errors?.length) throw new Error(r.errors[0].message);
    }
    if (input.soldDate && input.soldValue != null) {
      const vals = await listAssetValuations(ctx.client);
      const sale = vals.find((v) => v.assetId === asset.id && v.source === "SALE");
      const row = { assetId: asset.id, date: input.soldDate, value: input.soldValue, source: "SALE" as const };
      if (sale) await M.homeFinanceAssetValuation.update({ id: sale.id, ...row });
      else await M.homeFinanceAssetValuation.create(row);
    }
    if (input.value !== undefined || input.removeValuationId) await syncCurrentValue(ctx, asset.id);

    const fresh = await loadAll(ctx);
    const saved = fresh.assets.find((a) => a.id === asset.id);
    return { action, asset: assetOut(saved, fresh, await listAssetValuations(ctx.client)) };
  },
});

// ── refresh_asset_values ───────────────────────────────────────────────────

export const refreshAssetValuesOp = defineOp({
  name: "refresh_asset_values",
  domain: "finance",
  access: "write",
  description:
    "Fetch today's market value for every asset that has a value provider (RentCast for the house, MarketCheck for a car by VIN + mileage, or the depreciation curve), or for one asset, and record it as an ESTIMATE valuation. The scheduled finance sync does this monthly; this is the 'refresh now'. Answers 'what's the house worth now?' when a fresh number is wanted. Runs in the finance-sync Lambda.",
  input: z.object({
    assetId: z.string().optional(),
    assetName: z.string().optional(),
  }),
  output: z.object({
    results: z.array(z.object({ assetId: z.string(), name: z.string(), provider: z.string().nullable(), value: z.number().nullable(), previous: z.number().nullable(), change: z.number().nullable(), skipped: z.boolean(), error: z.string().nullable() })),
  }),
  async run(ctx, input) {
    const d = await loadAll(ctx);
    const asset = findAsset(d, input);
    if (asset === null) throw new OpError("Which asset?");
    const mutations = ctx.client.mutations;
    if (!mutations?.refreshAssetValues) throw new OpError("refreshAssetValues isn't available on this client");
    const r = await mutations.refreshAssetValues(asset ? { assetId: asset.id } : {});
    if (r.errors?.length) throw new Error(r.errors[0].message);
    let data = r.data;
    for (let i = 0; i < 3 && typeof data === "string"; i++) data = JSON.parse(data);
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length && !asset) throw new OpError("No asset has a value provider yet (save_finance_asset valueProvider)");
    return { results };
  },
});

// ── save_finance_loan ──────────────────────────────────────────────────────

export const saveFinanceLoan = defineOp({
  name: "save_finance_loan",
  domain: "finance",
  access: "write",
  description:
    "Add or change a loan's terms (mortgage, car loan, student loan). The balance lives on a LOAN account: pass accountId to attach to an existing one (the SimpleFIN-synced mortgage), or newAccountName + owed to create a manual one (its balance then moves with record_loan_payment). owed also corrects a manual loan's balance. assetId / assetName links what secures it (mortgage → the house), for equity; null unlinks. interestAccrual DAILY for simple-interest loans (most auto loans): estimated splits then use the days since the last payment. recurringId links the scheduled transaction that pays it (null unlinks); newSchedule creates one from the terms (monthly, the contractual payment + escrow, next due on the next payment date) on the given checking account, with matchPattern so the sync links the bank's rows — a linked transaction then records the payment here automatically. With loanId, only the fields given change. remove deletes the loan's terms and payment history but keeps the account and the schedule.",
  input: z.object({
    loanId: z.string().optional(),
    loanName: z.string().optional().describe("Find the loan to change by name"),
    accountId: z.string().optional().describe("Existing LOAN account holding the balance"),
    newAccountName: z.string().optional().describe("Create a manual LOAN account with this name"),
    institution: z.string().optional(),
    owed: z.number().min(0).optional().describe("What's owed now, positive; manual accounts only"),
    loanType: z.enum(LOAN_TYPES).optional(),
    lender: z.string().nullable().optional(),
    originalPrincipal: z.number().positive().optional(),
    interestRate: RATE.optional(),
    termMonths: z.number().int().positive().max(600).optional(),
    startDate: DATE.nullable().optional(),
    firstPaymentDate: DATE.optional(),
    monthlyPayment: z.number().positive().nullable().optional().describe("Contractual principal + interest; null = computed from the terms"),
    escrowMonthly: z.number().min(0).nullable().optional(),
    interestAccrual: z.enum(INTEREST_ACCRUALS).optional().describe("MONTHLY (default) or DAILY simple interest"),
    assetId: z.string().nullable().optional(),
    assetName: z.string().nullable().optional(),
    recurringId: z.string().nullable().optional().describe("The scheduled transaction that pays it; null unlinks"),
    newSchedule: z
      .object({
        accountId: z.string().optional().describe("The account it's paid from; default the household checking account"),
        amount: z.number().positive().optional().describe("What's actually paid each month; default the contractual payment + escrow"),
        nextDate: DATE.optional().describe("When it's next due; default the loan's next payment date"),
        lastDayOfMonth: z.boolean().optional().describe("Due on each month's last day instead of a fixed day"),
        matchPattern: z.string().nullable().optional().describe("A word from the bank description ('BMW FINANCIAL'); default the lender or account name"),
        autopay: z.boolean().optional(),
      })
      .optional()
      .describe("Create the scheduled transaction from the loan's terms and link it"),
    notes: z.string().nullable().optional(),
    remove: z.boolean().optional(),
  }),
  output: z.object({ action: z.enum(["created", "updated", "removed"]), loan: LoanOut.nullable() }),
  async run(ctx, input) {
    const M = ctx.client.models;
    const d = await loadAll(ctx);
    const existing = input.loanId || input.loanName ? findLoan(d, input) : null;

    if (input.remove) {
      if (!existing) throw new OpError("remove needs loanId or loanName");
      for (const p of d.payments.filter((x) => x.loanId === existing.id)) await M.homeFinanceLoanPayment.delete({ id: p.id });
      const r = await M.homeFinanceLoan.delete({ id: existing.id });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      return { action: "removed" as const, loan: null };
    }

    const asset = findAsset(d, input);
    const fields: Record<string, unknown> = Object.fromEntries(
      (["loanType", "lender", "originalPrincipal", "interestRate", "termMonths", "startDate", "firstPaymentDate", "monthlyPayment", "escrowMonthly", "interestAccrual", "notes"] as const).filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
    );
    if (asset !== undefined) fields.assetId = asset?.id ?? null;
    if (input.recurringId !== undefined && input.newSchedule) throw new OpError("Give recurringId or newSchedule, not both");
    if (input.recurringId) {
      const s = d.schedules.find((x) => x.id === input.recurringId);
      if (!s) throw new OpError(`No scheduled transaction ${input.recurringId}`);
      const taken = d.loans.find((l) => l.recurringId === s.id && l.id !== existing?.id);
      if (taken) throw new OpError(`"${s.description}" already pays the loan ${loanName(taken, d)}`);
      fields.recurringId = s.id;
    } else if (input.recurringId === null) fields.recurringId = null;
    const start = (fields.startDate ?? existing?.startDate) as string | null | undefined;
    const first = (fields.firstPaymentDate ?? existing?.firstPaymentDate) as string | undefined;
    if (start && first && start > first) throw new OpError(`startDate ${start} is after the first payment (${first})`);

    // Which account holds the balance.
    let accountId: string | undefined = existing?.accountId;
    if (input.accountId || input.newAccountName) {
      if (existing && input.accountId && input.accountId !== existing.accountId) throw new OpError("A loan stays on its account; remove it and add it again to move it");
      if (input.accountId) {
        const acct = d.accounts.find((a) => a.id === input.accountId);
        if (!acct) throw new OpError(`No account ${input.accountId}`);
        if (acct.type !== "LOAN") throw new OpError(`${acct.name} is a ${acct.type} account; a loan needs a LOAN account`);
        accountId = acct.id;
      } else if (!existing) {
        if (input.owed == null) throw new OpError("owed is required with newAccountName");
        const r = await M.homeFinanceAccount.create({
          name: input.newAccountName!.trim(),
          type: "LOAN",
          institution: input.institution?.trim() || (input.lender ?? null),
          currentBalance: -input.owed,
          apr: input.interestRate ?? null,
          active: true,
          balanceUpdatedAt: new Date().toISOString(),
        });
        if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Creating the account failed");
        accountId = r.data.id;
        d.accounts.push(r.data);
      }
    }
    if (!accountId) throw new OpError("Pass accountId (an existing LOAN account) or newAccountName + owed");
    const other = d.loans.find((l) => l.accountId === accountId && l.id !== existing?.id);
    if (other) throw new OpError(`That account already has a loan (${other.id})`);
    const account = d.accounts.find((a) => a.id === accountId);

    let saved: any;
    let action: "created" | "updated";
    if (existing) {
      if (!Object.keys(fields).length && input.owed === undefined && !input.newSchedule) throw new OpError("Nothing to change");
      if (Object.keys(fields).length) {
        const r = await M.homeFinanceLoan.update({ id: existing.id, ...fields });
        if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
        saved = r.data;
      } else saved = existing;
      action = "updated";
    } else {
      const missing = (["originalPrincipal", "interestRate", "termMonths", "firstPaymentDate"] as const).filter((k) => input[k] == null);
      if (missing.length) throw new OpError(`A new loan needs ${missing.join(", ")}`);
      const r = await M.homeFinanceLoan.create({ loanType: "OTHER", ...fields, accountId });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      saved = r.data;
      action = "created";
    }

    // Keep the account in step: its APR, and a manual balance when given.
    const acctPatch: Record<string, unknown> = {};
    if (input.interestRate != null && account?.apr !== input.interestRate) acctPatch.apr = input.interestRate;
    if (input.owed !== undefined && !input.newAccountName) {
      if (isSynced(account)) throw new OpError(`${account.name} is synced from SimpleFIN; its balance comes from the bank`);
      acctPatch.currentBalance = -input.owed;
      acctPatch.balanceUpdatedAt = new Date().toISOString();
    }
    if (Object.keys(acctPatch).length) await M.homeFinanceAccount.update({ id: accountId, ...acctPatch });

    // The scheduled transaction that pays it, from the terms.
    if (input.newSchedule) {
      const ns = input.newSchedule;
      const from = ns.accountId
        ? d.accounts.find((a) => a.id === ns.accountId)
        : (d.accounts.find((a) => a.active !== false && a.type === "CHECKING" && !(a.ownerPersonIds ?? []).length) ?? d.accounts.find((a) => a.active !== false && a.type === "CHECKING"));
      if (!from) throw new OpError(ns.accountId ? `No account ${ns.accountId}` : "No household checking account to pay it from; pass newSchedule.accountId");
      const terms = termsOf(saved);
      const o = loanOutlook(terms, owedOn(account), [], todayIso());
      const name = account?.name ?? LOAN_TYPE_LABELS[saved.loanType as keyof typeof LOAN_TYPE_LABELS] ?? "Loan";
      const due = ns.nextDate ?? o.nextPaymentDate;
      const nextDate = ns.lastDayOfMonth ? monthEnd(due) : due;
      const r = await M.homeFinanceRecurring.create({
        accountId: from.id,
        description: name,
        amount: -round2(ns.amount ?? contractualPayment(terms) + (saved.escrowMonthly ?? 0)),
        type: "EXPENSE",
        cadence: "MONTHLY",
        startDate: nextDate,
        nextDate,
        lastDayOfMonth: ns.lastDayOfMonth ?? false,
        endDate: o.contractEnd,
        matchPattern: ns.matchPattern === undefined ? (saved.lender ?? name) : ns.matchPattern,
        autopay: ns.autopay ?? true,
        active: true,
        notes: `Pays the ${name} loan`,
      });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Creating the scheduled transaction failed");
      const u = await M.homeFinanceLoan.update({ id: saved.id, recurringId: r.data.id });
      if (u.errors?.length) throw new Error(u.errors[0].message);
    }

    const fresh = await loadAll(ctx);
    return { action, loan: loanOut(fresh.loans.find((l) => l.id === saved.id), fresh, todayIso(), 3) };
  },
});

// ── record_loan_payment ────────────────────────────────────────────────────

export const recordLoanPayment = defineOp({
  name: "record_loan_payment",
  domain: "finance",
  access: "write",
  description:
    "Record a payment made on a loan (or fix / remove one: paymentId, remove). Give the total; principal and interest come from the lender's statement when known, otherwise interest is estimated on what's owed (a month of it, or the days since the last payment for a DAILY-accrual loan) and the rest (after escrow and fees) goes to principal; such a row is marked estimated. isExtra = principal-only extra payment. On a manual loan account the balance drops by the principal (and moves back on edit/remove); a SimpleFIN-synced loan's balance comes from the bank.",
  input: z.object({
    loanId: z.string().optional(),
    loanName: z.string().optional(),
    paymentId: z.string().optional(),
    remove: z.boolean().optional(),
    date: DATE.optional().describe("Default today"),
    totalAmount: z.number().positive().optional(),
    principal: z.number().min(0).optional(),
    interest: z.number().min(0).optional(),
    escrow: z.number().min(0).nullable().optional(),
    fees: z.number().min(0).nullable().optional(),
    isExtra: z.boolean().optional(),
    paymentNumber: z.number().int().positive().nullable().optional().describe("The lender's payment number"),
    transactionId: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  }),
  output: z.object({
    action: z.enum(["created", "updated", "removed"]),
    payment: PaymentOut.nullable(),
    balanceMoved: z.boolean().describe("A manual account's balance changed"),
    owed: z.number(),
  }),
  async run(ctx, input) {
    const M = ctx.client.models;
    const d = await loadAll(ctx);
    const old = input.paymentId ? d.payments.find((p) => p.id === input.paymentId) : null;
    if (input.paymentId && !old) throw new OpError(`No payment ${input.paymentId}`);
    const loan = old ? d.loans.find((l) => l.id === old.loanId) : findLoan(d, input);
    if (!loan) throw new OpError("That payment's loan is gone");
    const account = d.accounts.find((a) => a.id === loan.accountId);
    const manual = !!account && !isSynced(account);
    const owedNow = owedOn(account);
    const oldPrincipal: number = old?.principal ?? 0;
    const owedBefore = owedNow + (manual ? oldPrincipal : 0);

    const moveBalance = async (principalDelta: number) => {
      if (!manual || Math.abs(principalDelta) < 0.005) return false;
      const r = await M.homeFinanceAccount.update({ id: account.id, currentBalance: round2((account.currentBalance ?? 0) + principalDelta), balanceUpdatedAt: new Date().toISOString() });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      return true;
    };

    if (input.remove) {
      if (!old) throw new OpError("remove needs paymentId");
      const r = await M.homeFinanceLoanPayment.delete({ id: old.id });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      const moved = await moveBalance(-old.principal);
      return { action: "removed" as const, payment: null, balanceMoved: moved, owed: round2(owedNow + (moved ? old.principal : 0)) };
    }

    const total = input.totalAmount ?? old?.totalAmount;
    if (total == null) throw new OpError("totalAmount is required");
    const escrow = input.escrow !== undefined ? input.escrow ?? 0 : old?.escrow ?? 0;
    const fees = input.fees !== undefined ? input.fees ?? 0 : old?.fees ?? 0;
    const isExtra = input.isExtra ?? old?.isExtra ?? false;
    const date = input.date ?? old?.date ?? todayIso();
    let principal = input.principal ?? (input.totalAmount === undefined ? old?.principal : undefined);
    let interest = input.interest ?? (input.totalAmount === undefined ? old?.interest : undefined);
    let estimated = old?.estimated ?? false;
    if (principal == null || interest == null) {
      if (isExtra) {
        interest = interest ?? 0;
        principal = principal ?? round2(total - escrow - fees - interest);
      } else if (principal != null) interest = round2(total - escrow - fees - principal);
      else if (interest != null) principal = round2(total - escrow - fees - interest);
      else {
        const others = d.payments.filter((p) => p.loanId === loan.id && p.id !== old?.id);
        ({ principal, interest } = suggestSplit(owedBefore, loan.interestRate, total, escrow, fees, interestDays(termsOf(loan), others, date)));
        estimated = true;
      }
    } else if (input.principal != null || input.interest != null) estimated = false;
    const sum = round2(principal + interest + escrow + fees);
    if (Math.abs(sum - total) > 0.01) throw new OpError(`principal + interest + escrow + fees = ${sum}, but the total is ${total}`);
    if (principal < 0 || interest < 0) throw new OpError("The split comes out negative; check escrow and fees against the total");

    const row = {
      loanId: loan.id,
      date,
      totalAmount: total,
      principal,
      interest,
      escrow: escrow || null,
      fees: fees || null,
      isExtra,
      paymentNumber: input.paymentNumber !== undefined ? input.paymentNumber : old?.paymentNumber ?? null,
      source: old?.source ?? "MANUAL",
      estimated,
      transactionId: input.transactionId !== undefined ? input.transactionId : old?.transactionId ?? null,
      notes: input.notes !== undefined ? input.notes?.trim() || null : old?.notes ?? null,
    };
    const r = old ? await M.homeFinanceLoanPayment.update({ id: old.id, ...row }) : await M.homeFinanceLoanPayment.create(row);
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
    const delta = principal - oldPrincipal;
    const moved = await moveBalance(delta);
    return { action: old ? ("updated" as const) : ("created" as const), payment: paymentOut(r.data), balanceMoved: moved, owed: round2(owedNow - (moved ? delta : 0)) };
  },
});

// ── import_loan_payments ───────────────────────────────────────────────────

const ImportRow = z.object({
  number: z.number().int().positive().nullable().optional().describe("The lender's payment number"),
  date: DATE,
  total: z.number().positive(),
  principal: z.number().min(0),
  interest: z.number().min(0),
  fees: z.number().min(0).nullable().optional(),
  escrow: z.number().min(0).nullable().optional(),
  balance: z.number().min(0).nullable().optional().describe("Principal balance after this payment, as the lender prints it"),
});

export const importLoanPayments = defineOp({
  name: "import_loan_payments",
  domain: "finance",
  access: "write",
  description:
    "Load a lender's payment history (its amortization schedule / payment history, as rows) onto a loan: one row per payment made, with the lender's own principal / interest split. Rows are matched to existing payments by date: a payment already recorded on that date is corrected to the lender's numbers (an estimated split from a bank transaction becomes exact), others are added. Nothing is deleted. On a manual loan account the balance is set to owedAfter (or the last row's balance) when given, else it moves by the principal added. Re-run with each new schedule from the lender; that's the manual sync. The loan page gets the rows out of a PDF (parseLoanSchedulePdf); over the API pass them directly.",
  input: z.object({
    loanId: z.string().optional(),
    loanName: z.string().optional(),
    rows: z.array(ImportRow).min(1).max(1000),
    owedAfter: z.number().min(0).nullable().optional().describe("Principal balance after the last row; default that row's balance"),
    source: z.string().nullable().optional().describe("Where it came from, for the notes: 'BMW FS schedule 2026-11-15'"),
  }),
  output: z.object({
    loan: z.string(),
    created: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    owed: z.number(),
    balanceMoved: z.boolean(),
    problems: z.array(z.string()).describe("Rows whose split didn't add up; they were skipped"),
  }),
  async run(ctx, input) {
    const M = ctx.client.models;
    const d = await loadAll(ctx);
    const loan = findLoan(d, input);
    const account = d.accounts.find((a) => a.id === loan.accountId);
    const manual = !!account && !isSynced(account);
    const existing = d.payments.filter((p) => p.loanId === loan.id);
    const tag = input.source?.trim() ? `Lender's schedule (${input.source.trim()})` : "Lender's schedule";

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let principalDelta = 0;
    const problems: string[] = [];
    const seen = new Set<string>();
    const imported: typeof input.rows = [];
    for (const r of [...input.rows].sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? 0) - (b.number ?? 0))) {
      const fees = r.fees ?? 0;
      const escrow = r.escrow ?? 0;
      const sum = round2(r.principal + r.interest + fees + escrow);
      if (Math.abs(sum - r.total) > 0.01) {
        problems.push(`${r.date}: principal + interest + fees + escrow = ${sum.toFixed(2)}, not ${r.total.toFixed(2)}`);
        continue;
      }
      imported.push(r);
      // Two lender rows on one date (a payment and an extra) take the second
      // slot rather than overwriting each other.
      const key = `${r.date}:${seen.has(r.date) ? r.total : ""}`;
      seen.add(r.date);
      const match = existing.find((p) => p.date === r.date && !p._claimed && (key.endsWith(":") || Math.abs(p.totalAmount - r.total) < 0.01));
      const row = {
        loanId: loan.id,
        date: r.date,
        totalAmount: round2(r.total),
        principal: round2(r.principal),
        interest: round2(r.interest),
        escrow: escrow || null,
        fees: fees || null,
        isExtra: false,
        paymentNumber: r.number ?? null,
        source: "LENDER" as const,
        estimated: false,
      };
      if (match) {
        match._claimed = true;
        const same = (["totalAmount", "principal", "interest", "escrow", "fees", "paymentNumber"] as const).every((k) => (match[k] ?? null) === (row[k] ?? null)) && match.source === "LENDER" && !match.estimated;
        if (same) {
          unchanged++;
          continue;
        }
        const u = await M.homeFinanceLoanPayment.update({ id: match.id, ...row, notes: match.notes && !/^Split estimated/.test(match.notes) ? match.notes : tag });
        if (u.errors?.length) throw new Error(u.errors[0].message);
        principalDelta += row.principal - (match.principal ?? 0);
        updated++;
      } else {
        const c = await M.homeFinanceLoanPayment.create({ ...row, transactionId: null, notes: tag });
        if (c.errors?.length || !c.data) throw new Error(c.errors?.[0]?.message ?? "Save failed");
        existing.push({ ...c.data, _claimed: true });
        principalDelta += row.principal;
        created++;
      }
    }

    // The balance: the lender's figure when given (owedAfter, else the last
    // imported row's balance), else moved by what was added.
    let balanceMoved = false;
    if (manual) {
      const last = imported[imported.length - 1];
      const target = input.owedAfter ?? last?.balance ?? null;
      const next = target != null ? -round2(target) : round2((account.currentBalance ?? 0) + principalDelta);
      if (Math.abs(next - (account.currentBalance ?? 0)) >= 0.005) {
        const u = await M.homeFinanceAccount.update({ id: account.id, currentBalance: next, balanceUpdatedAt: new Date().toISOString() });
        if (u.errors?.length) throw new Error(u.errors[0].message);
        balanceMoved = true;
      }
    }
    const fresh = await loadAll(ctx);
    return { loan: loanName(loan, d), created, updated, unchanged, owed: owedOn(fresh.accounts.find((a) => a.id === loan.accountId)), balanceMoved, problems };
  },
});

export const netWorthOps = [getNetWorth, listFinanceLoans, simulateLoanPayoff, saveFinanceAsset, refreshAssetValuesOp, saveFinanceLoan, recordLoanPayment, importLoanPayments] as const;
