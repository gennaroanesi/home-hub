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

/** How accounts are grouped on screen: by type, cash first, debt, then invested. */
export const ACCOUNT_SECTIONS: Array<{ type: string; label: string }> = [
  { type: "CHECKING", label: "Checking" },
  { type: "SAVINGS", label: "Savings" },
  { type: "CASH", label: "Cash" },
  { type: "CREDIT", label: "Credit cards" },
  { type: "LOAN", label: "Loans" },
  { type: "RETIREMENT", label: "Retirement" },
  { type: "BROKERAGE", label: "Brokerage" },
  { type: "OTHER", label: "Other" },
];

/** Accounts in ACCOUNT_SECTIONS order, empty sections left out. */
export function groupAccountsByType<T extends { type?: string | null }>(accounts: T[]): Array<{ type: string; label: string; accounts: T[]; total: number }> {
  const known = new Set(ACCOUNT_SECTIONS.map((s) => s.type));
  const sectionOf = (t: string | null | undefined) => (t && known.has(t) ? t : "OTHER");
  return ACCOUNT_SECTIONS.map((s) => {
    const mine = accounts.filter((a) => sectionOf(a.type) === s.type);
    return { ...s, accounts: mine, total: mine.reduce((n, a) => n + ((a as { currentBalance?: number | null }).currentBalance ?? 0), 0) };
  }).filter((g) => g.accounts.length > 0);
}

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

/**
 * Accounts whose transactions aren't household cash flow: invested ones
 * (above) and loans. A loan's rows (principal, interest, escrow, mortgage
 * insurance…) are the other side of a payment already counted when it left
 * checking, so they'd double it; the loan feeds net worth, not the budget.
 */
export const isOutsideCashFlow = (type: string | null | undefined) => isInvested(type) || type === "LOAN";

/** Active accounts whose transactions are household cash flow (not invested, not loans). */
export function householdAccounts<T extends { type?: string | null; active?: boolean | null }>(accounts: T[]): T[] {
  return accounts.filter((a) => a.active !== false && !isOutsideCashFlow(a.type));
}

/** "Retirement · 401(k)", "Brokerage", "Checking". */
export function accountTypeLabel(a: { type?: string | null; retirementType?: string | null }): string {
  const base = ACCOUNT_TYPE_LABELS[a.type ?? "OTHER"] ?? a.type ?? "Other";
  return a.type === "RETIREMENT" && a.retirementType && a.retirementType !== "OTHER" ? RETIREMENT_TYPE_LABELS[a.retirementType] ?? base : base;
}
