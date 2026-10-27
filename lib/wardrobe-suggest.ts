// Outfit suggester core, shared by the wardrobe-suggest Lambda (the
// /wardrobe page's "Suggest" button) and Janet's suggest_outfit tool.
//
// Flow: loadSuggestContext() pulls one person's wardrobe, profile, recent
// wears, the day's calendar and a weather forecast; suggestOutfits() hands
// that to Claude with the propose_outfits tool and validates the answer so
// only real item ids come back (wishlist pieces allowed, flagged as such).

import type Anthropic from "@anthropic-ai/sdk";
import {
  addDaysYmd,
  dayBoundsUtc,
  isWearable,
  isWishlist,
  recentlyWorn,
  ymdInTz,
  type WardrobeItemLike,
} from "./wardrobe";
import { listAllPages } from "./list-all";
import { getHouseholdTimezone } from "./household-settings";

export const SUGGEST_MODEL = "claude-sonnet-5-5";
export const MAX_SUGGESTIONS = 5;

// Austin; used for the forecast until the household has a stored location.
export const DEFAULT_LOCATION = { latitude: 30.2672, longitude: -97.7431, label: "Austin" };

export interface DayWeather {
  highF: number;
  lowF: number;
  precipChance: number | null; // %
  summary: string; // "Partly cloudy"
}

export interface SuggestEvent {
  title: string;
  startAt: string;
  endAt?: string | null;
  isAllDay?: boolean | null;
}

export interface SuggestContext {
  person: { id: string; name: string };
  styleNotes: string | null;
  date: string; // YYYY-MM-DD
  timezone: string;
  items: WardrobeItemLike[]; // wearable only
  wishlist: WardrobeItemLike[];
  recentlyWornIds: string[]; // last 3 days, newest first
  events: SuggestEvent[];
  weather: DayWeather | null;
}

export interface Suggestion {
  title: string;
  palette: string | null;
  occasion: string | null;
  itemIds: string[];
  why: string | null;
  wishlistItemIds: string[];
}

// ── Weather (Open-Meteo, no key) ───────────────────────────────────────────

const WMO: Record<number, string> = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Drizzle",
  53: "Drizzle",
  55: "Drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Showers",
  81: "Showers",
  82: "Heavy showers",
  95: "Thunderstorms",
  96: "Thunderstorms",
  99: "Thunderstorms",
};

export async function fetchDayWeather(
  ymd: string,
  tz: string,
  loc: { latitude: number; longitude: number } = DEFAULT_LOCATION,
  fetchImpl: typeof fetch = fetch,
): Promise<DayWeather | null> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(loc.latitude));
  url.searchParams.set("longitude", String(loc.longitude));
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", tz);
  url.searchParams.set("start_date", ymd);
  url.searchParams.set("end_date", ymd);
  try {
    const res = await fetchImpl(url.href, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      daily?: {
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: (number | null)[];
        weather_code?: number[];
      };
    };
    const d = j.daily;
    if (!d?.temperature_2m_max?.length || !d.temperature_2m_min?.length) return null;
    const code = d.weather_code?.[0];
    return {
      highF: Math.round(d.temperature_2m_max[0]),
      lowF: Math.round(d.temperature_2m_min[0]),
      precipChance: d.precipitation_probability_max?.[0] ?? null,
      summary: code != null ? (WMO[code] ?? "Mixed") : "Unknown",
    };
  } catch {
    return null;
  }
}

export function describeWeather(w: DayWeather | null): string {
  if (!w) return "Weather unavailable";
  const rain = w.precipChance != null && w.precipChance >= 30 ? `, ${w.precipChance}% chance of rain` : "";
  return `${w.summary}, high ${w.highF}°F / low ${w.lowF}°F${rain}`;
}

// ── Context loading ────────────────────────────────────────────────────────

/**
 * Loads everything the suggester needs for one person and day. `client` is
 * an Amplify data client (userPool or IAM flavour — typed `any` for the
 * same reason as lib/household-settings.ts).
 */
