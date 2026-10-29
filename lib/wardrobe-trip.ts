// Trip looks: what to pack for a trip and which outfit to wear for each day
// and activity. Backs the planTripOutfits mutation (wardrobe-suggest
// Lambda) and the Trips tab on /wardrobe.
//
// Flow: loadTripPlanContext() pulls the trip, its reservations, one
// person's owned wardrobe and style brief, and the weather at the
// destination for every trip day (the live forecast when the day is within
// Open-Meteo's 16-day window, otherwise the same dates averaged over the
// last few years). planTripOutfits() hands that to Claude with the
// propose_trip_plan tool and validates the answer against real item ids.

import type Anthropic from "@anthropic-ai/sdk";
import { addDaysYmd, isWearable, ymdInTz, type WardrobeItemLike } from "./wardrobe";
import { listAllPages } from "./list-all";
import { getHouseholdTimezone } from "./household-settings";
import { SUGGEST_MODEL, fetchDayWeather, type DayWeather } from "./wardrobe-suggest";

export const TRIP_CAPACITIES = ["CARRY_ON", "CHECKED", "PIECES"] as const;
export type TripCapacity = (typeof TRIP_CAPACITIES)[number];
export const TRIP_CAPACITY_LABELS: Record<TripCapacity, string> = {
  CARRY_ON: "Carry-on",
  CHECKED: "Checked bag",
  PIECES: "Set number of pieces",
};

// Open-Meteo forecasts 16 days including today.
export const FORECAST_DAYS = 16;
// Years of history averaged for days beyond the forecast window.
export const HISTORY_YEARS = 3;
// Longest trip we plan day by day; longer trips repeat looks anyway.
export const MAX_TRIP_DAYS = 21;

export interface TripActivity {
  date?: string | null; // YYYY-MM-DD, or none for "some time during the trip"
  text: string;
}

export interface TripDayWeather extends DayWeather {
  date: string;
  source: "FORECAST" | "TYPICAL";
}

export interface TripLook {
  date: string | null;
  title: string;
  occasion: string | null;
  itemIds: string[];
  why: string | null;
}

export interface TripPlan {
  packItemIds: string[];
  looks: TripLook[];
  tips: string | null;
}

export interface TripLocation {
  latitude: number;
  longitude: number;
  label: string;
  timezone?: string | null;
}

export interface TripPlanContext {
  person: { id: string; name: string };
  styleNotes: string | null;
  trip: { id: string; name: string; type: string | null; startDate: string; endDate: string; notes: string | null };
  location: TripLocation | null;
  dates: string[];
  weather: TripDayWeather[];
  reservations: { type: string | null; name: string; date: string | null; time: string | null }[];
  items: WardrobeItemLike[]; // owned and wearable only
}

export interface TripPlanOptions {
  capacity: TripCapacity;
  maxPieces?: number | null;
  activities: TripActivity[];
  request?: string | null;
}

// ── Dates ──────────────────────────────────────────────────────────────────

