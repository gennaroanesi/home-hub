// Trip prep: what every trip gets automatically.
//
//  1. Checklist templates flagged `autoAttachTrips` are copied onto the
//     trip (once each: the copy remembers `sourceTemplateId`; its name
//     drops "template", checklistNameFromTemplate). A deleted
//     copy comes back on the next save; to drop one from a trip, archive
//     it (archived copies still count as attached). Flagging a template
//     later adds it to every upcoming trip.
//  2. One "last look" reminder (kind DEPARTURE_REMINDER_KIND, parent the
//     trip) DEPARTURE_LEAD_HOURS before the first leg departs. It follows
//     the leg if the time changes, until it has fired. When it fires, the
//     reminder sweep lists whatever is still unchecked on the trip's
//     checklists (departureMessage).
//
//  3. Once a trip is over (endDate before today), its checklists are
//     archived (archivePastTripChecklists), once: a list unarchived by hand
//     keeps its archivedAt and is left alone.
//
// ensureTripPrep is idempotent and runs after every trip / leg save (web,
// phone, Janet) and from the reminder sweep for upcoming trips, so a save
// path that forgets to call it is caught within minutes.

import type { ReminderItem } from "./reminder-schedule";
import { DEFAULT_HOUSEHOLD_TZ, parseItems } from "./reminder-schedule";
import { getHouseholdTimezone } from "./household-settings";
import { parseLegIso } from "./trip";
import { archivePatch, copyChecklist } from "./checklist";

export const DEPARTURE_REMINDER_KIND = "trip-departure";
export const DEPARTURE_LEAD_HOURS = 5;
const ITEM_ID = "departure";

type Loc = { timezone?: string | null } | null | undefined;
export type PrepLeg = { departAt?: string | null; fromLocation?: Loc; sortOrder?: number | null };

/** UTC offset (ms) of `tz` at the instant `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - utcMs;
}

/** The real instant of a leg's stored wall clock (see lib/trip.ts) in `tz`. */
export function legInstant(iso: string | null | undefined, tz: string): Date | null {
  const p = parseLegIso(iso);
  if (!p) return null;
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  let utc = wall - tzOffsetMs(wall, tz);
  utc = wall - tzOffsetMs(utc, tz); // second pass settles DST edges
  return new Date(utc);
}

/** When the trip's first leg leaves, as a real instant (its origin's timezone, else the household's). */
export function tripDeparture(legs: PrepLeg[], fallbackTz: string = DEFAULT_HOUSEHOLD_TZ): Date | null {
  let first: Date | null = null;
  for (const l of legs) {
    let tz = l.fromLocation?.timezone?.trim() || fallbackTz;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      tz = fallbackTz;
    }
    const at = legInstant(l.departAt, tz);
    if (at && (!first || at < first)) first = at;
  }
  return first;
}

export function departureReminderAt(departure: Date): Date {
  return new Date(departure.getTime() - DEPARTURE_LEAD_HOURS * 3600_000);
}

/**
 * The text sent when the reminder fires: what's still unchecked on the
 * trip's checklists, grouped by list (capped), or an all-clear.
 */
export function departureMessage(
  tripName: string,
  lists: { name: string; items: { text: string; isDone?: boolean | null }[] }[],
  maxItems = 15,
): string {
  const open = lists.map((l) => ({ name: l.name, items: l.items.filter((i) => !i.isDone) })).filter((l) => l.items.length);
  const head = `Last look before ${tripName}: you leave in about ${DEPARTURE_LEAD_HOURS} hours.`;
  if (lists.length === 0) return `${head} No checklists on this trip.`;
  if (open.length === 0) return `${head} Every checklist is done ✅`;
  const total = open.reduce((n, l) => n + l.items.length, 0);
  const lines: string[] = [];
  let shown = 0;
  for (const l of open) {
    if (shown >= maxItems) break;
    lines.push(`*${l.name}*`);
    for (const i of l.items) {
      if (shown >= maxItems) break;
      lines.push(`• ${i.text}`);
      shown++;
    }
  }
  if (total > shown) lines.push(`…and ${total - shown} more`);
  return `${head} Still unchecked:\n${lines.join("\n")}`;
}

// ── I/O ───────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = { models: any };

