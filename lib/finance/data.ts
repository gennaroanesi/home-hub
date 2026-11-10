// Loading finance rows. Works with any Amplify data client (the web's
// generateClient<Schema>(), the ops context, a Lambda's client): typed
// loosely for the reason given in lib/list-all.ts.
//
// Transactions are read per account through the accountId+date index, so a
// month view is a handful of Queries instead of a table Scan.

import { householdMembers } from "../household";
import { isInvested } from "./accounts";
import { listAllPages } from "../list-all";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

const TX_FIELDS = `id accountId amount type category categorySource description date status personId personSource
  goalId spendGroupId toAccountId recurringId importHash sfTransactionId notes lineItems createdAt updatedAt`;

const TX_INDEX: Record<"AccountIdAndDate" | "SpendGroupId" | "RecurringId", { field: string; key: string; sortKey?: string }> = {
  AccountIdAndDate: { field: "listHomeFinanceTransactionByAccountIdAndDate", key: "accountId", sortKey: "date" },
  SpendGroupId: { field: "listHomeFinanceTransactionBySpendGroupId", key: "spendGroupId" },
  RecurringId: { field: "listHomeFinanceTransactionByRecurringId", key: "recurringId" },
};

/**
 * A homeFinanceTransaction secondary-index query, sent as raw GraphQL.
 *
 * The generated model client can't run these for lowercase model names
 * (this Amplify version): the typed name (`listhomeFinance…`) doesn't exist
 * at runtime, and the runtime one (`listHomeFinance…`) declares its
 * variables as `ModelHomeFinance…FilterInput` while AppSync expects
 * `ModelhomeFinance…`, so AppSync rejects it. Every index read goes through
 * here. Same call shape as the model method: (key, { limit, nextToken,
 * sortDirection }) → { data, nextToken, errors }.
 */
export function txIndexQuery(
  client: Client,
  by: keyof typeof TX_INDEX,
): (key: Record<string, any>, opts?: { limit?: number; nextToken?: string | null; sortDirection?: "ASC" | "DESC" }) => Promise<{ data: any[]; nextToken?: string | null; errors?: Array<{ message: string }> }> {
  const idx = TX_INDEX[by];
  // A fake client in tests may provide the model method directly.
  const direct = client.models?.homeFinanceTransaction?.[idx.field];
  if (typeof direct === "function" && typeof client.graphql !== "function") return direct.bind(client.models.homeFinanceTransaction);
  const query = `query Q($${idx.key}: ID!, ${idx.sortKey ? `$${idx.sortKey}: ModelStringKeyConditionInput, ` : ""}$limit: Int, $nextToken: String, $sortDirection: ModelSortDirection) {
    ${idx.field}(${idx.key}: $${idx.key}, ${idx.sortKey ? `${idx.sortKey}: $${idx.sortKey}, ` : ""}limit: $limit, nextToken: $nextToken, sortDirection: $sortDirection) {
      items { ${TX_FIELDS} }
      nextToken
    }
  }`;
  return async (key, opts = {}) => {
    try {
      const res = await client.graphql({ query, variables: { ...key, limit: opts.limit ?? 1000, nextToken: opts.nextToken ?? null, sortDirection: opts.sortDirection ?? null } });
      const conn = res?.data?.[idx.field];
      return { data: conn?.items ?? [], nextToken: conn?.nextToken ?? null, errors: res?.errors };
    } catch (e: any) {
      // client.graphql throws { data, errors } on GraphQL errors.
      const errors = e?.errors ?? [{ message: e instanceof Error ? e.message : String(e) }];
      return { data: e?.data?.[idx.field]?.items ?? [], nextToken: null, errors };
    }
  };
}

export async function listAccounts(client: Client): Promise<any[]> {
  const rows = await listAllPages<any>(client.models.homeFinanceAccount);
  return rows.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || (a.name ?? "").localeCompare(b.name ?? ""));
}

