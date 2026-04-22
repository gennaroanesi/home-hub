// Shared reminder scheduling logic. Pure TypeScript — no Amplify or React
// dependencies — so it can be imported from Lambdas, API routes, and
// client components alike, and unit-tested without mocks.
//
// All functions here are pure: given the same inputs they produce the
// same outputs with no I/O. The one runtime import is `rrule`, which is
// a deterministic library.
//
// This module consolidates logic that was previously duplicated in:
//   - amplify/functions/reminder-sweep/handler.ts
//   - amplify/functions/daily-summary/handler.ts
//   - amplify/functions/agent/handler.ts
//   - pages/reminders.tsx
//   - components/schedule-picker.tsx

import { RRule } from "rrule";

// ── Timezone handling ──────────────────────────────────────────────────────
// The picker stores user-entered times as bare BYHOUR/BYMINUTE values with
// no DTSTART or TZID. rrule.js interprets these as UTC by default, which
// means a user typing "9 AM" gets a reminder at 9 AM UTC — 4 AM Central
// during CDT. To respect household-local time without plumbing DTSTART
// through the picker + lambdas, we shift iteration into a "naive UTC"
// frame (UTC fields = local wall-clock values), let rrule iterate there,
// and shift the result back to real UTC. Single-household app, single
// timezone — no config surface needed.
//
// If an RRULE already has `DTSTART;TZID=...` we trust it and skip the
// shim (future-proofing for manual advanced rules).

/** Household timezone. All picker-entered BYHOUR values are interpreted here. */
const HOUSEHOLD_TZ = "America/Chicago";

/**
 * Convert a real UTC Date to a "naive" Date whose UTC fields represent
 * the corresponding wall-clock time in the given TZ.
 *
 *   toNaive(2026-04-22T08:00Z, "America/Chicago") → 2026-04-22T03:00Z
 *   (3 AM CDT, encoded as if UTC)
 */
function toNaive(utc: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utc);
  const pick = (t: string) => parts.find((p) => p.type === t)!.value;
  const y = parseInt(pick("year"), 10);
  const mo = parseInt(pick("month"), 10);
  const d = parseInt(pick("day"), 10);
  let h = parseInt(pick("hour"), 10);
  if (h === 24) h = 0; // some locales return 24 for midnight
  const mi = parseInt(pick("minute"), 10);
  const s = parseInt(pick("second"), 10);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

/**
 * Inverse of toNaive: given a Date whose UTC fields represent local wall-
 * clock time, return the real UTC Date that corresponds to that moment.
 * Uses a self-referential approximation for the offset — accurate except
 * during the two DST transition hours per year, which we accept.
 */
function fromNaive(naive: Date, tz: string): Date {
  const offsetMs = naive.getTime() - toNaive(naive, tz).getTime();
  return new Date(naive.getTime() + offsetMs);
}

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * One item within a homeReminder.items array. The field is an
 * a.json() scalar in the schema, so shape isn't enforced server-side —
 * this type is the contract our code agrees to.
 */
export interface ReminderItem {
  id: string;
  name: string;
  notes?: string | null;
  /** ISO 8601 datetime for one-shot items. Mutually exclusive with rrule. */
  firesAt?: string | null;
  /** RRULE string (with or without "RRULE:" prefix) for recurring items. */
  rrule?: string | null;
  /** ISO date — recurring rule does not fire before this. Null = no gate. */
  startDate?: string | null;
  /** ISO date — recurring rule does not fire after this. Null = forever. */
  endDate?: string | null;
  /** ISO datetime of the last fire. Set by the sweep after each firing. */
  lastFiredAt?: string | null;
}

export interface ParsedRRULE {
  freq?: string;
  byhour?: number[];
  byminute?: number[];
  byday?: string[];
  bymonthday?: number[];
  interval?: number;
}

// ── Items blob normalization ────────────────────────────────────────────────

/**
 * Normalize a homeReminder.items blob. The field is stored as a
 * pre-stringified JSON string (AWSJSON scalar requirement — AppSync
 * rejects plain objects with "Variable 'items' has an invalid value"),
 * but on read the Amplify client may or may not deserialize depending
 * on context. Accepts both forms plus common empty cases.
 */
