// Per-feed settings for imported calendars (homeCalendarFeed): who the
// feed's events belong to, and which features read them. Every reader of
// homeCalendarEvent goes through `eventsFor`, so a work calendar can show
// on the calendar without crowding the week planner, and its events land
// in the owner's row instead of asking "who is it for?".

export const FEED_USES = ["CALENDAR", "WEEK", "SUMMARY", "AGENT"] as const;
export type FeedUse = (typeof FEED_USES)[number];

export const FEED_USE_LABELS: Record<FeedUse, string> = {
  CALENDAR: "Calendar & home",
  WEEK: "Week planner",
  SUMMARY: "Daily summary",
  AGENT: "Janet",
};

/** ASK: assign each event by hand (the planner asks). HOUSEHOLD: everyone's. PEOPLE: ownerPersonIds'. */
export const FEED_OWNER_MODES = ["ASK", "HOUSEHOLD", "PEOPLE"] as const;
export type FeedOwnerMode = (typeof FEED_OWNER_MODES)[number];

export interface FeedSettings {
  id: string;
  ownerMode?: string | null;
  ownerPersonIds?: (string | null)[] | null;
  uses?: (string | null)[] | null;
}

export interface FeedEvent {
  feedId?: string | null;
  assignedPersonIds?: (string | null)[] | null;
}

/** A feed with no `uses` saved predates the setting and is used everywhere. */
export function feedUsedFor(feed: FeedSettings, use: FeedUse): boolean {
  const uses = (feed.uses ?? []).filter(Boolean);
  return uses.length === 0 ? true : uses.includes(use);
}

export function feedOwnerMode(feed: FeedSettings | undefined): FeedOwnerMode {
  const mode = feed?.ownerMode;
  if (mode === "HOUSEHOLD") return "HOUSEHOLD";
  if (mode === "PEOPLE" && (feed?.ownerPersonIds ?? []).some(Boolean)) return "PEOPLE";
  return "ASK";
}

/**
 * The events `use` should see: native events, plus events from feeds used
 * for it (events whose feed is gone are kept). An event nobody was assigned
 * to takes its feed's owners; `feedOwned` is true when the feed settles who
 * it's for, so nothing should ask.
 */
export function eventsFor<E extends FeedEvent>(events: E[], feeds: FeedSettings[], use: FeedUse): Array<E & { feedOwned: boolean }> {
  const byId = new Map(feeds.map((f) => [f.id, f]));
  const out: Array<E & { feedOwned: boolean }> = [];
  for (const e of events) {
    const feed = e.feedId ? byId.get(e.feedId) : undefined;
    if (feed && !feedUsedFor(feed, use)) continue;
    const own = (e.assignedPersonIds ?? []).filter((x): x is string => !!x);
    const mode = feedOwnerMode(feed);
    if (own.length || mode === "ASK") {
      out.push({ ...e, feedOwned: !!feed && mode !== "ASK" });
    } else {
      const owners = mode === "PEOPLE" ? (feed!.ownerPersonIds ?? []).filter((x): x is string => !!x) : [];
      out.push({ ...e, assignedPersonIds: owners, feedOwned: true });
    }
  }
  return out;
}

/** Feed rows that share an ICS UID; all but one are duplicates to delete. Keeps a hand-assigned row if there is one. */
export function duplicateFeedRows<E extends { id: string; externalUid?: string | null; assignedPersonIds?: (string | null)[] | null; createdAt?: string | null }>(
  rows: E[],
): { keep: Map<string, E>; extra: E[] } {
  const keep = new Map<string, E>();
  const extra: E[] = [];
  const score = (e: E) => ((e.assignedPersonIds ?? []).some(Boolean) ? 1 : 0);
  for (const e of rows) {
    if (!e.externalUid) continue;
    const cur = keep.get(e.externalUid);
    if (!cur) {
      keep.set(e.externalUid, e);
      continue;
    }
    const better = score(e) > score(cur) || (score(e) === score(cur) && (e.createdAt ?? "") < (cur.createdAt ?? ""));
    if (better) {
      extra.push(cur);
      keep.set(e.externalUid, e);
    } else {
      extra.push(e);
    }
  }
  return { keep, extra };
}
