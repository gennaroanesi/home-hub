// A spend group's transactions and total (homeFinanceSpendGroup): the rows
// tagged with it (spendGroupId index), what they add up to, and which
// untagged rows in its date range "Auto-assign by dates" offers. Was inline
// in pages/finance/groups.tsx; the phone's Groups screen uses it too.

import { effectiveCategory, isExcludedFromBudget } from "./categories";
import { txIndexQuery } from "./data";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

/** Every transaction tagged with the group, newest first. */
export async function listGroupTransactions(client: Client, groupId: string): Promise<any[]> {
  const out: any[] = [];
  let nextToken: string | null | undefined;
  do {
    const r = await txIndexQuery(client, "SpendGroupId")({ spendGroupId: groupId }, { limit: 500, nextToken });
    if (r.errors?.length && !r.data?.length) throw new Error(r.errors[0].message);
    out.push(...(r.data ?? []));
    nextToken = r.nextToken;
  } while (nextToken);
  return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** Net spend of tagged rows: money out minus refunds, pending excluded. */
export function groupNetSpend(txs: Array<{ amount?: number | null; status?: string | null }>): number {
  return -txs.filter((t) => t.status !== "PENDING").reduce((s, t) => s + (t.amount ?? 0), 0);
}

/** Untagged spending (no transfers / card payments) among rows loaded for the group's dates. */
export function groupAutoAssignCandidates<T extends { amount?: number | null; spendGroupId?: string | null }>(rows: T[]): T[] {
  return rows.filter((t) => (t.amount ?? 0) < 0 && !t.spendGroupId && !isExcludedFromBudget(effectiveCategory(t as any)));
}
