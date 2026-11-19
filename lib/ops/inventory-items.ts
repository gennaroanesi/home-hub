// Inventory items: list, get, create / change / delete, photo drafts,
// quantities, photos, and ammo (use, totals, minimums). Moved out of the
// agent Lambda so the web, the phone, Janet and the API share them; the
// tool names stayed, so Janet's prompts still fit. Detail fields come from
// lib/inventory-details.ts; firearms and ammo are owner-only and go only to
// their owner (docs/inventory-specialized.md, section 4).

import { z } from "zod/v4";
import { approveDrafts } from "../inventory";
import { DETAIL_SPECS, DETAIL_TYPES, detailSummary, type DetailField, type DetailType } from "../inventory-details";
import { caliberKey, caliberTotals, planAmmoUse, thresholdChanges, lotsOldestFirst } from "../inventory-ammo";
import { createItem, deleteItem, detailTypeOfCategory, loadInventoryStore, moveItemTable, tableForCategory, updateItem, upsertDetail, type InventoryStore, type StoreItem } from "../inventory-store";
import { categoryAndDescendants, categoryTree, isLowStock, matchCategory, sizeRank, wishlistSummary } from "../inventory";
import { decodeBase64Image } from "../inventory-images";
import { matchRoom, roomAndDescendants, roomLabel } from "../floorplan";
import { babyProfileFor, ymdInTimezone } from "../pregnancy";
import { listAllPages } from "../list-all";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HOUSEHOLD_TZ = "America/Chicago";
const today = () => ymdInTimezone(HOUSEHOLD_TZ);
const PHOTO_PREFIX = "home/inventory/";

const STATUSES = ["DRAFT", "WISHLIST", "OWNED", "SOLD", "GIVEN_AWAY"] as const;
const DETAILS_DOC = DETAIL_TYPES.map((t) => `${t}: ${DETAIL_SPECS[t].fields.map((f) => f.key).join(", ")}`).join("; ");

// ── Who's asking, and who may see owner-only items ────────────────────────────

async function people(ctx: OpContext): Promise<any[]> {
  return listAllPages<any>(ctx.client.models.homePerson);
}

function personByName(all: any[], name: string | null | undefined): any | null {
  const q = (name ?? "").trim().toLowerCase();
  if (!q) return null;
  const first = (p: any) => String(p.name ?? "").toLowerCase().split(/\s+/)[0];
  return all.find((p) => p.id === name) ?? all.find((p) => String(p.name).toLowerCase() === q) ?? all.find((p) => first(p) === q) ?? null;
}

/**
 * The login whose owner-only items this caller may see: the verified login
 * (web / phone), else the named person's (Janet in a DM, the API). Never in
 * a group chat.
 */
async function viewerOf(ctx: OpContext, folks?: any[]): Promise<{ username: string | null; person: any | null }> {
  const all = folks ?? (await people(ctx));
  if (ctx.actor.groupChat) return { username: null, person: personByName(all, ctx.actor.personName) };
  if (ctx.actor.username) return { username: ctx.actor.username, person: all.find((p) => p.cognitoUsername === ctx.actor.username) ?? null };
  const person = personByName(all, ctx.actor.personName);
  return { username: person?.cognitoUsername ?? null, person };
}

function requireViewer(v: { username: string | null }, ctx: OpContext, what = "Firearms and ammo"): string {
  if (v.username) return v.username;
  throw new OpError(ctx.actor.groupChat ? `${what} are private: ask me in a direct message.` : `${what} are private to their owner, and I can't tell who's asking.`);
}

// ── Lookups ──────────────────────────────────────────────────────────────────

const rooms = (ctx: OpContext) => listAllPages<any>(ctx.client.models.homeRoom);
const pets = async (ctx: OpContext) => (ctx.client.models.homePet ? listAllPages<any>(ctx.client.models.homePet) : []);
const pregnancies = async (ctx: OpContext) => (ctx.client.models.homePregnancy ? listAllPages<any>(ctx.client.models.homePregnancy) : []);

async function shoppingLists(ctx: OpContext): Promise<any[]> {
  return (await listAllPages<any>(ctx.client.models.homeShoppingList)).filter((l) => !l.isArchived);
}

function matchShoppingList(lists: any[], name?: string | null): any | null {
  if (lists.length === 0) return null;
  if (!name) {
    return (
      lists.find((l) => /supermarket|grocer/i.test(l.name)) ?? [...lists].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0]
    );
  }
  const q = name.toLowerCase().trim();
  return lists.find((l) => l.name.toLowerCase() === q) ?? lists.find((l) => l.name.toLowerCase().includes(q)) ?? lists.find((l) => q.includes(l.name.toLowerCase())) ?? null;
}

function matchItem(items: StoreItem[], itemId?: string | null, query?: string | null): StoreItem | null {
  if (itemId) return items.find((i) => i.id === itemId) ?? null;
  if (!query) return null;
  const q = query.toLowerCase().trim();
  // Prefer items we still have over sold / given-away ones with the same name.
  const ranked = [...items].sort((a, b) => Number(a.status === "SOLD" || a.status === "GIVEN_AWAY") - Number(b.status === "SOLD" || b.status === "GIVEN_AWAY"));
  return ranked.find((i) => i.name.toLowerCase() === q) ?? ranked.find((i) => i.name.toLowerCase().includes(q)) ?? ranked.find((i) => q.includes(i.name.toLowerCase())) ?? null;
}

function noCategory(text: string, categories: any[], suffix = ""): never {
  throw new OpError(`No single category matching "${text}"${suffix}`, { categories: categoryTree(categories).map((n) => n.path) });
}

function noRoom(text: string, all: any[], suffix = ""): never {
  const byId = new Map(all.map((r) => [r.id, r]));
  throw new OpError(`No room matching "${text}"${suffix}`, { rooms: all.map((r) => roomLabel(r, byId)) });
}

type Owner = { ownerPersonId: string | null; pregnancyId: string | null; petId: string | null };
const NO_OWNER: Owner = { ownerPersonId: null, pregnancyId: null, petId: null };

/** ownerName → a person, the baby ("baby" / forBaby: its profile, else the pregnancy), a pet, or the household. */
async function resolveOwner(ctx: OpContext, folks: any[], ownerName?: string | null, forBaby?: boolean): Promise<Owner> {
  const name = (ownerName ?? "").toLowerCase().trim();
  if (forBaby || name === "baby") {
    const active = (await pregnancies(ctx)).filter((p) => p.status === "ACTIVE");
    if (active.length !== 1) throw new OpError(active.length === 0 ? "No active pregnancy to link baby items to" : "Several active pregnancies: say whose");
    const profile = babyProfileFor(active[0], folks);
    return profile ? { ...NO_OWNER, ownerPersonId: profile.id } : { ...NO_OWNER, pregnancyId: active[0].id };
  }
  if (!name || ["household", "both", "shared", "us"].includes(name)) return NO_OWNER;
  const pet = (await pets(ctx)).filter((p) => p.active !== false).find((p) => p.name.toLowerCase() === name || name.startsWith(p.name.toLowerCase()));
  if (pet) return { ...NO_OWNER, petId: pet.id };
  const person = personByName(folks, ownerName);
  if (!person) throw new OpError(`No person or pet named "${ownerName}"`);
  return { ...NO_OWNER, ownerPersonId: person.id };
}

