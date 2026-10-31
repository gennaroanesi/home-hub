// Wardrobe helpers shared by the /wardrobe page, the outfit-suggester
// Lambda, Janet, and the closet import script. Pure — no I/O.

import { originalPhotoUrl, photoUrl } from "./image-loader";

export const WARDROBE_STATUSES = ["KEEP", "NEW", "TAILOR", "RETIRE", "WISHLIST"] as const;
export type WardrobeStatus = (typeof WARDROBE_STATUSES)[number];

export const WARDROBE_STATUS_LABELS: Record<WardrobeStatus, string> = {
  KEEP: "Keep",
  NEW: "New with tags",
  TAILOR: "Tailor",
  RETIRE: "Retire",
  WISHLIST: "Wishlist",
};

export const FORMALITIES = ["ATHLETIC", "CASUAL", "SMART_CASUAL", "OFFICE", "DRESSY"] as const;
export type Formality = (typeof FORMALITIES)[number];
export const FORMALITY_LABELS: Record<Formality, string> = {
  ATHLETIC: "Athletic",
  CASUAL: "Casual",
  SMART_CASUAL: "Smart casual",
  OFFICE: "Office",
  DRESSY: "Dressy",
};

export const SEASONS = ["ALL", "WARM", "COLD"] as const;
export type Season = (typeof SEASONS)[number];
export const SEASON_LABELS: Record<Season, string> = { ALL: "All year", WARM: "Warm weather", COLD: "Cold weather" };

// Used when a person has no profile yet.
export const DEFAULT_CATEGORIES = ["Tops", "Knitwear", "Pants", "Outerwear", "Shoes", "Accessories"];

// Offered in the profile editor; anything else can be typed in.
export const CATEGORY_PRESETS = [
  "Tops",
  "Tees",
  "Shirts",
  "Blouses",
  "Knitwear",
  "Pants",
  "Jeans",
  "Skirts",
  "Shorts",
  "Dresses",
  "Outerwear",
  "Suits",
  "Shoes",
  "Bags",
  "Accessories",
  "Jewelry",
  "Activewear",
  "Golf",
  "Swim",
  "Loungewear",
];

export interface WardrobeItemLike {
  id: string;
  category?: string | null;
  name?: string | null;
  brand?: string | null;
  color?: string | null;
  colorHex?: string | null;
  fabric?: string | null;
  fit?: string | null;
  size?: string | null;
  status?: string | null;
  season?: string | null;
  formality?: string | null;
  notes?: string | null;
  imageKeys?: (string | null)[] | null;
  lastWornOn?: string | null;
  quantity?: number | null;
}

/** Identical copies owned; missing or bad values count as one. */
export function quantityOf(item: { quantity?: number | null }): number {
  const q = item.quantity;
  return q != null && Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1;
}

/** The person's ordered categories, plus any category an item uses that the profile doesn't list. */
export function categoriesFor(
  profileCategories: (string | null)[] | null | undefined,
  items: { category?: string | null }[],
): string[] {
  const base = (profileCategories ?? []).filter((c): c is string => !!c && !!c.trim());
  const list = base.length ? [...base] : [...DEFAULT_CATEGORIES];
  for (const it of items) {
    const c = it.category?.trim();
    if (c && !list.some((x) => x.toLowerCase() === c.toLowerCase())) list.push(c);
  }
  return list;
}

export function imagesOf(item: { imageKeys?: (string | null)[] | null }): string[] {
  return (item.imageKeys ?? []).filter((k): k is string => !!k);
}

export function mainImage(item: { imageKeys?: (string | null)[] | null }): string | null {
  return imagesOf(item)[0] ?? null;
}

/** Every field of a wardrobe item, as served to Janet and the Muse API. */
export interface WardrobeItemApi {
  id: string;
  category: string | null;
  name: string | null;
  brand: string | null;
  color: string | null;
  colorHex: string | null;
  size: string | null;
  fabric: string | null;
  fit: string | null;
  styleCode: string | null;
  status: string;
  season: string | null;
  formality: string | null;
  price: number | null;
  quantity: number; // identical copies owned
  url: string | null;
  notes: string | null;
  lastWornOn: string | null;
  photoUrl: string | null; // main photo, resized
  photoUrls: string[]; // every photo, full size, main first
  createdAt: string | null;
  updatedAt: string | null;
}

export function wardrobeItemForApi(
  i: WardrobeItemLike & {
    styleCode?: string | null;
    price?: number | null;
    url?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  },
): WardrobeItemApi {
  const keys = imagesOf(i);
  return {
    id: i.id,
    category: i.category ?? null,
    name: i.name ?? null,
    brand: i.brand ?? null,
    color: i.color ?? null,
    colorHex: i.colorHex ?? null,
    size: i.size ?? null,
    fabric: i.fabric ?? null,
    fit: i.fit ?? null,
    styleCode: i.styleCode ?? null,
    status: i.status ?? "KEEP",
    season: i.season ?? null,
    formality: i.formality ?? null,
    price: i.price ?? null,
    quantity: quantityOf(i),
    url: i.url ?? null,
    notes: i.notes ?? null,
    lastWornOn: i.lastWornOn ?? null,
    photoUrl: keys[0] ? photoUrl(keys[0], 800) : null,
    photoUrls: keys.map(originalPhotoUrl),
    createdAt: i.createdAt ?? null,
    updatedAt: i.updatedAt ?? null,
  };
}