/** Transactions on one account, optionally within [fromIso, toIso]. */
export async function listAccountTransactions(client: Client, accountId: string, range?: { fromIso?: string; toIso?: string }): Promise<any[]> {
  const date =
    range?.fromIso && range?.toIso
      ? { between: [range.fromIso, range.toIso] }
      : range?.fromIso
        ? { ge: range.fromIso }
        : range?.toIso
          ? { le: range.toIso }
          : undefined;
  const out: any[] = [];
  let nextToken: string | null | undefined;
  do {
    const res = await txIndexQuery(client, "AccountIdAndDate")(
      { accountId, ...(date ? { date } : {}) },
      { limit: 1000, nextToken, sortDirection: "DESC" },
    );
    if (res.errors?.length) throw new Error(res.errors[0].message);
    out.push(...(res.data ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/**
 * Transactions across accounts, newest first. Without accountIds: every
 * account except invested ones (401k, brokerage), whose rows aren't
 * household cash flow; pass their ids (or includeInvested) to see them.
 */
export async function listTransactions(
  client: Client,
  opts: { fromIso?: string; toIso?: string; accountIds?: string[]; includeInvested?: boolean } = {},
): Promise<any[]> {
  const ids = opts.accountIds ?? (await listAccounts(client)).filter((a) => opts.includeInvested || !isInvested(a.type)).map((a) => a.id);
  const per = await Promise.all(ids.map((id) => listAccountTransactions(client, id, opts)));
  return per.flat().sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export async function listSchedules(client: Client): Promise<any[]> {
  return listAllPages<any>(client.models.homeFinanceRecurring);
}

/**
 * Budget rows. `categories` is an array field, which the typed client
 * drops on some selection paths in gennaroanesi.com; listing the model
 * directly returns it here, but callers should still treat it as optional.
 */
export async function listBudgetLines(client: Client): Promise<any[]> {
  return listAllPages<any>(client.models.homeFinanceBudget);
}

export async function listGoals(client: Client): Promise<any[]> {
  return listAllPages<any>(client.models.homeFinanceSavingsGoal);
}

export async function listGoalMilestones(client: Client): Promise<any[]> {
  return listAllPages<any>(client.models.homeFinanceGoalMilestone);
}

/** Positions in invested accounts (one account, or all), largest first. */
export async function listHoldings(client: Client, accountId?: string): Promise<any[]> {
  const rows = accountId
    ? await listAllPages<any>({ list: (opts: any) => client.models.homeFinanceHolding.list({ ...opts, accountId }) })
    : await listAllPages<any>(client.models.homeFinanceHolding);
  return rows.sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
}

export async function listSpendGroups(client: Client): Promise<any[]> {
  return listAllPages<any>(client.models.homeFinanceSpendGroup);
}

export async function listCategoryRules(client: Client): Promise<any[]> {
  const rows = await listAllPages<any>(client.models.homeFinanceCategoryRule);
  return rows.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/** Every paycheck, newest first. Optionally one year. */
export async function listPaychecks(client: Client, year?: number): Promise<any[]> {
  const rows = await listAllPages<any>(client.models.homePaycheck, year ? { filter: { payDate: { between: [`${year}-01-01`, `${year}-12-31`] } } } : undefined);
  return rows.sort((a, b) => (b.payDate ?? "").localeCompare(a.payDate ?? ""));
}

/** A finance setting's JSON value (homeFinanceSetting), or null. */
export async function getFinanceSetting<T = unknown>(client: Client, key: string): Promise<T | null> {
  const { data } = await client.models.homeFinanceSetting.get({ key });
  if (!data?.value) return null;
  let v: unknown = data.value;
  while (typeof v === "string") v = JSON.parse(v);
  return v as T;
}

export async function setFinanceSetting(client: Client, key: string, value: unknown): Promise<void> {
  const { data } = await client.models.homeFinanceSetting.get({ key });
  const row = { key, value: JSON.stringify(value) };
  const r = data ? await client.models.homeFinanceSetting.update(row) : await client.models.homeFinanceSetting.create(row);
  if (r.errors?.length) throw new Error(r.errors[0].message);
}

/** Members of the household (home-users), for contributor pickers. */
export async function listHouseholdPeople(client: Client): Promise<Array<{ id: string; name: string; color?: string | null; emoji?: string | null }>> {
  const rows = await listAllPages<any>(client.models.homePerson);
  return householdMembers(rows).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}