// ── Detail fields ────────────────────────────────────────────────────────────

/** Check `details` against the type's spec and convert values; unknown keys and bad values are errors. */
function parseDetails(type: DetailType, details: Record<string, unknown>, lists: any[]): Record<string, unknown> {
  const spec = DETAIL_SPECS[type];
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(details)) {
    const f = spec.fields.find((x) => x.key === key) ?? (key === "shoppingListName" ? spec.fields.find((x) => x.kind === "shoppingList") : undefined);
    if (!f) throw new OpError(`"${key}" isn't a ${spec.label.toLowerCase()} field. ${spec.label} fields: ${spec.fields.map((x) => x.key).join(", ")}`);
    out[f.key] = coerce(f, raw, lists);
  }
  return out;
}

function coerce(f: DetailField, raw: unknown, lists: any[]): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  const bad = (want: string) => new OpError(`${f.label}: expected ${want}, got ${JSON.stringify(raw)}`);
  switch (f.kind) {
    case "text":
      return String(raw).trim();
    case "int": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(n)) throw bad("a whole number");
      return Math.round(n);
    }
    case "float": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(n)) throw bad("a number");
      return n;
    }
    case "bool":
      if (typeof raw === "boolean") return raw;
      if (/^(true|yes|1)$/i.test(String(raw))) return true;
      if (/^(false|no|0)$/i.test(String(raw))) return false;
      throw bad("true or false");
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw bad("YYYY-MM-DD");
      return String(raw);
    case "choice": {
      const s = String(raw).trim().toLowerCase();
      const hit = (f.options ?? []).find((o) => o.toLowerCase() === s || f.optionLabels?.[o]?.toLowerCase() === s || o.toLowerCase().replace(/_/g, " ") === s);
      if (!hit) throw bad(`one of ${(f.options ?? []).join(", ")}`);
      return hit;
    }
    case "shoppingList": {
      const s = String(raw);
      const list = lists.find((l) => l.id === s) ?? matchShoppingList(lists, s);
      if (!list) throw new OpError(`No shopping list matching "${s}"`);
      return list.id;
    }
  }
}

const detailsOut = (type: DetailType | null, row: Record<string, any> | undefined): Record<string, unknown> | null => {
  if (!type || !row) return null;
  return Object.fromEntries(DETAIL_SPECS[type].fields.map((f) => [f.key, row[f.key] ?? null]));
};

// ── Consumable restock ───────────────────────────────────────────────────────

async function restockIfLow(ctx: OpContext, item: any, detail: Record<string, any> | null | undefined, lists?: any[]) {
  const none = { lowStock: false, addedToList: null as string | null, alreadyOnList: false };
  if (!detail || item.status !== "OWNED" || !isLowStock(item.quantity, detail.lowStockThreshold)) return none;
  const all = lists ?? (await shoppingLists(ctx));
  const list = (detail.shoppingListId && all.find((l) => l.id === detail.shoppingListId)) || matchShoppingList(all, null);
  if (!list) return { ...none, lowStock: true };
  const open = await listAllPages<any>(ctx.client.models.homeShoppingItem, { filter: { listId: { eq: list.id }, isChecked: { eq: false } } });
  if (open.some((i) => i.name.toLowerCase() === item.name.toLowerCase())) return { lowStock: true, addedToList: null, alreadyOnList: true };
  await ctx.client.models.homeShoppingItem.create({
    listId: list.id,
    name: item.name,
    notes: `Low stock (${item.quantity ?? 0}${detail.unit ? ` ${detail.unit}` : ""} left)`,
    isChecked: false,
  });
  return { lowStock: true, addedToList: list.name as string, alreadyOnList: false };
}
const RestockOut = z.object({ lowStock: z.boolean(), addedToList: z.string().nullable(), alreadyOnList: z.boolean() }).nullable();

// ── Ammo minimums ────────────────────────────────────────────────────────────

/** After rounds change: DM the owner for calibers newly below their minimum, re-arm ones back above. */
async function checkAmmoMinimums(ctx: OpContext, store: InventoryStore, username: string, ownerPersonId: string | null) {
  const thresholds = (await listAllPages<any>(ctx.client.models.homeAmmoThreshold)).filter((t) => t.ownerUsername === username);
  if (thresholds.length === 0) return [] as string[];
  const totals = caliberTotals(ammoLots(store));
  const { alert, rearm } = thresholdChanges(thresholds, totals);
  const now = new Date().toISOString();
  for (const t of rearm) await ctx.client.models.homeAmmoThreshold.update({ id: t.id, notifiedAt: null });
  for (const { threshold, rounds } of alert) {
    if (ownerPersonId) {
      await ctx.client.models.homeOutboundMessage.create({
        channel: "WHATSAPP",
        target: "PERSON",
        personId: ownerPersonId,
        text: `🔻 Low on ${threshold.caliber}: ${rounds} rounds left (your minimum is ${threshold.minRounds}).`,
        status: "PENDING",
        kind: "ammo_low",
      });
    }
    await ctx.client.models.homeAmmoThreshold.update({ id: threshold.id, notifiedAt: now });
  }
  return alert.map((a) => a.threshold.caliber);
}

function ammoLots(store: InventoryStore) {
  return store.items
    .filter((i) => store.details.get(i.id)?.type === "AMMO")
    .map((i) => {
      const d = store.details.get(i.id)!.row;
      return { itemId: i.id, caliber: d.caliber ?? "", roundsAvailable: d.roundsAvailable ?? 0, acquiredAt: i.acquiredAt, createdAt: i.createdAt, status: i.status, detailId: d.id as string, name: i.name };
    });
}

// ── Output ───────────────────────────────────────────────────────────────────

