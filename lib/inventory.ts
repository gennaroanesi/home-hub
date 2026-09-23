// Shared inventory vocabulary + derivations: categories, which of them
// have a detail model, clothing size presets, low-stock and wishlist
// totals. Used by the /inventory page, the dashboard, and the agent's
// inventory tools so they agree on what "low" or "$ left to buy" means.

export const INVENTORY_CATEGORIES = [
  "CLOTHING",
  "CONSUMABLE",
  "GEAR",
  "FURNITURE",
  "KITCHEN",
  "ELECTRONICS",
  "TOYS",
  "BOOKS",
  "TOOLS",
  "OTHER",
] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

export const INVENTORY_CATEGORY_LABELS: Record<InventoryCategory, string> = {
  CLOTHING: "Clothing",
  CONSUMABLE: "Consumables",
  GEAR: "Gear",
  FURNITURE: "Furniture",
  KITCHEN: "Kitchen",
  ELECTRONICS: "Electronics",
  TOYS: "Toys",
  BOOKS: "Books",
  TOOLS: "Tools",
  OTHER: "Other",
};

// Categories with their own detail model (keyed by itemId). Everything
// else lives entirely on homeInventoryItem.
export const DETAIL_MODEL_BY_CATEGORY = {
  CLOTHING: "homeInventoryClothing",
  CONSUMABLE: "homeInventoryConsumable",
} as const satisfies Partial<Record<InventoryCategory, string>>;

export function hasDetailModel(
  category: string | null | undefined,
): category is keyof typeof DETAIL_MODEL_BY_CATEGORY {
  return !!category && category in DETAIL_MODEL_BY_CATEGORY;
}

export const INVENTORY_STATUSES = ["WISHLIST", "OWNED", "SOLD", "GIVEN_AWAY"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
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
