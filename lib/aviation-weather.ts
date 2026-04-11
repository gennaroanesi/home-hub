// Minimal client for the FAA/NWS aviationweather.gov API.
//
// Fetches METAR (current observations) and TAF (terminal forecasts) for
// airports by ICAO code. No auth, no API key, no rate-limit headaches
// at normal use. Public endpoint, government funded.
//
// Used by:
//   - daily-summary lambda (morning briefing weather section)
//   - agent lambda (Janet's get_weather_briefing tool)
//   - anything in the Next.js app that wants current weather
//
// This module has zero dependencies on the Amplify runtime — pure fetch
// + string parsing so it can be imported from anywhere.
//
// API reference: https://aviationweather.gov/data/api/

const BASE = "https://aviationweather.gov/api/data";

/** Default airport ICAO for the household — baked in, not configurable. */
export const DEFAULT_ICAO = "KAUS";

/** Raw response types from the aviationweather.gov JSON endpoints. */
interface RawMetarResponse {
  icaoId?: string;
  reportTime?: string;
  rawOb?: string;
  temp?: number; // Celsius
  dewp?: number;
  wdir?: number | string;
  wspd?: number;
  wgst?: number;
  visib?: string | number;
  altim?: number; // hPa
  wxString?: string;
  clouds?: { cover?: string; base?: number }[];
  name?: string;
}

interface RawTafResponse {
  icaoId?: string;
  issueTime?: string;
  validTimeFrom?: number;
  validTimeTo?: number;
  rawTAF?: string;
  fcsts?: {
    timeFrom?: number;
    timeTo?: number;
    wdir?: number;
    wspd?: number;
    wgst?: number;
    visib?: string | number;
    wxString?: string;
    clouds?: { cover?: string; base?: number }[];
  }[];
}

// ── Parsed / friendly shapes ────────────────────────────────────────────────

export interface ParsedMetar {
  icao: string;
  observedAt: string | null;
  raw: string;
  tempC: number | null;
  tempF: number | null;
  dewpointC: number | null;
  windDirDeg: number | null;
  windSpeedKt: number | null;
  windGustKt: number | null;
  visibilityMi: number | null;
  altimeterHpa: number | null;
  weather: string | null;
  clouds: { cover: string; baseFt: number | null }[];
  flightRules: "VFR" | "MVFR" | "IFR" | "LIFR" | null;
}

