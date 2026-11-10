// Rule-based transaction categories for household finance. Ported from
// gennaroanesi.com (components/finance/categories.ts). Pure: shared by the
// pages, the finance ops and the finance-sync Lambda.
//
// Household differences from the personal version:
//  - Money IN that a rule calls "Transfers" is a member funding the joint
//    account, so it becomes CONTRIBUTION (household income), unless the
//    sync paired it with an outflow from another tracked account.
//  - Mortgage and car payments are ordinary budgeted spending here; only
//    real internal movement is excluded (see EXCLUDED_FROM_BUDGET).

import rulesData from "./category-rules.json";

export type CategoryRule = { pattern: string; category: string | null; personId?: string | null };

/** Bundled fallback rules (first match wins). */
export const CATEGORY_RULES: CategoryRule[] = (rulesData.rules ?? []) as CategoryRule[];

export const UNCATEGORIZED = "Uncategorized";
export const REFUND_CATEGORY = "Refund";
export const TRANSFER_CATEGORY = "Transfers";
/** A household member moving money into the joint account. */
export const CONTRIBUTION_CATEGORY = "Contribution";
export const CARD_PAYMENT_CATEGORY = "Credit Card Payment";

/**
 * Not spending and not income: money between the household's own accounts,
 * or a card payment settling charges already counted. Everything else,
 * mortgage included, is budgetable.
 */
export const EXCLUDED_FROM_BUDGET = new Set<string>([TRANSFER_CATEGORY, CARD_PAYMENT_CATEGORY, "Investments"]);

export function isExcludedFromBudget(category: string): boolean {
  return EXCLUDED_FROM_BUDGET.has(category);
}

/** Categories that are money in, not spending. */
export const INCOME_CATEGORIES = new Set<string>(["Income", CONTRIBUTION_CATEGORY, "Interest"]);

