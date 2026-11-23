// The category vocabulary pickers offer: every category the rules know,
// the budget lines' categories, and categories created by hand. Categories
// are plain names on the rows (no table), so one typed into a transaction
// editor is remembered in the finance setting `categories` (a JSON list)
// when it's saved through update_finance_transaction; otherwise it would
// vanish from the pickers the moment that row scrolled out of view.

import { allCategories, rulesFromDbRows, SUBCATEGORY_SEPARATOR, UNCATEGORIZED, type CategoryRule } from "./categories";
import { bucketCategories } from "./budget";
import { getFinanceSetting, listBudgetLines, listCategoryRules, setFinanceSetting } from "./data";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

export const SAVED_CATEGORIES_KEY = "categories";

/** Trimmed, single-spaced, and "Parent:Child" spelled "Parent: Child". */
export function normalizeCategoryName(name: string): string {
  return name
    .split(":")
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(SUBCATEGORY_SEPARATOR);
}

export function categoryVocabulary(rules: CategoryRule[], budgetLines: any[], saved: string[]): string[] {
  const set = new Set(allCategories(rules));
  for (const l of budgetLines) for (const c of bucketCategories(l)) set.add(c);
  for (const c of saved) if (c && c !== UNCATEGORIZED) set.add(c);
  return [...set].sort((a, b) => a.localeCompare(b));
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

export async function loadCategoryVocabulary(client: Client): Promise<{ categories: string[]; rules: CategoryRule[] }> {
  const [ruleRows, lines, saved] = await Promise.all([listCategoryRules(client), listBudgetLines(client), savedCategories(client)]);
  const rules = rulesFromDbRows(ruleRows);
  return { categories: categoryVocabulary(rules, lines, saved), rules };
}

/**
 * Remember categories the vocabulary doesn't have yet (case-insensitive).
 * A sub-category's parent comes along, so "Baby: Bath" also lists "Baby".
 * Returns the names added.
 */
export async function rememberCategories(client: Client, names: Array<string | null | undefined>): Promise<string[]> {
  const wanted = names.map((n) => normalizeCategoryName(n ?? "")).filter((n) => n && n !== UNCATEGORIZED);
  if (!wanted.length) return [];
  const { categories } = await loadCategoryVocabulary(client);
  const known = new Set(categories.map((c) => c.toLowerCase()));
  const added: string[] = [];
  for (const n of wanted) {
    const parts = n.split(SUBCATEGORY_SEPARATOR);
    for (let i = 1; i <= parts.length; i++) {
      const c = parts.slice(0, i).join(SUBCATEGORY_SEPARATOR);
      if (known.has(c.toLowerCase())) continue;
      known.add(c.toLowerCase());
      added.push(c);
    }
  }
  if (added.length) {
    const saved = await savedCategories(client);
    await setFinanceSetting(client, SAVED_CATEGORIES_KEY, [...saved, ...added].sort((a, b) => a.localeCompare(b)));
  }
  return added;
}
