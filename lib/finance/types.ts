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
  goalId?: string | null;
  recurringId?: string | null;
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
};

export type GoalLike = {
  id: string;
  name: string;
  targetAmount?: number | null;
  currentAmount?: number | null;
  fundingAccountId?: string | null;
  priority?: number | null;
  targetDate?: string | null;
  active?: boolean | null;
};