/** Every YYYY-MM-DD from start to end inclusive, capped at MAX_TRIP_DAYS. */
export function tripDates(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < MAX_TRIP_DAYS; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

/** The same calendar day `yearsBack` years earlier; Feb 29 maps to Feb 28. */
export function sameDayYearsAgo(ymd: string, yearsBack: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const year = y - yearsBack;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m === 2 && d === 29 && !leap ? 28 : d;
  return `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ── Weather ────────────────────────────────────────────────────────────────

interface ArchiveDaily {
  time?: string[];
  temperature_2m_max?: (number | null)[];
  temperature_2m_min?: (number | null)[];
  precipitation_sum?: (number | null)[];
}

/**
 * Averages past years into one "typical" day per trip date. `years[n]` is
 * the archive response for the trip dates shifted back n+1 years, so index
 * i in each lines up with dates[i]. Rain chance is the share of those years
 * with at least 1 mm of rain that day.
 */
export function typicalWeather(dates: string[], years: ArchiveDaily[]): TripDayWeather[] {
  const out: TripDayWeather[] = [];
  dates.forEach((date, i) => {
    const hi: number[] = [];
    const lo: number[] = [];
    let wet = 0;
    let seen = 0;
    for (const y of years) {
      const h = y.temperature_2m_max?.[i];
      const l = y.temperature_2m_min?.[i];
      if (h == null || l == null) continue;
      hi.push(h);
      lo.push(l);
      seen++;
      if ((y.precipitation_sum?.[i] ?? 0) >= 1) wet++;
    }
    if (!seen) return;
    const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    const precipChance = Math.round((wet / seen) * 100);
    out.push({
      date,
      source: "TYPICAL",
      highF: avg(hi),
      lowF: avg(lo),
      precipChance,
      summary: precipChance >= 50 ? "Often rainy" : precipChance >= 25 ? "Some rainy days" : "Usually dry",
    });
  });
  return out;
}

async function fetchArchive(
  loc: TripLocation,
  start: string,
  end: string,
  tz: string,
  fetchImpl: typeof fetch,
): Promise<ArchiveDaily | null> {
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude", String(loc.latitude));
  url.searchParams.set("longitude", String(loc.longitude));
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", tz);
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);
  try {
    const res = await fetchImpl(url.href, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return ((await res.json()) as { daily?: ArchiveDaily }).daily ?? null;
  } catch {
    return null;
  }
}

/**
 * Weather for each trip date: the forecast for days inside the 16-day
 * window, the multi-year average for the rest (and for any forecast day
 * that comes back empty).
 */
export async function fetchTripWeather(
  dates: string[],
  loc: TripLocation,
  today: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TripDayWeather[]> {
  if (!dates.length) return [];
  const tz = loc.timezone || "auto";
  const lastForecast = addDaysYmd(today, FORECAST_DAYS - 1);
  const byDate = new Map<string, TripDayWeather>();

  const forecastDays = dates.filter((d) => d >= today && d <= lastForecast);
  const forecasts = await Promise.all(forecastDays.map((d) => fetchDayWeather(d, tz, loc, fetchImpl)));
  forecastDays.forEach((d, i) => {
    const w = forecasts[i];
    if (w) byDate.set(d, { ...w, date: d, source: "FORECAST" });
  });

  const rest = dates.filter((d) => !byDate.has(d));
  if (rest.length) {
    // One archive call per past year covering the whole trip span, then
    // pick out the days that still need weather.
    const first = dates[0];
    const last = dates[dates.length - 1];
    const years = await Promise.all(
      Array.from({ length: HISTORY_YEARS }, (_, n) =>
        fetchArchive(loc, sameDayYearsAgo(first, n + 1), sameDayYearsAgo(last, n + 1), tz, fetchImpl),
      ),
    );
    const typical = typicalWeather(dates, years.filter((y): y is ArchiveDaily => !!y));
    for (const t of typical) if (!byDate.has(t.date)) byDate.set(t.date, t);
  }
  return dates.map((d) => byDate.get(d)).filter((w): w is TripDayWeather => !!w);
}

export function describeTripDay(w: TripDayWeather): string {
  const rain = w.precipChance != null && w.precipChance >= 25 ? `, ${w.precipChance}% rain` : "";
  const src = w.source === "TYPICAL" ? " (typical for the date)" : "";
  return `${w.summary}, ${w.highF}°F / ${w.lowF}°F${rain}${src}`;
}

// ── Context ────────────────────────────────────────────────────────────────

type Loc = { city?: string | null; country?: string | null; latitude?: number | null; longitude?: number | null; timezone?: string | null } | null | undefined;

function toTripLocation(l: Loc): TripLocation | null {
  if (l?.latitude == null || l.longitude == null) return null;
  return {
    latitude: l.latitude,
    longitude: l.longitude,
    // City often already ends with the country ("Seattle, United States").
    label:
      (l.city && l.country && l.city.includes(l.country) ? l.city : [l.city, l.country].filter(Boolean).join(", ")) ||
      "Destination",
    timezone: l.timezone ?? null,
  };
}

/**
 * Where to look up weather: the trip's destination, else the first hotel,
 * else where the first leg lands.
 */
export function resolveTripLocation(
  trip: { destination?: Loc },
  reservations: { type?: string | null; location?: Loc; startAt?: string | null }[],
  legs: { toLocation?: Loc; departAt?: string | null; sortOrder?: number | null }[],
): TripLocation | null {
  const dest = toTripLocation(trip.destination);
  if (dest) return dest;
  const hotel = reservations
    .filter((r) => r.type === "HOTEL")
    .sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""))
    .map((r) => toTripLocation(r.location))
    .find(Boolean);
  if (hotel) return hotel;
  return (
    legs
      .slice()
      .sort((a, b) => (a.departAt ?? "").localeCompare(b.departAt ?? "") || (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((l) => toTripLocation(l.toLocation))
      .find(Boolean) ?? null
  );
}

/**
 * Loads everything the trip planner needs. `client` is an Amplify data
 * client (typed `any` for the same reason as lib/wardrobe-suggest.ts).
 */
export async function loadTripPlanContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  args: { tripId: string; personId: string; fetchImpl?: typeof fetch },
): Promise<TripPlanContext> {
  const { data: trip } = await client.models.homeTrip.get({ id: args.tripId });
  if (!trip) throw new Error("Trip not found");
  const { data: person } = await client.models.homePerson.get({ id: args.personId });
  if (!person) throw new Error("Person not found");

  const [profiles, items, reservations, legs, tz] = await Promise.all([
    listAllPages<{ personId: string; styleNotes?: string | null }>(client.models.homeWardrobeProfile, {
      filter: { personId: { eq: args.personId } },
    }),
    listAllPages<WardrobeItemLike & { ownerPersonId: string }>(client.models.homeWardrobeItem, {
      filter: { ownerPersonId: { eq: args.personId } },
    }),
    listAllPages<{ type?: string | null; name: string; startAt?: string | null; location?: Loc }>(
      client.models.homeTripReservation,
      { filter: { tripId: { eq: args.tripId } } },
    ),
    listAllPages<{ toLocation?: Loc; departAt?: string | null; sortOrder?: number | null }>(client.models.homeTripLeg, {
      filter: { tripId: { eq: args.tripId } },
    }),
    getHouseholdTimezone(client),
  ]);

  const dates = tripDates(trip.startDate, trip.endDate);
  const location = resolveTripLocation(trip, reservations, legs);
  const today = ymdInTz(new Date(), tz);
  const weather = location ? await fetchTripWeather(dates, location, today, args.fetchImpl) : [];

  return {
    person: { id: person.id, name: person.name },
    styleNotes: profiles[0]?.styleNotes ?? null,
    trip: {
      id: trip.id,
      name: trip.name,
      type: trip.type ?? null,
      startDate: trip.startDate,
      endDate: trip.endDate,
      notes: trip.notes ?? null,
    },
    location,
    dates,
    weather,
    // Reservation times are local wall-clock with a placeholder "Z" (see
    // homeTripReservation in the schema), so slice the string, don't parse it.
    reservations: reservations
      .filter((r) => r.type !== "CAR_RENTAL")
      .sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""))
      .map((r) => ({
        type: r.type ?? null,
        name: r.name,
        date: r.startAt?.slice(0, 10) ?? null,
        time: r.startAt && r.type !== "HOTEL" ? r.startAt.slice(11, 16) : null,
      })),
    items: items.filter(isWearable),
  };
}

// ── Prompt ─────────────────────────────────────────────────────────────────

export function capacityRule(capacity: TripCapacity, maxPieces?: number | null): string {
  switch (capacity) {
    case "CARRY_ON":
      return "Carry-on only: pack light, about 10–14 pieces in total, at most 2 pairs of shoes in the bag. The travel-day outfit is worn, so it doesn't take bag space, but it still counts toward the looks.";
    case "CHECKED":
      return "Checked bag: room for a fuller wardrobe, up to about 25 pieces and 4 pairs of shoes. Still favour pieces that mix across several looks.";
    case "PIECES":
      return `Hard limit: pack at most ${Math.max(1, maxPieces ?? 12)} pieces in total, counting every garment, pair of shoes and accessory, including what's worn on the travel day.`;
  }
}