const ItemOut = z.object({
  id: z.string(),
  name: z.string(),
  private: z.boolean().describe("Owner-only (firearms, ammo): never repeat in a group chat"),
  status: z.string().nullable(),
  category: z.string().nullable(),
  categoryId: z.string().nullable(),
  detailType: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable().describe("The detail type's fields (see manage_inventory_item)"),
  summary: z.string().describe('One line from the details, e.g. "9mm · 115gr · FMJ · 850 rds"'),
  owner: z.string(),
  ownerPersonId: z.string().nullable(),
  petId: z.string().nullable(),
  pregnancyId: z.string().nullable(),
  brand: z.string().nullable(),
  quantity: z.number().nullable(),
  room: z.string().nullable(),
  roomId: z.string().nullable(),
  location: z.string().nullable(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  url: z.string().nullable(),
  priority: z.string().nullable(),
  neededBy: z.string().nullable(),
  estimatedPrice: z.number().nullable(),
  pricePaid: z.number().nullable(),
  priceSold: z.number().nullable(),
  acquiredVia: z.string().nullable(),
  acquiredAt: z.string().nullable(),
  giftFrom: z.string().nullable(),
  vendor: z.string().nullable(),
  disposedAt: z.string().nullable(),
  barcode: z.string().nullable(),
  imageKeys: z.array(z.string()).describe("S3 keys; the apps sign them for display"),
  parentItemId: z.string().nullable().describe("Installed on / part of this item"),
  parentName: z.string().nullable(),
  partCount: z.number(),
  lowStock: z.boolean().nullable().describe("Consumables: at or below their low-stock level"),
});
type ItemOutT = z.infer<typeof ItemOut>;

function itemOutFactory(store: InventoryStore, roomRows: any[], folks: any[], petRows: any[]) {
  const roomsById = new Map(roomRows.map((r) => [r.id, r]));
  const byId = new Map(store.items.map((i) => [i.id, i]));
  const partsOf = new Map<string, number>();
  for (const i of store.items) if (i.parentItemId) partsOf.set(i.parentItemId, (partsOf.get(i.parentItemId) ?? 0) + 1);
  return (i: StoreItem): ItemOutT => {
    const type = detailTypeOfCategory(store.nodes, i.categoryId);
    const d = store.details.get(i.id);
    const row = d && d.type === type ? d.row : undefined;
    const room = i.roomId ? roomsById.get(i.roomId) : undefined;
    return {
      id: i.id,
      name: i.name,
      private: i.table === "private",
      status: i.status ?? null,
      category: i.categoryId ? store.nodes.get(i.categoryId)?.path ?? null : null,
      categoryId: i.categoryId ?? null,
      detailType: type,
      details: detailsOut(type, row),
      summary: row ? detailSummary(type, row, { quantity: i.quantity }) : "",
      owner: i.pregnancyId
        ? "baby (on the way)"
        : i.petId
          ? petRows.find((p) => p.id === i.petId)?.name ?? "pet"
          : i.ownerPersonId
            ? folks.find((p) => p.id === i.ownerPersonId)?.name ?? "?"
            : "household",
      ownerPersonId: i.ownerPersonId ?? null,
      petId: i.petId ?? null,
      pregnancyId: i.pregnancyId ?? null,
      brand: i.brand ?? null,
      quantity: i.quantity ?? null,
      room: room ? roomLabel(room, roomsById) : null,
      roomId: i.roomId ?? null,
      location: i.location ?? null,
      tags: (i.tags ?? []).filter(Boolean),
      notes: i.notes ?? null,
      url: i.url ?? null,
      priority: i.priority ?? null,
      neededBy: i.neededBy ?? null,
      estimatedPrice: i.estimatedPrice ?? null,
      pricePaid: i.pricePaid ?? null,
      priceSold: i.priceSold ?? null,
      acquiredVia: i.acquiredVia ?? null,
      acquiredAt: i.acquiredAt ?? null,
      giftFrom: i.giftFrom ?? null,
      vendor: i.vendor ?? null,
      disposedAt: i.disposedAt ?? null,
      barcode: i.barcode ?? null,
      imageKeys: (i.imageKeys ?? []).filter(Boolean),
      parentItemId: i.parentItemId ?? null,
      parentName: i.parentItemId ? byId.get(i.parentItemId)?.name ?? null : null,
      partCount: partsOf.get(i.id) ?? 0,
      lowStock: type === "CONSUMABLE" && row ? i.status === "OWNED" && isLowStock(i.quantity, row.lowStockThreshold) : null,
    };
  };
}

// ── list_inventory ───────────────────────────────────────────────────────────

export const listInventory = defineOp({
  name: "list_inventory",
  domain: "inventory",
  access: "read",
  description:
    "Search the inventory: things we own, the wishlist (also the private baby registry), drafts from photos, and sold / given-away items. Each item has a room (from the house map) plus a free-text spot within it, so this answers 'where is the breast pump?' and 'what's in the garage?'. Also 'size 0-3M sleepers?', 'what's left on the baby wishlist and what will it cost?', 'how many diapers do we have?', 'what's running low?', 'which lenses do I have?', 'what PLA colors do I have?'. Items carry their category's detail fields (clothing, consumable, firearm, ammo, filament, instrument, photography, electronic) in `details` and a one-line `summary`. Firearms and ammo are owner-only: they're only returned to their owner, never in a group chat. For ammo totals use get_ammo_summary.",
  input: z.object({
    status: z.enum([...STATUSES, "ALL"]).optional().describe("Default OWNED. WISHLIST = things to get; DRAFT = identified from a photo, not approved yet."),
    category: z.string().optional().describe("Category name or path ('Clothing', 'Clothing > Baby'); includes its subcategories."),
    detailType: z.enum(DETAIL_TYPES).optional().describe("Only items whose category has this detail type."),
    ownerName: z.string().optional().describe("A person, a pet ('Dolce'), 'household' for shared items, or 'baby'."),
    query: z.string().optional().describe("Matches name, brand, notes, tags, category, room, spot and detail text (color, caliber, part number…)."),
    roomName: z.string().optional().describe("Only items in this room (and closets inside it)."),
    size: z.string().optional().describe("Clothing size: NB, 0-3M, 3T, M."),
    lowStockOnly: z.boolean().optional().describe("Only consumables at or below their low-stock level."),
    partsOf: z.string().optional().describe("Only the parts installed on this item (id or name)."),
    limit: z.number().int().min(1).max(1000).optional().describe("Default 100."),
  }),
  output: z.object({
    count: z.number().describe("Matches before the limit"),
    wishlist: z.object({ count: z.number(), estimatedTotal: z.number(), missingPrice: z.number() }).partial().passthrough().nullable(),
    items: z.array(ItemOut),
    hiddenPrivate: z.boolean().describe("True in a group chat or when the caller is unknown: owner-only items were left out"),
  }),
  async run(ctx, input) {
    const folks = await people(ctx);
    const viewer = await viewerOf(ctx, folks);
    const [store, roomRows, petRows] = await Promise.all([loadInventoryStore(ctx.client, { viewer: viewer.username }), rooms(ctx), pets(ctx)]);
    const status = input.status ?? "OWNED";
    let roomIds: Set<string> | null = null;
    if (input.roomName) {
      const room = matchRoom(roomRows, input.roomName);
      if (!room) noRoom(input.roomName, roomRows);
      roomIds = roomAndDescendants(room.id, roomRows);
    }
    let categoryIds: Set<string> | null = null;
    if (input.category) {
      const match = matchCategory(store.categories, input.category);
      if (!match) noCategory(input.category, store.categories);
      categoryIds = categoryAndDescendants(match.category.id, store.categories);
    }
    const owner = input.ownerName ? await resolveOwner(ctx, folks, input.ownerName) : null;
    let parentId: string | null = null;
    if (input.partsOf) {
      const parent = matchItem(store.items, store.items.some((i) => i.id === input.partsOf) ? input.partsOf : null, input.partsOf);
      if (!parent) throw new OpError(`No inventory item matching "${input.partsOf}"`);
      parentId = parent.id;
    }
    const out = itemOutFactory(store, roomRows, folks, petRows);
    const q = (input.query ?? "").toLowerCase().trim();
    const size = (input.size ?? "").toLowerCase().trim();
    const rows = store.items
      .filter((i) => status === "ALL" || i.status === status)
      .filter((i) => !categoryIds || (!!i.categoryId && categoryIds.has(i.categoryId)))
      .filter((i) => !input.detailType || detailTypeOfCategory(store.nodes, i.categoryId) === input.detailType)
      .filter((i) => !roomIds || (!!i.roomId && roomIds.has(i.roomId)))
      .filter((i) => !parentId || i.parentItemId === parentId)
      .filter((i) => {
        if (!owner) return true;
        if (owner.pregnancyId) return i.pregnancyId === owner.pregnancyId;
        if (owner.petId) return i.petId === owner.petId;
        if (owner.ownerPersonId) return i.ownerPersonId === owner.ownerPersonId;
        return !i.ownerPersonId && !i.pregnancyId && !i.petId;
      })
      .map(out)
      .filter((o) => {
        if (!q) return true;
        const hay = [o.name, o.brand, o.notes, o.category, o.room, o.location, ...o.tags, o.summary, ...Object.values(o.details ?? {}).filter((v) => typeof v === "string")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .filter((o) => !size || String(o.details?.size ?? "").toLowerCase() === size)
      .filter((o) => !input.lowStockOnly || o.lowStock === true)
      .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || sizeRank(a.details?.size as string) - sizeRank(b.details?.size as string) || a.name.localeCompare(b.name));
    return {
      count: rows.length,
      wishlist: status === "WISHLIST" ? (wishlistSummary(rows) as any) : null,
      items: rows.slice(0, input.limit ?? 100),
      hiddenPrivate: !viewer.username,
    };
  },
});

// ── get_inventory_item ───────────────────────────────────────────────────────

export const getInventoryItem = defineOp({
  name: "get_inventory_item",
  domain: "inventory",
  access: "read",
  description: "One inventory item in full: its fields, detail fields, photos, the parts installed on it, and for ammo the uses logged against it. Identify it by itemId or a name query.",
  input: z.object({ itemId: z.string().optional(), query: z.string().optional() }),
  output: z.object({
    item: ItemOut,
    parts: z.array(ItemOut),
    ammoUses: z.array(z.object({ id: z.string(), date: z.string(), rounds: z.number().describe("Taken from this lot"), totalRounds: z.number(), note: z.string().nullable() })).nullable(),
  }),
  async run(ctx, input) {
    const folks = await people(ctx);
    const viewer = await viewerOf(ctx, folks);
    const [store, roomRows, petRows] = await Promise.all([loadInventoryStore(ctx.client, { viewer: viewer.username }), rooms(ctx), pets(ctx)]);
    const item = matchItem(store.items, input.itemId, input.query);
    if (!item) throw new OpError(`No inventory item matching "${input.itemId ?? input.query ?? ""}"`);
    const out = itemOutFactory(store, roomRows, folks, petRows);
    let ammoUses = null;
    if (store.details.get(item.id)?.type === "AMMO" && viewer.username) {
      const uses = (await listAllPages<any>(ctx.client.models.homeAmmoUse)).filter((u) => u.ownerUsername === viewer.username);
      ammoUses = uses
        .map((u) => {
          const lots = (typeof u.lots === "string" ? JSON.parse(u.lots) : u.lots) ?? [];
          const mine = lots.find((l: any) => l.itemId === item.id);
          return mine ? { id: u.id, date: u.date, rounds: mine.rounds, totalRounds: u.rounds, note: u.note ?? null } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => b.date.localeCompare(a.date));
    }
    return { item: out(item), parts: store.items.filter((i) => i.parentItemId === item.id).map(out), ammoUses };
  },
});

// ── manage_inventory_item ────────────────────────────────────────────────────

const BaseIn = {
  brand: z.string().optional(),
  quantity: z.number().int().min(0).optional(),
  location: z.string().optional().describe("Spot within the room: 'top shelf, gray box'."),
  tags: z.array(z.string()).optional().describe("['nursery'], ['feeding']"),
  notes: z.string().optional(),
  url: z.string().optional(),
  priority: z.enum(["MUST_HAVE", "NICE_TO_HAVE"]).optional(),
  neededBy: z.string().optional().describe("YYYY-MM-DD"),
  estimatedPrice: z.number().optional().describe("Per unit, USD."),
  acquiredVia: z.enum(["PURCHASED", "GIFT", "HAND_ME_DOWN"]).optional(),
  giftFrom: z.string().optional(),
  vendor: z.string().optional(),
  acquiredAt: z.string().optional().describe("YYYY-MM-DD. Defaults to today on create as OWNED and on mark_owned."),
  pricePaid: z.number().optional().describe("Per unit, USD."),
  priceSold: z.number().optional(),
  barcode: z.string().optional(),
};

const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export const manageInventoryItem = defineOp({
  name: "manage_inventory_item",
  domain: "inventory",
  access: "write",
  description:
    `Create, change or delete an inventory item. status WISHLIST for things to get (estimatedPrice, priority, neededBy, url), OWNED for things we have. action mark_owned moves a wishlist item to OWNED (bought or a gift). The category decides the detail fields, passed in \`details\` (${DETAILS_DOC}); consumables restock onto shoppingListName when they run low. partOf links a part to the item it's installed on (an optic on a rifle, pickups in a guitar; "" detaches). forBaby files it for the baby. Firearms and ammo are owner-only: they always belong to whoever is asking, and can't be handled in a group chat. Identify an existing item by itemId or query.`,
  input: z.object({
    action: z.enum(["create", "update", "delete", "mark_owned"]),
    itemId: z.string().optional(),
    query: z.string().optional().describe("Fuzzy name match when itemId isn't known."),
    name: z.string().optional().describe("Required for create."),
    category: z.string().optional().describe("Category name or path (list_inventory_categories). Required for create; '' clears."),
    status: z.enum(["WISHLIST", "OWNED", "SOLD", "GIVEN_AWAY"]).optional().describe("Default OWNED on create."),
    ownerName: z.string().optional().describe("A person, a pet ('Dolce'), or 'household' / omit for shared."),
    forBaby: z.boolean().optional(),
    roomName: z.string().optional().describe("Room from the house map; '' clears."),
    partOf: z.string().optional().describe("Item it's installed on / part of (id or name); '' detaches."),
    details: z.record(z.string(), z.unknown()).optional().describe("Detail fields for the item's category type (see description)."),
    shoppingListName: z.string().optional().describe("Consumables: list to restock onto. Default: the supermarket list."),
    ...BaseIn,
  }),
  output: z.object({
    action: z.string(),
    item: ItemOut.nullable(),
    deleted: z.string().nullable(),
    restock: RestockOut,
    lowAmmo: z.array(z.string()).describe("Calibers that just dropped below their minimum (the owner got a DM)"),
  }),
  async run(ctx, input) {
    const folks = await people(ctx);
    const viewer = await viewerOf(ctx, folks);
    const [store, roomRows, petRows, lists] = await Promise.all([loadInventoryStore(ctx.client, { viewer: viewer.username }), rooms(ctx), pets(ctx), shoppingLists(ctx)]);
    const out = itemOutFactory(store, roomRows, folks, petRows);

    let categoryId: string | null | undefined;
    if (input.category !== undefined) {
      if (!input.category) categoryId = null;
      else {
        const match = matchCategory(store.categories, input.category);
        if (!match) noCategory(input.category, store.categories);
        categoryId = match.category.id;
      }
    }
    let roomId: string | null | undefined;
    if (input.roomName !== undefined) {
      if (!input.roomName) roomId = null;
      else {
        const room = matchRoom(roomRows, input.roomName);
        if (!room) noRoom(input.roomName, roomRows);
        roomId = room.id;
      }
    }
    const ownerFields = input.ownerName !== undefined || input.forBaby ? await resolveOwner(ctx, folks, input.ownerName, input.forBaby) : undefined;
    let parentItemId: string | null | undefined;
    if (input.partOf !== undefined) {
      if (!input.partOf) parentItemId = null;
      else {
        const parent = matchItem(store.items, store.items.some((i) => i.id === input.partOf) ? input.partOf : null, input.partOf);
        if (!parent) throw new OpError(`No inventory item matching "${input.partOf}" to attach it to`);
        parentItemId = parent.id;
      }
    }
    const base = defined({
      name: input.name?.trim(),
      status: input.status,
      brand: input.brand,
      quantity: input.quantity,
      location: input.location,
      tags: input.tags,
      notes: input.notes,
      url: input.url,
      priority: input.priority,
      neededBy: input.neededBy,
      estimatedPrice: input.estimatedPrice,
      acquiredVia: input.acquiredVia,
      giftFrom: input.giftFrom,
      vendor: input.vendor,
      acquiredAt: input.acquiredAt,
      pricePaid: input.pricePaid,
      priceSold: input.priceSold,
      barcode: input.barcode,
    });
    const detailInput = { ...(input.details ?? {}), ...(input.shoppingListName !== undefined ? { shoppingListName: input.shoppingListName } : {}) };

    /** Owner-only items belong to the caller; check before writing one. */
    const privateOwner = () => {
      const username = requireViewer(viewer, ctx);
      if (!viewer.person) throw new OpError("I can't tell which household member you are");
      if (ownerFields?.ownerPersonId && ownerFields.ownerPersonId !== viewer.person.id) throw new OpError("Firearms and ammo can only be filed under the person asking");
      return { username, ownerPersonId: viewer.person.id as string };
    };

    if (input.action === "create") {
      if (!base.name || categoryId === undefined || categoryId === null) throw new OpError("name and category are required for create");
      const type = detailTypeOfCategory(store.nodes, categoryId);
      const table = tableForCategory(store.nodes, categoryId);
      const details = type ? parseDetails(type, detailInput, lists) : {};
      if (!type && Object.keys(detailInput).length) throw new OpError("That category has no detail fields; pick one that does or leave details out");
      const status = base.status ?? "OWNED";
      const priv = table === "private" ? privateOwner() : null;
      const item = await createItem(
        ctx.client,
        table,
        {
          quantity: 1,
          ...base,
          categoryId,
          status,
          ...(priv ? { ...NO_OWNER, ownerPersonId: priv.ownerPersonId } : (ownerFields ?? {})),
          ...(roomId !== undefined ? { roomId } : {}),
          ...(parentItemId !== undefined ? { parentItemId } : {}),
          ...(status === "OWNED" && !base.acquiredAt ? { acquiredAt: today() } : {}),
          createdBy: ctx.actor.via === "whatsapp" ? "agent" : ctx.actor.via,
        },
        priv?.username ?? null,
      );
      if (type) store.details.set(item.id, await upsertDetail(ctx.client, item.id, type, undefined, details, priv?.username ?? null));
      store.items.push(item);
      const restock = type === "CONSUMABLE" ? await restockIfLow(ctx, item, store.details.get(item.id)?.row, lists) : null;
      const lowAmmo = type === "AMMO" && priv ? await checkAmmoMinimums(ctx, store, priv.username, priv.ownerPersonId) : [];
      return { action: "created", item: itemOutFactory(store, roomRows, folks, petRows)(item), deleted: null, restock, lowAmmo };
    }

    const item = matchItem(store.items, input.itemId, input.query ?? (input.itemId ? null : input.name));
    if (!item) {
      if (!viewer.username) throw new OpError(`No inventory item matching "${input.itemId ?? input.query ?? input.name ?? ""}" (firearms and ammo aren't searched in a group chat)`);
      throw new OpError(`No inventory item matching "${input.itemId ?? input.query ?? input.name ?? ""}"`);
    }

    if (input.action === "delete") {
      await deleteItem(ctx.client, item);
      for (const p of store.items.filter((i) => i.parentItemId === item.id)) await updateItem(ctx.client, p, { parentItemId: null });
      return { action: "deleted", item: null, deleted: item.name, restock: null, lowAmmo: [] };
    }

    const via = input.acquiredVia ?? item.acquiredVia ?? "PURCHASED";
    const markOwned =
      input.action === "mark_owned"
        ? {
            status: "OWNED",
            acquiredAt: input.acquiredAt ?? today(),
            acquiredVia: via,
            // Bought at the estimate unless told otherwise; gifts cost nothing.
            ...(via === "PURCHASED" && input.pricePaid === undefined && item.estimatedPrice != null ? { pricePaid: item.estimatedPrice } : {}),
          }
        : {};
    const newCategoryId = categoryId === undefined ? item.categoryId : categoryId;
    const type = detailTypeOfCategory(store.nodes, newCategoryId);
    const details = type ? parseDetails(type, detailInput, lists) : {};
    if (!type && Object.keys(detailInput).length) throw new OpError("That item's category has no detail fields");
    const table = tableForCategory(store.nodes, newCategoryId);
    const priv = table === "private" ? privateOwner() : null;

    let current = item;
    if (table !== item.table) current = await moveItemTable(ctx.client, item, table, priv?.username ?? null, store.items.filter((i) => i.parentItemId === item.id));
    const updated = await updateItem(ctx.client, current, {
      ...base,
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(priv ? { ...NO_OWNER, ownerPersonId: priv.ownerPersonId } : (ownerFields ?? {})),
      ...(roomId !== undefined ? { roomId } : {}),
      ...(parentItemId !== undefined ? { parentItemId: parentItemId === current.id ? null : parentItemId } : {}),
      ...markOwned,
      ...(input.status === "SOLD" || input.status === "GIVEN_AWAY" ? { disposedAt: today() } : {}),
    });
    store.items = store.items.filter((i) => i.id !== item.id).concat(updated);
    const existing = current.id === item.id ? store.details.get(item.id) : undefined;
    if (type) store.details.set(updated.id, await upsertDetail(ctx.client, updated.id, type, existing, details, priv?.username ?? null));
    const restock = type === "CONSUMABLE" ? await restockIfLow(ctx, updated, store.details.get(updated.id)?.row, lists) : null;
    const lowAmmo = type === "AMMO" && priv ? await checkAmmoMinimums(ctx, store, priv.username, priv.ownerPersonId) : [];
    return { action: input.action === "mark_owned" ? "marked owned" : "updated", item: itemOutFactory(store, roomRows, folks, petRows)(updated), deleted: null, restock, lowAmmo };
  },
});

// ── add_inventory_items (from a photo) ───────────────────────────────────────

export const addInventoryItems = defineOp({
  name: "add_inventory_items",
  domain: "inventory",
  access: "write",
  description:
    "Create several inventory items at once, typically from a photo: the user sends a picture of a shelf / closet / drawer and says where it is; identify each distinct item you can see and add them all in one call, in that room, with the photo attached. One entry per distinct item (identical ones grouped with quantity). Only include what you can make out; don't guess brands you can't read. Items are DRAFTs (not counted anywhere until approved). Then reply with a numbered list and ask to approve or correct it ('drop 3', 'make 5 two boxes'), and call review_inventory_drafts. Firearms and ammo can't be added as drafts: use manage_inventory_item, in a direct message.",
  input: z.object({
    roomName: z.string().optional().describe("Room from the house map; applies to every item."),
    location: z.string().optional().describe("Spot within the room; applies to every item unless one sets its own."),
    ownerName: z.string().optional().describe("A person, a pet, or omit for the household."),
    forBaby: z.boolean().optional(),
    status: z.enum(["OWNED", "WISHLIST"]).optional().describe("What they become once approved. Default OWNED."),
    attachPhoto: z.boolean().optional().describe("Attach the photo(s) sent with this message to every item. Default true when there is one."),
    items: z
      .array(
        z.object({
          name: z.string(),
          category: z.string().describe("Category name or path."),
          quantity: z.number().int().min(1).optional(),
          brand: z.string().optional(),
          location: z.string().optional(),
          notes: z.string().optional(),
          details: z.record(z.string(), z.unknown()).optional().describe("Detail fields for the category's type."),
        }),
      )
      .min(1)
      .max(60),
  }),
  output: z.object({
    status: z.literal("DRAFT"),
    becomesOnApproval: z.string(),
    room: z.string().nullable(),
    photoAttached: z.boolean(),
    created: z.array(z.object({ n: z.number(), id: z.string(), name: z.string(), quantity: z.number() })),
    failed: z.array(z.object({ name: z.string(), error: z.string() })),
  }),
  async run(ctx, input) {
    const folks = await people(ctx);
    const [categories, roomRows, lists] = await Promise.all([listAllPages<any>(ctx.client.models.homeInventoryCategory), rooms(ctx), shoppingLists(ctx)]);
    const nodes = new Map(categoryTree(categories).map((n) => [n.category.id, n]));
    // All checked up front so one bad entry doesn't leave half a batch behind.
    const plan = input.items.map((it) => {
      const match = matchCategory(categories, it.category);
      if (!match) noCategory(it.category, categories, " — nothing was created");
      if (tableForCategory(nodes, match.category.id) === "private") throw new OpError(`"${it.name}": firearms and ammo can't be drafted from a photo — nothing was created`);
      const type = match.detailType;
      return { it, categoryId: match.category.id, type, details: type ? parseDetails(type, it.details ?? {}, lists) : {} };
    });
    let roomId: string | null = null;
    let roomText: string | null = null;
    if (input.roomName) {
      const room = matchRoom(roomRows, input.roomName);
      if (!room) noRoom(input.roomName, roomRows, " — nothing was created");
      roomId = room.id;
      roomText = roomLabel(room, new Map(roomRows.map((r) => [r.id, r])));
    }
    const owner = input.ownerName || input.forBaby ? await resolveOwner(ctx, folks, input.ownerName, input.forBaby) : NO_OWNER;
    const photos = input.attachPhoto === false ? [] : (ctx.messageImageKeys ?? []);
    const draftStatus = input.status === "WISHLIST" ? "WISHLIST" : "OWNED";
    const created: Array<{ n: number; id: string; name: string; quantity: number }> = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const p of plan) {
      try {
        const item = await createItem(
          ctx.client,
          "household",
          {
            name: p.it.name.trim(),
            categoryId: p.categoryId,
            status: "DRAFT",
            draftStatus,
            quantity: p.it.quantity ?? 1,
            brand: p.it.brand ?? null,
            notes: p.it.notes ?? null,
            roomId,
            location: p.it.location ?? input.location ?? null,
            ...owner,
            imageKeys: photos,
            createdBy: ctx.actor.via === "whatsapp" ? "agent" : ctx.actor.via,
          },
          null,
        );
        if (p.type) await upsertDetail(ctx.client, item.id, p.type, undefined, p.details, null);
        created.push({ n: created.length + 1, id: item.id, name: item.name, quantity: item.quantity ?? 1 });
      } catch (err) {
        failed.push({ name: p.it.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { status: "DRAFT" as const, becomesOnApproval: draftStatus, room: roomText, photoAttached: photos.length > 0, created, failed };
  },
});

// ── review_inventory_drafts ──────────────────────────────────────────────────

export const reviewInventoryDrafts = defineOp({
  name: "review_inventory_drafts",
  domain: "inventory",
  access: "write",
  description:
    "Approve or discard DRAFT inventory items (made from a photo by add_inventory_items). 'Looks good' → approve with the ids just created (or all). 'Drop 3' → discard that id. Approved items become OWNED (or WISHLIST if drafted as that). action list shows what's pending.",
  input: z.object({
    action: z.enum(["approve", "discard", "list"]),
    itemIds: z.array(z.string()).optional(),
    all: z.boolean().optional().describe("Every current draft."),
  }),
  output: z.object({
    drafts: z.array(z.object({ id: z.string(), name: z.string(), quantity: z.number().nullable(), becomes: z.string() })).nullable(),
    approved: z.number(),
    discarded: z.number(),
    names: z.array(z.string()),
    notDrafts: z.array(z.string()),
  }),
  async run(ctx, input) {
    const drafts = await listAllPages<any>(ctx.client.models.homeInventoryItem, { filter: { status: { eq: "DRAFT" } } });
    if (input.action === "list") {
      return { drafts: drafts.map((d) => ({ id: d.id, name: d.name, quantity: d.quantity ?? null, becomes: d.draftStatus ?? "OWNED" })), approved: 0, discarded: 0, names: [], notDrafts: [] };
    }
    const ids = input.itemIds ?? [];
    const targets = input.all ? drafts : drafts.filter((d) => ids.includes(d.id));
    const notDrafts = input.all ? [] : ids.filter((id) => !drafts.some((d) => d.id === id));
    if (targets.length === 0) throw new OpError("No matching drafts", notDrafts.length ? { notDrafts } : undefined);
    if (input.action === "approve") {
      const n = await approveDrafts(ctx.client, targets, today());
      return { drafts: null, approved: n, discarded: 0, names: targets.map((t) => t.name), notDrafts };
    }
    for (const t of targets) await deleteItem(ctx.client, { id: t.id, table: "household" });
    return { drafts: null, approved: 0, discarded: targets.length, names: targets.map((t) => t.name), notDrafts };
  },
});

// ── adjust_inventory_quantity ────────────────────────────────────────────────

export const adjustInventoryQuantity = defineOp({
  name: "adjust_inventory_quantity",
  domain: "inventory",
  access: "write",
  description:
    "Change how many of an item we have: 'used a pack of diapers' (delta -1), 'bought 3 more cans of formula' (delta 3), 'we have 2 boxes of wipes left' (set 2). A consumable that drops to its low-stock level goes on the shopping list. For ammo rounds use log_ammo_use.",
  input: z.object({
    itemId: z.string().optional(),
    query: z.string().optional(),
    delta: z.number().int().optional(),
    set: z.number().int().min(0).optional(),
  }),
  output: z.object({ name: z.string(), before: z.number(), after: z.number(), restock: RestockOut }),
  async run(ctx, input) {
    if (input.delta === undefined && input.set === undefined) throw new OpError("Pass delta or set");
    const viewer = await viewerOf(ctx);
    const store = await loadInventoryStore(ctx.client, { viewer: viewer.username });
    const item = matchItem(store.items, input.itemId, input.query);
    if (!item) throw new OpError(`No inventory item matching "${input.itemId ?? input.query ?? ""}"`);
    const before = item.quantity ?? 0;
    const after = Math.max(0, input.set ?? before + (input.delta ?? 0));
    const updated = await updateItem(ctx.client, item, { quantity: after });
    const d = store.details.get(item.id);
    const restock = d?.type === "CONSUMABLE" ? await restockIfLow(ctx, updated, d.row) : null;
    return { name: updated.name, before, after, restock };
  },
});

// ── add_inventory_photo ──────────────────────────────────────────────────────

export const addInventoryPhoto = defineOp({
  name: "add_inventory_photo",
  domain: "inventory",
  access: "write",
  description:
    "Attach a photo to an inventory item (appends; replace=true swaps out the old ones). The image can come from: the photo(s) sent with this message ('add this photo to the stroller'); s3Key from POST /uploads (API clients, the recommended way to send image bytes); an https imageUrl; or imageBase64 for small images only. Identify the item by itemId or a name query.",
  input: z.object({
    itemId: z.string().optional(),
    query: z.string().optional(),
    s3Key: z.string().optional().describe("Key returned by POST /uploads after you PUT the image there (home/inventory/…)."),
    imageBase64: z.string().optional().describe("Base64 or a data: URL; tiny images only via the API (bodies over ~8 KB are blocked), prefer s3Key."),
    contentType: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic", "image/gif"]).optional(),
    imageUrl: z.string().optional(),
    replace: z.boolean().optional(),
  }),
  output: z.object({ itemId: z.string(), name: z.string(), added: z.number(), photos: z.number() }),
  async run(ctx, input) {
    const viewer = await viewerOf(ctx);
    const store = await loadInventoryStore(ctx.client, { viewer: viewer.username });
    const item = matchItem(store.items, input.itemId, input.query);
    if (!item) throw new OpError(`No inventory item matching "${input.itemId ?? input.query ?? ""}"`);
    let added: string[];
    if (input.s3Key) added = [await ctx.storage.copyUpload(input.s3Key, PHOTO_PREFIX)];
    else if (input.imageBase64) {
      if (!ctx.storage.storeBytes) throw new OpError("Base64 images aren't accepted here; use s3Key");
      let img;
      try {
        img = decodeBase64Image(input.imageBase64, input.contentType);
      } catch (err) {
        throw new OpError(err instanceof Error ? err.message : String(err));
      }
      added = [await ctx.storage.storeBytes(img, PHOTO_PREFIX)];
    } else if (input.imageUrl) added = [await ctx.storage.storeFromUrl(input.imageUrl, PHOTO_PREFIX)];
    else if (ctx.messageImageKeys?.length) added = ctx.messageImageKeys;
    else throw new OpError("No image given: send a photo, or pass s3Key (from POST /uploads), imageUrl or imageBase64");
    const existing = (item.imageKeys ?? []).filter(Boolean);
    const imageKeys = input.replace ? added : Array.from(new Set([...existing, ...added]));
    await updateItem(ctx.client, item, { imageKeys });
    return { itemId: item.id, name: item.name, added: added.length, photos: imageKeys.length };
  },
});

// ── Ammo ─────────────────────────────────────────────────────────────────────

const CaliberOut = z.object({
  caliber: z.string(),
  rounds: z.number(),
  lots: z.number().describe("Purchases with rounds left"),
  minRounds: z.number().nullable(),
  below: z.boolean(),
});

export const getAmmoSummary = defineOp({
  name: "get_ammo_summary",
  domain: "inventory",
  access: "read",
  description:
    "Rounds of ammo on hand per caliber (summed across purchases) against each caliber's minimum, plus the purchases with rounds left, oldest first, and recent logged uses. Answers 'how much 9mm do I have?', 'what am I low on?'. Owner-only: only the asker's ammo, never in a group chat.",
  input: z.object({ caliber: z.string().optional().describe("Just this caliber (loose match: '9mm' finds '9mm Luger').") }),
  output: z.object({
    calibers: z.array(CaliberOut),
    lots: z.array(z.object({ itemId: z.string(), name: z.string(), caliber: z.string(), roundsAvailable: z.number(), acquiredAt: z.string().nullable() })),
    recentUses: z.array(z.object({ id: z.string(), date: z.string(), caliber: z.string(), rounds: z.number(), note: z.string().nullable() })),
  }),
  async run(ctx, input) {
    const username = requireViewer(await viewerOf(ctx), ctx, "Ammo");
    const [store, thresholds, uses] = await Promise.all([
      loadInventoryStore(ctx.client, { viewer: username }),
      listAllPages<any>(ctx.client.models.homeAmmoThreshold),
      listAllPages<any>(ctx.client.models.homeAmmoUse),
    ]);
    const want = input.caliber ? caliberKey(input.caliber) : null;
    const fits = (c: string) => !want || caliberKey(c).includes(want) || want.includes(caliberKey(c));
    const lots = ammoLots(store).filter((l) => fits(l.caliber));
    return {
      calibers: caliberTotals(lots, thresholds.filter((t) => t.ownerUsername === username && fits(t.caliber))),
      lots: lotsOldestFirst(lots.filter((l) => (l.roundsAvailable ?? 0) > 0 && (!l.status || l.status === "OWNED"))).map((l) => ({
        itemId: l.itemId,
        name: l.name,
        caliber: l.caliber,
        roundsAvailable: l.roundsAvailable ?? 0,
        acquiredAt: l.acquiredAt ?? null,
      })),
      recentUses: uses
        .filter((u) => u.ownerUsername === username && fits(u.caliber))
        .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
        .slice(0, 20)
        .map((u) => ({ id: u.id, date: u.date, caliber: u.caliber, rounds: u.rounds, note: u.note ?? null })),
    };
  },
});

export const logAmmoUse = defineOp({
  name: "log_ammo_use",
  domain: "inventory",
  access: "write",
  description:
    "Log rounds used ('shot 200 rounds of 9mm at the range'): takes them from the oldest purchases of that caliber first and records the use (undo with undoUseId). If a caliber drops below its minimum the owner gets a WhatsApp DM. Owner-only, never in a group chat.",
  input: z.object({
    caliber: z.string().optional().describe("Required unless undoUseId."),
    rounds: z.number().int().min(1).optional(),
    date: z.string().optional().describe("YYYY-MM-DD; default today."),
    note: z.string().optional().describe("'range day with Cris'"),
    undoUseId: z.string().optional().describe("A logged use to undo: puts its rounds back on the lots they came from."),
  }),
  output: z.object({
    caliber: z.string(),
    rounds: z.number().describe("Taken (or put back)"),
    shortfall: z.number().describe("Logged beyond what was on hand"),
    remaining: z.number().describe("Rounds of that caliber left"),
    useId: z.string().nullable(),
    lowAmmo: z.array(z.string()),
  }),
  async run(ctx, input) {
    const viewer = await viewerOf(ctx);
    const username = requireViewer(viewer, ctx, "Ammo");
    const store = await loadInventoryStore(ctx.client, { viewer: username });
    const lots = ammoLots(store);
    const setRounds = async (itemId: string, n: number) => {
      const lot = lots.find((l) => l.itemId === itemId);
      if (!lot) return;
      await ctx.client.models.homeInventoryAmmo.update({ id: lot.detailId, roundsAvailable: n, ownerUsername: username });
      lot.roundsAvailable = n;
      store.details.get(itemId)!.row.roundsAvailable = n;
    };

    if (input.undoUseId) {
      const use = (await ctx.client.models.homeAmmoUse.get({ id: input.undoUseId })).data;
      if (!use || use.ownerUsername !== username) throw new OpError(`No logged use ${input.undoUseId}`);
      const drawn = (typeof use.lots === "string" ? JSON.parse(use.lots) : use.lots) ?? [];
      for (const d of drawn) {
        const lot = lots.find((l) => l.itemId === d.itemId);
        if (lot) await setRounds(lot.itemId, (lot.roundsAvailable ?? 0) + d.rounds);
      }
      await ctx.client.models.homeAmmoUse.delete({ id: use.id });
      const remaining = caliberTotals(lots).find((t) => caliberKey(t.caliber) === caliberKey(use.caliber))?.rounds ?? 0;
      const lowAmmo = await checkAmmoMinimums(ctx, store, username, viewer.person?.id ?? null);
      return { caliber: use.caliber, rounds: drawn.reduce((n: number, d: any) => n + d.rounds, 0), shortfall: 0, remaining, useId: null, lowAmmo };
    }

    if (!input.caliber || !input.rounds) throw new OpError("caliber and rounds are required");
    const key = caliberKey(input.caliber);
    const known = [...new Set(lots.map((l) => l.caliber.trim()))];
    // Exact caliber, else one that contains what was said ("9mm" → "9mm Luger"), when only one fits.
    const loose = known.filter((c) => caliberKey(c).includes(key));
    const caliber = known.find((c) => caliberKey(c) === key) ?? (loose.length === 1 ? loose[0] : null);
    if (!caliber) throw new OpError(`No ammo of caliber "${input.caliber}"`, { calibers: known });
    const plan = planAmmoUse(lots, caliber, input.rounds);
    for (const d of plan.draws) {
      const lot = lots.find((l) => l.itemId === d.itemId)!;
      await setRounds(d.itemId, (lot.roundsAvailable ?? 0) - d.rounds);
    }
    const taken = plan.draws.reduce((n, d) => n + d.rounds, 0);
    const use = await ctx.client.models.homeAmmoUse.create({
      caliber,
      rounds: taken,
      date: input.date ?? today(),
      note: input.note ?? null,
      lots: JSON.stringify(plan.draws),
      personId: viewer.person?.id ?? null,
      ownerUsername: username,
    });
    const remaining = caliberTotals(lots).find((t) => caliberKey(t.caliber) === caliberKey(caliber))?.rounds ?? 0;
    const lowAmmo = await checkAmmoMinimums(ctx, store, username, viewer.person?.id ?? null);
    return { caliber, rounds: taken, shortfall: plan.shortfall, remaining, useId: use.data?.id ?? null, lowAmmo };
  },
});

export const saveAmmoThreshold = defineOp({
  name: "save_ammo_threshold",
  domain: "inventory",
  access: "write",
  description: "Set (or with minRounds 0, remove) the minimum rounds to keep of a caliber; dropping below it sends the owner a WhatsApp DM once, until it's restocked. Owner-only.",
  input: z.object({ caliber: z.string(), minRounds: z.number().int().min(0), enabled: z.boolean().optional() }),
  output: z.object({ caliber: z.string(), minRounds: z.number().nullable(), removed: z.boolean(), currentRounds: z.number(), below: z.boolean() }),
  async run(ctx, input) {
    const viewer = await viewerOf(ctx);
    const username = requireViewer(viewer, ctx, "Ammo");
    const [store, all] = await Promise.all([loadInventoryStore(ctx.client, { viewer: username }), listAllPages<any>(ctx.client.models.homeAmmoThreshold)]);
    const mine = all.filter((t) => t.ownerUsername === username);
    const existing = mine.find((t) => caliberKey(t.caliber) === caliberKey(input.caliber));
    const current = caliberTotals(ammoLots(store)).find((t) => caliberKey(t.caliber) === caliberKey(input.caliber))?.rounds ?? 0;
    if (input.minRounds === 0) {
      if (existing) await ctx.client.models.homeAmmoThreshold.delete({ id: existing.id });
      return { caliber: input.caliber.trim(), minRounds: null, removed: !!existing, currentRounds: current, below: false };
    }
    const fields = { caliber: input.caliber.trim(), minRounds: input.minRounds, enabled: input.enabled ?? true, ownerUsername: username };
    if (existing) await ctx.client.models.homeAmmoThreshold.update({ id: existing.id, ...fields, notifiedAt: null });
    else await ctx.client.models.homeAmmoThreshold.create(fields);
    await checkAmmoMinimums(ctx, store, username, viewer.person?.id ?? null);
    return { caliber: fields.caliber, minRounds: input.minRounds, removed: false, currentRounds: current, below: current < input.minRounds };
  },
});

export const inventoryItemOps = [
  listInventory,
  getInventoryItem,
  manageInventoryItem,
  addInventoryItems,
  reviewInventoryDrafts,
  adjustInventoryQuantity,
  addInventoryPhoto,
  getAmmoSummary,
  logAmmoUse,
  saveAmmoThreshold,
];
