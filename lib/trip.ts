// Shared trip types, constants, and helpers — single source of truth for
// both the web (/trips, calendar trip modal, components/trip-form) and
// the mobile trips screens. mobile/lib/trip.ts is a thin re-export so
// the two surfaces never drift.
//
// Keep this file dependency-free beyond the Amplify Schema type import:
// no dayjs, no Next-only path aliases, nothing that wouldn't bundle on
// React Native. If you reach for a date library here, do it in a
// platform-specific helper file instead and let this file stay portable.

import type { Schema } from "../amplify/data/resource";

export type Trip = Schema["homeTrip"]["type"];
export type TripLeg = Schema["homeTripLeg"]["type"];
export type TripReservation = Schema["homeTripReservation"]["type"];

export type TripType = "LEISURE" | "WORK" | "FLYING" | "FAMILY";

export const TRIP_TYPE_CONFIG: Record<TripType, { label: string; color: string }> = {
  LEISURE: { label: "Leisure", color: "#DEBA02" },
  WORK: { label: "Work", color: "#587D71" },
  FLYING: { label: "Flying", color: "#60A5FA" },
  FAMILY: { label: "Family", color: "#EC4899" },
};

export type LegMode =
  | "COMMERCIAL_FLIGHT"
  | "PERSONAL_FLIGHT"
  | "CAR"
  | "TRAIN"
  | "BUS"
  | "BOAT"
  | "OTHER";

export const LEG_MODE_LABEL: Record<LegMode, string> = {
  COMMERCIAL_FLIGHT: "Commercial flight",
  PERSONAL_FLIGHT: "Personal flight",
  CAR: "Car",
  TRAIN: "Train",
  BUS: "Bus",
  BOAT: "Boat",
  OTHER: "Other",
};

export const LEG_MODE_EMOJI: Record<LegMode, string> = {
  COMMERCIAL_FLIGHT: "✈️",
  PERSONAL_FLIGHT: "🛩️",
  CAR: "🚗",
  TRAIN: "🚆",
  BUS: "🚌",
  BOAT: "⛵",
  OTHER: "📍",
};

// Form-side leg shape (id is empty for new legs that haven't been saved yet)
export interface LegFormRow {
  id: string;
  mode: LegMode;
  departAt: string; // datetime-local string
  arriveAt: string;
  fromCity: string;
  toCity: string;
  // Optional airport codes — only exposed in the UI for flight modes,
  // but the field lives on the leg's from/to location regardless.
  fromAirport: string;
  toAirport: string;
  // IANA timezones for the endpoints, populated automatically when the
  // user picks a city via CityAutocomplete (lat/lon → tz-lookup). Used
  // for labeling depart/arrive inputs and, in the future, for any
  // computation that needs the local TZ. Null when no city was ever
  // picked (e.g. a leg imported without location data).
  fromLatitude?: number | null;
  fromLongitude?: number | null;
  fromTimezone?: string | null;
  toLatitude?: number | null;
  toLongitude?: number | null;
  toTimezone?: string | null;
  airline: string;
  flightNumber: string;
  aircraft: string;
  confirmationCode: string;
  url: string;
  notes: string;
  sortOrder: number;
}

// ── Reservations ────────────────────────────────────────────────────────
export type ReservationType =
  | "HOTEL"
  | "CAR_RENTAL"
  | "TICKET"
  | "TOUR"
  | "RESTAURANT"
  | "ACTIVITY"
  | "OTHER";

export const RESERVATION_TYPE_LABEL: Record<ReservationType, string> = {
  HOTEL: "Hotel",
  CAR_RENTAL: "Car rental",
  TICKET: "Ticket",
  TOUR: "Tour",
  RESTAURANT: "Restaurant",
  ACTIVITY: "Activity",
  OTHER: "Other",
};

export const RESERVATION_TYPE_EMOJI: Record<ReservationType, string> = {
  HOTEL: "🏨",
  CAR_RENTAL: "🚗",
  TICKET: "🎫",
  TOUR: "🗺️",
  RESTAURANT: "🍽️",
  ACTIVITY: "🎯",
  OTHER: "📌",
};
// Alias under the shorter name mobile uses. Both names point at the
// same map so renaming on either side stays a no-op.
export const RESERVATION_EMOJI = RESERVATION_TYPE_EMOJI;