/** Fields an API caller may set on a wardrobe item (photos are handled separately). */
export interface WardrobeItemPatch {
  category?: string;
  name?: string;
  brand?: string | null;
  color?: string | null;
  colorHex?: string | null;
  size?: string | null;
  fabric?: string | null;
  fit?: string | null;
  styleCode?: string | null;
  status?: WardrobeStatus;
  season?: Season;
  formality?: Formality | null;
  price?: number | null;
  quantity?: number;
  url?: string | null;
  notes?: string | null;
  lastWornOn?: string | null;
}

const PATCH_TEXT = ["brand", "color", "size", "fabric", "fit", "styleCode", "notes"] as const;

/**
 * Validates API input into an item patch. Keys left out are untouched;
 * null or "" clears an optional field. Returns every problem at once so a
 * caller can fix them in one go.
 */
export function wardrobeItemPatch(input: Record<string, unknown>): { patch: WardrobeItemPatch; errors: string[] } {
  const patch: WardrobeItemPatch = {};
  const errors: string[] = [];
  const has = (k: string) => input[k] !== undefined;
  const text = (k: string): string | null => {
    const v = input[k];
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
  };
  for (const k of ["category", "name"] as const) {
    if (!has(k)) continue;
    const v = text(k);
    if (v) patch[k] = v;
    else errors.push(`${k} can't be empty`);
  }
  for (const k of PATCH_TEXT) if (has(k)) patch[k] = text(k);
  if (has("colorHex")) {
    const v = text("colorHex");
    if (v && !/^#?[0-9a-f]{6}$/i.test(v)) errors.push("colorHex must look like #1f2a44");
    else patch.colorHex = v ? (v.startsWith("#") ? v : `#${v}`).toLowerCase() : null;
  }
  const oneOf = <T extends string>(k: string, values: readonly T[], nullable: boolean): T | null | undefined => {
    if (!has(k)) return undefined;
    const v = text(k)?.toUpperCase().replace(/[\s-]+/g, "_");
    if (!v) {
      if (!nullable) errors.push(`${k} must be one of ${values.join(", ")}`);
      return null;
    }
    if (!(values as readonly string[]).includes(v)) {
      errors.push(`${k} must be one of ${values.join(", ")}`);
      return undefined;
    }
    return v as T;
  };
  const status = oneOf("status", WARDROBE_STATUSES, false);
  if (status) patch.status = status;
  const season = oneOf("season", SEASONS, false);
  if (season) patch.season = season;
  const formality = oneOf("formality", FORMALITIES, true);
  if (formality !== undefined) patch.formality = formality;
  if (has("price")) {
    const v = input.price;
    if (v == null || v === "") patch.price = null;
    else if (Number.isFinite(Number(v)) && Number(v) >= 0) patch.price = Number(v);
    else errors.push("price must be a number of dollars, 0 or more");
  }
  if (has("quantity")) {
    const v = Number(input.quantity);
    if (Number.isInteger(v) && v >= 1) patch.quantity = v;
    else errors.push("quantity must be a whole number, 1 or more");
  }
  if (has("url")) {
    const v = text("url");
    if (v && !/^https?:\/\/\S+$/i.test(v)) errors.push("url must start with http:// or https://");
    else patch.url = v;
  }
  if (has("lastWornOn")) {
    const v = text("lastWornOn");
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push("lastWornOn must be YYYY-MM-DD");
    else patch.lastWornOn = v;
  }
  return { patch, errors };
}

/** Splits a trailing "(×4)" or "(x4)" count off a name, as older imports wrote it. */
export function splitNameQuantity(name: string): { name: string; quantity: number | null } {
  const m = /^(.*?)\s*\(\s*[×x]\s*(\d+)\s*\)\s*$/i.exec(name);
  if (!m || Number(m[2]) < 1) return { name, quantity: null };
  return { name: m[1], quantity: Number(m[2]) };
}

/** Moves imageKeys[index] to the front (the main photo). */
export function makeMain(keys: string[], index: number): string[] {
  if (index <= 0 || index >= keys.length) return keys.slice();
  const next = keys.slice();
  const [k] = next.splice(index, 1);
  next.unshift(k);
  return next;
}

/** Owned and wearable today: what the suggester may pick from. */
export function isWearable(item: { status?: string | null }): boolean {
  const s = item.status ?? "KEEP";
  return s === "KEEP" || s === "NEW" || s === "TAILOR";
}

export function isWishlist(item: { status?: string | null }): boolean {
  return item.status === "WISHLIST";
}

/** Item ids worn on or after `sinceYmd` (inclusive), newest first, deduped. */
export function recentlyWorn(
  wears: { date: string; itemIds?: (string | null)[] | null }[],
  sinceYmd: string,
): string[] {
  const out: string[] = [];
  for (const w of [...wears].sort((a, b) => b.date.localeCompare(a.date))) {
    if (w.date < sinceYmd) continue;
    for (const id of w.itemIds ?? []) if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD for `when` in `tz`. */
export function ymdInTz(when: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(when);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Minutes `tz` is ahead of UTC at instant `when` (Chicago in winter → -360). */
export function tzOffsetMinutes(when: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(when);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - when.getTime()) / 60000);
}

/** UTC instants bounding the local day `ymd` in `tz`: [start, end). */
export function dayBoundsUtc(ymd: string, tz: string): { start: Date; end: Date } {
  const noon = new Date(`${ymd}T12:00:00Z`);
  const off = tzOffsetMinutes(noon, tz);
  const start = new Date(Date.parse(`${ymd}T00:00:00Z`) - off * 60000);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

/** Rough light/dark check for drawing text on a swatch. */
export function isDarkHex(hex: string | null | undefined): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return false;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255,
    g = (v >> 8) & 255,
    b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}
