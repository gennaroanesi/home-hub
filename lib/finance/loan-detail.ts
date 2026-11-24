// One loan's detail view (web /finance/loans/[id], the phone's finance/loan
// screen): the derivations both pages show on top of lib/finance/loans.ts —
// payments against the plan and grouped by year, the payoff what-if and its
// balance series, the payment form's suggested split, and the terms form ⇄
// save_finance_loan input. Pure.

import { fmtDate, round2 } from "./dates";
import {
  compareToPlan,
  contractualPayment,
  interestDays,
  paymentDate,
  paymentsBetween,
  paymentToFinishIn,
  simulatePayoff,
  suggestSplit,
  type InterestAccrual,
  type LoanOutlook,
  type LoanPaymentLike,
  type LoanTerms,
  type PayoffPlan,
  type PlanComparison,
} from "./loans";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** "4.5%", "6.125%": a decimal rate as a percent, no trailing zeros. */
export const ratePct = (r: number) => `${(r * 100).toFixed(3).replace(/\.?0+$/, "")}%`;
export const longDate = (d: string | null | undefined) => fmtDate(d, { month: "short", day: "numeric", year: "numeric" });
export const monthYear = (d: string | null | undefined) => fmtDate(d, { month: "short", year: "numeric" });

/** A homeFinanceLoan row's terms for the loans.ts math. */
export function loanTermsOf(l: any): LoanTerms {
  return {
    originalPrincipal: l.originalPrincipal,
    interestRate: l.interestRate,
    termMonths: l.termMonths,
    firstPaymentDate: l.firstPaymentDate,
    monthlyPayment: l.monthlyPayment,
    escrowMonthly: l.escrowMonthly,
    interestAccrual: (l.interestAccrual ?? null) as InterestAccrual | null,
  };
}

/** What a loan account owes, positive. */
export const owedOnAccount = (account: { currentBalance?: number | null } | null | undefined) => Math.max(0, -(account?.currentBalance ?? 0));

/** Each recorded payment against the contract's row (by id), and the principal ahead (behind, negative) so far. */
export function planByPayment(loan: LoanTerms, payments: LoanPaymentLike[]): { byId: Map<string, PlanComparison>; ahead: number } {
  const byId = new Map<string, PlanComparison>();
  const rows = compareToPlan(loan, payments);
  for (const r of rows) if (r.id) byId.set(r.id, r);
  return { byId, ahead: rows.length ? rows[rows.length - 1].cumulative : 0 };
}

export type PaymentYear<P> = { year: string; rows: P[]; principal: number; interest: number; escrow: number; total: number };

/** Recorded payments grouped by calendar year (newest year first), with the year's principal / interest / escrow (interest per year, for taxes). */
export function paymentsByYear<P extends { date: string; principal?: number | null; interest?: number | null; escrow?: number | null; totalAmount?: number | null }>(payments: P[]): Array<PaymentYear<P>> {
  const m = new Map<string, PaymentYear<P>>();
  for (const p of payments) {
    const y = p.date.slice(0, 4);
    let g = m.get(y);
    if (!g) m.set(y, (g = { year: y, rows: [], principal: 0, interest: 0, escrow: 0, total: 0 }));
    g.rows.push(p);
    g.principal = round2(g.principal + (p.principal ?? 0));
    g.interest = round2(g.interest + (p.interest ?? 0));
    g.escrow = round2(g.escrow + (p.escrow ?? 0));
    g.total = round2(g.total + (p.totalAmount ?? 0));
  }
  return [...m.values()].sort((a, b) => b.year.localeCompare(a.year));
}

export type PayoffWhatIf = {
  extra: number;
  lump: number;
  /** Paying extra / a lump sum, from the next payment (null when neither is given). */
  scenario: PayoffPlan | null;
  /** The payment that finishes by the target date (null when no target or it's too early). */
  byTarget: { n: number; payment: number; extra: number } | null;
  /** The target is before the next payment date. */
  targetTooEarly: boolean;
};

/** The simulator: extra each month, a lump sum now, and/or a paid-off-by date, from strings as typed. */
export function payoffWhatIf(loan: LoanTerms, o: LoanOutlook, input: { extra?: string; lump?: string; by?: string }): PayoffWhatIf {
  const extra = Math.max(0, Number(input.extra) || 0);
  const lump = Math.max(0, Number(input.lump) || 0);
  const scenario = extra || lump ? simulatePayoff({ balance: o.owed, annualRate: loan.interestRate, payment: o.payment, firstDate: o.nextPaymentDate, extraMonthly: extra, lumpSum: lump }) : null;
  const by = input.by ?? "";
  const targetTooEarly = !!by && by < o.nextPaymentDate;
  let byTarget: PayoffWhatIf["byTarget"] = null;
  if (by && !targetTooEarly) {
    const n = paymentsBetween(o.nextPaymentDate, by);
    const payment = paymentToFinishIn(Math.max(0, o.owed - lump), loan.interestRate, n);
    byTarget = { n, payment, extra: round2(Math.max(0, payment - o.payment)) };
  }
  return { extra, lump, scenario, byTarget, targetTooEarly };
}

