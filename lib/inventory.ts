// Shared inventory vocabulary + derivations: categories, which of them
// have a detail model, clothing size presets, low-stock and wishlist
// totals. Used by the /inventory page, the dashboard, and the agent's
// inventory tools so they agree on what "low" or "$ left to buy" means.

// ── Categories ───────────────────────────────────────────────────────────────
// A tree of homeInventoryCategory rows. detailType says which detail model
// (homeInventoryClothing / homeInventoryConsumable) items in a category use;
// a subcategory without its own inherits it from the nearest ancestor.

export const CATEGORY_DETAIL_TYPES = ["CLOTHING", "CONSUMABLE"] as const;
export type CategoryDetailType = (typeof CATEGORY_DETAIL_TYPES)[number];

export const CATEGORY_DETAIL_TYPE_LABELS: Record<CategoryDetailType, string> = {
  CLOTHING: "Clothing (size, color, type, season)",
  CONSUMABLE: "Consumable (unit, low stock, expiry)",
};

export interface CategoryLike {
  id: string;
  name: string;
  parentId?: string | null;
  detailType?: string | null;
  sortOrder?: number | null;
}

export interface CategoryNode<T extends CategoryLike = CategoryLike> {
  category: T;
  path: string; // "Clothing › Baby"
  depth: number;
  detailType: CategoryDetailType | null; // own or inherited
}

/** Depth-first, siblings by sortOrder then name. A row whose parent is gone counts as top-level. */
export function categoryTree<T extends CategoryLike>(categories: T[]): CategoryNode<T>[] {
  const ids = new Set(categories.map((c) => c.id));
  const childrenOf = new Map<string | null, T[]>();
  for (const c of categories) {
    const parent = c.parentId && ids.has(c.parentId) ? c.parentId : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), c]);
  }
  const out: CategoryNode<T>[] = [];
  const seen = new Set<string>();
  const walk = (c: T, parent: CategoryNode<T> | null) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    const node: CategoryNode<T> = {
      category: c,
      path: parent ? `${parent.path} › ${c.name}` : c.name,
      depth: parent ? parent.depth + 1 : 0,
      detailType: (c.detailType as CategoryDetailType | null | undefined) ?? parent?.detailType ?? null,
    };
    out.push(node);
    const kids = [...(childrenOf.get(c.id) ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    for (const kid of kids) walk(kid, node);
  };
  const roots = [...(childrenOf.get(null) ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  for (const c of roots) walk(c, null);
  for (const c of categories) walk(c, null); // rows caught in a parent loop still show up
  return out;
}

export function categoryAndDescendants(id: string, categories: CategoryLike[]): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of categories) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

const normalizePath = (s: string) =>
  s
    .toLowerCase()
    .split(/[›>/]/)
    .map((part) => part.trim().replace(/s$/, ""))
    .join("/");

/**
 * Finds a category by name or path, ignoring case and a plural "s", so
 * "CONSUMABLE", "clothing" and "Clothing > Baby" all work. A full path wins;
 * otherwise a name has to be unique, or this returns undefined.
 */
export function matchCategory<T extends CategoryLike>(categories: T[], text: string): CategoryNode<T> | undefined {
  const q = normalizePath(text);
  if (!q) return undefined;
  const nodes = categoryTree(categories).map((node) => ({ node, path: normalizePath(node.path) }));
  const exact = nodes.find((n) => n.path === q);
  if (exact) return exact.node;
  const partial = nodes.filter((n) => n.path.endsWith(`/${q}`));
  return partial.length === 1 ? partial[0].node : undefined;
}

// What homeInventoryItem.category (the old fixed enum) becomes. Used by
// scripts/inventory-categories-backfill.ts, which creates these rows.
export const LEGACY_CATEGORIES = [
  { key: "CLOTHING", name: "Clothing", detailType: "CLOTHING" },
  { key: "CONSUMABLE", name: "Consumables", detailType: "CONSUMABLE" },
  { key: "GEAR", name: "Gear", detailType: null },
  { key: "FURNITURE", name: "Furniture", detailType: null },
  { key: "KITCHEN", name: "Kitchen", detailType: null },
  { key: "ELECTRONICS", name: "Electronics", detailType: null },
  { key: "TOYS", name: "Toys", detailType: null },
  { key: "BOOKS", name: "Books", detailType: null },
  { key: "TOOLS", name: "Tools", detailType: null },
  { key: "OTHER", name: "Other", detailType: null },
] as const;

/** The category rows still to create, and the items still to point at one (null category → Other). */
export function planCategoryBackfill(
  categories: CategoryLike[],
  items: { id: string; category?: string | null; categoryId?: string | null }[],
) {
  const topLevel = categories.filter((c) => !c.parentId);
  const existing = (name: string) => topLevel.find((c) => c.name.toLowerCase() === name.toLowerCase());
  return {
    createCategories: LEGACY_CATEGORIES.flatMap((c, sortOrder) =>
      existing(c.name) ? [] : [{ name: c.name, detailType: c.detailType, sortOrder }],
    ),
    moves: items.flatMap((i) => {
      if (i.categoryId) return [];
      const legacy = LEGACY_CATEGORIES.find((c) => c.key === i.category) ?? LEGACY_CATEGORIES[LEGACY_CATEGORIES.length - 1];
      return [{ itemId: i.id, categoryName: legacy.name }];
    }),
  };
}

export const INVENTORY_STATUSES = ["DRAFT", "WISHLIST", "OWNED", "SOLD", "GIVEN_AWAY"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  DRAFT: "Draft",
  WISHLIST: "Wishlist",
  OWNED: "Owned",
  SOLD: "Sold",
  GIVEN_AWAY: "Given away",
};

export const ACQUIRED_VIA_LABELS = {
  PURCHASED: "Bought",
  GIFT: "Gift",
  HAND_ME_DOWN: "Hand-me-down",
} as const;

export const PRIORITY_LABELS = {
  MUST_HAVE: "Must have",
  NICE_TO_HAVE: "Nice to have",
} as const;

export const CLOTHING_SIZE_PRESETS = {
  baby: ["Preemie", "NB", "0-3M", "3-6M", "6-9M", "9-12M", "12-18M", "18-24M"],
  toddler: ["2T", "3T", "4T", "5T"],
  adult: ["XS", "S", "M", "L", "XL", "XXL"],
} as const;

// Order for sorting baby/toddler clothes by size; unknown sizes sort last.
const SIZE_ORDER: string[] = [
  ...CLOTHING_SIZE_PRESETS.baby,
  ...CLOTHING_SIZE_PRESETS.toddler,
  ...CLOTHING_SIZE_PRESETS.adult,
];
export function sizeRank(size: string | null | undefined): number {
  if (!size) return Number.MAX_SAFE_INTEGER;
  const i = SIZE_ORDER.findIndex((s) => s.toLowerCase() === size.trim().toLowerCase());
  return i === -1 ? SIZE_ORDER.length : i;
}

// ── Low stock ────────────────────────────────────────────────────────────────

export function isLowStock(
  quantity: number | null | undefined,
  lowStockThreshold: number | null | undefined,
): boolean {
  if (lowStockThreshold == null) return false;
  return (quantity ?? 0) <= lowStockThreshold;
}

// ── Money ────────────────────────────────────────────────────────────────────

export interface PricedItem {
  status?: string | null;
  quantity?: number | null;
  estimatedPrice?: number | null;
  pricePaid?: number | null;
  priority?: string | null;
  acquiredVia?: string | null;
}

const qty = (i: PricedItem) => Math.max(1, i.quantity ?? 1);

export interface WishlistSummary {
  count: number;
  estimatedTotal: number; // sum of estimatedPrice × quantity
  mustHaveTotal: number;
  unpriced: number; // wishlist items with no estimate yet
}

export function wishlistSummary(items: PricedItem[]): WishlistSummary {
  const out: WishlistSummary = { count: 0, estimatedTotal: 0, mustHaveTotal: 0, unpriced: 0 };
  for (const i of items) {
    if (i.status !== "WISHLIST") continue;
    out.count++;
    if (i.estimatedPrice == null) {
      out.unpriced++;
      continue;
    }
    const total = i.estimatedPrice * qty(i);
    out.estimatedTotal += total;
    if (i.priority === "MUST_HAVE") out.mustHaveTotal += total;
  }
  return out;
}

// What owned items cost us (gifts and hand-me-downs are free by
// definition, even if someone typed a price for reference).
export function spentTotal(items: PricedItem[]): number {
  let total = 0;
  for (const i of items) {
    if (i.status !== "OWNED" && i.status !== "SOLD" && i.status !== "GIVEN_AWAY") continue;
    if (i.acquiredVia && i.acquiredVia !== "PURCHASED") continue;
    if (i.pricePaid == null) continue;
    total += i.pricePaid * qty(i);
  }
  return total;
}

export function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  });
}

