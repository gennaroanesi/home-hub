// The push/pull loop against an in-memory CalDAV server and table: an edit
// on either side lands on the other exactly once, and nothing echoes.

import { beforeEach, describe, expect, it, vi } from "vitest";

const server = new Map<string, { ics: string; etag: string }>();
let etagSeq = 0;

vi.mock("./caldav", async (orig) => {
  const real = await orig<typeof import("./caldav")>();
  class CaldavError extends Error {
    constructor(
      m: string,
      readonly status: number,
    ) {
      super(m);
    }
  }
  return {
    ...real,
    CaldavError,
    fetchCalendarObjects: async (_c: unknown, cal: string) =>
      [...server.entries()].filter(([u]) => u.startsWith(cal)).map(([url, o]) => ({ url, etag: o.etag, ics: o.ics })),
    getObject: async (_c: unknown, url: string) => {
      const o = server.get(url);
      return o ? { url, etag: o.etag, ics: o.ics } : null;
    },
    putObject: async (_c: unknown, url: string, ics: string, ifMatch: string | null) => {
      const cur = server.get(url);
      if (ifMatch ? cur?.etag !== ifMatch : !!cur) throw new CaldavError("412", 412);
      const etag = `"e${++etagSeq}"`;
      server.set(url, { ics, etag });
      return etag;
    },
    deleteObject: async (_c: unknown, url: string) => {
      server.delete(url);
    },
  };
});
vi.mock("./reminder-parent", () => ({ cascadeDeleteRemindersFor: async () => {} }));

const { pullCaldavFeed, pushDelete, pushEvent } = await import("./calendar-sync");
const { buildEventIcs, syncHashOf } = await import("./calendar-ics");

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const table = new Map<string, Row>();
/** Stream records the table would emit: [eventName, id, oldImage]. */
let stream: Array<[string, string, Row | null]> = [];
let idSeq = 0;

const model = {
  get: async ({ id }: { id: string }) => ({ data: table.get(id) ? { ...table.get(id) } : null }),
  list: async ({ filter }: { filter?: { feedId?: { eq: string } } }) => ({
    data: [...table.values()].filter((r) => !filter?.feedId || r.feedId === filter.feedId.eq).map((r) => ({ ...r })),
    nextToken: null,
  }),
  create: async (row: Row) => {
    const id = `row${++idSeq}`;
    table.set(id, { ...row, id });
    stream.push(["INSERT", id, null]);
    return { data: { ...row, id } };
  },
  update: async (patch: Row) => {
    const cur = table.get(patch.id)!;
    table.set(patch.id, { ...cur, ...patch });
    stream.push(["MODIFY", patch.id, null]);
    return { data: table.get(patch.id) };
  },
  delete: async ({ id }: { id: string }) => {
    const old = table.get(id)!;
    table.delete(id);
    stream.push(["REMOVE", id, old]);
    return { data: old };
  },
};
const client = { models: { homeCalendarEvent: model } };
const CAL = "https://p1-caldav.icloud.com/1/calendars/family/";
const feed = { id: "feed1", name: "Family", caldavUrl: CAL, writeNewEvents: true, active: true };
const feeds = [feed];
const creds = { username: "u", password: "p" };

/** Run the push Lambda over everything the table emitted, until it goes quiet. */
async function drainStream(): Promise<number> {
  let pushes = 0;
  for (let guard = 0; stream.length && guard < 20; guard++) {
    const batch = stream;
    stream = [];
    for (const [name, id, old] of batch) {
      if (name === "REMOVE") {
        if (await pushDelete(creds, old as never, feeds)) pushes++;
        continue;
      }
      const row = table.get(id);
      if (row && (await pushEvent(client, creds, row as never, feeds)) !== "skipped") pushes++;
    }
  }
  expect(stream).toHaveLength(0);
  return pushes;
}

beforeEach(() => {
  server.clear();
  table.clear();
  stream = [];
});

