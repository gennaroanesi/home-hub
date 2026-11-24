// Structural shapes the finance logic needs. Deliberately not the Amplify
// Schema types: lib/finance is shared by pages, ops and Lambdas, and the
// generated row types are expensive for the checker (see lib/list-all.ts).
// Any homeFinance* row satisfies the matching shape.

export type AccountLike = {
  id: string;
  name: string;
  type?: string | null;
  currentBalance?: number | null;
  active?: boolean | null;
  minBalance?: number | null;
  simplefinAccountId?: string | null;
  simplefinConnection?: string | null;
};

export type TxLike = {
  id: string;
  accountId: string;
  amount?: number | null;
  type?: string | null;
  category?: string | null;
  categorySource?: string | null;
  description?: string | null;
  date?: string | null;
  status?: string | null;
  personId?: string | null;
  spendGroupId?: string | null;
  outOfBudget?: boolean | null; // its spend group is kept out of the monthly budget
  goalId?: string | null;
  recurringId?: string | null;
  lineItems?: string | null; // JSON [{ name, amount, category, quantity?, ledger? }] (categories.ts)
  ledger?: string | null; // whose budget, when not the account's (ledger.ts)
  ledgerSource?: string | null; // MANUAL | SCHEDULE | RULE
  toAccountId?: string | null; // TRANSFER: the other account
};

export type RecurringLike = {
  id: string;
  accountId: string;
  toAccountId?: string | null;
  amount?: number | null;
  type?: string | null;
  category?: string | null;
  description?: string | null;
  cadence?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  nextDate?: string | null;
  active?: boolean | null;
  matchPattern?: string | null;
  personId?: string | null;
  lastDayOfMonth?: boolean | null; // monthly-ish: due on each month's last day
  ledger?: string | null; // whose budget, when not the account's (ledger.ts scheduleLedger)
};

export type GoalLike = {
  id: string;
  name: string;
  targetAmount?: number | null;
  currentAmount?: number | null;
  fundingAccountId?: string | null;
  fundingAccountIds?: Array<string | null> | null;
  priority?: number | null;
  targetDate?: string | null;
  active?: boolean | null;
};