async function listAll(model: any, args: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  let nextToken: string | null | undefined;
  do {
    const res = await model.list({ ...args, limit: 1000, nextToken });
    if (res.errors?.length) throw new Error(res.errors[0].message);
    out.push(...(res.data ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

export type TripPrepResult = { checklistsAdded: string[]; reminder: "created" | "moved" | "kept" | "none" | "fired" };

/**
 * Attach the auto templates and place the departure reminder for one trip.
 * Past trips (ended before today) are left alone.
 */
export async function ensureTripPrep(
  c: Client,
  tripId: string,
  opts: { now?: Date; householdTz?: string } = {},
): Promise<TripPrepResult> {
  const now = opts.now ?? new Date();
  const result: TripPrepResult = { checklistsAdded: [], reminder: "none" };
  const { data: trip } = await c.models.homeTrip.get({ id: tripId });
  if (!trip) return result;
  if (trip.endDate && trip.endDate < now.toISOString().slice(0, 10)) return result;

  // 1. Checklists.
  const [templates, onTrip] = await Promise.all([
    listAll(c.models.homeChecklist, { filter: { entityType: { eq: "TEMPLATE" }, autoAttachTrips: { eq: true } } }),
    listAll(c.models.homeChecklist, { filter: { entityType: { eq: "TRIP" }, entityId: { eq: tripId } } }),
  ]);
  const have = new Set(onTrip.map((l) => l.sourceTemplateId).filter(Boolean));
  let order = onTrip.length;
  for (const t of templates.filter((t) => t.isArchived !== true && !have.has(t.id)).sort((a, b) => a.name.localeCompare(b.name))) {
    const copy = await copyChecklist(c, t, { entityType: "TRIP", entityId: tripId, sortOrder: order++ });
    result.checklistsAdded.push(copy.name);
  }

  // 2. Departure reminder.
  const legs = await listAll(c.models.homeTripLeg, { filter: { tripId: { eq: tripId } } });
  const departure = tripDeparture(legs, opts.householdTz ?? (await getHouseholdTimezone(c)));
  const existing = (await listAll(c.models.homeReminder, { filter: { parentId: { eq: tripId } } })).find(
    (r) => r.kind === DEPARTURE_REMINDER_KIND,
  );
  const item = existing ? parseItems(existing.items).find((i) => i.id === ITEM_ID) : undefined;
  if (item?.lastFiredAt) return { ...result, reminder: "fired" };

  const fireAt = departure ? departureReminderAt(departure) : null;
  if (!fireAt || fireAt <= now) {
    // No departure time yet, or it's already past the reminder time: nothing to send.
    if (existing && existing.status === "PENDING") await c.models.homeReminder.update({ id: existing.id, status: "CANCELLED" });
    return result;
  }
  const items: ReminderItem[] = [{ id: ITEM_ID, name: `Last look at the checklists for ${trip.name}`, firesAt: fireAt.toISOString(), rrule: null }];
  const ids = ((trip.participantIds ?? []) as (string | null)[]).filter((x): x is string => !!x);
  const target = ids.length === 1 ? { targetKind: "PERSON", personId: ids[0] } : { targetKind: "GROUP", personId: null };
  const row = {
    name: `Last look: ${trip.name}`,
    items: JSON.stringify(items),
    useLlm: false,
    scheduledAt: fireAt.toISOString(),
    status: "PENDING",
    kind: DEPARTURE_REMINDER_KIND,
    parentType: "TRIP",
    parentId: tripId,
    ...target,
  };
  if (!existing) {
    const { errors } = await c.models.homeReminder.create({ ...row, createdBy: "trip-prep" });
    if (errors?.length) throw new Error(`departure reminder: ${errors[0].message}`);
    return { ...result, reminder: "created" };
  }
  if (item?.firesAt === row.scheduledAt && existing.status === "PENDING" && existing.name === row.name) return { ...result, reminder: "kept" };
  const { errors } = await c.models.homeReminder.update({ id: existing.id, ...row });
  if (errors?.length) throw new Error(`departure reminder: ${errors[0].message}`);
  return { ...result, reminder: "moved" };
}

/**
 * Archive the checklists of trips that ended before `today` (YYYY-MM-DD),
 * each once: one with an archivedAt was archived before (and maybe brought
 * back on purpose), so it's skipped. Returns the ids archived.
 */
export async function archivePastTripChecklists(c: Client, today: string, now: Date = new Date()): Promise<string[]> {
  const [trips, lists] = await Promise.all([
    listAll(c.models.homeTrip, {}),
    listAll(c.models.homeChecklist, { filter: { entityType: { eq: "TRIP" } } }),
  ]);
  const ended = new Set(trips.filter((t) => t.endDate && t.endDate < today).map((t) => t.id));
  const archived: string[] = [];
  for (const l of lists) {
    if (!ended.has(l.entityId) || l.isArchived === true || l.archivedAt) continue;
    const { errors } = await c.models.homeChecklist.update({ id: l.id, ...archivePatch(true, now) });
    if (errors?.length) throw new Error(`archiving "${l.name}": ${errors[0].message}`);
    archived.push(l.id);
  }
  return archived;
}

/** ensureTripPrep that never throws (for save paths: the trip is saved either way). */
export async function ensureTripPrepQuietly(c: Client, tripId: string, opts?: { householdTz?: string }): Promise<TripPrepResult | null> {
  try {
    return await ensureTripPrep(c, tripId, opts);
  } catch (e) {
    console.warn(`[trip-prep] ${tripId}:`, e);
    return null;
  }
}
