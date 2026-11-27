// Wardrobe operations: list, save (create / update), and the saved trip plan.

import { z } from "zod/v4";
import { getHouseholdTimezone } from "../household-settings";
import { listAllPages } from "../list-all";
import { photoUrl } from "../image-loader";
import {
  FORMALITIES,
  SEASONS,
  WARDROBE_STATUSES,
  categoriesFor,
  imagesOf,
  wardrobeItemForApi,
  ymdInTz,
  type WardrobeItemApi,
} from "../wardrobe";
import {
  TRIP_REVIEW_LABELS,
  categoryCounts,
  categoryCountsLabel,
  describeTripDay,
  packCount,
  parseJsonField,
  picksOf,
  type TripDayWeather,
  type TripLook,
  type TripReview,
} from "../wardrobe-trip";
import { tripPlanStillGenerating } from "../wardrobe-trip-edits";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";
import { resolvePerson } from "./people";

const WARDROBE_PREFIX = "home/wardrobe/";
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const OWNED = ["KEEP", "NEW", "TAILOR"];

const person = {
  personId: z.string().optional().describe("Whose wardrobe, by id. Or use personName."),
  personName: z.string().optional().describe("Whose wardrobe, by name. Defaults to the caller."),
};

// ── Item shape served to every caller ──────────────────────────────────────