// ── Drafts (shared by the /inventory page and the agent) ─────────────────────
// Janet creates photo-identified items as DRAFT; a person approves them
// (→ draftStatus, default OWNED) or discards them. Takes the Amplify data
// client as `any` so browser and Lambda clients both fit.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataClient = any;

export interface DraftLike {
  id: string;
  status?: string | null;
  draftStatus?: string | null;
  acquiredAt?: string | null;
}

/** Approve drafts. Non-draft ids are skipped. Returns how many changed. */
export async function approveDrafts(client: DataClient, items: DraftLike[], today: string): Promise<number> {
  let n = 0;
  for (const item of items) {
    if (item.status !== "DRAFT") continue;
    const status = item.draftStatus === "WISHLIST" ? "WISHLIST" : "OWNED";
    const { errors } = await client.models.homeInventoryItem.update({
      id: item.id,
      status,
      draftStatus: null,
      ...(status === "OWNED" && !item.acquiredAt ? { acquiredAt: today } : {}),
    });
    if (!errors?.length) n++;
  }
  return n;
}

/** Delete items along with their clothing / consumable detail rows. */
export async function deleteInventoryItems(client: DataClient, itemIds: string[]): Promise<number> {
  let n = 0;
  for (const id of itemIds) {
    for (const model of ["homeInventoryClothing", "homeInventoryConsumable"]) {
      const { data } = await client.models[model].list({ filter: { itemId: { eq: id } }, limit: 100 });
      for (const row of data ?? []) await client.models[model].delete({ id: row.id });
    }
    const { errors } = await client.models.homeInventoryItem.delete({ id });
    if (!errors?.length) n++;
  }
  return n;
}
