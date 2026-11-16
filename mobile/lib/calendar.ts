// Helpers for the Calendar tab.
//
// Recurring events live in homeCalendarEvent as a single base row
// with an RRULE string. The agenda needs to expand each rule into
// concrete occurrences in the window the user is looking at — the
// web app does the same thing with rrule.between(). We keep the
// expansion logic here so EventFormModal and the screen can share it.

import { RRule } from "rrule";

import { eventsFor, type FeedUse } from "../../lib/calendar-feeds";
import { listAllPages } from "../../lib/list-all";
import type { Schema } from "../../amplify/data/resource";
import { getClient } from "./amplify";

type Event = Schema["homeCalendarEvent"]["type"];
type Feed = Schema["homeCalendarFeed"]["type"];

/**
 * Every event row (all pages; a single list() stops at 100) as `use`
 * should see them: per-feed settings applied by lib/calendar-feeds.ts
 * `eventsFor`, the same reader the web uses. Drops feeds not used there
 * and fills an unassigned feed event's people from its feed's owner.
 * Imported events stay read-only in EventFormModal, so the filled-in
 * people are never written back.
 */
export async function loadCalendarEvents(use: FeedUse): Promise<Array<Event & { feedOwned: boolean }>> {
  const client = getClient();
  const [events, feeds] = await Promise.all([
    listAllPages<Event>(client.models.homeCalendarEvent, { limit: 1000 }),
    listAllPages<Feed>(client.models.homeCalendarFeed),
  ]);
  return eventsFor(events, feeds, use);
}

export interface AgendaEvent {
  event: Event;
  start: Date;
  end: Date;
  /** True if this is the result of expanding a recurrence rule. */
  isRecurrenceInstance: boolean;
}

/**
 * Expand an array of homeCalendarEvent rows into concrete agenda
 * occurrences in [from, to). Non-recurring events pass through if
 * their startAt falls in the window. Recurring events get expanded
 * via rrule.between().
 */
export function expandEvents(
  events: Event[],
  from: Date,
  to: Date
): AgendaEvent[] {
  const out: AgendaEvent[] = [];
  for (const event of events) {
    const baseStart = new Date(event.startAt);
    const duration = event.endAt
      ? new Date(event.endAt).getTime() - baseStart.getTime()
      : 60 * 60 * 1000;

    if (event.recurrence) {
      try {
        const parsed = RRule.fromString(event.recurrence);
        const rule = new RRule({ ...parsed.origOptions, dtstart: baseStart });
        for (const occ of rule.between(from, to, true)) {
          out.push({
            event,
            start: occ,
            end: new Date(occ.getTime() + duration),
            isRecurrenceInstance: true,
          });
        }
      } catch {
        // Malformed RRULE → fall back to the base occurrence so the
        // event isn't invisible.
        if (baseStart >= from && baseStart < to) {
          out.push({
            event,
            start: baseStart,
            end: new Date(baseStart.getTime() + duration),
            isRecurrenceInstance: false,
          });
        }
      }
    } else if (baseStart >= from && baseStart < to) {
      out.push({
        event,
        start: baseStart,
        end: new Date(baseStart.getTime() + duration),
        isRecurrenceInstance: false,
      });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Group occurrences by their local-date YYYY-MM-DD. */
export function groupByDay(occurrences: AgendaEvent[]): Map<string, AgendaEvent[]> {
  const groups = new Map<string, AgendaEvent[]>();
  for (const occ of occurrences) {
    const key = isoDate(occ.start);
    const arr = groups.get(key) ?? [];
    arr.push(occ);
    groups.set(key, arr);
  }
  return groups;
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDayLabel(dateKey: string): string {
  const today = isoDate(new Date());
  const tomorrow = isoDate(new Date(Date.now() + 86400_000));
  if (dateKey === today) return "Today";
  if (dateKey === tomorrow) return "Tomorrow";
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function formatEventTime(occ: AgendaEvent): string {
  if (occ.event.isAllDay) return "All day";
  return occ.start.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
