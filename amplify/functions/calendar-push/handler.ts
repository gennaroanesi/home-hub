// homeCalendarEvent stream → two-way calendars (iCloud over CalDAV). Every
// way an event is saved (web, phone, Janet, health visits, trips) reaches
// the calendar through here; rows the sync itself wrote are skipped by
// their syncHash (see lib/calendar-sync.ts). A failed edit is logged and
// re-sent by the next ics-sync run. A failed delete can't be (the row is
// gone, and the pull would bring the event back), so the batch is retried
// instead; every step is idempotent.

import type { DynamoDBStreamHandler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/calendar-push";
import type { Schema } from "../../data/resource";
import { isTwoWayFeed } from "../../../lib/calendar-feeds.js";
import { pushDelete, pushEvent, type SyncEvent } from "../../../lib/calendar-sync.js";
import { readCaldavCreds } from "../../../lib/caldav-secret.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

type Attr = { S?: string; NULL?: boolean };
const str = (img: Record<string, Attr> | undefined, k: string) => img?.[k]?.S ?? null;

export const handler: DynamoDBStreamHandler = async (event) => {
  const { data: feedRows } = await client.models.homeCalendarFeed.list({ limit: 1000 });
  const feeds = (feedRows ?? []).filter((f) => f.active !== false);
  if (!feeds.some(isTwoWayFeed)) return; // nothing to write to

  const creds = await readCaldavCreds();
  const failedDeletes: string[] = [];

  for (const rec of event.Records) {
    const id = (rec.dynamodb?.Keys as Record<string, Attr> | undefined)?.id?.S;
    if (!id) continue;
    try {
      if (rec.eventName === "REMOVE") {
        const old = rec.dynamodb?.OldImage as Record<string, Attr> | undefined;
        const done = await pushDelete(creds, { feedId: str(old, "feedId"), externalHref: str(old, "externalHref"), syncHash: str(old, "syncHash") }, feeds);
        if (done) console.log(`calendar-push: deleted ${id} from the calendar`);
        continue;
      }
      // Read the row as it is now: later changes in this batch are folded in.
      const { data: row } = await client.models.homeCalendarEvent.get({ id });
      if (!row) continue;
      const result = await pushEvent(client, creds, row as SyncEvent, feeds);
      if (result !== "skipped") console.log(`calendar-push: ${result} ${id}`);
    } catch (err) {
      console.error(`calendar-push: ${rec.eventName} ${id} failed:`, err instanceof Error ? err.message : err);
      if (rec.eventName === "REMOVE") failedDeletes.push(id);
    }
  }
  if (failedDeletes.length) throw new Error(`calendar-push: delete failed for ${failedDeletes.join(", ")}`);
};
