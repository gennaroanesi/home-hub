// The finance category tree (homeFinanceCategory), managed like inventory's
// (lib/inventory.ts categoryTree) but stored differently: every row that
// has a category keeps it as its path text, "Parent: Child", which is what
// the budget, rules, sync, CSV import and Janet all read. The tree is the
// list of names and where they sit; renaming, moving or deleting a category
// rewrites the path text everywhere (`rewriteCategories`).

import { categoryTree, type CategoryNode } from "../inventory";
import { listAllPages } from "../list-all";
import { SUBCATEGORY_SEPARATOR, UNCATEGORIZED } from "./categories";
import { getFinanceSetting, setFinanceSetting } from "./data";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

export interface FinanceCategoryRow {
  id: string;
  name: string;
  parentId?: string | null;
  sortOrder?: number | null;
}

export interface FinanceCategoryNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  /** "Parent: Child", as stored on the rows. */
  path: string;
  depth: number;
}

/** Depth-first, siblings by sortOrder then name (inventory's order), with finance paths. */
export function financeCategoryTree(rows: FinanceCategoryRow[]): FinanceCategoryNode[] {
  return categoryTree(rows).map((n: CategoryNode<FinanceCategoryRow>) => ({
    id: n.category.id,
    name: n.category.name,
    parentId: n.category.parentId ?? null,
    sortOrder: n.category.sortOrder ?? 0,
    path: n.path.split(" › ").join(SUBCATEGORY_SEPARATOR),
    depth: n.depth,
  }));
}

/** A category name is one level: no ":" (the path separator) or ">" (what pickers read as one). */
export function checkCategoryName(name: string): string | null {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) return "A category needs a name";
  if (/[:>›]/.test(n)) return 'A name can\'t contain ":" or ">"; pick the parent to nest it';
  if (n.toLowerCase() === UNCATEGORIZED.toLowerCase()) return `"${UNCATEGORIZED}" is what no category means`;
  return null;
}

/** `cat` with the `from` prefix (itself or a sub-category of it) swapped for `to`; unchanged otherwise. */
export function renamePath(cat: string, from: string, to: string): string {
  if (cat === from) return to;
  if (cat.startsWith(from + SUBCATEGORY_SEPARATOR)) return to ? to + cat.slice(from.length) : cat.slice(from.length + SUBCATEGORY_SEPARATOR.length);
  return cat;
}

/**
 * Rows to create so every path in `paths` is in the tree (parents first),
 * given what's there. Returns [path, parentPath | null, name] in order.
 */
export function missingTreePaths(existing: string[], paths: string[]): Array<{ path: string; parentPath: string | null; name: string }> {
  const have = new Set(existing.map((p) => p.toLowerCase()));
  const out: Array<{ path: string; parentPath: string | null; name: string }> = [];
  for (const raw of paths) {
    const parts = raw
      .split(SUBCATEGORY_SEPARATOR.trim())
      .map((p) => p.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join(SUBCATEGORY_SEPARATOR);
      if (path.toLowerCase() === UNCATEGORIZED.toLowerCase() || have.has(path.toLowerCase())) continue;
      have.add(path.toLowerCase());
      out.push({ path, parentPath: i > 1 ? parts.slice(0, i - 1).join(SUBCATEGORY_SEPARATOR) : null, name: parts[i - 1] });
    }
  }
  return out;
}

/** Create the tree rows `paths` need (parents included). Returns the paths created. */
export async function ensureTreePaths(client: Client, paths: string[]): Promise<string[]> {
  const rows = await listAllPages<FinanceCategoryRow>(client.models.homeFinanceCategory);
  const tree = financeCategoryTree(rows);
  const plan = missingTreePaths(
    tree.map((n) => n.path),
    paths,
  );
  if (!plan.length) return [];
  const idByPath = new Map(tree.map((n) => [n.path.toLowerCase(), n.id]));
  const siblings = new Map<string | null, number>();
  for (const r of rows) siblings.set(r.parentId ?? null, (siblings.get(r.parentId ?? null) ?? 0) + 1);
  for (const p of plan) {
    const parentId = p.parentPath ? idByPath.get(p.parentPath.toLowerCase()) ?? null : null;
    const sortOrder = siblings.get(parentId) ?? 0;
    siblings.set(parentId, sortOrder + 1);
    const r = await client.models.homeFinanceCategory.create({ name: p.name, parentId, sortOrder });
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Couldn't create a category");
    idByPath.set(p.path.toLowerCase(), r.data.id);
  }
  return plan.map((p) => p.path);
}

