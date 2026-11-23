// ICS text for two-way calendar feeds (homeCalendarFeed.caldavUrl): build
// a VEVENT for an event made in the app, patch an existing one in place
// for an edit (keeping what the app doesn't model: alarms, attendees,
// Apple's X- properties), and the content hash that tells the push and
// the pull which side changed a row.
//
// Times are real UTC. All-day events have two stored shapes: the pull
// writes midnight UTC of the date (node-ical in a UTC Lambda), the web and
// phone forms write local midnight / end of day. `allDayDate` reads both.

import { DEFAULT_HOUSEHOLD_TZ } from "./reminder-schedule";

export interface SyncedFields {
  title: string;
  description?: string | null;
  startAt: string;
  endAt?: string | null;
  isAllDay?: boolean | null;
  recurrence?: string | null;
  location?: { city?: string | null } | null;
  url?: string | null;
}

/** Fields a CalDAV calendar holds, normalized; equal strings = nothing to sync. */
export function syncHashOf(e: SyncedFields): string {
  const iso = (v?: string | null) => {
    if (!v) return "";
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : v;
  };
  const parts = [
    (e.title ?? "").trim(),
    (e.description ?? "").trim(),
    iso(e.startAt),
    iso(e.endAt),
    e.isAllDay ? "1" : "0",
    rruleOf(e.recurrence) ?? "",
    (e.location?.city ?? "").trim(),
    (e.url ?? "").trim(),
  ];
  // FNV-1a: no crypto import, so the browser could use it too.
  let h = 0x811c9dc5;
  const s = parts.join("\u0001");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `v1-${h.toString(16)}-${s.length}`;
}

/** The pull marks a row it is about to delete, so the push doesn't delete it from the calendar too. */
export const PULL_DELETE_MARK = "pull-delete";

