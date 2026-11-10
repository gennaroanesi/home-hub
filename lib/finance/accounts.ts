// Account types and what each implies. Shared by the pages, the ops and
// the finance-sync Lambda.

export const ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "BROKERAGE", "RETIREMENT", "CREDIT", "LOAN", "CASH", "OTHER"] as const;

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  CHECKING: "Checking",
  SAVINGS: "Savings",
  BROKERAGE: "Brokerage",
  RETIREMENT: "Retirement",
  CREDIT: "Credit card",
  LOAN: "Loan",
  CASH: "Cash",
  OTHER: "Other",
};

export const RETIREMENT_TYPES = ["_401K", "TRAD_IRA", "ROTH_IRA", "HSA", "SEP_IRA", "OTHER"] as const;

export const RETIREMENT_TYPE_LABELS: Record<string, string> = {
  _401K: "401(k)",
  TRAD_IRA: "Traditional IRA",
  ROTH_IRA: "Roth IRA",
  HSA: "HSA",
  SEP_IRA: "SEP IRA",
  OTHER: "Other",
};

/**
 * 401k, IRA, brokerage. Their balance is the total value (cash +
 * positions); the sync pulls positions (homeFinanceHolding) and their
 * transactions too, but those aren't household cash flow (contributions
 * from payroll, fund buys, dividends): they stay out of the budget,
 * overview, review, schedule and invoice matching, and the Haiku
 * classifier. See householdAccounts.
 */
export const INVESTED_TYPES = new Set<string>(["BROKERAGE", "RETIREMENT"]);
export const isInvested = (type: string | null | undefined) => INVESTED_TYPES.has(type ?? "");

/** Active accounts whose transactions are household cash flow (not invested). */
export function householdAccounts<T extends { type?: string | null; active?: boolean | null }>(accounts: T[]): T[] {
  return accounts.filter((a) => a.active !== false && !isInvested(a.type));
}

/** "Retirement · 401(k)", "Brokerage", "Checking". */
export function accountTypeLabel(a: { type?: string | null; retirementType?: string | null }): string {
  const base = ACCOUNT_TYPE_LABELS[a.type ?? "OTHER"] ?? a.type ?? "Other";
  return a.type === "RETIREMENT" && a.retirementType && a.retirementType !== "OTHER" ? RETIREMENT_TYPE_LABELS[a.retirementType] ?? base : base;
}