export interface RewriteCounts {
  transactions: number;
  rules: number;
  budgetLines: number;
  schedules: number;
  invoices: number;
}

async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>, size = 25): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function update(model: any, patch: Record<string, unknown>): Promise<void> {
  const r = await model.update(patch);
  if (r.errors?.length) throw new Error(r.errors[0].message);
}

/**
 * Rename category paths everywhere a category is stored: transactions
 * (category and itemized lines), rules, budget lines (every version),
 * schedules, invoices, and the legacy `categories` setting. `map` returns
 * the new path for a stored one ("" = Uncategorized).
 */
export async function rewriteCategories(client: Client, map: (cat: string) => string): Promise<RewriteCounts> {
  const counts: RewriteCounts = { transactions: 0, rules: 0, budgetLines: 0, schedules: 0, invoices: 0 };
  const m = client.models;
  const next = (cat: string | null | undefined): string | null | undefined => {
    if (!cat) return cat;
    const out = map(cat);
    return out === cat ? cat : out || null;
  };

  const txs = await listAllPages<any>(m.homeFinanceTransaction, { limit: 1000 });
  const txPatches: Record<string, unknown>[] = [];
  for (const t of txs) {
    const patch: Record<string, unknown> = {};
    const c = next(t.category);
    if (c !== t.category) patch.category = c;
    if (t.lineItems) {
      try {
        const items = typeof t.lineItems === "string" ? JSON.parse(t.lineItems) : t.lineItems;
        if (Array.isArray(items)) {
          let changed = false;
          const out = items.map((i: any) => {
            const ic = next(i?.category);
            if (ic === i?.category) return i;
            changed = true;
            return { ...i, category: ic ?? UNCATEGORIZED };
          });
          if (changed) patch.lineItems = JSON.stringify(out);
        }
      } catch {
        /* leave malformed items alone */
      }
    }
    if (Object.keys(patch).length) txPatches.push({ id: t.id, ...patch });
  }
  await inBatches(txPatches, (p) => update(m.homeFinanceTransaction, p));
  counts.transactions = txPatches.length;

  for (const [model, field, key] of [
    [m.homeFinanceCategoryRule, "category", "rules"],
    [m.homeFinanceRecurring, "category", "schedules"],
    [m.homeInvoice, "category", "invoices"],
  ] as const) {
    if (!model) continue;
    const rows = await listAllPages<any>(model, { limit: 1000 });
    const patches = rows.filter((r) => next(r[field]) !== r[field]).map((r) => ({ id: r.id, [field]: next(r[field]) }));
    await inBatches(patches, (p) => update(model, p));
    counts[key] = patches.length;
  }

  const lines = await listAllPages<any>(m.homeFinanceBudget, { limit: 1000 });
  const linePatches: Record<string, unknown>[] = [];
  for (const l of lines) {
    const cats: string[] = (l.categories ?? []).filter(Boolean);
    const out = [...new Set(cats.map((c) => next(c)).filter((c): c is string => !!c))];
    if (out.length !== cats.length || out.some((c, i) => c !== cats[i])) linePatches.push({ id: l.id, categories: out });
  }
  await inBatches(linePatches, (p) => update(m.homeFinanceBudget, p));
  counts.budgetLines = linePatches.length;

  // The legacy list of hand-made names (lib/finance/category-list.ts).
  const saved = await getFinanceSetting<unknown>(client, "categories");
  if (Array.isArray(saved)) {
    const out = [...new Set(saved.filter((c): c is string => typeof c === "string").map((c) => next(c)).filter((c): c is string => !!c))];
    if (JSON.stringify(out) !== JSON.stringify(saved)) await setFinanceSetting(client, "categories", out);
  }
  return counts;
}

/** How many transactions use each path directly (charge or itemized line). */
export function countCategoryUse(txs: Array<{ category?: string | null; lineItems?: unknown }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of txs) {
    const seen = new Set<string>();
    if (t.category) seen.add(t.category);
    if (t.lineItems) {
      try {
        const items = typeof t.lineItems === "string" ? JSON.parse(t.lineItems) : t.lineItems;
        if (Array.isArray(items)) for (const i of items) if (i?.category) seen.add(i.category);
      } catch {
        /* ignore */
      }
    }
    for (const c of seen) out.set(c, (out.get(c) ?? 0) + 1);
  }
  return out;
}