export const WardrobeItemOut = z.object({
  id: z.string(),
  category: z.string().nullable(),
  name: z.string().nullable(),
  brand: z.string().nullable(),
  color: z.string().nullable(),
  colorHex: z.string().nullable(),
  size: z.string().nullable(),
  fabric: z.string().nullable(),
  fit: z.string().nullable(),
  styleCode: z.string().nullable(),
  status: z.string(),
  season: z.string().nullable(),
  formality: z.string().nullable(),
  price: z.number().nullable().describe("USD: paid, or expected for wishlist"),
  quantity: z.number().describe("Identical copies owned"),
  url: z.string().nullable().describe("Product page"),
  notes: z.string().nullable().describe("Free-text description"),
  lastWornOn: z.string().nullable(),
  photoUrl: z.string().nullable().describe("Main photo, resized"),
  photoUrls: z.array(z.string()).describe("Every photo, full size, main first"),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
// Keep the zod shape and the serializer's type in step.
type _ItemOutMatches = [z.infer<typeof WardrobeItemOut>] extends [WardrobeItemApi]
  ? [WardrobeItemApi] extends [z.infer<typeof WardrobeItemOut>]
    ? true
    : never
  : never;
const _itemOutMatches: _ItemOutMatches = true;
void _itemOutMatches;

async function itemsOf(ctx: OpContext, personId: string) {
  return listAllPages<any>(ctx.client.models.homeWardrobeItem, { filter: { ownerPersonId: { eq: personId } } }); // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function categoriesOf(ctx: OpContext, personId: string, items: { category?: string | null }[]) {
  const { data } = await ctx.client.models.homeWardrobeProfile.list({ filter: { personId: { eq: personId } }, limit: 500 });
  return categoriesFor(data?.[0]?.categories, items);
}

// ── list_wardrobe ──────────────────────────────────────────────────────────

export const listWardrobe = defineOp({
  name: "list_wardrobe",
  domain: "wardrobe",
  access: "read",
  description:
    "List items in someone's wardrobe with every field: category, brand, name, color (+hex), size, fabric, fit, style code, status, season, formality, price (USD; paid, or expected for wishlist), quantity, product link (url), notes (the description), last worn, photo URLs (photoUrl = main photo resized, photoUrls = all photos full size) and timestamps. Also returns the person's categories. Filter by itemId, category, status or a fuzzy query (name, brand, color, fabric, style code, notes). Answers 'what navy sweaters do I have?', 'what's on my wardrobe wishlist and what does it cost?', 'send me the link to the Barbour', 'show me a photo of my brown boots'.",
  input: z.object({
    ...person,
    itemId: z.string().optional().describe("Return just this item."),
    category: z.string().optional(),
    status: z
      .enum([...WARDROBE_STATUSES, "OWNED", "ALL"])
      .optional()
      .describe("Default OWNED (keep + new + tailor); ALL when itemId is given."),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional().describe("Max items returned, default 60."),
  }),
  output: z.object({
    categories: z.array(z.string()),
    count: z.number().describe("Matches before the limit"),
    wishlistTotalUsd: z.number().optional().describe("Only when listing the wishlist"),
    items: z.array(WardrobeItemOut),
  }),
  async run(ctx, input) {
    const p = await resolvePerson(ctx, input);
    const rows = await itemsOf(ctx, p.id);
    const status = input.status ?? (input.itemId ? "ALL" : "OWNED");
    const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const out = rows.filter((i) => {
      if (input.itemId && i.id !== input.itemId) return false;
      const st = i.status ?? "KEEP";
      if (status === "OWNED" && !OWNED.includes(st)) return false;
      if (status !== "OWNED" && status !== "ALL" && st !== status) return false;
      if (input.category && (i.category ?? "").toLowerCase() !== input.category.toLowerCase()) return false;
      if (words.length) {
        const hay = [i.name, i.brand, i.color, i.fabric, i.category, i.styleCode, i.notes].filter(Boolean).join(" ").toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    out.sort((x, y) => (x.category ?? "").localeCompare(y.category ?? "") || (x.brand ?? "").localeCompare(y.brand ?? ""));
    return {
      categories: await categoriesOf(ctx, p.id, rows),
      count: out.length,
      ...(status === "WISHLIST" ? { wishlistTotalUsd: out.reduce((sum, i) => sum + (i.price ?? 0), 0) } : {}),
      items: out.slice(0, input.limit ?? 60).map(wardrobeItemForApi),
    };
  },
});

// ── save_wardrobe_item ─────────────────────────────────────────────────────

// "" clears like null does, so form fields and API callers behave the same.
const optText = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v == null ? v : v.trim() || null));
const orEmpty = <T extends z.ZodType>(t: T) =>
  z.union([t, z.literal("")]).nullable().optional().transform((v) => (v === "" ? null : v));

export const SaveWardrobeItemInput = z.object({
  ...person,
  itemId: z.string().optional().describe("Item to update. Leave out to create."),
  category: z.string().trim().min(1).optional().describe("One of the person's categories (list_wardrobe returns them)."),
  name: z.string().trim().min(1).optional().describe("Product name without the brand, e.g. 'Cotton piqué polo'."),
  brand: optText,
  color: optText.describe("Color name, e.g. 'Navy'."),
  colorHex: orEmpty(z.string().regex(/^#[0-9a-fA-F]{6}$/, "must look like #1f2a44")).describe("Swatch color, e.g. '#2a2e3d'."),
  size: optText,
  fabric: optText,
  fit: optText.describe("e.g. 'Slim', 'Regular'."),
  styleCode: optText.describe("Brand's product or SKU code."),
  status: z
    .enum(WARDROBE_STATUSES)
    .optional()
    .describe("KEEP = owned and worn, NEW = owned with tags, TAILOR = needs alterations, RETIRE = letting go, WISHLIST = want to buy."),
  season: z.enum(SEASONS).optional(),
  formality: z.enum(FORMALITIES).nullable().optional(),
  price: z.number().min(0).nullable().optional().describe("USD: paid, or expected for wishlist."),
  quantity: z.number().int().min(1).optional().describe("Identical copies owned. Default 1."),
  url: orEmpty(z.string().regex(/^https?:\/\/\S+$/, "must start with http:// or https://")).describe("Product page link."),
  notes: optText.describe("Free-text description: details, what it pairs with, where it came from. Replaces the existing notes."),
  lastWornOn: orEmpty(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")),
  imageUrls: z.array(z.string()).max(6).optional().describe("https image links to download and add as photos."),
  s3Keys: z.array(z.string()).max(6).optional().describe("Keys returned by POST /uploads after the image was PUT there."),
  imageKeys: z
    .array(z.string().startsWith(WARDROBE_PREFIX))
    .max(20)
    .optional()
    .describe("The full, ordered photo list as keys already under home/wardrobe/ (the web uploader). Replaces the item's photos."),
  photoMode: z.enum(["append", "main", "replace"]).optional().describe("How imageUrls / s3Keys join existing photos. Default append."),
  allowDuplicate: z.boolean().optional().describe("Create even if the url or style code is already in the wardrobe."),
});

const PATCH_FIELDS = [
  "category",
  "name",
  "brand",
  "color",
  "colorHex",
  "size",
  "fabric",
  "fit",
  "styleCode",
  "status",
  "season",
  "formality",
  "price",
  "quantity",
  "url",
  "notes",
  "lastWornOn",
] as const;

export const saveWardrobeItem = defineOp({
  name: "save_wardrobe_item",
  domain: "wardrobe",
  access: "write",
  description:
    "Add a wardrobe item or change one. Without itemId it creates a new item (name and category required; status defaults to WISHLIST, so 'add this to my wishlist' needs nothing more). With itemId it updates only the fields given, e.g. { itemId, status: 'KEEP' } when a wishlist piece arrives, or status RETIRE to let something go. Send null or \"\" to clear an optional field. Photos: imageUrls (https links to product images) or s3Keys (from POST /uploads), added after the existing photos; photoMode 'main' puts them first, 'replace' drops the old ones. On create it refuses an item whose url or style code is already in the wardrobe and returns that item instead; pass allowDuplicate to add it anyway. Returns the saved item with every field. Use list_wardrobe first to find itemId and the person's categories.",
  input: SaveWardrobeItemInput,
  output: z.object({
    action: z.enum(["created", "updated"]),
    note: z.string().optional().describe("Set when the category is new for this person"),
    item: WardrobeItemOut,
  }),
  async run(ctx, input) {
    const p = await resolvePerson(ctx, input);
    const rows = await itemsOf(ctx, p.id);
    const existing = input.itemId ? rows.find((i) => i.id === input.itemId) : undefined;
    if (input.itemId && !existing) throw new OpError(`No wardrobe item ${input.itemId} for ${p.name}. Use list_wardrobe to find the id.`);

    const patch: Record<string, unknown> = {};
    for (const k of PATCH_FIELDS) if (input[k] !== undefined) patch[k] = input[k];
    if (!existing) {
      const missing = (["name", "category"] as const).filter((k) => !input[k]);
      if (missing.length) throw new OpError(`${missing.join(" and ")} required to add an item`);
      if (!input.allowDuplicate) {
        const same = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
        const dup = rows.find((i) => same(i.url, input.url) || same(i.styleCode, input.styleCode));
        if (dup) {
          throw new OpError("Already in the wardrobe (same url or style code). Update it with itemId, or pass allowDuplicate to add another.", {
            existing: wardrobeItemForApi(dup),
          });
        }
      }
    }

    const fetched: string[] = [];
    for (const u of input.imageUrls ?? []) fetched.push(await ctx.storage.storeFromUrl(u, WARDROBE_PREFIX));
    for (const k of input.s3Keys ?? []) fetched.push(await ctx.storage.copyUpload(k, WARDROBE_PREFIX));
    const base = input.imageKeys ?? (existing ? imagesOf(existing) : []);
    const mode = input.photoMode ?? "append";
    const imageKeys = fetched.length
      ? mode === "replace"
        ? fetched
        : mode === "main"
          ? [...fetched, ...base]
          : [...base, ...fetched]
      : input.imageKeys;
    if (imageKeys) patch.imageKeys = Array.from(new Set(imageKeys));

    const r = existing
      ? await ctx.client.models.homeWardrobeItem.update({ id: existing.id, ...patch })
      : await ctx.client.models.homeWardrobeItem.create({ status: "WISHLIST", season: "ALL", ...patch, ownerPersonId: p.id });
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");

    const known = await categoriesOf(ctx, p.id, []);
    const newCategory = input.category && !known.some((c) => c.toLowerCase() === input.category!.toLowerCase());
    return {
      action: existing ? ("updated" as const) : ("created" as const),
      ...(newCategory ? { note: `"${input.category}" isn't one of ${p.name}'s categories (${known.join(", ")}); it shows as an extra tab.` } : {}),
      item: wardrobeItemForApi(r.data),
    };
  },
});

// ── get_trip_plan ──────────────────────────────────────────────────────────

export const getTripPlan = defineOp({
  name: "get_trip_plan",
  domain: "wardrobe",
  access: "read",
  description:
    "Read the saved trip-looks plan for someone's trip (made on the wardrobe page's Trip looks tab): the packing list (with copies to pack, what's already ticked off as packed, and how it adds up by type, e.g. '4 T-Shirts · 3 Jeans'), the outfits (one per day and activity, or a set of mix-and-match looks), the weather used and packing tips. When the person picked the pieces themselves, `review` is the stylist's opinion of them: verdict, concerns, pieces to add and to leave at home. Answers 'what am I packing for Seattle?', 'what do I wear for the dinner on the London trip?'. Defaults to the next upcoming trip.",
  input: z.object({
    ...person,
    tripName: z.string().optional().describe("Fuzzy trip name or city, e.g. 'Seattle'. Defaults to the next upcoming trip."),
  }),
  output: z.object({
    trip: z.string(),
    dates: z.string(),
    status: z.string().describe("READY, GENERATING, FAILED or NONE"),
    note: z.string().optional(),
    luggage: z.string().nullable().optional(),
    context: z.string().nullable().optional(),
    startedFrom: z.enum(["SUGGESTED", "PICKED"]).optional().describe("Who chose the pieces: the stylist, or the person"),
    perDay: z.boolean().optional().describe("false = mix-and-match looks, not one per day"),
    counts: z.string().optional().describe("The packing list by type, copies counted: '4 T-Shirts · 3 Jeans'"),
    review: z
      .object({
        verdict: z.string(),
        summary: z.string(),
        concerns: z.array(z.string()),
        add: z.array(z.object({ piece: z.string(), why: z.string().nullable() })),
        leaveHome: z.array(z.object({ piece: z.string(), why: z.string().nullable() })),
      })
      .nullable()
      .optional(),
    weather: z.array(z.object({ date: z.string(), forecast: z.string() })).optional(),
    packingList: z.array(WardrobeItemOut.extend({ copiesToPack: z.number(), packed: z.boolean() })).optional(),
    looks: z
      .array(z.object({ date: z.string().nullable(), title: z.string(), occasion: z.string().nullable(), pieces: z.array(z.string()), why: z.string().nullable() }))
      .optional(),
    tips: z.string().nullable().optional(),
    generatedAt: z.string().nullable().optional(),
  }),
  async run(ctx, input) {
    const p = await resolvePerson(ctx, input);
    const trip = await findTrip(ctx, p.id, input);
    const dates = `${trip.startDate} to ${trip.endDate}`;

    const plan = await latestPlan(ctx, trip.id, p.id);
    if (!plan || plan.status !== "READY") {
      return { trip: trip.name, dates, status: plan?.status ?? "NONE", note: "No finished plan yet. Make one on the wardrobe page's Trip looks tab." };
    }

    const byId = new Map((await itemsOf(ctx, p.id)).map((i) => [i.id, i]));
    const label = (id: string) => (byId.has(id) ? itemLabel(byId.get(id)) : null);
    const packed = new Set((plan.packedItemIds ?? []).filter(Boolean));
    const looks = parseJsonField<TripLook[]>(plan.looks, []);
    const picks = plan.mode === "PICKED" ? picksOf(plan) : null;
    const packList = (plan.packItemIds ?? []).filter((id: string | null): id is string => !!id && byId.has(id)).map((id: string) => byId.get(id));
    const review = parseJsonField<TripReview | null>(plan.review, null);
    const refs = (list: { itemId: string; why: string | null }[]) => list.filter((r) => byId.has(r.itemId)).map((r) => ({ piece: label(r.itemId)!, why: r.why }));
    return {
      trip: trip.name,
      dates,
      status: "READY",
      luggage: plan.capacity === "PIECES" ? `${plan.maxPieces} pieces` : plan.capacity,
      context: plan.context,
      startedFrom: picks ? ("PICKED" as const) : ("SUGGESTED" as const),
      perDay: plan.perDay !== false,
      counts: categoryCountsLabel(categoryCounts(packList, (it: any) => packCount(it, looks, picks))), // eslint-disable-line @typescript-eslint/no-explicit-any
      review: review
        ? { verdict: TRIP_REVIEW_LABELS[review.verdict] ?? review.verdict, summary: review.summary, concerns: review.concerns ?? [], add: refs(review.add ?? []), leaveHome: refs(review.leaveHome ?? []) }
        : null,
      weather: parseJsonField<TripDayWeather[]>(plan.weather, []).map((w) => ({ date: w.date, forecast: describeTripDay(w) })),
      packingList: (plan.packItemIds ?? [])
        .filter((id: string | null): id is string => !!id && byId.has(id))
        .map((id: string) => ({ ...wardrobeItemForApi(byId.get(id)), copiesToPack: packCount(byId.get(id), looks, picks), packed: packed.has(id) })),
      looks: looks.map((l) => ({
        date: l.date ?? null,
        title: l.title,
        occasion: l.occasion ?? null,
        pieces: l.itemIds.map(label).filter((x): x is string => !!x),
        why: l.why ?? null,
      })),
      tips: plan.tips,
      generatedAt: plan.generatedAt,
    };
  },
});

// ── add_trip_pack_to_checklist ─────────────────────────────────────────────

export const addTripPackToChecklist = defineOp({
  name: "add_trip_pack_to_checklist",
  domain: "wardrobe",
  access: "write",
  description:
    "Copy a finished trip-looks packing list (see get_trip_plan) into a checklist on that trip: one line per piece, '×2' when more than one copy goes, grouped by wardrobe category. Pass checklistId to add to one of the trip's checklists, or leave it out to create a new one (checklistName, default 'Packing · <name>'). itemIds limits it to some pieces; default is the whole list. Lines already on the checklist are skipped, so running it again only adds what's new.",
  input: z.object({
    ...person,
    tripId: z.string().optional().describe("The trip, by id. Or use tripName."),
    tripName: z.string().optional().describe("Fuzzy trip name or city. Defaults to the next upcoming trip."),
    itemIds: z.array(z.string()).optional().describe("Pieces from the packing list to add; default all"),
    checklistId: z.string().optional().describe("One of the trip's checklists to add to; omit to create a new one"),
    checklistName: z.string().optional().describe("Name for a new checklist"),
  }),
  output: z.object({
    checklistId: z.string(),
    checklistName: z.string(),
    created: z.boolean(),
    added: z.array(z.string()),
    skipped: z.array(z.string()).describe("Already on the checklist"),
  }),
  async run(ctx, input) {
    const p = await resolvePerson(ctx, input);
    const trip = await findTrip(ctx, p.id, input);
    const plan = await latestPlan(ctx, trip.id, p.id);
    if (plan?.status !== "READY") throw new OpError(`No finished trip-looks plan for ${p.name} on ${trip.name} yet.`);

    const byId = new Map((await itemsOf(ctx, p.id)).map((i) => [i.id, i]));
    const pack: string[] = (plan.packItemIds ?? []).filter((id: string | null): id is string => !!id && byId.has(id));
    const want = input.itemIds ? new Set(input.itemIds) : null;
    const picked = want ? pack.filter((id) => want.has(id)) : pack;
    if (!picked.length) throw new OpError("None of those pieces are on the packing list.");
    const looks = parseJsonField<TripLook[]>(plan.looks, []);

    let checklist: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (input.checklistId) {
      checklist = (await ctx.client.models.homeChecklist.get({ id: input.checklistId })).data;
      if (!checklist || checklist.entityType !== "TRIP" || checklist.entityId !== trip.id) {
        throw new OpError(`That checklist isn't on ${trip.name}.`);
      }
    } else {
      const name = input.checklistName?.trim() || `Packing · ${p.name}`;
      const r = await ctx.client.models.homeChecklist.create({ entityType: "TRIP", entityId: trip.id, name, sortOrder: 0 });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Couldn't create the checklist");
      checklist = r.data;
    }

    const existing = input.checklistId
      ? await listAllPages<any>(ctx.client.models.homeChecklistItem, { filter: { checklistId: { eq: checklist.id } } }) // eslint-disable-line @typescript-eslint/no-explicit-any
      : [];
    const have = new Set(existing.map((i) => String(i.text).trim().toLowerCase()));
    let order = Math.max(-1, ...existing.map((i) => i.sortOrder ?? 0));
    const added: string[] = [];
    const skipped: string[] = [];
    for (const id of picked) {
      const item = byId.get(id);
      const copies = packCount(item, looks, plan.mode === "PICKED" ? picksOf(plan) : null);
      const text = copies > 1 ? `${itemLabel(item)} ×${copies}` : itemLabel(item);
      if (have.has(text.toLowerCase())) {
        skipped.push(text);
        continue;
      }
      have.add(text.toLowerCase());
      const r = await ctx.client.models.homeChecklistItem.create({
        checklistId: checklist.id,
        text,
        section: item.category || null,
        isDone: false,
        sortOrder: ++order,
      });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      added.push(text);
    }
    return { checklistId: checklist.id, checklistName: checklist.name, created: !input.checklistId, added, skipped };
  },
});

// ── Shared trip lookup ─────────────────────────────────────────────────────

// "Todd Snyder Chino (Stone)"
function itemLabel(i: { brand?: string | null; name?: string | null; color?: string | null }): string {
  return [i.brand, i.name, i.color && `(${i.color})`].filter(Boolean).join(" ");
}

// The trip by id, else by fuzzy name/city (latest match), else the next upcoming one; only trips the person is on.
async function findTrip(ctx: OpContext, personId: string, input: { tripId?: string; tripName?: string }) {
  const trips = (await listAllPages<any>(ctx.client.models.homeTrip)).filter((t) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const ids = (t.participantIds ?? []).filter(Boolean);
    return !ids.length || ids.includes(personId);
  });
  if (input.tripId) {
    const t = trips.find((x) => x.id === input.tripId);
    if (!t) throw new OpError(`No trip ${input.tripId} for this person`);
    return t;
  }
  const today = ymdInTz(new Date(), await getHouseholdTimezone(ctx.client));
  const want = (input.tripName ?? "").toLowerCase().trim();
  const trip = want
    ? trips
        .filter((t) => [t.name, t.destination?.city].filter(Boolean).join(" ").toLowerCase().includes(want))
        .sort((x, y) => y.startDate.localeCompare(x.startDate))[0]
    : trips.filter((t) => t.endDate >= today).sort((x, y) => x.startDate.localeCompare(y.startDate))[0];
  if (!trip) throw new OpError(want ? `No trip matching "${input.tripName}"` : "No upcoming trips");
  return trip;
}

async function latestPlan(ctx: OpContext, tripId: string, personId: string) {
  const plans = await listAllPages<any>(ctx.client.models.homeWardrobeTripPlan, { // eslint-disable-line @typescript-eslint/no-explicit-any
    filter: { tripId: { eq: tripId }, personId: { eq: personId } },
  });
  return plans.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0] ?? null;
}

// ── Looks (homeWardrobeLook) ───────────────────────────────────────────────

const LookOut = z.object({
  id: z.string(),
  title: z.string(),
  occasion: z.string().nullable(),
  palette: z.string().nullable(),
  note: z.string().nullable().describe("Why it works"),
  source: z.string().nullable().describe("MANUAL, SUGGESTED or IMPORTED"),
  pieces: z.array(z.object({ id: z.string(), label: z.string(), category: z.string().nullable() })).describe("In the look's order; pieces since deleted are left out"),
  previewUrl: z.string().nullable().describe("Try-on image, when one was made"),
  updatedAt: z.string().nullable(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lookForApi(l: any, byId: Map<string, any>): z.infer<typeof LookOut> {
  return {
    id: l.id,
    title: l.title,
    occasion: l.occasion ?? null,
    palette: l.palette ?? null,
    note: l.note ?? null,
    source: l.source ?? null,
    pieces: (l.itemIds ?? [])
      .filter((id: string | null): id is string => !!id && byId.has(id))
      .map((id: string) => ({ id, label: itemLabel(byId.get(id)), category: byId.get(id).category ?? null })),
    previewUrl: l.previewImageKey ? photoUrl(l.previewImageKey, 800) : null,
    updatedAt: l.updatedAt ?? null,
  };
}

const looksOf = (ctx: OpContext, personId: string) =>
  listAllPages<any>(ctx.client.models.homeWardrobeLook, { filter: { ownerPersonId: { eq: personId } } }); // eslint-disable-line @typescript-eslint/no-explicit-any

export const listWardrobeLooks = defineOp({
  name: "list_wardrobe_looks",
  domain: "wardrobe",
  access: "read",
  description:
    "Someone's saved looks (outfits on the wardrobe page's Looks tab): title, occasion, palette, why it works, and its pieces. Answers 'what looks do I have for golf?', 'show my saved office outfits'. query matches title, occasion, palette, note and piece names.",
  input: z.object({
    ...person,
    lookId: z.string().optional().describe("Return just this look."),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
  }),
  output: z.object({ count: z.number(), looks: z.array(LookOut) }),
  async run(ctx, input) {
    const p = await resolvePerson(ctx, input);
    const [looks, items] = await Promise.all([looksOf(ctx, p.id), itemsOf(ctx, p.id)]);
    const byId = new Map(items.map((i) => [i.id, i]));
    const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const out = looks.filter((l) => {
      if (input.lookId && l.id !== input.lookId) return false;
      const pieces = (l.itemIds ?? []).map((id: string) => (byId.has(id) ? itemLabel(byId.get(id)) : "")).join(" ");
      const hay = [l.title, l.occasion, l.palette, l.note, pieces].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    out.sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0) || (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""));
    return { count: out.length, looks: out.slice(0, input.limit ?? 50).map((l) => lookForApi(l, byId)) };
  },
});

export const saveWardrobeLook = defineOp({
  name: "save_wardrobe_look",
  domain: "wardrobe",
  access: "write",
  description:
    "Save an outfit as a look on someone's wardrobe page, or change one. Without lookId it creates a look (title and itemIds required); with lookId it updates only what's given. itemIds are pieces from that person's closet (ids from list_wardrobe or suggest_outfit's pieces looked up there), at least two, in the order to show them; on update they replace the pieces. To keep a suggest_outfit result, save it with source SUGGESTED and its why as the note.",
  input: z.object({
    ...person,
    lookId: z.string().optional().describe("Look to change. Leave out to create."),
    title: z.string().optional(),
    itemIds: z.array(z.string()).optional().describe("Closet piece ids, at least 2. Replaces the pieces on update."),
    occasion: z.string().nullable().optional().describe("'Office', 'Weekend', 'Golf'…"),
    palette: z.string().nullable().optional().describe("'Navy + grey'"),
    note: z.string().nullable().optional().describe("Why it works"),
    source: z.enum(["MANUAL", "SUGGESTED"]).optional().describe("Default MANUAL on create"),
  }),
  output: z.object({ action: z.enum(["created", "updated"]), look: LookOut }),
  async run(ctx, input) {
    const p = await resolvePerson(ctx, input);
    const items = await itemsOf(ctx, p.id);
    const byId = new Map(items.map((i) => [i.id, i]));
    const text = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

    let itemIds: string[] | undefined;
    if (input.itemIds !== undefined) {
      itemIds = [...new Set(input.itemIds)];
      const missing = itemIds.filter((id) => !byId.has(id));
      if (missing.length) throw new OpError(`Not in ${p.name}'s closet: ${missing.join(", ")}. Use list_wardrobe for their ids.`);
      if (itemIds.length < 2) throw new OpError("A look needs at least two pieces");
    }
    const title = input.title === undefined ? undefined : input.title.trim();
    if (title === "") throw new OpError("A look needs a title");

    if (input.lookId) {
      const { data: existing } = await ctx.client.models.homeWardrobeLook.get({ id: input.lookId });
      if (!existing || existing.ownerPersonId !== p.id) throw new OpError(`No look ${input.lookId} for ${p.name}. Use list_wardrobe_looks.`);
      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (itemIds !== undefined) patch.itemIds = itemIds;
      for (const k of ["occasion", "palette", "note"] as const) if (input[k] !== undefined) patch[k] = text(input[k]);
      if (input.source !== undefined) patch.source = input.source;
      if (!Object.keys(patch).length) throw new OpError("Nothing to change");
      const r = await ctx.client.models.homeWardrobeLook.update({ id: existing.id, ...patch });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      return { action: "updated" as const, look: lookForApi(r.data, byId) };
    }

    if (!title) throw new OpError("title is required to create a look");
    if (!itemIds) throw new OpError("itemIds are required to create a look");
    const existing = await looksOf(ctx, p.id);
    const r = await ctx.client.models.homeWardrobeLook.create({
      ownerPersonId: p.id,
      title,
      itemIds,
      occasion: text(input.occasion) ?? null,
      palette: text(input.palette) ?? null,
      note: text(input.note) ?? null,
      source: input.source ?? "MANUAL",
      // At the end of the Looks tab.
      sortOrder: Math.max(0, ...existing.map((l) => l.sortOrder ?? 0)) + 1,
    });
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
    return { action: "created" as const, look: lookForApi(r.data, byId) };
  },
});

// ── plan_trip_looks ────────────────────────────────────────────────────────

export const planTripLooks = defineOp({
  name: "plan_trip_looks",
  domain: "wardrobe",
  access: "write",
  description:
    "Start the trip-looks planner for someone's trip (what the wardrobe page's Trip looks tab does). It runs in the background for a minute or more (longer trips take longer) and replaces the trip's current plan; read the result with get_trip_plan (status GENERATING, then READY or FAILED). Two ways: leave pickedItemIds out and the stylist chooses what to pack; or pass pickedItemIds (closet ids from list_wardrobe, at least 2, with pickedCopies for items owned more than once) and it builds the looks only from those and reviews them (get_trip_plan's `review`: verdict, concerns, pieces to add or leave home). perDay false gives mix-and-match looks instead of one per day. change tweaks the finished plan instead (\"swap the field jacket for something lower-key\"), keeping everything else and its saved settings.",
  input: z.object({
    ...person,
    tripId: z.string().optional().describe("The trip, by id. Or use tripName."),
    tripName: z.string().optional().describe("Fuzzy trip name or city. Defaults to the next upcoming trip."),
    luggage: z.enum(["CARRY_ON", "CHECKED", "PIECES"]).optional().describe("Default: the saved plan's, else CARRY_ON"),
    maxPieces: z.number().int().min(1).max(60).optional().describe("With luggage PIECES"),
    activities: z.array(z.object({ date: DATE.nullable().optional(), text: z.string() })).optional().describe("Things to dress for; reservations on the trip are included automatically. Default: the saved plan's"),
    request: z.string().optional().describe("Anything else, followed as an instruction ('one smart dinner; want to wear the new boots')"),
    pickedItemIds: z.array(z.string()).optional().describe("Pick the pieces yourself; the looks use only these and they get reviewed"),
    pickedCopies: z.record(z.string(), z.number().int().min(1)).optional().describe("{ itemId: copies } for picked items owned more than once"),
    perDay: z.boolean().optional().describe("Default true: a look per day. false: mix-and-match looks"),
    change: z.string().optional().describe("Tweak the finished plan instead of planning again"),
  }),
  output: z.object({ status: z.literal("STARTED"), trip: z.string(), dates: z.string(), startedFrom: z.enum(["SUGGESTED", "PICKED", "TWEAK"]), note: z.string() }),
  async run(ctx, input) {
    if (!ctx.startTripPlan) throw new OpError("Planning trip looks from here isn't available; use the wardrobe page's Trip looks tab.");
    const p = await resolvePerson(ctx, input);
    const trip = await findTrip(ctx, p.id, input);
    const before = await latestPlan(ctx, trip.id, p.id);
    const change = input.change?.trim() || null;
    if (before?.status === "GENERATING" && tripPlanStillGenerating(before)) {
      throw new OpError("A plan for this trip is already being made; check get_trip_plan in a minute.");
    }
    if (change && before?.status !== "READY") throw new OpError("There's no finished plan to tweak yet; plan it first.");

    const picked = input.pickedItemIds ? [...new Set(input.pickedItemIds)] : null;
    if (picked) {
      const byId = new Map((await itemsOf(ctx, p.id)).map((i) => [i.id, i]));
      const bad = picked.filter((id) => !byId.has(id) || !OWNED.includes(byId.get(id).status ?? "KEEP"));
      if (bad.length) throw new OpError(`Not wearable pieces in ${p.name}'s closet: ${bad.join(", ")}. Use list_wardrobe for their ids.`);
      if (picked.length < 2) throw new OpError("Pick at least two pieces to pack.");
    }
    const capacity = input.luggage ?? before?.capacity ?? "CARRY_ON";
    await ctx.startTripPlan({
      tripId: trip.id,
      personId: p.id,
      capacity,
      maxPieces: capacity === "PIECES" ? (input.maxPieces ?? before?.maxPieces ?? 12) : null,
      activities: JSON.stringify(input.activities ?? parseJsonField(before?.activities, [])),
      request: input.request ?? before?.request ?? null,
      revision: change,
      mode: picked ? "PICKED" : "SUGGEST",
      pickedItemIds: picked,
      pickedCopies: picked ? JSON.stringify(input.pickedCopies ?? {}) : null,
      perDay: input.perDay ?? before?.perDay ?? true,
    });
    return {
      status: "STARTED" as const,
      trip: trip.name,
      dates: `${trip.startDate} to ${trip.endDate}`,
      startedFrom: change ? ("TWEAK" as const) : picked ? ("PICKED" as const) : ("SUGGESTED" as const),
      note: "Takes a minute or more. Read it with get_trip_plan (same trip); status is GENERATING until it's READY or FAILED.",
    };
  },
});

export const wardrobeOps = [listWardrobe, saveWardrobeItem, listWardrobeLooks, saveWardrobeLook, getTripPlan, planTripLooks, addTripPackToChecklist];
