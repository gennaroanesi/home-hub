// Loans: amortization, where a loan stands against its contract, and
// payoff what-ifs. Pure; shared by the pages, the ops and the import script.
//
// Ported from gennaroanesi.com's loans-math.ts with one change of model:
// what's owed is the loan account's balance (SimpleFIN or recorded
// payments), not originalPrincipal − Σ principal, and the schedule is
// computed on demand instead of stored as one row per month.

import { addMonthsAnchored, round2 } from "./dates";

export const LOAN_TYPES = ["MORTGAGE", "AUTO", "STUDENT", "PERSONAL", "HELOC", "OTHER"] as const;
export type LoanType = (typeof LOAN_TYPES)[number];
export const LOAN_TYPE_LABELS: Record<LoanType, string> = {
  MORTGAGE: "Mortgage",
  AUTO: "Auto",
  STUDENT: "Student",
  PERSONAL: "Personal",
  HELOC: "HELOC",
  OTHER: "Other",
};

export type LoanTerms = {
  originalPrincipal: number;
  interestRate: number; // annual, decimal
  termMonths: number;
  firstPaymentDate: string;
  monthlyPayment?: number | null;
  escrowMonthly?: number | null;
};

export type LoanPaymentLike = {
  id?: string;
  date: string;
  totalAmount: number;
  principal: number;
  interest: number;
  escrow?: number | null;
  fees?: number | null;
  isExtra?: boolean | null;
};