function itemLine(i: WardrobeItemLike): string {
  const bits = [
    i.category,
    [i.brand, i.name].filter(Boolean).join(" "),
    i.color && `color: ${i.color}`,
    i.fabric && `fabric: ${i.fabric}`,
    i.season && i.season !== "ALL" && `season: ${i.season.toLowerCase()}`,
    i.formality && `formality: ${i.formality.toLowerCase().replace("_", " ")}`,
    i.notes && `notes: ${i.notes.slice(0, 100)}`,
  ].filter(Boolean);
  return `- [${i.id}] ${bits.join(" | ")}`;
}

export function buildTripPrompt(ctx: TripPlanContext, opts: TripPlanOptions): { system: string; user: string } {
  const system = [
    `You are a personal stylist packing for ${ctx.person.name}'s trip, using only clothes they own.`,
    "Rules:",
    "- Use only item ids from the wardrobe list. Never invent items.",
    "- First pick a compact capsule to pack (packItemIds), then build the looks only from that capsule.",
    "- Plan one look per day (date set), plus a separate look for each activity or reservation that needs different clothes (dinner out, golf, a wedding, a hike). The first day's look is what's worn while travelling: comfortable, with the bulkiest shoes and outerwear.",
    "- Every look is complete: a top, a bottom and shoes, plus a layer or outerwear when the weather calls for it.",
    "- Dress for each day's weather: no heavy wool above ~80°F, a layer below ~60°F, rain-proof shoes and outerwear when rain is likely.",
    "- Maximise reuse: each bottom, shoe and layer should appear in several looks. Repeat looks rather than over-pack.",
    "- Match formality to the activity and the trip type.",
    "- Golf-category items are only for golf.",
    "- Respect the luggage limit.",
    "- `why` is one sentence naming the pieces. `tips` is two or three short sentences: what to wear on the plane, anything missing from the closet that the trip needs, and what to leave at home.",
    ctx.styleNotes ? `\nThis person's style brief (follow it):\n${ctx.styleNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const weatherByDate = new Map(ctx.weather.map((w) => [w.date, w]));
  const days = ctx.dates.map((d) => {
    const w = weatherByDate.get(d);
    return `- ${d}: ${w ? describeTripDay(w) : "weather unknown"}`;
  });
  const activities = opts.activities.filter((a) => a.text.trim());
  const user = [
    `Trip: ${ctx.trip.name}${ctx.trip.type ? ` (${ctx.trip.type.toLowerCase()})` : ""}, ${ctx.trip.startDate} to ${ctx.trip.endDate}`,
    ctx.location ? `Destination: ${ctx.location.label}` : "Destination: unknown",
    ctx.trip.notes ? `Trip notes: ${ctx.trip.notes.slice(0, 400)}` : "",
    `Luggage: ${capacityRule(opts.capacity, opts.maxPieces)}`,
    `\nDays and weather:\n${days.join("\n")}`,
    activities.length
      ? `\nActivities:\n${activities.map((a) => `- ${a.date ? `${a.date}: ` : "Some day: "}${a.text.trim()}`).join("\n")}`
      : "",
    ctx.reservations.length
      ? `\nReservations:\n${ctx.reservations
          .map((r) => `- ${r.date ?? "?"}${r.time ? ` ${r.time}` : ""}: ${r.type ? `${r.type.toLowerCase()} ` : ""}${r.name}`)
          .join("\n")}`
      : "",
    opts.request?.trim() ? `\nRequest: ${opts.request.trim()}` : "",
    `\nWardrobe:\n${ctx.items.map(itemLine).join("\n")}`,
    "\nPlan the trip with the propose_trip_plan tool.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

export const PROPOSE_TRIP_PLAN_TOOL: Anthropic.Tool = {
  name: "propose_trip_plan",
  description: "Return the packing list and the looks for the trip.",
  input_schema: {
    type: "object",
    properties: {
      packItemIds: { type: "array", items: { type: "string" }, description: "Every wardrobe item id to pack or wear on the way" },
      looks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD, or empty for a look not tied to a day" },
            title: { type: "string", description: "Short name, e.g. 'Travel day' or 'Dinner in the old town'" },
            occasion: { type: "string" },
            itemIds: { type: "array", items: { type: "string" } },
            why: { type: "string" },
          },
          required: ["title", "itemIds"],
        },
      },
      tips: { type: "string" },
    },
    required: ["packItemIds", "looks"],
  },
};

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Keeps only owned item ids, drops looks with fewer than two real pieces,
 * and makes sure everything a look uses is on the packing list.
 */
export function parseTripPlan(raw: unknown, ctx: Pick<TripPlanContext, "items" | "dates">): TripPlan {
  const owned = new Set(ctx.items.map((i) => i.id));
  const days = new Set(ctx.dates);
  const r = (raw ?? {}) as { packItemIds?: unknown; looks?: unknown; tips?: unknown };
  const ids = (v: unknown) => {
    const list = Array.isArray(v) ? v.map(String) : [];
    return list.filter((id, n) => owned.has(id) && list.indexOf(id) === n);
  };

  const looks: TripLook[] = [];
  for (const l of (Array.isArray(r.looks) ? r.looks : []) as Record<string, unknown>[]) {
    const itemIds = ids(l.itemIds);
    if (itemIds.length < 2) continue;
    const date = typeof l.date === "string" && days.has(l.date) ? l.date : null;
    looks.push({
      date,
      title: typeof l.title === "string" && l.title.trim() ? l.title.trim() : "Look",
      occasion: typeof l.occasion === "string" && l.occasion.trim() ? l.occasion.trim() : null,
      itemIds,
      why: typeof l.why === "string" ? l.why : null,
    });
  }
  // Day looks in date order, undated ones last; stable otherwise.
  looks.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

  const pack = ids(r.packItemIds);
  for (const l of looks) for (const id of l.itemIds) if (!pack.includes(id)) pack.push(id);

  return {
    packItemIds: pack,
    looks,
    tips: typeof r.tips === "string" && r.tips.trim() ? r.tips.trim() : null,
  };
}

export function tripContextLine(ctx: TripPlanContext): string {
  const where = ctx.location?.label ?? "unknown destination";
  if (!ctx.weather.length) return `${where}; weather unavailable`;
  const hi = Math.max(...ctx.weather.map((w) => w.highF));
  const lo = Math.min(...ctx.weather.map((w) => w.lowF));
  const typical = ctx.weather.some((w) => w.source === "TYPICAL");
  return `${where}; ${lo}–${hi}°F${typical ? " (some days from past years' averages)" : ""}`;
}

// ── Call ───────────────────────────────────────────────────────────────────

export async function planTripOutfits(
  anthropic: Anthropic,
  ctx: TripPlanContext,
  opts: TripPlanOptions & { model?: string },
): Promise<{ plan: TripPlan; context: string }> {
  if (ctx.items.length < 3) {
    return { plan: { packItemIds: [], looks: [], tips: null }, context: "Add more items to the wardrobe first." };
  }
  const { system, user } = buildTripPrompt(ctx, opts);
  const msg = await anthropic.messages.create({
    model: opts.model ?? SUGGEST_MODEL,
    max_tokens: 6000,
    system,
    messages: [{ role: "user", content: user }],
    tools: [PROPOSE_TRIP_PLAN_TOOL],
    // Same as the outfit suggester: Sonnet 5.5 rejects forced tool_choice,
    // and the prompt's last line names the tool.
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  const plan = parseTripPlan(block && "input" in block ? block.input : null, ctx);
  return { plan, context: tripContextLine(ctx) };
}

/** Tolerates the AWSJSON round trip: a JSON string or the parsed value. */
export function parseJsonField<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}
