// The category vocabulary pickers offer: the category tree
// (homeFinanceCategory, managed in the Categories window; tree order), then
// anything else the rules, budget lines or the legacy `categories` setting
// name. Rows store a category as its path text ("Parent: Child"), so one
// typed into an editor is added to the tree when it's saved through
// update_finance_transaction (or the web Add); otherwise it would vanish
// from the pickers the moment that row scrolled out of view.

import { allCategories, normalizeCategoryName, rulesFromDbRows, UNCATEGORIZED, type CategoryRule } from "./categories";
import { bucketCategories } from "./budget";
import { getFinanceSetting, listBudgetLines, listCategoryRules } from "./data";
import { ensureTreePaths, financeCategoryTree, type FinanceCategoryNode, type FinanceCategoryRow } from "./category-tree";
import { listAllPages } from "../list-all";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

export const SAVED_CATEGORIES_KEY = "categories";

export { normalizeCategoryName } from "./categories";

export function categoryVocabulary(rules: CategoryRule[], budgetLines: any[], saved: string[], tree: FinanceCategoryNode[] = []): string[] {
  const set = new Set(allCategories(rules));
  for (const l of budgetLines) for (const c of bucketCategories(l)) set.add(c);
  for (const c of saved) if (c && c !== UNCATEGORIZED) set.add(c);
  const inTree = new Set(tree.map((n) => n.path.toLowerCase()));
  const extra = [...set].filter((c) => !inTree.has(c.toLowerCase())).sort((a, b) => a.localeCompare(b));
  return [...tree.map((n) => n.path), ...extra];
}

/** The category an editor should store for what was typed: an existing one when only the case differs. */
export function matchCategory(typed: string, known: string[]): string {
  const n = normalizeCategoryName(typed);
  return known.find((c) => c.toLowerCase() === n.toLowerCase()) ?? n;
}

async function savedCategories(client: Client): Promise<string[]> {
  const v = await getFinanceSetting<unknown>(client, SAVED_CATEGORIES_KEY);
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
}

export async function loadCategoryTree(client: Client): Promise<FinanceCategoryNode[]> {
  // Before the deploy that adds the model, a client may not have it.
  if (!client.models.homeFinanceCategory) return [];
  return financeCategoryTree(await listAllPages<FinanceCategoryRow>(client.models.homeFinanceCategory));
}

export async function loadCategoryVocabulary(client: Client): Promise<{ categories: string[]; rules: CategoryRule[]; tree: FinanceCategoryNode[] }> {
  const [ruleRows, lines, saved, tree] = await Promise.all([listCategoryRules(client), listBudgetLines(client), savedCategories(client), loadCategoryTree(client)]);
  const rules = rulesFromDbRows(ruleRows);
  return { categories: categoryVocabulary(rules, lines, saved, tree), rules, tree };
}

/**
 * Add categories the tree doesn't have yet (case-insensitive) to it. A
 * sub-category's parent comes along, so "Baby: Bath" also adds "Baby".
 * Returns the ones no picker offered before.
 */
export async function rememberCategories(client: Client, names: Array<string | null | undefined>): Promise<string[]> {
  const wanted = names.map((n) => normalizeCategoryName(n ?? "")).filter((n) => n && n !== UNCATEGORIZED);
  if (!wanted.length || !client.models.homeFinanceCategory) return [];
  // Report only names that are new to every picker; a name a rule or
  // budget line already used joins the tree quietly.
  const { categories } = await loadCategoryVocabulary(client);
  const known = new Set(categories.map((c) => c.toLowerCase()));
  const added = await ensureTreePaths(client, wanted);
  return added.filter((p) => !known.has(p.toLowerCase()));
}
