// Two-way calendar sync (server-side): the pull that ics-sync runs every 15
// minutes for a CalDAV feed, and the push that calendar-push runs on every
// homeCalendarEvent change. Shared so the pull also re-sends any edit
// whose push failed.
//
// Who changed what is told by `syncHash` (syncHashOf of the fields as last
// synced): the pull writes rows with it set, so their stream events are
// skipped; an app edit leaves it stale, and that row is pushed. The pull
// leaves a stale row alone (the app's edit wins over the calendar's for the
// fields the app owns) and pushes it instead. Before deleting a row itself,
// the pull sets syncHash to PULL_DELETE_MARK so the push doesn't delete
// the calendar's copy too.

import ical from "node-ical";
import { listAllPages } from "./list-all";
import { cascadeDeleteRemindersFor } from "./reminder-parent";
import { duplicateFeedRows, isTwoWayFeed, newEventsFeed, type TwoWayFeed } from "./calendar-feeds";
import { buildEventIcs, patchEventIcs, PULL_DELETE_MARK, syncHashOf, type SyncedFields } from "./calendar-ics";
import { CaldavError, deleteObject, fetchCalendarObjects, getObject, objectUrl, putObject, type CaldavCreds } from "./caldav";

type Client = { models: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SyncEvent extends SyncedFields {
  id: string;
  feedId?: string | null;
  externalUid?: string | null;
  externalHref?: string | null;
  externalEtag?: string | null;
  syncHash?: string | null;
  assignedPersonIds?: (string | null)[] | null;
  createdAt?: string | null;
  location?: {
    city?: string | null;
    country?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    timezone?: string | null;
    airportCode?: string | null;
  } | null;
}

// ── ICS → row fields (shared with the read-only ICS pull) ────────────────

function toIsoOrNull(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  const t = d.getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** node-ical marks all-day (DATE) values with dateOnly. */
function isDateOnly(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { dateOnly?: boolean }).dateOnly === true;
}

export function eventPayloadFromVevent(v: Record<string, unknown>) {
  const startAt = toIsoOrNull(v.start);
  if (!startAt) return null;
  const endAt = toIsoOrNull(v.end);
  // node-ical's RRule .toString() is the "FREQ=…" form RRule.fromString reads.
  const rrule = v.rrule ? String((v.rrule as { toString(): string }).toString()) : null;
  const locationString = typeof v.location === "string" ? v.location.trim() : "";
  const location = locationString
    ? { city: locationString, country: null, latitude: null, longitude: null, timezone: null, airportCode: null }
    : null;
  return {
    title: (typeof v.summary === "string" && v.summary.trim()) || "Untitled",
    description: typeof v.description === "string" ? v.description : null,
    startAt,
    endAt,
    isAllDay: isDateOnly(v.start),
    recurrence: rrule,
    location,
    url: typeof v.url === "string" ? v.url : typeof (v.url as { val?: string })?.val === "string" ? (v.url as { val: string }).val : null,
  };
}

export function vevents(icsText: string): Record<string, unknown>[] {
  const parsed = ical.sync.parseICS(icsText);
  return Object.values(parsed).filter(
    (v: unknown) => typeof v === "object" && v !== null && (v as { type?: string }).type === "VEVENT",
  ) as Record<string, unknown>[];
}

/** A row with an app edit the calendar hasn't got yet. */
export function hasPendingEdit(e: SyncEvent): boolean {
  return !!e.syncHash && e.syncHash !== PULL_DELETE_MARK && syncHashOf(e) !== e.syncHash;
}

/** Delete a row the calendar no longer has, without the push deleting it there. */
export async function deleteRowFromPull(c: Client, e: SyncEvent): Promise<void> {
  if (e.externalHref) await c.models.homeCalendarEvent.update({ id: e.id, syncHash: PULL_DELETE_MARK });
  await cascadeDeleteRemindersFor(c, e.id);
  await c.models.homeCalendarEvent.delete({ id: e.id });
}

// ── Push ──────────────────────────────────────────────────────────────────

export type PushResult = "skipped" | "created" | "updated" | "recreated";

/** How far back a native event may end and still be sent to the calendar when it changes. */
const NATIVE_PAST_MS = 24 * 3600_000;

/**
 * Send one row's change to its calendar. Native events go to the feed
 * marked writeNewEvents (unless they're long over) and become that feed's;
 * a two-way feed's events are patched in place. No-op when nothing synced
 * changed.
 */
export async function pushEvent(c: Client, creds: CaldavCreds, row: SyncEvent, feeds: TwoWayFeed[], now = new Date()): Promise<PushResult> {
  if (row.syncHash === PULL_DELETE_MARK) return "skipped";
  const hash = syncHashOf(row);
  if (row.syncHash === hash) return "skipped";

  if (!row.feedId) {
    const target = newEventsFeed(feeds);
    if (!target?.caldavUrl) return "skipped";
    const ends = new Date(row.endAt || row.startAt).getTime();
    if (Number.isFinite(ends) && ends < now.getTime() - NATIVE_PAST_MS) return "skipped";
    const uid = row.id;
    const url = objectUrl(target.caldavUrl, uid);
    let etag: string | null;
    try {
      etag = await putObject(creds, url, buildEventIcs(uid, row, now), null);
    } catch (err) {
      // 412: already there (a retry after the row update failed): patch it.
      if (!(err instanceof CaldavError && err.status === 412)) throw err;
      const obj = await getObject(creds, url);
      etag = await putObject(creds, url, obj ? patchEventIcs(obj.ics, row, now) : buildEventIcs(uid, row, now), obj?.etag ?? null);
    }
    await c.models.homeCalendarEvent.update({ id: row.id, feedId: target.id, externalUid: uid, externalHref: url, externalEtag: etag, syncHash: hash });
    return "created";
  }

  const feed = feeds.find((f) => f.id === row.feedId);
  if (!feed || !isTwoWayFeed(feed)) return "skipped";
  // Imported before the feed was two-way: the next pull fills in the URL
  // and the baseline, then edits go through.
  if (!row.externalHref || !row.syncHash) return "skipped";

  for (let attempt = 0; attempt < 3; attempt++) {
    const obj = await getObject(creds, row.externalHref);
    let etag: string | null;
    let result: PushResult;
    try {
      if (!obj) {
        // Deleted on a phone while edited here: keep the edit.
        etag = await putObject(creds, row.externalHref, buildEventIcs(row.externalUid || row.id, row, now), null);
        result = "recreated";
      } else {
        etag = await putObject(creds, row.externalHref, patchEventIcs(obj.ics, row, now), obj.etag);
        result = "updated";
      }
    } catch (err) {
      if (err instanceof CaldavError && err.status === 412) continue; // changed underneath us: re-read
      throw err;
    }
    await c.models.homeCalendarEvent.update({ id: row.id, externalEtag: etag, syncHash: hash });
    return result;
  }
  throw new Error(`push ${row.id}: calendar kept changing (412)`);
}

/** A deleted row: remove the calendar's copy (not when the pull deleted it). */
export async function pushDelete(creds: CaldavCreds, old: Pick<SyncEvent, "feedId" | "externalHref" | "syncHash">, feeds: TwoWayFeed[]): Promise<boolean> {
  if (!old.feedId || !old.externalHref || old.syncHash === PULL_DELETE_MARK) return false;
  const feed = feeds.find((f) => f.id === old.feedId);
  if (!feed || !isTwoWayFeed(feed)) return false;
  // Only objects inside the feed's calendar: never act on a stray URL.
  if (!old.externalHref.startsWith(feed.caldavUrl!.replace(/\/?$/, "/"))) return false;
  await deleteObject(creds, old.externalHref);
  return true;
}

// ── Pull ──────────────────────────────────────────────────────────────────

export interface PullResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  duplicatesRemoved: number;
  pushed: number;
}