// Form-side reservation shape (id empty = not yet saved)
export interface ReservationFormRow {
  id: string;
  type: ReservationType;
  name: string;
  startAt: string; // datetime-local string — SAME local-wall-clock rule as legs
  endAt: string;
  city: string;
  country: string;
  // IANA timezone for the reservation's location, populated from
  // CityAutocomplete the same way legs' fromTimezone/toTimezone are.
  // Null when no city was picked.
  latitude?: number | null;
  longitude?: number | null;
  timezone?: string | null;
  confirmationCode: string;
  url: string;
  cost: string; // kept as string in the form, parsed on save
  currency: string;
  notes: string;
  sortOrder: number;
}

export function emptyReservation(sortOrder: number): ReservationFormRow {
  return {
    id: "",
    type: "HOTEL",
    name: "",
    startAt: "",
    endAt: "",
    city: "",
    country: "",
    confirmationCode: "",
    url: "",
    cost: "",
    currency: "",
    notes: "",
    sortOrder,
  };
}

export function reservationToFormRow(r: TripReservation): ReservationFormRow {
  const loc = (r.location ?? {}) as any;
  return {
    id: r.id,
    type: (r.type ?? "HOTEL") as ReservationType,
    name: r.name ?? "",
    // Same slice-first-16-chars trick as legs — never run through new Date().
    // See the convention note further down in this file.
    startAt: r.startAt ? r.startAt.slice(0, 16) : "",
    endAt: r.endAt ? r.endAt.slice(0, 16) : "",
    city: loc.city ?? "",
    country: loc.country ?? "",
    latitude: loc.latitude ?? null,
    longitude: loc.longitude ?? null,
    timezone: loc.timezone ?? null,
    confirmationCode: r.confirmationCode ?? "",
    url: r.url ?? "",
    cost: r.cost != null ? String(r.cost) : "",
    currency: r.currency ?? "",
    notes: r.notes ?? "",
    sortOrder: r.sortOrder ?? 0,
  };
}

export interface TripFormState {
  id: string; // empty = new
  name: string;
  type: TripType;
  startDate: string;
  endDate: string;
  destination: string;
  destinationLat: number | null;
  destinationLon: number | null;
  destinationCountry: string;
  notes: string;
  participantIds: string[];
  legs: LegFormRow[];
  reservations: ReservationFormRow[];
}

export function emptyLeg(sortOrder: number): LegFormRow {
  return {
    id: "",
    mode: "COMMERCIAL_FLIGHT",
    departAt: "",
    arriveAt: "",
    fromCity: "",
    toCity: "",
    fromAirport: "",
    toAirport: "",
    airline: "",
    flightNumber: "",
    aircraft: "",
    confirmationCode: "",
    url: "",
    notes: "",
    sortOrder,
  };
}

export function legToFormRow(leg: TripLeg): LegFormRow {
  const from = (leg.fromLocation ?? {}) as any;
  const to = (leg.toLocation ?? {}) as any;
  return {
    id: leg.id,
    mode: (leg.mode ?? "COMMERCIAL_FLIGHT") as LegMode,
    // Trip leg times store local wall-clock at the airport in an ISO
    // string with a fake Z suffix. Direct-slice the first 16 chars
    // ("YYYY-MM-DDTHH:mm") so we never run the value through a Date
    // object — see the convention note in components/trip-form.tsx.
    departAt: leg.departAt ? leg.departAt.slice(0, 16) : "",
    arriveAt: leg.arriveAt ? leg.arriveAt.slice(0, 16) : "",
    fromCity: from.city ?? "",
    toCity: to.city ?? "",
    fromAirport: from.airportCode ?? "",
    toAirport: to.airportCode ?? "",
    fromLatitude: from.latitude ?? null,
    fromLongitude: from.longitude ?? null,
    fromTimezone: from.timezone ?? null,
    toLatitude: to.latitude ?? null,
    toLongitude: to.longitude ?? null,
    toTimezone: to.timezone ?? null,
    airline: leg.airline ?? "",
    flightNumber: leg.flightNumber ?? "",
    aircraft: leg.aircraft ?? "",
    confirmationCode: leg.confirmationCode ?? "",
    url: leg.url ?? "",
    notes: leg.notes ?? "",
    sortOrder: leg.sortOrder ?? 0,
  };
}

export function newTripFormState(): TripFormState {
  // Plain "YYYY-MM-DD" in the local timezone. The Date constructor's
  // toISOString would shift to UTC and could land us a day off.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(now.getDate()).padStart(2, "0")}`;
  return {
    id: "",
    name: "",
    type: "LEISURE",
    startDate: today,
    endDate: today,
    destination: "",
    destinationLat: null,
    destinationLon: null,
    destinationCountry: "",
    notes: "",
    participantIds: [],
    legs: [],
    reservations: [],
  };
}