/** Fixed monthly payment that clears `principal` in `months` (P·r / (1 − (1+r)^−n)). */
export function monthlyPaymentFor(principal: number, annualRate: number, months: number): number {
  if (months <= 0 || principal <= 0) return 0;
  const r = annualRate / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

/** Principal + interest per month: the stored one, else what the terms imply. */
export function contractualPayment(loan: LoanTerms): number {
  return loan.monthlyPayment && loan.monthlyPayment > 0 ? loan.monthlyPayment : round2(monthlyPaymentFor(loan.originalPrincipal, loan.interestRate, loan.termMonths));
}

const anchorDay = (loan: Pick<LoanTerms, "firstPaymentDate">) => Number(loan.firstPaymentDate.slice(8, 10));

/** Date of payment number n (1-based) on the loan's monthly grid. */
export function paymentDate(loan: Pick<LoanTerms, "firstPaymentDate">, n: number): string {
  return addMonthsAnchored(loan.firstPaymentDate, n - 1, anchorDay(loan));
}

/** How many payment dates fall on or before `date` (0 before the first). */
export function paymentsDueBy(loan: Pick<LoanTerms, "firstPaymentDate">, date: string): number {
  if (date < loan.firstPaymentDate) return 0;
  const [y0, m0] = loan.firstPaymentDate.split("-").map(Number);
  const [y, m] = date.split("-").map(Number);
  let n = (y - y0) * 12 + (m - m0) + 1;
  if (paymentDate(loan, n) > date) n--;
  return Math.max(0, n);
}

/** First payment date strictly after `date`. */
export function nextPaymentDate(loan: Pick<LoanTerms, "firstPaymentDate">, date: string): string {
  return paymentDate(loan, paymentsDueBy(loan, date) + 1);
}

/** Balance the contract expects after k payments of `payment`. */
export function scheduledBalance(loan: LoanTerms, k: number): number {
  const p = loan.originalPrincipal;
  const r = loan.interestRate / 12;
  const pmt = contractualPayment(loan);
  if (k <= 0) return p;
  const b = r === 0 ? p - pmt * k : p * Math.pow(1 + r, k) - (pmt * (Math.pow(1 + r, k) - 1)) / r;
  return Math.max(0, round2(b));
}

export type AmortizationRow = { n: number; date: string; payment: number; principal: number; interest: number; balance: number };

export type PayoffPlan = {
  months: number; // payments until the balance is gone (Infinity when it never is)
  payoffDate: string | null;
  totalInterest: number;
  totalPaid: number; // lump sum + every payment
  stalls: boolean; // the payment doesn't cover the interest
  rows: AmortizationRow[];
};

/**
 * Pay `payment` (+ `extraMonthly`) every month from `firstDate` until the
 * balance is gone. A lump sum comes off the balance first. Interest
 * accrues monthly at annualRate / 12. Capped at 100 years.
 */
export function simulatePayoff(opts: { balance: number; annualRate: number; payment: number; firstDate: string; extraMonthly?: number; lumpSum?: number }): PayoffPlan {
  const lump = Math.min(Math.max(0, opts.lumpSum ?? 0), Math.max(0, opts.balance));
  let balance = Math.max(0, opts.balance - lump);
  const r = opts.annualRate / 12;
  const pay = opts.payment + Math.max(0, opts.extraMonthly ?? 0);
  const rows: AmortizationRow[] = [];
  if (balance <= 0.005) return { months: 0, payoffDate: null, totalInterest: 0, totalPaid: round2(lump), stalls: false, rows };
  if (pay <= balance * r) return { months: Infinity, payoffDate: null, totalInterest: 0, totalPaid: 0, stalls: true, rows };
  const day = Number(opts.firstDate.slice(8, 10));
  let interestSum = 0;
  let paid = lump;
  for (let n = 1; balance > 0.005 && n <= 1200; n++) {
    const interest = balance * r;
    // Under a dollar left after this one is rounding drift: settle it now.
    const principal = balance - (pay - interest) < 1 ? balance : pay - interest;
    balance -= principal;
    interestSum += interest;
    paid += principal + interest;
    rows.push({ n, date: addMonthsAnchored(opts.firstDate, n - 1, day), payment: round2(principal + interest), principal: round2(principal), interest: round2(interest), balance: round2(Math.max(0, balance)) });
  }
  const last = rows[rows.length - 1];
  return { months: rows.length, payoffDate: last?.date ?? null, totalInterest: round2(interestSum), totalPaid: round2(paid), stalls: false, rows };
}

/** Principal + interest per month that clears `balance` in `months`. */
export function paymentToFinishIn(balance: number, annualRate: number, months: number): number {
  // Up to the cent: rounding down would leave cents for one more month.
  return Math.ceil(monthlyPaymentFor(balance, annualRate, Math.max(1, months)) * 100 - 1e-6) / 100;
}

/**
 * Suggested split for a payment being recorded: a month of interest on what's
 * owed, escrow and fees as given, the rest to principal. The lender's
 * statement wins; this only pre-fills the form.
 */
export function suggestSplit(owed: number, annualRate: number, total: number, escrow = 0, fees = 0): { principal: number; interest: number } {
  const interest = round2(Math.max(0, owed) * (annualRate / 12));
  const rest = round2(total - escrow - fees);
  if (rest <= interest) return { principal: 0, interest: Math.max(0, rest) };
  return { principal: round2(rest - interest), interest };
}

export type LoanOutlook = {
  owed: number;
  original: number;
  paidOffPct: number; // of the original principal, 0..1
  payment: number; // contractual principal + interest
  escrow: number;
  nextPaymentDate: string;
  paymentsMade: number; // payment dates passed so far
  contractEnd: string; // date of the last contractual payment
  contractBalance: number; // what the contract expects owed today
  projected: PayoffPlan; // keep paying `payment` from the next date
  monthsAhead: number; // contract months left − projected months left; negative = behind
  interestLeft: number; // at the contractual payment
  interestPaid: number; // Σ recorded payments' interest
  principalPaid: number; // original − owed
  lastPayment: LoanPaymentLike | null;
  recentAverage: number | null; // mean total of the last 6 regular payments
};

/** Where a loan stands today: owed vs the contract, payoff at the current payment. */
export function loanOutlook(loan: LoanTerms, owed: number, payments: LoanPaymentLike[], today: string): LoanOutlook {
  const payment = contractualPayment(loan);
  const made = Math.min(loan.termMonths, paymentsDueBy(loan, today));
  const next = nextPaymentDate(loan, today);
  const projected = simulatePayoff({ balance: owed, annualRate: loan.interestRate, payment, firstDate: next });
  const contractLeft = Math.max(0, loan.termMonths - made);
  const sorted = [...payments].sort((a, b) => b.date.localeCompare(a.date));
  const regular = sorted.filter((p) => !p.isExtra).slice(0, 6);
  return {
    owed: round2(owed),
    original: loan.originalPrincipal,
    paidOffPct: loan.originalPrincipal > 0 ? Math.min(1, Math.max(0, (loan.originalPrincipal - owed) / loan.originalPrincipal)) : 0,
    payment,
    escrow: loan.escrowMonthly ?? 0,
    nextPaymentDate: next,
    paymentsMade: made,
    contractEnd: paymentDate(loan, loan.termMonths),
    contractBalance: scheduledBalance(loan, made),
    projected,
    monthsAhead: projected.stalls ? -Infinity : contractLeft - projected.months,
    interestLeft: projected.totalInterest,
    interestPaid: round2(payments.reduce((s, p) => s + (p.interest ?? 0), 0)),
    principalPaid: round2(Math.max(0, loan.originalPrincipal - owed)),
    lastPayment: sorted[0] ?? null,
    recentAverage: regular.length ? round2(regular.reduce((s, p) => s + p.totalAmount, 0) / regular.length) : null,
  };
}

/** Monthly payments from `firstDate` that land on or before `byDate` (for "pay off by" targets). */
export function paymentsBetween(firstDate: string, byDate: string): number {
  return paymentsDueBy({ firstPaymentDate: firstDate }, byDate);
}

/** "6 years 3 months", "11 months", "paid off". */
export function fmtDuration(months: number): string {
  if (!Number.isFinite(months)) return "never at this payment";
  if (months <= 0) return "paid off";
  const y = Math.floor(months / 12);
  const m = months % 12;
  const parts = [y ? `${y} year${y === 1 ? "" : "s"}` : "", m ? `${m} month${m === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.join(" ");
}
