import type { Handler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/ics-sync";
import type { Schema } from "../../data/resource";
import { cascadeDeleteRemindersFor } from "../../../lib/reminder-parent.js";
import { listAllPages } from "../../../lib/list-all.js";
import { duplicateFeedRows, isTwoWayFeed } from "../../../lib/calendar-feeds.js";
import { eventPayloadFromVevent, pullCaldavFeed, pushPendingNative, vevents } from "../../../lib/calendar-sync.js";
import { readCaldavCreds } from "../../../lib/caldav-secret.js";
import type { CaldavCreds } from "../../../lib/caldav.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

type Feed = Schema["homeCalendarFeed"]["type"];
type CalendarEvent = Schema["homeCalendarEvent"]["type"];

interface FeedResult {
  total: number;
  pushed?: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  duplicatesRemoved: number;
}

function toHttps(url: string): string {
  // iCloud publishes calendars as webcal://; plain HTTPS fetch works the
  // same — just rewrite the scheme.
  if (url.startsWith("webcal://")) return "https://" + url.slice("webcal://".length);
  return url;
}

async function syncFeed(feed: Feed): Promise<FeedResult> {
  const url = toHttps(feed.url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`fetch ${res.status} ${res.statusText}`);
  }
  const icsText = await res.text();
  const events = vevents(icsText);

  // Load what we already have for this feed so we can tell create vs
  // update vs delete. Every page: the filter runs after DynamoDB's limit,
  // so a single page held only part of the feed and the rest got imported
  // again on every run. Rows that share a UID from that are removed here.
  const existing = await listAllPages<CalendarEvent>(client.models.homeCalendarEvent, {
    filter: { feedId: { eq: feed.id } },
    limit: 1000,
  });
  const { keep: existingByUid, extra } = duplicateFeedRows(existing);
  for (const e of extra) {
    await cascadeDeleteRemindersFor(client, e.id);
    await client.models.homeCalendarEvent.delete({ id: e.id });
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const seenUids = new Set<string>();

  for (const v of events) {
    if (typeof v.uid !== "string" || !v.uid) continue;
    // Skip cancelled events entirely — treat them the same as removed.
    if (v.status === "CANCELLED") continue;

    const payload = eventPayloadFromVevent(v);
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
    duplicatesRemoved: extra.length,
  };
}

interface SyncSummary {
  feedCount: number;
  totalEvents: number;
  created: number;
  updated: number;
  deleted: number;
  errors: string[];
}

export const handler: Handler<unknown, SyncSummary> = async () => {
  console.log("ics-sync: starting at", new Date().toISOString());
  const { data: feeds, errors } = await client.models.homeCalendarFeed.list({ limit: 1000 });
  if (errors?.length) {
    console.error("ics-sync: failed to list feeds", errors);
    throw new Error(errors[0].message);
  }
  const active = (feeds ?? []).filter((f) => f.active !== false);
  console.log(`ics-sync: ${active.length} active feed(s)`);

  const aggregate: SyncSummary = {
    feedCount: active.length,
    totalEvents: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    errors: [],
  };

  // Two-way feeds read the calendar over CalDAV with the account in
  // Secrets Manager; read-only feeds fetch their ICS URL.
  let creds: CaldavCreds | null = null;
  const getCreds = async () => (creds ??= await readCaldavCreds());

  for (const feed of active) {
    try {
      const result: FeedResult = isTwoWayFeed(feed)
        ? await pullCaldavFeed(client, await getCreds(), feed, active)
        : await syncFeed(feed);
      if (result.pushed) console.log(`ics-sync: ${feed.name}: re-sent ${result.pushed} app edit(s)`);
      aggregate.totalEvents += result.total;
      aggregate.created += result.created;
      aggregate.updated += result.updated;
      aggregate.deleted += result.deleted + result.duplicatesRemoved;
      await client.models.homeCalendarFeed.update({
        id: feed.id,
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: null,
        eventCount: result.total,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`ics-sync: ${feed.name} failed:`, msg);
      aggregate.errors.push(`${feed.name}: ${msg}`);
      // Record but don't throw — other feeds should still sync.
      await client.models.homeCalendarFeed.update({
        id: feed.id,
        lastSyncError: msg.slice(0, 500),
      });
    }
  }

  // Events made in the app that calendar-push missed (it was down, or the
  // calendar was just linked).
  if (active.some((f) => isTwoWayFeed(f) && f.writeNewEvents)) {
    try {
      const sent = await pushPendingNative(client, await getCreds(), active);
      if (sent) console.log(`ics-sync: sent ${sent} app event(s) to the calendar`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("ics-sync: sending app events failed:", msg);
      aggregate.errors.push(`new events: ${msg}`);
    }
  }

  console.log("ics-sync: summary", JSON.stringify(aggregate));
  return aggregate;
};