/** Every category the rule table knows, plus the structural ones, sorted. */
export function allCategories(rules: CategoryRule[] = CATEGORY_RULES): string[] {
  const set = new Set<string>([CONTRIBUTION_CATEGORY, REFUND_CATEGORY, TRANSFER_CATEGORY]);
  for (const r of rules) if (r.category) set.add(r.category);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Categories the LLM fallback may pick from a description alone. Structural
 * buckets depend on direction or pairing, not merchant text.
 */
export function classifiableCategories(rules: CategoryRule[] = CATEGORY_RULES): string[] {
  return allCategories(rules).filter(
    (c) => !EXCLUDED_FROM_BUDGET.has(c) && c !== REFUND_CATEGORY && c !== CONTRIBUTION_CATEGORY && c !== "Income",
  );
}

/** Rule rows from the DB → ordered active rules; bundled rules when the table is empty. */
export function rulesFromDbRows(
  rows: Array<{
    pattern?: string | null;
    category?: string | null;
    personId?: string | null;
    sortOrder?: number | null;
    active?: boolean | null;
  }>,
): CategoryRule[] {
  const usable = rows.filter((r) => r.active !== false && r.pattern && (r.category || r.personId));
  if (usable.length === 0) return CATEGORY_RULES;
  return [...usable]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((r) => ({ pattern: r.pattern as string, category: r.category ?? null, personId: r.personId ?? null }));
}

/** `/regex/flags` or a case-insensitive substring. A bad regex falls back to substring. */
export function patternMatches(pattern: string, text: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const regexForm = p.match(/^\/(.+)\/([imsu]*)$/);
  if (regexForm) {
    try {
      return new RegExp(regexForm[1], regexForm[2]).test(text);
    } catch {
      /* substring below */
    }
  }
  return text.toLowerCase().includes(p.toLowerCase());
}

// Payment-processor prefixes that hide the merchant ("SQ *BLUE BOTTLE").
const PROCESSOR_PREFIX = /^(paypal\s*\*|sq\s*\*|sp\s+|aplpay\s+|pwp\s+|dojo\s*\*|zettle\s*\*|tst\s*\*|py\s*\*|ic\*\s*)+/i;

export function stripProcessorPrefix(description: string): string {
  return description.replace(PROCESSOR_PREFIX, "").trim();
}

// A money-IN row matching one of these keeps the rule's category instead of
// becoming a Refund.
const NON_REFUNDABLE = new Set<string>([...EXCLUDED_FROM_BUDGET, ...INCOME_CATEGORIES, REFUND_CATEGORY]);

type InferInput = {
  description?: string | null;
  type?: string | null;
  amount?: number | null;
  category?: string | null;
  lineItems?: string | null;
};

function isInflow(tx: InferInput): boolean {
  if (tx.type === "EXPENSE") return false;
  if (tx.type === "INCOME") return true;
  return (tx.amount ?? 0) > 0;
}

function ruleHits(rule: CategoryRule, desc: string, stripped: string): boolean {
  return patternMatches(rule.pattern, desc) || (stripped !== desc && patternMatches(rule.pattern, stripped));
}

/**
 * Category and attributed person for a transaction. Category rules and
 * person rules are independent: the first rule with a category decides the
 * category, the first rule with a personId decides the person, so a rule
 * like "transfer from … 1234 → Gennaro" can sit next to the generic
 * transfer rule.
 */
export function classify(
  tx: InferInput,
  rules: CategoryRule[] = CATEGORY_RULES,
): { category: string | null; personId: string | null } {
  let category: string | null = null;
  let personId: string | null = null;
  const desc = (tx.description ?? "").trim();
  if (desc) {
    const stripped = stripProcessorPrefix(desc);
    for (const rule of rules) {
      if (category && personId) break;
      if (!ruleHits(rule, desc, stripped)) continue;
      if (!personId && rule.personId) personId = rule.personId;
      if (!category && rule.category) category = rule.category;
    }
  }
  if (tx.type === "TRANSFER") category = TRANSFER_CATEGORY;
  else if (category && isInflow(tx)) {
    if (category === TRANSFER_CATEGORY) category = CONTRIBUTION_CATEGORY;
    else if (!NON_REFUNDABLE.has(category)) category = REFUND_CATEGORY;
  }
  if (!category && tx.type === "INCOME") category = "Income";
  return { category, personId };
}

/** Category alone (see classify). Null = no rule matched and the type implies nothing. */
export function inferCategory(tx: InferInput, rules: CategoryRule[] = CATEGORY_RULES): string | null {
  return classify(tx, rules).category;
}

/**
 * What to group by: for an itemized charge, its largest item's category
 * (the items, not the charge, carry categories; see categoryParts); else
 * the stored category, else inferred, else Uncategorized.
 */
export function effectiveCategory(tx: InferInput, rules: CategoryRule[] = CATEGORY_RULES): string {
  const items = parseLineItems(tx);
  if (items) return [...itemTotals(items)].sort((a, b) => b[1] - a[1])[0][0];
  const set = (tx.category ?? "").trim();
  if (set) return set;
  return inferCategory(tx, rules) ?? UNCATEGORIZED;
}

// ── Line items ────────────────────────────────────────────────────────────────
// A charge that spans categories (an Amazon shipment: diapers and a patio
// cover) carries `lineItems`, a JSON string of [{ name, amount, category,
// quantity? }]. Its spending then counts per item category instead of the
// charge's own. Ported from gennaroanesi.com.

export type LineItem = { name?: string | null; amount: number; category: string; quantity?: number | null };

/**
 * The stored lineItems, validated, or null when absent, empty or
 * malformed. Lenient: a row without a numeric amount or a category is
 * dropped, so a partial import can't break the totals. Accepts the JSON
 * string or an already-parsed array (AWSJSON-style round trips).
 */
export function parseLineItems(tx: { lineItems?: unknown }): LineItem[] | null {
  let parsed: unknown = tx.lineItems;
  try {
    while (typeof parsed === "string") parsed = parsed.trim() ? JSON.parse(parsed) : null;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const items: LineItem[] = [];
  for (const it of parsed as Array<Record<string, unknown>>) {
    const amount = Number(it?.amount);
    const category = String(it?.category ?? "").trim();
    if (!Number.isFinite(amount) || !category) continue;
    items.push({ name: it?.name == null ? null : String(it.name), amount: Math.abs(amount), category, quantity: it?.quantity == null ? null : Number(it.quantity) });
  }
  return items.length ? items : null;
}

function itemTotals(items: LineItem[]): Map<string, number> {
  const byCat = new Map<string, number>();
  for (const it of items) byCat.set(it.category, (byCat.get(it.category) ?? 0) + it.amount);
  return byCat;
}

/**
 * A transaction's magnitude split by category: per item category, scaled so
 * the parts sum exactly to |amount| (tax, shipping and rounding make the raw
 * item sum differ); a single part under effectiveCategory when not itemized.
 * Every category total should go through this, so itemized and plain rows
 * add up the same way.
 */
export function categoryParts(tx: InferInput, rules: CategoryRule[] = CATEGORY_RULES): Array<{ category: string; amount: number }> {
  const magnitude = Math.abs(tx.amount ?? 0);
  const items = parseLineItems(tx);
  const raw = items ? items.reduce((s, i) => s + i.amount, 0) : 0;
  if (!items || raw <= 0) return [{ category: effectiveCategory(tx, rules), amount: magnitude }];
  return [...itemTotals(items)].map(([category, amount]) => ({ category, amount: (amount * magnitude) / raw }));
}