// ── Trip leg time helpers ───────────────────────────────────────────────
//
// CONVENTION: homeTripLeg.departAt / arriveAt store the local wall-clock
// time AT THE RESPECTIVE AIRPORT as an ISO 8601 string with a "Z" suffix.
// The Z is a syntactic placeholder required by the AWSDateTime scalar —
// it does NOT mean UTC. A 4:22 PM departure from Austin is stored as
// "2026-07-02T16:22:00.000Z" regardless of where the user entering it is
// physically located. No timezone math is ever performed on these fields.
//
// These helpers parse the string directly instead of routing through a
// Date object, because JS Date would re-interpret the string in the
// viewer's browser timezone and display garbage.

/** Parse a leg ISO string into its parts. Returns null for empty/invalid. */
export function parseLegIso(iso: string | null | undefined):
  | { year: number; month: number; day: number; hour: number; minute: number }
  | null {
  if (!iso) return null;
  // Expected shape: YYYY-MM-DDTHH:mm[:ss[.sss]][Z]
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
}

/** "4:22 PM" style display from a leg ISO string. No Date object involved. */
export function formatLegTime(iso: string | null | undefined): string {
  const p = parseLegIso(iso);
  if (!p) return "";
  const ampm = p.hour >= 12 ? "PM" : "AM";
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const mm = p.minute.toString().padStart(2, "0");
  return `${h12}:${mm} ${ampm}`;
}

/**
 * Convert a leg ISO string to a JS Date whose local wall-clock matches
 * the stored wall-clock. Used by anything that needs a Date object for
 * positioning (e.g. react-big-calendar). We strip the fake Z so JS parses
 * the remaining "YYYY-MM-DDTHH:mm:ss" as local time, which means the
 * resulting Date renders in the viewer's browser as the same HH:mm that
 * was stored — regardless of the viewer's actual timezone.
 */
export function legIsoToLocalDate(iso: string | null | undefined): Date | null {
  const p = parseLegIso(iso);
  if (!p) return null;
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
}

// ── Trip date helpers (uses YYYY-MM-DD pure-date strings) ──────────────────

/** "Apr 28" / "Apr 28 – May 2" range from two YYYY-MM-DD strings. */
export function formatTripRange(
  startDate: string,
  endDate: string
): string {
  const s = parseDateOnly(startDate);
  const e = parseDateOnly(endDate);
  if (!s || !e) return `${startDate} – ${endDate}`;
  const sLabel = s.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const eLabel = e.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  if (sLabel === eLabel) return sLabel;
  return `${sLabel} – ${eLabel}`;
}

function parseDateOnly(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** True if the trip ends on or after today (i.e. still ongoing or future). */
export function isUpcomingOrOngoing(trip: Trip): boolean {
  const end = parseDateOnly(trip.endDate);
  if (!end) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return end.getTime() >= today.getTime();
}

/** "Tue Apr 28" — short date label from a wall-clock leg ISO. */
export function formatLegDateShort(iso: string | null | undefined): string {
  const d = legIsoToLocalDate(iso);
  if (!d) return "";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// ── Location formatting ────────────────────────────────────────────────────

interface LocationLike {
  city?: string | null;
  country?: string | null;
  airportCode?: string | null;
}

/** "MIA" if airport code, else "Miami, US", else null. */
export function shortLocation(
  loc: LocationLike | null | undefined
): string | null {
  if (!loc) return null;
  if (loc.airportCode) return loc.airportCode;
  if (loc.city && loc.country) return `${loc.city}, ${loc.country}`;
  return loc.city ?? loc.country ?? null;
}

export function tripToFormState(
  trip: Trip,
  allLegs: TripLeg[],
  allReservations: TripReservation[] = []
): TripFormState {
  const dest = (trip.destination ?? {}) as any;
  const tripLegs = allLegs
    .filter((l) => l.tripId === trip.id)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(legToFormRow);
  const tripReservations = allReservations
    .filter((r) => r.tripId === trip.id)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(reservationToFormRow);
  return {
    id: trip.id,
    name: trip.name,
    type: (trip.type ?? "LEISURE") as TripType,
    startDate: trip.startDate,
    endDate: trip.endDate,
    destination: dest.city ?? "",
    destinationLat: dest.latitude ?? null,
    destinationLon: dest.longitude ?? null,
    destinationCountry: dest.country ?? "",
    notes: trip.notes ?? "",
    participantIds: (trip.participantIds ?? []).filter((id): id is string => !!id),
    legs: tripLegs,
    reservations: tripReservations,
  };
}
