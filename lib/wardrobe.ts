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

/** Same ids, any order (a try-on image only describes the exact set of pieces it was rendered from). */
export function sameIdSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Owned and wearable today: what the suggester may pick from. */
export function isWearable(item: { status?: string | null }): boolean {
  const s = item.status ?? "KEEP";
  return s === "KEEP" || s === "NEW" || s === "TAILOR";
}

export function isWishlist(item: { status?: string | null }): boolean {
  return item.status === "WISHLIST";
}

/**
 * Every word must appear somewhere in the haystack: "navy wool" matches a
 * navy merino-wool sweater, not just the literal phrase.
 */
export function matchesSearch(q: string, parts: (string | null | undefined)[]): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Closet filters (web /wardrobe query string, mobile chips). "OWNED" = wearing; "" = everything. */
export interface ClosetFilter {
  category: string;
  status: WardrobeStatus | "OWNED" | "";
  inLook: "" | "YES" | "NO";
  search: string;
}

/** Item ids used by at least one of the looks. */
export function itemIdsInLooks(looks: { itemIds?: (string | null)[] | null }[]): Set<string> {
  return new Set(looks.flatMap((l) => (l.itemIds ?? []).filter((x): x is string => !!x)));
}

export function filterCloset<T extends WardrobeItemLike & { styleCode?: string | null }>(
  items: T[],
  f: ClosetFilter,
  inLooks: Set<string>,
): T[] {
  return items.filter((i) => {
    if (f.category && i.category !== f.category) return false;
    const s = i.status ?? "KEEP";
    if (f.status === "OWNED" && (s === "WISHLIST" || s === "RETIRE")) return false;
    if (f.status && f.status !== "OWNED" && s !== f.status) return false;
    if (f.inLook === "YES" && !inLooks.has(i.id)) return false;
    if (f.inLook === "NO" && inLooks.has(i.id)) return false;
    return matchesSearch(f.search, [i.name, i.brand, i.color, i.fabric, i.fit, i.size, i.styleCode, i.notes, i.category]);
  });
}

/** Header counts: owned (not wishlist / retired), on the wishlist, with a photo. */
export function closetCounts(items: WardrobeItemLike[]): { owned: number; wish: number; photos: number } {
  return {
    owned: items.filter((i) => i.status !== "WISHLIST" && i.status !== "RETIRE").length,
    wish: items.filter((i) => i.status === "WISHLIST").length,
    photos: items.filter((i) => mainImage(i)).length,
  };
}

export interface LookLike {
  title?: string | null;
  occasion?: string | null;
  palette?: string | null;
  note?: string | null;
  stylingInstructions?: string | null;
  previewImageKey?: string | null;
  itemIds?: (string | null)[] | null;
}

/**
 * Occasion chips for saved looks: distinct occasions, case-insensitive,
 * shown with the first spelling seen, most used first. Keys are lowercased.
 */
export function lookOccasions(looks: LookLike[]): [string, { label: string; count: number }][] {
  const m = new Map<string, { label: string; count: number }>();
  for (const l of looks) {
    const o = l.occasion?.trim();
    if (!o) continue;
    const k = o.toLowerCase();
    const e = m.get(k);
    if (e) e.count++;
    else m.set(k, { label: o, count: 1 });
  }
  return Array.from(m.entries()).sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label));
}

/** Saved-look filters: occasion key (lowercased), has a try-on, and words across the look and its pieces. */
export function filterLooks<L extends LookLike>(
  looks: L[],
  f: { occasion: string; tryOn: boolean; search: string },
  byId: Map<string, WardrobeItemLike>,
): L[] {
  return looks.filter((l) => {
    if (f.occasion && (l.occasion ?? "").trim().toLowerCase() !== f.occasion) return false;
    if (f.tryOn && !l.previewImageKey) return false;
    const pieces = (l.itemIds ?? []).map((id) => (id ? byId.get(id) : undefined));
    return matchesSearch(f.search, [
      l.title,
      l.occasion,
      l.palette,
      l.note,
      l.stylingInstructions,
      ...pieces.flatMap((p) => (p ? [p.brand, p.name, p.color, p.category] : [])),
    ]);
  });
}

/** Closet order inside a category: brand, then name. */
export function compareClosetItems(a: WardrobeItemLike, b: WardrobeItemLike): number {
  return (a.brand ?? "").localeCompare(b.brand ?? "") || (a.name ?? "").localeCompare(b.name ?? "");
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
