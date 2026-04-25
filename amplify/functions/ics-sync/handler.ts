import type { Handler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import ical from "node-ical";
import { env } from "$amplify/env/ics-sync";
import type { Schema } from "../../data/resource";
import { cascadeDeleteRemindersFor } from "../../../lib/reminder-parent.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

type Feed = Schema["homeCalendarFeed"]["type"];
type CalendarEvent = Schema["homeCalendarEvent"]["type"];

interface FeedResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

function toHttps(url: string): string {
  // iCloud publishes calendars as webcal://; plain HTTPS fetch works the
  // same — just rewrite the scheme.
  if (url.startsWith("webcal://")) return "https://" + url.slice("webcal://".length);
  return url;
}

function toIsoOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  try {
    const d = new Date(value as string);
    const t = d.getTime();
    return Number.isFinite(t) ? d.toISOString() : null;
  } catch {
    return null;
  }
}

function isDateOnly(value: unknown): boolean {
  // node-ical marks all-day events with dateOnly=true on the Date object.
  // DATE (not DATE-TIME) values in ICS become midnight-of-the-day in the
  // system TZ after parsing; the dateOnly flag is the authoritative signal.
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { dateOnly?: boolean }).dateOnly === true
  );
}

function buildEventPayload(v: Record<string, unknown>) {
  const startAt = toIsoOrNull(v.start);
  if (!startAt) return null;

  const endAt = toIsoOrNull(v.end);
  // Recurring rule as ICS string. node-ical hands us a parsed RRule
  // object (from the rrule.js package); .toString() serialises it to
  // the canonical "FREQ=...;...;" form that our calendar page's
  // RRule.fromString already consumes.
  const rrule = v.rrule ? String((v.rrule as { toString(): string }).toString()) : null;

  const locationString = typeof v.location === "string" ? v.location.trim() : "";
  const location = locationString
    ? {
        city: locationString,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        airportCode: null,
      }
    : null;

  return {
    title: (typeof v.summary === "string" && v.summary.trim()) || "Untitled",
    description: typeof v.description === "string" ? v.description : null,
    startAt,
    endAt,
    isAllDay: isDateOnly(v.start),
    recurrence: rrule,
    location,
    url: typeof v.url === "string" ? v.url : null,
  };
}

async function syncFeed(feed: Feed): Promise<FeedResult> {
  const url = toHttps(feed.url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`fetch ${res.status} ${res.statusText}`);
  }
  const icsText = await res.text();
  const parsed = ical.sync.parseICS(icsText);
  const vevents = Object.values(parsed).filter(
    (v: unknown) =>
      typeof v === "object" && v !== null && (v as { type?: string }).type === "VEVENT"
  ) as Record<string, unknown>[];

  // Load what we already have for this feed so we can tell create vs
  // update vs delete. One page should cover a normal shared calendar;
  // if a feed has >1000 events we'd need to paginate.
  const { data: existing } = await client.models.homeCalendarEvent.list({
    filter: { feedId: { eq: feed.id } },
    limit: 1000,
  });
  const existingByUid = new Map<string, CalendarEvent>();
  for (const e of existing ?? []) {
    if (e.externalUid) existingByUid.set(e.externalUid, e);
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const seenUids = new Set<string>();

  for (const v of vevents) {
    if (typeof v.uid !== "string" || !v.uid) continue;
    // Skip cancelled events entirely — treat them the same as removed.
    if (v.status === "CANCELLED") continue;

    const payload = buildEventPayload(v);
    if (!payload) continue;

    const uid = v.uid;
    seenUids.add(uid);
    const hit = existingByUid.get(uid);
    if (hit) {
      // Cheap change-detection to avoid write-amplification. Most sync
      // runs see zero changes, so this keeps the DDB write volume down.
      if (
        hit.title === payload.title &&
        hit.startAt === payload.startAt &&
        (hit.endAt ?? null) === (payload.endAt ?? null) &&
        (hit.isAllDay ?? false) === payload.isAllDay &&
        (hit.recurrence ?? null) === (payload.recurrence ?? null) &&
        (hit.description ?? null) === (payload.description ?? null)
      ) {
        unchanged++;
      } else {
        await client.models.homeCalendarEvent.update({
          id: hit.id,
          ...payload,
        });
        updated++;
      }
    } else {
      await client.models.homeCalendarEvent.create({
        ...payload,
        feedId: feed.id,
        externalUid: uid,
      });
      created++;
    }
  }

  // Anything in existingByUid not in seenUids has dropped out of the
  // source and should be removed here too. Cascade-delete any linked
  // reminders on the way — an event that's gone shouldn't page anyone.
  let deleted = 0;
  for (const [uid, e] of existingByUid) {
    if (seenUids.has(uid)) continue;
    await cascadeDeleteRemindersFor(client, e.id);
    await client.models.homeCalendarEvent.delete({ id: e.id });
    deleted++;
  }

  return {
    total: seenUids.size,
    created,
    updated,
    unchanged,
    deleted,
  };
}

export const handler: Handler = async () => {
  console.log("ics-sync: starting at", new Date().toISOString());
  const { data: feeds, errors } = await client.models.homeCalendarFeed.list({
    limit: 50,
  });
  if (errors?.length) {
    console.error("ics-sync: failed to list feeds", errors);
    throw new Error(errors[0].message);
  }
  const active = (feeds ?? []).filter((f) => f.active !== false);
  console.log(`ics-sync: ${active.length} active feed(s)`);

  const summary: Array<{ id: string; name: string; result?: FeedResult; error?: string }> = [];

  for (const feed of active) {
    try {
      const result = await syncFeed(feed);
      summary.push({ id: feed.id, name: feed.name, result });
      await client.models.homeCalendarFeed.update({
        id: feed.id,
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: null,
        eventCount: result.total,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`ics-sync: ${feed.name} failed:`, msg);
      summary.push({ id: feed.id, name: feed.name, error: msg });
      // Record but don't throw — other feeds should still sync.
      await client.models.homeCalendarFeed.update({
        id: feed.id,
        lastSyncError: msg.slice(0, 500),
      });
    }
  }

  console.log("ics-sync: summary", JSON.stringify(summary));
  return summary;
};