/** Mirror a CalDAV calendar into homeCalendarEvent, and re-send pending app edits. */
export async function pullCaldavFeed(c: Client, creds: CaldavCreds, feed: TwoWayFeed & { id: string }, feeds: TwoWayFeed[]): Promise<PullResult> {
  const objects = await fetchCalendarObjects(creds, feed.caldavUrl!);
  const existing = await listAllPages<SyncEvent>(c.models.homeCalendarEvent, { filter: { feedId: { eq: feed.id } }, limit: 1000 });
  const { keep: byUid, extra } = duplicateFeedRows(existing);
  for (const e of extra) await deleteRowFromPull(c, e);

  const r: PullResult = { total: 0, created: 0, updated: 0, unchanged: 0, deleted: 0, duplicatesRemoved: extra.length, pushed: 0 };
  const seen = new Set<string>();

  for (const obj of objects) {
    let events: Record<string, unknown>[];
    try {
      events = vevents(obj.ics);
    } catch (err) {
      console.warn(`calendar-sync: unparseable ${obj.url}:`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const v of events) {
      if (typeof v.uid !== "string" || !v.uid) continue;
      if (v.status === "CANCELLED") continue;
      const payload = eventPayloadFromVevent(v);
      if (!payload) continue;
      const uid = v.uid;
      seen.add(uid);
      const sync = { externalHref: obj.url, externalEtag: obj.etag, syncHash: syncHashOf(payload) };
      const hit = byUid.get(uid);

      if (hit) {
        if (hasPendingEdit(hit)) {
          try {
            if ((await pushEvent(c, creds, hit, feeds)) !== "skipped") r.pushed++;
          } catch (err) {
            console.warn(`calendar-sync: push retry for ${hit.id} failed:`, err instanceof Error ? err.message : err);
          }
          continue;
        }
        if (hit.syncHash === sync.syncHash && hit.externalHref === obj.url && (hit.externalEtag ?? null) === (obj.etag ?? null)) {
          r.unchanged++;
          continue;
        }
        // Keep an app-set location (coordinates) when the calendar's text didn't change.
        const location = payload.location && hit.location?.city === payload.location.city ? hit.location : payload.location;
        await c.models.homeCalendarEvent.update({ id: hit.id, ...payload, location, ...sync });
        r.updated++;
        continue;
      }

      // An event the app just sent (its UID is the row id) whose row update
      // hasn't landed: adopt the row instead of importing it twice.
      const { data: own } = await c.models.homeCalendarEvent.get({ id: uid });
      if (own && !own.feedId) {
        await c.models.homeCalendarEvent.update({ id: own.id, feedId: feed.id, externalUid: uid, ...sync, ...payload });
        r.updated++;
        continue;
      }
      await c.models.homeCalendarEvent.create({ ...payload, feedId: feed.id, externalUid: uid, ...sync });
      r.created++;
    }
  }

  for (const [uid, e] of byUid) {
    if (seen.has(uid)) continue;
    if (hasPendingEdit(e)) {
      // Deleted there, edited here: the push puts it back.
      try {
        if ((await pushEvent(c, creds, e, feeds)) !== "skipped") r.pushed++;
      } catch (err) {
        console.warn(`calendar-sync: push retry for ${e.id} failed:`, err instanceof Error ? err.message : err);
      }
      continue;
    }
    await deleteRowFromPull(c, e);
    r.deleted++;
  }

  r.total = seen.size;
  return r;
}

/** Native events the app made while the push was down: send the recent ones. */
export async function pushPendingNative(c: Client, creds: CaldavCreds, feeds: TwoWayFeed[], now = new Date()): Promise<number> {
  if (!newEventsFeed(feeds)) return 0;
  const since = new Date(now.getTime() - NATIVE_PAST_MS).toISOString();
  const rows = await listAllPages<SyncEvent>(c.models.homeCalendarEvent, { filter: { startAt: { ge: since } }, limit: 1000 });
  let n = 0;
  for (const row of rows) {
    if (row.feedId || row.syncHash) continue;
    try {
      if ((await pushEvent(c, creds, row, feeds, now)) !== "skipped") n++;
    } catch (err) {
      console.warn(`calendar-sync: native push for ${row.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return n;
}