export interface ParsedTaf {
  icao: string;
  issuedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  raw: string;
  periods: {
    from: string | null;
    to: string | null;
    windDirDeg: number | null;
    windSpeedKt: number | null;
    windGustKt: number | null;
    visibilityMi: number | null;
    weather: string | null;
    clouds: { cover: string; baseFt: number | null }[];
  }[];
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch and parse the latest METAR for an airport. Returns null on any
 * failure (unreachable API, unknown ICAO, empty response) — callers
 * should treat it as "weather currently unknown" and proceed.
 */
export async function fetchMetar(icao: string): Promise<ParsedMetar | null> {
  try {
    const url = `${BASE}/metar?ids=${encodeURIComponent(icao)}&format=json&hours=3`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as RawMetarResponse[];
    if (!Array.isArray(data) || data.length === 0) return null;
    return parseMetar(data[0]);
  } catch {
    return null;
  }
}

/**
 * Fetch and parse the latest TAF for an airport. Returns null on any
 * failure.
 */
export async function fetchTaf(icao: string): Promise<ParsedTaf | null> {
  try {
    const url = `${BASE}/taf?ids=${encodeURIComponent(icao)}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as RawTafResponse[];
    if (!Array.isArray(data) || data.length === 0) return null;
    return parseTaf(data[0]);
  } catch {
    return null;
  }
}

/**
 * Fetch METAR and TAF in parallel. Preferred over two separate calls
 * when both are needed (briefings always want both).
 */
export async function fetchAirportWeather(
  icao: string
): Promise<{ metar: ParsedMetar | null; taf: ParsedTaf | null }> {
  const [metar, taf] = await Promise.all([fetchMetar(icao), fetchTaf(icao)]);
  return { metar, taf };
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

function cToF(c: number | null | undefined): number | null {
  if (typeof c !== "number") return null;
  return Math.round((c * 9) / 5 + 32);
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    // Visibility comes as "10+" sometimes; strip trailing junk
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Derive flight rules from ceiling and visibility, per FAA standard:
 *   VFR  — ceiling > 3000 ft AND visibility > 5 sm
 *   MVFR — ceiling 1000-3000 ft OR visibility 3-5 sm
 *   IFR  — ceiling 500-1000 ft OR visibility 1-3 sm
 *   LIFR — ceiling < 500 ft OR visibility < 1 sm
 *
 * Used for the "flying mode" briefing so Janet can lead with "VFR today"
 * instead of making the pilot parse the raw TAF.
 */
function deriveFlightRules(
  visMi: number | null,
  clouds: { cover: string; baseFt: number | null }[]
): ParsedMetar["flightRules"] {
  // Ceiling = lowest BKN or OVC layer. Scattered/few don't count.
  const ceilingFt = clouds
    .filter((c) => c.cover === "BKN" || c.cover === "OVC")
    .map((c) => c.baseFt)
    .filter((b): b is number => typeof b === "number")
    .sort((a, b) => a - b)[0];

  const vis = visMi ?? 10;
  const ceiling = ceilingFt ?? 10000;

  if (ceiling < 500 || vis < 1) return "LIFR";
  if (ceiling < 1000 || vis < 3) return "IFR";
  if (ceiling <= 3000 || vis <= 5) return "MVFR";
  return "VFR";
}

function parseMetar(raw: RawMetarResponse): ParsedMetar {
  const clouds = (raw.clouds ?? []).map((c) => ({
    cover: c.cover ?? "",
    baseFt: typeof c.base === "number" ? c.base : null,
  }));
  const visibilityMi = toNum(raw.visib);
  return {
    icao: raw.icaoId ?? "",
    observedAt: raw.reportTime ?? null,
    raw: raw.rawOb ?? "",
    tempC: toNum(raw.temp),
    tempF: cToF(raw.temp),
    dewpointC: toNum(raw.dewp),
    windDirDeg: toNum(raw.wdir),
    windSpeedKt: toNum(raw.wspd),
    windGustKt: toNum(raw.wgst),
    visibilityMi,
    altimeterHpa: toNum(raw.altim),
    weather: raw.wxString ?? null,
    clouds,
    flightRules: deriveFlightRules(visibilityMi, clouds),
  };
}

/** Convert epoch seconds (as the API gives us) to ISO string. */
function epochToIso(sec: number | undefined): string | null {
  if (typeof sec !== "number") return null;
  return new Date(sec * 1000).toISOString();
}

function parseTaf(raw: RawTafResponse): ParsedTaf {
  return {
    icao: raw.icaoId ?? "",
    issuedAt: raw.issueTime ?? null,
    validFrom: epochToIso(raw.validTimeFrom),
    validTo: epochToIso(raw.validTimeTo),
    raw: raw.rawTAF ?? "",
    periods: (raw.fcsts ?? []).map((f) => ({
      from: epochToIso(f.timeFrom),
      to: epochToIso(f.timeTo),
      windDirDeg: toNum(f.wdir),
      windSpeedKt: toNum(f.wspd),
      windGustKt: toNum(f.wgst),
      visibilityMi: toNum(f.visib),
      weather: f.wxString ?? null,
      clouds: (f.clouds ?? []).map((c) => ({
        cover: c.cover ?? "",
        baseFt: typeof c.base === "number" ? c.base : null,
      })),
    })),
  };
}

// ── Briefing mode selection ─────────────────────────────────────────────────
//
// The morning briefing has two flavors: "plain" (household-friendly weather
// line) and "aviation" (full METAR/TAF + plain-English interpretation for
// a flying day). We pick based on whether there's a flight today or in the
// next 2 days.
//
// Two signals:
//   1. homeTripLeg with mode PERSONAL_FLIGHT and departAt in window
//   2. homeCalendarEvent whose title/description fuzzy-matches "flight"-ish
//      keywords, for users who add flights as calendar events instead of
//      (or in addition to) structured trip legs
//
// This function is pure — callers pre-fetch the trip legs and events and
// pass them in. Keeps the lib free of Amplify runtime deps.

/** Fuzzy regex for detecting flight-related calendar events. */
const FLIGHT_EVENT_REGEX =
  /\b(flight|fly(?:ing)?|pilot|depart(?:ure|ing)?|arrival|boarding|airport|takeoff|taxi)\b/i;

/** Airline names that often appear in event titles without "flight". */
const AIRLINE_REGEX =
  /\b(united|american|delta|southwest|jetblue|alaska|spirit|frontier|hawaiian|british airways|lufthansa|air france|klm|emirates|qatar)\b/i;

/** A flight number like "AA1234", "UA 789", "DL-42". */
const FLIGHT_NUMBER_REGEX = /\b[A-Z]{2}\s?-?\d{1,4}\b/;

/** Minimal shapes for the inputs — callers pass their own model objects. */
export interface FlightTripLeg {
  mode?: string | null;
  departAt?: string | null;
}

export interface FlightCalendarEvent {
  title?: string | null;
  description?: string | null;
  startAt?: string | null;
}

export interface BriefingContext {
  /** All trip legs from homeTripLeg.list(). We'll filter. */
  tripLegs?: FlightTripLeg[];
  /** All upcoming events from homeCalendarEvent.list(). We'll filter. */
  events?: FlightCalendarEvent[];
  /** How many days ahead to scan for flights. Default 2. */
  lookaheadDays?: number;
}

export interface FlyingDetection {
  flying: boolean;
  source?: "trip_leg" | "calendar";
  title?: string;
  when?: string;
}

/**
 * Decide whether the user is flying in the lookahead window based on
 * structured trip legs and fuzzy calendar event matching. Pure function.
 */
export function detectFlyingWindow(ctx: BriefingContext): FlyingDetection {
  const lookaheadDays = ctx.lookaheadDays ?? 2;
  const now = Date.now();
  const windowEnd = now + lookaheadDays * 24 * 60 * 60 * 1000;

  // 1. Structured trip legs — exact match on mode
  //
  // Trip leg departAt stores local wall-clock at the airport with a fake
  // Z suffix (see convention in lib/trip.ts). For the flying-window
  // check we strip the Z and parse the remainder as a naive local
  // instant. This puts the comparison on the same footing as "what
  // calendar day is the flight" without pretending to do real timezone
  // math — the detection is a rough ±half-day lookahead and that's fine.
  for (const leg of ctx.tripLegs ?? []) {
    if (leg.mode !== "PERSONAL_FLIGHT") continue;
    if (!leg.departAt) continue;
    const naive = leg.departAt.replace(/Z$/, "");
    const t = new Date(naive).getTime();
    if (!Number.isFinite(t)) continue;
    if (t >= now && t <= windowEnd) {
      return {
        flying: true,
        source: "trip_leg",
        title: `PERSONAL_FLIGHT leg at ${leg.departAt}`,
        when: leg.departAt,
      };
    }
  }

  // 2. Calendar events — fuzzy keyword match
  for (const evt of ctx.events ?? []) {
    if (!evt.startAt) continue;
    const t = new Date(evt.startAt).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < now || t > windowEnd) continue;

    const haystack = `${evt.title ?? ""} ${evt.description ?? ""}`;
    if (
      FLIGHT_EVENT_REGEX.test(haystack) ||
      AIRLINE_REGEX.test(haystack) ||
      FLIGHT_NUMBER_REGEX.test(haystack)
    ) {
      return {
        flying: true,
        source: "calendar",
        title: evt.title ?? "",
        when: evt.startAt,
      };
    }
  }

  return { flying: false };
}

/**
 * Top-level morning briefing. Fetches METAR + TAF for the airport and
 * decides whether to render in plain or aviation mode. Callers supply
 * the context (trip legs + calendar events) and the ICAO; the function
 * handles everything else.
 */
export async function getMorningWeatherBriefing(
  icao: string,
  ctx: BriefingContext = {}
): Promise<{
  icao: string;
  mode: "plain" | "aviation";
  metar: ParsedMetar | null;
  taf: ParsedTaf | null;
  flyingContext: FlyingDetection;
}> {
  const [{ metar, taf }, flyingContext] = [
    await fetchAirportWeather(icao),
    detectFlyingWindow(ctx),
  ];
  return {
    icao,
    mode: flyingContext.flying ? "aviation" : "plain",
    metar,
    taf,
    flyingContext,
  };
}

// ── Human-readable rendering ────────────────────────────────────────────────

/**
 * Render a METAR as a short plain-English line suitable for a
 * household summary.
 *
 * Example: "82°F, winds 160@12 G18, VFR"
 */
export function renderMetarPlain(m: ParsedMetar): string {
  const parts: string[] = [];
  if (m.tempF !== null) parts.push(`${m.tempF}°F`);
  if (m.windSpeedKt !== null && m.windSpeedKt > 0) {
    let wind = `winds ${String(m.windDirDeg ?? "VRB").padStart(3, "0")}@${m.windSpeedKt}`;
    if (m.windGustKt !== null) wind += ` G${m.windGustKt}`;
    parts.push(wind);
  }
  if (m.weather) parts.push(m.weather);
  if (m.flightRules) parts.push(m.flightRules);
  return parts.join(", ");
}

/**
 * Render a pilot-friendly multi-line briefing from METAR + TAF.
 * Used in aviation mode only.
 */
export function renderAviationBriefing(
  metar: ParsedMetar | null,
  taf: ParsedTaf | null
): string {
  const lines: string[] = [];
  if (metar) {
    lines.push(`*${metar.icao} METAR*`);
    lines.push(metar.raw);
  }
  if (taf) {
    lines.push(`*${taf.icao} TAF*`);
    lines.push(taf.raw);
  }
  return lines.join("\n");
}