/** "FREQ=…" from a stored recurrence ("RRULE:FREQ=…", or rrule.js's "DTSTART:…\nRRULE:…"). */
export function rruleOf(recurrence?: string | null): string | null {
  if (!recurrence?.trim()) return null;
  const line = recurrence.split(/\r?\n/).find((l) => /^RRULE:/i.test(l.trim()));
  const rule = (line ?? recurrence).trim().replace(/^RRULE:/i, "").trim();
  return /FREQ=/i.test(rule) ? rule : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

function ymdInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

function isUtcMidnight(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

/** YYYYMMDD of an all-day start: midnight UTC is the pull's date, anything else is a local time. */
export function allDayDate(iso: string, tz = DEFAULT_HOUSEHOLD_TZ): string {
  const d = new Date(iso);
  return isUtcMidnight(d) ? `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` : ymdInTz(d, tz);
}

function addDays(ymd: string, n: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** DTEND (exclusive) of an all-day event: the pull stores it exclusive at midnight UTC, the forms store the last day. */
export function allDayEnd(startIso: string, endIso: string | null | undefined, tz = DEFAULT_HOUSEHOLD_TZ): string {
  const start = allDayDate(startIso, tz);
  if (!endIso) return addDays(start, 1);
  const d = new Date(endIso);
  const end = isUtcMidnight(d) ? allDayDate(endIso, tz) : addDays(ymdInTz(d, tz), 1);
  return end > start ? end : addDays(start, 1);
}

/** Wall-clock YYYYMMDDTHHMMSS of an instant in `tz`. */
function localStamp(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
}

function utcStamp(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 folding: lines over 75 octets continue on the next line after a space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (curLen + n > limit) {
      out.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function unfold(ics: string): string[] {
  return ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

/**
 * The properties the app owns, as unfolded ICS lines. Timed events are
 * written in `timeTzid` when given (the zone the event already had, or the
 * household's for a new recurring one, so a weekly 9:00 stays 9:00 across
 * DST), else in UTC.
 */
function ownedLines(e: SyncedFields, tz: string, timeTzid: string | null = null): string[] {
  const lines: string[] = [];
  if (e.isAllDay) {
    lines.push(`DTSTART;VALUE=DATE:${allDayDate(e.startAt, tz)}`);
    lines.push(`DTEND;VALUE=DATE:${allDayEnd(e.startAt, e.endAt, tz)}`);
  } else {
    const end = e.endAt && new Date(e.endAt).getTime() > new Date(e.startAt).getTime() ? e.endAt : new Date(new Date(e.startAt).getTime() + 3600_000).toISOString();
    if (timeTzid && validTz(timeTzid)) {
      lines.push(`DTSTART;TZID=${timeTzid}:${localStamp(e.startAt, timeTzid)}`);
      lines.push(`DTEND;TZID=${timeTzid}:${localStamp(end, timeTzid)}`);
    } else {
      lines.push(`DTSTART:${utcStamp(e.startAt)}`);
      lines.push(`DTEND:${utcStamp(end)}`);
    }
  }
  lines.push(`SUMMARY:${escapeText(e.title.trim() || "Untitled")}`);
  if (e.description?.trim()) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.location?.city?.trim()) lines.push(`LOCATION:${escapeText(e.location.city.trim())}`);
  if (e.url?.trim()) lines.push(`URL:${e.url.trim()}`);
  const rule = rruleOf(e.recurrence);
  if (rule) lines.push(`RRULE:${rule}`);
  return lines;
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// US Central rules, for new recurring events written in the household zone.
const CHICAGO_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Chicago",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0600",
  "TZOFFSETTO:-0500",
  "TZNAME:CDT",
  "DTSTART:20070311T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0600",
  "TZNAME:CST",
  "DTSTART:20071104T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const OWNED = new Set(["DTSTART", "DTEND", "DURATION", "SUMMARY", "DESCRIPTION", "LOCATION", "URL", "RRULE", "DTSTAMP", "LAST-MODIFIED", "SEQUENCE"]);
const propName = (line: string) => line.split(/[;:]/, 1)[0].toUpperCase();

/** A whole calendar object for an event made in the app. */
export function buildEventIcs(uid: string, e: SyncedFields, now = new Date(), tz = DEFAULT_HOUSEHOLD_TZ): string {
  // A recurring event keeps its wall-clock time across DST only in a zone.
  const zoned = !e.isAllDay && !!rruleOf(e.recurrence) && tz === "America/Chicago";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Home Hub//Calendar//EN",
    "CALSCALE:GREGORIAN",
    ...(zoned ? CHICAGO_VTIMEZONE : []),
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `CREATED:${utcStamp(now)}`,
    `LAST-MODIFIED:${utcStamp(now)}`,
    "SEQUENCE:0",
    ...ownedLines(e, tz, zoned ? tz : null),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/**
 * The calendar object with its main VEVENT (the one without RECURRENCE-ID)
 * rewritten from `e`: the app's properties replaced, SEQUENCE bumped,
 * everything else (VTIMEZONE, alarms, attendees, overrides) kept.
 */
export function patchEventIcs(ics: string, e: SyncedFields, now = new Date(), tz = DEFAULT_HOUSEHOLD_TZ): string {
  const lines = unfold(ics).filter((l) => l !== "");
  const out: string[] = [];
  let depth = 0; // nesting inside the current VEVENT (VALARM etc.)
  let inEvent = false;
  let block: string[] = [];
  const flush = () => {
    const isMain = !block.some((l) => propName(l) === "RECURRENCE-ID");
    if (!isMain) {
      out.push(...block);
      return;
    }
    const seqLine = block.find((l) => propName(l) === "SEQUENCE");
    // Keep the zone the event was written in (Apple writes TZID=…).
    const startLine = block.find((l) => propName(l) === "DTSTART") ?? "";
    const tzid = startLine.match(/;TZID=("?)([^;:"]+)\1/i)?.[2] ?? null;
    const seq = seqLine ? parseInt(seqLine.split(":").pop() ?? "0", 10) || 0 : 0;
    const kept: string[] = [];
    let sub = 0;
    for (const l of block.slice(1, -1)) {
      if (/^BEGIN:/i.test(l)) sub++;
      if (sub === 0 && OWNED.has(propName(l))) {
        if (/^END:/i.test(l)) sub--;
        continue;
      }
      if (/^END:/i.test(l)) sub--;
      kept.push(l);
    }
    // Properties go before sub-components (VALARM) for tidy output.
    const firstSub = kept.findIndex((l) => /^BEGIN:/i.test(l));
    const props = firstSub === -1 ? kept : kept.slice(0, firstSub);
    const subs = firstSub === -1 ? [] : kept.slice(firstSub);
    out.push(
      block[0],
      ...props,
      `DTSTAMP:${utcStamp(now)}`,
      `LAST-MODIFIED:${utcStamp(now)}`,
      `SEQUENCE:${seq + 1}`,
      ...ownedLines(e, tz, tzid),
      ...subs,
      block[block.length - 1],
    );
  };
  for (const l of lines) {
    if (!inEvent && /^BEGIN:VEVENT$/i.test(l)) {
      inEvent = true;
      depth = 0;
      block = [l];
      continue;
    }
    if (inEvent) {
      block.push(l);
      if (/^BEGIN:/i.test(l)) depth++;
      else if (/^END:VEVENT$/i.test(l) && depth === 0) {
        inEvent = false;
        flush();
      } else if (/^END:/i.test(l)) depth--;
      continue;
    }
    out.push(l);
  }
  return out.map(fold).join("\r\n") + "\r\n";
}