export async function loadSuggestContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  args: { personId: string; date?: string | null; fetchImpl?: typeof fetch },
): Promise<SuggestContext> {
  const tz = await getHouseholdTimezone(client);
  const date = args.date || ymdInTz(new Date(), tz);

  const { data: person } = await client.models.homePerson.get({ id: args.personId });
  if (!person) throw new Error("Person not found");

  const [profiles, items, wears] = await Promise.all([
    listAllPages<{ personId: string; styleNotes?: string | null }>(client.models.homeWardrobeProfile, {
      filter: { personId: { eq: args.personId } },
    }),
    listAllPages<WardrobeItemLike & { ownerPersonId: string }>(client.models.homeWardrobeItem, {
      filter: { ownerPersonId: { eq: args.personId } },
    }),
    listAllPages<{ date: string; itemIds?: (string | null)[] | null }>(client.models.homeWardrobeWear, {
      filter: { personId: { eq: args.personId }, date: { ge: addDaysYmd(date, -14) } },
    }),
  ]);

  const { start, end } = dayBoundsUtc(date, tz);
  let events: SuggestEvent[] = [];
  try {
    const rows = await listAllPages<SuggestEvent & { assignedPersonIds?: (string | null)[] | null }>(
      client.models.homeCalendarEvent,
      { filter: { startAt: { between: [start.toISOString(), new Date(end.getTime() - 1).toISOString()] } } },
    );
    events = rows
      .filter((e) => {
        const ids = (e.assignedPersonIds ?? []).filter(Boolean);
        return ids.length === 0 || ids.includes(args.personId);
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .map((e) => ({ title: e.title, startAt: e.startAt, endAt: e.endAt, isAllDay: e.isAllDay }));
  } catch {
    events = [];
  }

  const weather = await fetchDayWeather(date, tz, DEFAULT_LOCATION, args.fetchImpl);

  return {
    person: { id: person.id, name: person.name },
    styleNotes: profiles[0]?.styleNotes ?? null,
    date,
    timezone: tz,
    items: items.filter(isWearable),
    wishlist: items.filter(isWishlist),
    recentlyWornIds: recentlyWorn(wears, addDaysYmd(date, -3)),
    events,
    weather,
  };
}

// ── Prompt ─────────────────────────────────────────────────────────────────

function itemLine(i: WardrobeItemLike): string {
  const bits = [
    i.category,
    [i.brand, i.name].filter(Boolean).join(" "),
    i.color && `color: ${i.color}${i.colorHex ? ` (${i.colorHex})` : ""}`,
    i.fabric && `fabric: ${i.fabric}`,
    i.fit && `fit: ${i.fit}`,
    i.season && i.season !== "ALL" && `season: ${i.season.toLowerCase()}`,
    i.formality && `formality: ${i.formality.toLowerCase().replace("_", " ")}`,
    i.status === "TAILOR" && "needs tailoring",
    i.lastWornOn && `last worn ${i.lastWornOn}`,
    i.notes && `notes: ${i.notes.slice(0, 140)}`,
  ].filter(Boolean);
  return `- [${i.id}] ${bits.join(" | ")}`;
}

function eventLine(e: SuggestEvent, tz: string): string {
  if (e.isAllDay) return `- All day: ${e.title}`;
  const t = new Date(e.startAt).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return `- ${t}: ${e.title}`;
}

export function buildSuggestPrompt(
  ctx: SuggestContext,
  opts: { occasion?: string | null; request?: string | null; count: number },
): { system: string; user: string } {
  const system = [
    `You are a personal stylist putting together outfits for ${ctx.person.name}, mostly from clothes they already own.`,
    "Rules:",
    "- Use only item ids from the wardrobe and wishlist lists. Never invent items.",
    "- Each outfit is complete for the occasion: a top (or dress), a bottom unless it's a dress, and shoes. Add a layer, outerwear or accessory when the weather or occasion calls for it.",
    "- Dress for the weather: no heavy knits or wool above ~80°F, add a layer below ~60°F, and avoid suede if rain is likely.",
    "- Match formality to the calendar and occasion.",
    "- Golf-category items are for the course: use them only when the occasion, request or calendar involves golf, and then build the look mainly from them.",
    "- Avoid items in the recently-worn list unless nothing else works.",
    "- Make the options genuinely different from each other (different palette or key piece).",
    "- Lean on color harmony: tonal or two-color palettes, with earthy neutrals over high contrast.",
    "- Wishlist items aren't owned yet, but you may put them in itemIds when they make a look clearly better, so the person can see how a new piece would work. Build around at least one owned piece, and keep the other options owned-only unless asked.",
    "- Keep `why` to one or two sentences that name the specific pieces.",
    ctx.styleNotes ? `\nThis person's style brief (follow it):\n${ctx.styleNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `Date: ${ctx.date}`,
    `Weather: ${describeWeather(ctx.weather)}`,
    ctx.events.length ? `Calendar:\n${ctx.events.map((e) => eventLine(e, ctx.timezone)).join("\n")}` : "Calendar: nothing scheduled",
    opts.occasion ? `Occasion: ${opts.occasion}` : "",
    opts.request ? `Request: ${opts.request}` : "",
    ctx.recentlyWornIds.length ? `Recently worn (avoid): ${ctx.recentlyWornIds.join(", ")}` : "",
    `\nWardrobe:\n${ctx.items.map(itemLine).join("\n")}`,
    ctx.wishlist.length ? `\nWishlist (not owned yet):\n${ctx.wishlist.map(itemLine).join("\n")}` : "",
    `\nPropose ${opts.count} outfit${opts.count === 1 ? "" : "s"} with the propose_outfits tool.`,
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

export const PROPOSE_OUTFITS_TOOL: Anthropic.Tool = {
  name: "propose_outfits",
  description: "Return the proposed outfits.",
  input_schema: {
    type: "object",
    properties: {
      outfits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short name, e.g. 'Navy over grey'" },
            palette: { type: "string", description: "e.g. 'Navy + grey'" },
            occasion: { type: "string" },
            itemIds: { type: "array", items: { type: "string" }, description: "Wardrobe item ids; wishlist ids allowed" },
            why: { type: "string" },
          },
          required: ["title", "itemIds", "why"],
        },
      },
    },
    required: ["outfits"],
  },
};

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Drops unknown/duplicate ids and outfits with fewer than two real pieces or
 * no owned piece. Wishlist pieces stay in itemIds and are also listed in
 * wishlistItemIds so callers can flag them as not owned yet.
 */
export function parseSuggestions(raw: unknown, ctx: Pick<SuggestContext, "items" | "wishlist">, count: number): Suggestion[] {
  const owned = new Set(ctx.items.map((i) => i.id));
  const wish = new Set(ctx.wishlist.map((i) => i.id));
  const outfits = (raw as { outfits?: unknown })?.outfits;
  if (!Array.isArray(outfits)) return [];
  const out: Suggestion[] = [];
  for (const o of outfits as Record<string, unknown>[]) {
    const ids = Array.isArray(o.itemIds) ? (o.itemIds as unknown[]).map(String) : [];
    const itemIds = ids.filter((id, n) => (owned.has(id) || wish.has(id)) && ids.indexOf(id) === n);
    if (itemIds.length < 2 || !itemIds.some((id) => owned.has(id))) continue;
    out.push({
      title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : "Outfit",
      palette: typeof o.palette === "string" ? o.palette : null,
      occasion: typeof o.occasion === "string" ? o.occasion : null,
      itemIds,
      why: typeof o.why === "string" ? o.why : null,
      wishlistItemIds: itemIds.filter((id) => wish.has(id)),
    });
    if (out.length >= count) break;
  }
  return out;
}

export function contextLine(ctx: SuggestContext): string {
  const ev = ctx.events.length ? `${ctx.events.length} calendar event${ctx.events.length === 1 ? "" : "s"}` : "nothing on the calendar";
  return `${describeWeather(ctx.weather)}; ${ev}`;
}

// ── Call ───────────────────────────────────────────────────────────────────

export async function suggestOutfits(
  anthropic: Anthropic,
  ctx: SuggestContext,
  opts: { occasion?: string | null; request?: string | null; count?: number | null; model?: string },
): Promise<{ suggestions: Suggestion[]; context: string }> {
  const count = Math.min(Math.max(opts.count ?? 3, 1), MAX_SUGGESTIONS);
  if (ctx.items.length < 2) {
    return { suggestions: [], context: "Add a few items to the wardrobe first." };
  }
  const { system, user } = buildSuggestPrompt(ctx, { occasion: opts.occasion, request: opts.request, count });
  const msg = await anthropic.messages.create({
    model: opts.model ?? SUGGEST_MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: user }],
    tools: [PROPOSE_OUTFITS_TOOL],
    // Sonnet 5.5 rejects forced tool_choice ("tool"/"any") with a 400; the
    // prompt's last line names the tool, so "auto" still lands on it.
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  const suggestions = parseSuggestions(block && "input" in block ? block.input : null, ctx, count);
  return { suggestions, context: contextLine(ctx) };
}