export function parseItems(raw: unknown): ReminderItem[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as ReminderItem[];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? (parsed as ReminderItem[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ── RRULE parsing ───────────────────────────────────────────────────────────

/**
 * Structured parse of an RRULE string. We only surface the parts we
 * actually use downstream (for format/display). The rrule library
 * handles the hard work at iteration time.
 */
export function parseRRULE(rrule: string): ParsedRRULE {
  const out: ParsedRRULE = {};
  const body = rrule.replace(/^RRULE:/i, "");
  for (const part of body.split(";")) {
    const [k, v] = part.split("=");
    if (!k || v === undefined) continue;
    const key = k.toUpperCase();
    if (key === "FREQ") out.freq = v.toUpperCase();
    else if (key === "BYHOUR")
      out.byhour = v.split(",").map((x) => parseInt(x, 10));
    else if (key === "BYMINUTE")
      out.byminute = v.split(",").map((x) => parseInt(x, 10));
    else if (key === "BYDAY") out.byday = v.split(",").map((x) => x.toUpperCase());
    else if (key === "BYMONTHDAY")
      out.bymonthday = v.split(",").map((x) => parseInt(x, 10));
    else if (key === "INTERVAL") out.interval = parseInt(v, 10);
  }
  return out;
}

// ── Occurrence math ─────────────────────────────────────────────────────────

/**
 * Next occurrence of a single item, strictly after `after`. Returns null
 * if there are no more occurrences (one-shot already in the past,
 * recurring past its endDate, invalid RRULE).
 *
 * Rules:
 *   - firesAt: one-shot. Returns the datetime if it's in the future and
 *     before endDate; otherwise null.
 *   - rrule: recurring. Honors startDate (don't fire before it) and
 *     endDate (don't fire after it).
 *   - Neither: returns null.
 */
export function nextOccurrence(item: ReminderItem, after: Date): Date | null {
  const endDate = item.endDate ? new Date(item.endDate) : null;
  if (endDate && !Number.isFinite(endDate.getTime())) {
    return null;
  }

  if (item.firesAt) {
    const fires = new Date(item.firesAt);
    if (!Number.isFinite(fires.getTime())) return null;
    if (fires <= after) return null;
    if (endDate && fires > endDate) return null;
    return fires;
  }

  if (item.rrule) {
    try {
      const rule = RRule.fromString(item.rrule);
      const startDate = item.startDate ? new Date(item.startDate) : null;
      if (startDate && !Number.isFinite(startDate.getTime())) {
        return null;
      }
      // rule.after() returns the first occurrence strictly after the
      // search date. If startDate is set and later than `after`, use
      // it as the search floor so we don't return pre-start times.
      const searchFrom = startDate && startDate > after ? startDate : after;

      // If the RRULE includes its own DTSTART;TZID= we trust it and pass
      // the real UTC search time through unmodified. Otherwise interpret
      // BYHOUR/BYMINUTE as household-local time via the naive-UTC shift.
      const hasOwnTZ = /DTSTART[^\n]*TZID=/i.test(item.rrule);
      if (hasOwnTZ) {
        const next = rule.after(searchFrom, false);
        if (!next) return null;
        if (endDate && next > endDate) return null;
        return next;
      }

      const naiveSearchFrom = toNaive(searchFrom, HOUSEHOLD_TZ);
      // Important: rrule.after() falls back to system time as DTSTART when
      // none is provided. System time (Lambda) is real UTC, which is AHEAD
      // of our naive-shifted search floor — rrule would then skip our
      // window and return the next day's occurrence. Fix: clone the rule
      // with dtstart set explicitly to the naive search floor so iteration
      // starts from where we want.
      const ruleWithNaiveStart = new RRule({
        ...rule.origOptions,
        dtstart: naiveSearchFrom,
      });
      const nextNaive = ruleWithNaiveStart.after(naiveSearchFrom, false);
      if (!nextNaive) return null;
      const next = fromNaive(nextNaive, HOUSEHOLD_TZ);
      if (endDate && next > endDate) return null;
      return next;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Earliest next occurrence across a set of items, strictly after `after`.
 * Returns null if no item has a future occurrence.
 */
export function earliestNextOccurrence(
  items: ReminderItem[],
  after: Date
): Date | null {
  let earliest: Date | null = null;
  for (const item of items) {
    const next = nextOccurrence(item, after);
    if (next && (!earliest || next < earliest)) earliest = next;
  }
  return earliest;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const DAY_LABELS: Record<string, string> = {
  SU: "Sun",
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
};

function prettyTime(hour: number, minute: number): string {
  const m = String(minute).padStart(2, "0");
  if (hour === 0) return `12:${m}am`;
  if (hour < 12) return `${hour}:${m}am`;
  if (hour === 12) return `12:${m}pm`;
  return `${hour - 12}:${m}pm`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/**
 * Render a schedule as a compact plain-English label.
 *
 * Examples:
 *   { firesAt: "2026-04-21T15:00:00Z" } → "once @ 10:00:00 AM ..."
 *   { rrule: "RRULE:FREQ=DAILY;BYHOUR=20;BYMINUTE=0" } → "daily @ 8:00pm"
 *   { rrule: "RRULE:FREQ=DAILY;BYHOUR=9,21;BYMINUTE=0" } → "daily @ 9:00am, 9:00pm"
 *   { rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=7;BYMINUTE=0" } → "Mon, Thu @ 7:00am"
 *   { rrule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=10;BYMINUTE=0" } → "15th of each month @ 10:00am"
 *
 * Falls back to the raw RRULE (minus the "RRULE:" prefix) for patterns
 * we don't recognize.
 */
export function formatScheduleLabel(schedule: {
  firesAt?: string | null;
  rrule?: string | null;
}): string {
  if (schedule.firesAt) {
    return `once @ ${new Date(schedule.firesAt).toLocaleString()}`;
  }
  if (!schedule.rrule) return "";

  const p = parseRRULE(schedule.rrule);
  const minute = p.byminute?.[0] ?? 0;

  if (p.freq === "DAILY") {
    const hours = p.byhour ?? [];
    if (hours.length === 0) return "daily";
    if (hours.length === 1) return `daily @ ${prettyTime(hours[0], minute)}`;
    return `daily @ ${hours.map((h) => prettyTime(h, minute)).join(", ")}`;
  }
  if (p.freq === "WEEKLY") {
    const days = (p.byday ?? []).map((d) => DAY_LABELS[d] ?? d).join(", ");
    const hour = p.byhour?.[0] ?? 8;
    return days
      ? `${days} @ ${prettyTime(hour, minute)}`
      : `weekly @ ${prettyTime(hour, minute)}`;
  }
  if (p.freq === "MONTHLY") {
    const day = p.bymonthday?.[0];
    const hour = p.byhour?.[0] ?? 8;
    const nth = day ? ordinal(day) : "";
    return `${nth} of each month @ ${prettyTime(hour, minute)}`;
  }
  return schedule.rrule.replace(/^RRULE:/i, "");
}