describe("two-way calendar sync", () => {
  it("imports a phone event without echoing it back", async () => {
    server.set(CAL + "a.ics", { ics: buildEventIcs("A", { title: "Swim", startAt: "2026-12-01T15:00:00Z" }), etag: '"x1"' });
    const r = await pullCaldavFeed(client, creds, feed, feeds);
    expect(r.created).toBe(1);
    expect(await drainStream()).toBe(0);
    const again = await pullCaldavFeed(client, creds, feed, feeds);
    expect(again.unchanged).toBe(1);
    expect(stream).toHaveLength(0); // no writes at all on a quiet run
  });

  it("sends an app edit once, and the next pull leaves it alone", async () => {
    server.set(CAL + "a.ics", { ics: buildEventIcs("A", { title: "Swim", startAt: "2026-12-01T15:00:00Z" }), etag: '"x1"' });
    await pullCaldavFeed(client, creds, feed, feeds);
    await drainStream();
    const [row] = table.values();
    await model.update({ id: row.id, title: "Swim lessons", assignedPersonIds: ["kid"] });
    expect(await drainStream()).toBe(1);
    expect(server.get(CAL + "a.ics")!.ics).toContain("SUMMARY:Swim lessons");
    const r = await pullCaldavFeed(client, creds, feed, feeds);
    expect(r.unchanged).toBe(1);
    expect(table.get(row.id)!.assignedPersonIds).toEqual(["kid"]);
  });

  it("an assignment-only change doesn't touch the calendar", async () => {
    server.set(CAL + "a.ics", { ics: buildEventIcs("A", { title: "Swim", startAt: "2026-12-01T15:00:00Z" }), etag: '"x1"' });
    await pullCaldavFeed(client, creds, feed, feeds);
    await drainStream();
    const [row] = table.values();
    const before = server.get(CAL + "a.ics")!.etag;
    await model.update({ id: row.id, assignedPersonIds: ["kid"] });
    expect(await drainStream()).toBe(0);
    expect(server.get(CAL + "a.ics")!.etag).toBe(before);
  });

  it("adds an event made in the app to the calendar, then treats it as the calendar's", async () => {
    await model.create({ title: "Dentist", startAt: "2026-12-02T15:00:00.000Z", endAt: "2026-12-02T16:00:00.000Z" });
    expect(await drainStream()).toBe(1);
    const [row] = table.values();
    expect(row.feedId).toBe("feed1");
    expect(server.has(CAL + row.id + ".ics")).toBe(true);
    const r = await pullCaldavFeed(client, creds, feed, feeds);
    expect(r.unchanged).toBe(1);
    expect(table.size).toBe(1);
  });

  it("adopts the app's own event if the pull sees it before the row update lands", async () => {
    const id = "native1";
    table.set(id, { id, title: "Dentist", startAt: "2026-12-02T15:00:00.000Z" });
    server.set(CAL + id + ".ics", { ics: buildEventIcs(id, table.get(id) as never), etag: '"x1"' });
    const r = await pullCaldavFeed(client, creds, feed, feeds);
    expect(r.created).toBe(0);
    expect(table.size).toBe(1);
    expect(table.get(id)!.feedId).toBe("feed1");
  });

  it("deletes on both sides without a loop", async () => {
    server.set(CAL + "a.ics", { ics: buildEventIcs("A", { title: "Swim", startAt: "2026-12-01T15:00:00Z" }), etag: '"x1"' });
    server.set(CAL + "b.ics", { ics: buildEventIcs("B", { title: "Piano", startAt: "2026-12-03T15:00:00Z" }), etag: '"x2"' });
    await pullCaldavFeed(client, creds, feed, feeds);
    await drainStream();
    // Deleted in the app → gone from the calendar.
    const a = [...table.values()].find((r) => r.externalUid === "A")!;
    await model.delete({ id: a.id });
    expect(await drainStream()).toBe(1);
    expect(server.has(CAL + "a.ics")).toBe(false);
    // Deleted on a phone → the pull removes the row, and doesn't delete anything else.
    server.delete(CAL + "b.ics");
    const r = await pullCaldavFeed(client, creds, feed, feeds);
    expect(r.deleted).toBe(1);
    expect(await drainStream()).toBe(0);
    expect(table.size).toBe(0);
  });

  it("re-sends an edit whose push failed on the next pull", async () => {
    server.set(CAL + "a.ics", { ics: buildEventIcs("A", { title: "Swim", startAt: "2026-12-01T15:00:00Z" }), etag: '"x1"' });
    await pullCaldavFeed(client, creds, feed, feeds);
    await drainStream();
    const [row] = table.values();
    await model.update({ id: row.id, title: "Swim (pool B)" });
    stream = []; // the push Lambda failed
    const r = await pullCaldavFeed(client, creds, feed, feeds);
    expect(r.pushed).toBe(1);
    expect(server.get(CAL + "a.ics")!.ics).toContain("SUMMARY:Swim (pool B)");
    expect(table.get(row.id)!.syncHash).toBe(syncHashOf(table.get(row.id) as never));
    expect(await drainStream()).toBe(0);
  });

  it("leaves long-past app events and read-only feeds alone", async () => {
    await model.create({ title: "Old", startAt: "2020-01-01T15:00:00.000Z" });
    await model.create({ title: "Work", startAt: "2026-12-02T15:00:00.000Z", feedId: "google" });
    expect(await drainStream()).toBe(0);
    expect(server.size).toBe(0);
  });
});
