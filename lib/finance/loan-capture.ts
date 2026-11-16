// A loan whose scheduled transaction (homeFinanceLoan.recurringId) just
// got a posted bank transaction linked to it gets that payment recorded
// automatically: the bank total, split by suggestSplit (a month or the
// days of interest on what's owed), marked estimated + BANK until the
// lender's own schedule is imported (import_loan_payments then corrects
// the row by date). Pure: the finance-sync Lambda applies the plan.

import { round2 } from "./dates";
import { interestDays, suggestSplit, type LoanPaymentLike, type LoanTerms } from "./loans";

export type CapturedTransaction = { id: string; date: string; amount: number; recurringId: string | null | undefined };

export type LoanLike = LoanTerms & { id: string; accountId: string; recurringId?: string | null; escrowMonthly?: number | null };
export type LoanAccountLike = { id: string; currentBalance?: number | null; simplefinAccountId?: string | null };
export type StoredPayment = LoanPaymentLike & { id: string; loanId: string; transactionId?: string | null };

export type CapturePlan = {
  creates: Array<{
    loanId: string;
    date: string;
    totalAmount: number;
    principal: number;
    interest: number;
    escrow: number | null;
    fees: null;
    isExtra: false;
    transactionId: string;
    source: "BANK";
    estimated: true;
    notes: string;
  }>;
  /** Existing payments on the same loan and date that just gain the transaction. */
  links: Array<{ paymentId: string; transactionId: string }>;
  /** Manual LOAN accounts whose balance moves by the captured principal. */
  balanceMoves: Array<{ accountId: string; principalDelta: number }>;
};

export function planLoanCapture(args: { transactions: CapturedTransaction[]; loans: LoanLike[]; accounts: LoanAccountLike[]; payments: StoredPayment[] }): CapturePlan {
  const plan: CapturePlan = { creates: [], links: [], balanceMoves: [] };
  const byRecurring = new Map(args.loans.filter((l) => l.recurringId).map((l) => [l.recurringId as string, l]));
  if (!byRecurring.size) return plan;
  const owedBy = new Map(args.accounts.map((a) => [a.id, Math.max(0, -(a.currentBalance ?? 0))]));
  const seen = new Set<string>();
  for (const tx of [...args.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    const loan = tx.recurringId ? byRecurring.get(tx.recurringId) : null;
    if (!loan || tx.amount >= 0) continue;
    const key = `${loan.id}:${tx.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = args.payments.find((p) => p.loanId === loan.id && p.date === tx.date);
    if (existing) {
      if (!existing.transactionId) plan.links.push({ paymentId: existing.id, transactionId: tx.id });
      continue;
    }
    const total = round2(-tx.amount);
    const escrow = Math.min(loan.escrowMonthly ?? 0, total);
    const owed = owedBy.get(loan.accountId) ?? 0;
    const days = interestDays(loan, args.payments.filter((p) => p.loanId === loan.id), tx.date);
    const split = suggestSplit(owed, loan.interestRate, total, escrow, 0, days);
    plan.creates.push({
      loanId: loan.id,
      date: tx.date,
      totalAmount: total,
      principal: split.principal,
      interest: split.interest,
      escrow: escrow || null,
      fees: null,
      isExtra: false,
      transactionId: tx.id,
      source: "BANK",
      estimated: true,
      notes: days != null ? `Split estimated: ${days} days of interest on ${owed.toFixed(2)}` : `Split estimated: a month of interest on ${owed.toFixed(2)}`,
    });
    const account = args.accounts.find((a) => a.id === loan.accountId);
    if (account && !account.simplefinAccountId && split.principal > 0) {
      plan.balanceMoves.push({ accountId: account.id, principalDelta: split.principal });
      owedBy.set(account.id, round2(owed - split.principal));
    }
    // Later captures in the same run see this one.
    args.payments = [...args.payments, { id: "", loanId: loan.id, date: tx.date, totalAmount: total, principal: split.principal, interest: split.interest }];
  }
  return plan;
}