export type PayoffPoint = { date: string; contract: number | null; pace: number | null; scenario: number | null };

/**
 * Balance from today on three lines: the original schedule, the current
 * payment, and the what-if (when given). The web's chart data.
 */
export function payoffSeries(loan: LoanTerms, o: LoanOutlook, scenario: PayoffPlan | null, lump: number, today: string): PayoffPoint[] {
  const rows = new Map<string, PayoffPoint>();
  const point = (date: string) => {
    let row = rows.get(date);
    if (!row) rows.set(date, (row = { date, contract: null, pace: null, scenario: null }));
    return row;
  };
  const r = loan.interestRate / 12;
  let b = o.contractBalance;
  point(today).contract = b;
  for (let n = o.paymentsMade + 1; n <= loan.termMonths && b > 0; n++) {
    b = Math.max(0, b * (1 + r) - o.payment);
    point(paymentDate(loan, n)).contract = round2(b);
  }
  point(today).pace = o.owed;
  for (const row of o.projected.rows) point(row.date).pace = row.balance;
  if (scenario) {
    point(today).scenario = round2(Math.max(0, o.owed - lump));
    for (const row of scenario.rows) point(row.date).scenario = row.balance;
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The series at each year's end (the last value each line has that year).
 * A line that has reached zero stays at zero; one that hasn't started or
 * has no point that year is null.
 */
export function yearEndBalances(series: PayoffPoint[]): Array<{ year: string; contract: number | null; pace: number | null; scenario: number | null }> {
  const keys = ["contract", "pace", "scenario"] as const;
  const out: Array<{ year: string; contract: number | null; pace: number | null; scenario: number | null }> = [];
  const last: Record<(typeof keys)[number], number | null> = { contract: null, pace: null, scenario: null };
  let year: string | null = null;
  let row: (typeof out)[number] | null = null;
  for (const p of series) {
    const y = p.date.slice(0, 4);
    if (y !== year) {
      year = y;
      row = { year: y, contract: last.contract === 0 ? 0 : null, pace: last.pace === 0 ? 0 : null, scenario: last.scenario === 0 ? 0 : null };
      out.push(row);
    }
    for (const k of keys) {
      if (p[k] != null) {
        row![k] = p[k];
        last[k] = p[k];
      }
    }
  }
  return out;
}

// ── Payment form ───────────────────────────────────────────────────────────

/** A new payment's starting values: today, the contractual payment + escrow, split estimated on what's owed. */
export function newPaymentDraft(loan: LoanTerms & { id?: string }, owed: number, payments: Array<Pick<LoanPaymentLike, "date">>, today: string): { date: string; total: number; principal: number; interest: number; escrow: number } {
  const escrow = loan.escrowMonthly ?? 0;
  const total = round2(contractualPayment(loan) + escrow);
  const s = suggestSplit(owed, loan.interestRate, total, escrow, 0, interestDays(loan, payments, today));
  return { date: today, total, principal: s.principal, interest: s.interest, escrow };
}

/**
 * The split to show as the total / date / escrow / fees change (until the
 * split is typed by hand). Editing a payment adds its old principal back to
 * what's owed and leaves it out of the daily-interest days.
 */
export function estimatePaymentSplit(opts: {
  loan: LoanTerms;
  owed: number;
  payments: Array<Pick<LoanPaymentLike, "date"> & { id?: string }>;
  editing?: { id: string; principal?: number | null } | null;
  total: number;
  escrow: number;
  fees: number;
  isExtra: boolean;
  date: string;
}): { principal: number; interest: number; days: number | null } {
  const others = opts.editing ? opts.payments.filter((p) => p.id !== opts.editing!.id) : opts.payments;
  const days = interestDays(opts.loan, others, opts.date);
  if (opts.isExtra) return { principal: round2(opts.total - opts.escrow - opts.fees), interest: 0, days };
  const s = suggestSplit(opts.owed + (opts.editing?.principal ?? 0), opts.loan.interestRate, opts.total, opts.escrow, opts.fees, days);
  return { ...s, days };
}

// ── Terms form (an existing loan) ──────────────────────────────────────────

export const NO_SCHEDULE = "";
export const NEW_SCHEDULE = "__new_schedule__";

export type LoanTermsForm = {
  owed: string;
  loanType: string;
  lender: string;
  originalPrincipal: string;
  ratePct: string;
  termMonths: string;
  startDate: string;
  firstPaymentDate: string;
  monthlyPayment: string;
  escrowMonthly: string;
  interestAccrual: string;
  assetId: string;
  recurringId: string; // NO_SCHEDULE, NEW_SCHEDULE or a schedule id
  payFromId: string;
  matchPattern: string;
  payAmount: string;
  payLastDay: boolean;
  notes: string;
};

export const numOrNull = (s: string): number | null => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
const str = (n: number | null | undefined) => (n == null ? "" : String(n));

/** The form for an existing loan row; `payFromId` defaults to the joint checking account. */
export function loanTermsFormFrom(loan: any, account: any | null | undefined, accounts: any[]): LoanTermsForm {
  const checking = accounts.filter((a) => a.active !== false && (a.type === "CHECKING" || a.type === "SAVINGS"));
  return {
    owed: account && !account.simplefinAccountId ? str(round2(-(account.currentBalance ?? 0))) : "",
    loanType: loan.loanType ?? "OTHER",
    lender: loan.lender ?? "",
    originalPrincipal: str(loan.originalPrincipal),
    ratePct: str(round2(loan.interestRate * 100 * 1000) / 1000),
    termMonths: str(loan.termMonths),
    startDate: loan.startDate ?? "",
    firstPaymentDate: loan.firstPaymentDate ?? "",
    monthlyPayment: str(loan.monthlyPayment),
    escrowMonthly: str(loan.escrowMonthly),
    interestAccrual: loan.interestAccrual ?? "MONTHLY",
    assetId: loan.assetId ?? "",
    recurringId: loan.recurringId ?? NO_SCHEDULE,
    payFromId: checking.find((a) => !(a.ownerPersonIds ?? []).length && a.type === "CHECKING")?.id ?? checking[0]?.id ?? "",
    matchPattern: loan.lender ?? "",
    payAmount: "",
    payLastDay: false,
    notes: loan.notes ?? "",
  };
}

/** The P&I the typed terms imply (the placeholder when the payment is left empty). */
export function formContractualPayment(f: Pick<LoanTermsForm, "originalPrincipal" | "ratePct" | "termMonths" | "firstPaymentDate">): number | null {
  const p = numOrNull(f.originalPrincipal);
  const r = numOrNull(f.ratePct);
  const n = numOrNull(f.termMonths);
  if (!p || r == null || !n || !f.firstPaymentDate) return null;
  return contractualPayment({ originalPrincipal: p, interestRate: r / 100, termMonths: n, firstPaymentDate: f.firstPaymentDate });
}

/** save_finance_loan's input for an existing loan, or an error to show. */
export function loanTermsSaveInput(f: LoanTermsForm, loan: any, account: any | null | undefined): { input: Record<string, unknown> } | { error: string } {
  const rate = numOrNull(f.ratePct);
  if (numOrNull(f.originalPrincipal) == null || rate == null || numOrNull(f.termMonths) == null || !f.firstPaymentDate) return { error: "The original amount, rate, term and first payment are required" };
  const input: Record<string, unknown> = {
    loanId: loan.id,
    loanType: f.loanType,
    lender: f.lender.trim() || null,
    originalPrincipal: numOrNull(f.originalPrincipal),
    interestRate: round2(rate * 1000) / 100000,
    termMonths: Math.round(numOrNull(f.termMonths)!),
    startDate: f.startDate || null,
    firstPaymentDate: f.firstPaymentDate,
    monthlyPayment: numOrNull(f.monthlyPayment),
    escrowMonthly: numOrNull(f.escrowMonthly),
    interestAccrual: f.interestAccrual,
    assetId: f.assetId || null,
    notes: f.notes.trim() || null,
  };
  if (f.recurringId === NEW_SCHEDULE) {
    if (!f.payFromId) return { error: "Which account is it paid from?" };
    input.newSchedule = { accountId: f.payFromId, matchPattern: f.matchPattern.trim() || null, amount: numOrNull(f.payAmount) ?? undefined, lastDayOfMonth: f.payLastDay };
  } else if ((loan.recurringId ?? NO_SCHEDULE) !== f.recurringId) {
    input.recurringId = f.recurringId === NO_SCHEDULE ? null : f.recurringId;
  }
  const owed = numOrNull(f.owed);
  if (account && !account.simplefinAccountId && owed != null && Math.abs(owed + (account.currentBalance ?? 0)) >= 0.005) input.owed = owed;
  return { input };
}
