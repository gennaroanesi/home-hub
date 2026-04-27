// Trip helpers — minimal port of lib/trip.ts on the web side. The
// wall-clock-time convention (auto-memory: feedback_timezone_conventions)
// is the critical detail: leg / reservation times are stored as
// "YYYY-MM-DDTHH:mm:ss.000Z" where the Z is a syntactic placeholder,
// NOT real UTC. Routing those values through `new Date()` re-interprets
// them in the device timezone and prints garbage.
//
// We re-implement parseLegIso / formatLegTime / legIsoToLocalDate here
// rather than importing from the web lib — the web file uses the `@/*`
// path alias and pulls in dayjs, neither of which mobile is set up for.
// Keep this file small enough to keep in sync by hand.

import type { Schema } from "../../amplify/data/resource";

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

export type ReservationType =
  | "HOTEL"
  | "CAR_RENTAL"
  | "TICKET"
  | "TOUR"
  | "RESTAURANT"
  | "ACTIVITY"
  | "OTHER";

export const RESERVATION_EMOJI: Record<ReservationType, string> = {
  HOTEL: "🏨",
  CAR_RENTAL: "🚙",
  TICKET: "🎟️",
  TOUR: "🚌",
  RESTAURANT: "🍽️",
  ACTIVITY: "🎯",
  OTHER: "📌",
};

// ── Wall-clock ISO helpers ─────────────────────────────────────────────────

/** Parse a leg/reservation ISO string into its parts. Null on bad input. */
export function parseLegIso(iso: string | null | undefined):
  | { year: number; month: number; day: number; hour: number; minute: number }
  | null {
  if (!iso) return null;
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

/** "4:22 PM" style display. No Date object involved. */
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
 * the stored wall-clock. We strip the fake Z so JS parses the
 * remaining "YYYY-MM-DDTHH:mm:ss" as local time, which means the
 * resulting Date renders on the device as the same HH:mm that was
 * stored — regardless of the device's actual timezone.
 */
export function legIsoToLocalDate(iso: string | null | undefined): Date | null {
  const p = parseLegIso(iso);
  if (!p) return null;
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
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

// ── Trip date helpers (uses YYYY-MM-DD pure-date strings) ──────────────────

/** "Apr 28" / "Apr 28 – May 2" range from two YYYY-MM-DD strings. */
export function formatTripRange(
  startDate: string,
  endDate: string
): string {
  const s = parseDateOnly(startDate);
  const e = parseDateOnly(endDate);
  if (!s || !e) return `${startDate} – ${endDate}`;
  const sLabel = s.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const eLabel = e.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

// ── Location formatting ────────────────────────────────────────────────────

interface LocationLike {
  city?: string | null;
  country?: string | null;
  airportCode?: string | null;
}

/** "MIA" if airport code, else "Miami, US", else null. */
export function shortLocation(loc: LocationLike | null | undefined): string | null {
  if (!loc) return null;
  if (loc.airportCode) return loc.airportCode;
  if (loc.city && loc.country) return `${loc.city}, ${loc.country}`;
  return loc.city ?? loc.country ?? null;
}
