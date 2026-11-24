// What the Categories window shows around the save_finance_category /
// delete_finance_category ops: use counts with sub-categories, where a
// category may move, and the "Updated 12 transactions, 2 rules" note.
// Was inline in components/finance/category-manager.tsx; the phone's
// Categories screen uses it too.

import { categoryAndDescendants } from "../inventory";

export type CategoryManagerNode = { id: string; name: string; parentId: string | null; path: string; depth: number; transactions?: number };

/** Transactions filed under the category or any of its sub-categories. */
export function categoryUseCount(id: string, nodes: CategoryManagerNode[]): number {
  const ids = categoryAndDescendants(id, nodes);
  return nodes.filter((n) => ids.has(n.id)).reduce((s, n) => s + (n.transactions ?? 0), 0);
}

/** Transactions filed directly under the category. */
export function categoryDirectCount(id: string, nodes: CategoryManagerNode[]): number {
  return nodes.find((n) => n.id === id)?.transactions ?? 0;
}

/** Categories `id` may move under (or move its rows to): anything outside itself and its sub-categories. */
export function categoriesOutside(id: string | null, nodes: CategoryManagerNode[]): CategoryManagerNode[] {
  if (!id) return nodes;
  const inside = categoryAndDescendants(id, nodes);
  return nodes.filter((n) => !inside.has(n.id));
}

/** A top-level category with transactions needs somewhere to send them before it's deleted. */
export function deleteNeedsTarget(id: string, nodes: CategoryManagerNode[]): boolean {
  const n = nodes.find((x) => x.id === id);
  return !!n && !n.parentId && categoryDirectCount(id, nodes) > 0;
}

/** "Updated 12 transactions, 2 rules" from the ops' `rewritten` counts. */
export function rewrittenNote(r: { transactions: number; rules: number; budgetLines: number; schedules: number; invoices: number } | null | undefined): string | undefined {
  if (!r) return undefined;
  const parts = (
    [
      [r.transactions, "transaction"],
      [r.rules, "rule"],
      [r.budgetLines, "budget line"],
      [r.schedules, "scheduled transaction"],
      [r.invoices, "invoice"],
    ] as Array<[number, string]>
  )
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  return parts.length ? `Updated ${parts.join(", ")}` : undefined;
}
