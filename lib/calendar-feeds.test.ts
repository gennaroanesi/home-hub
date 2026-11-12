import { describe, expect, it } from "vitest";
import { duplicateFeedRows, eventsFor, feedUsedFor } from "./calendar-feeds";

const work = { id: "work", ownerMode: "PEOPLE", ownerPersonIds: ["gen"], uses: ["CALENDAR", "SUMMARY"] };
const family = { id: "family", ownerMode: null, ownerPersonIds: null, uses: null };
const shared = { id: "shared", ownerMode: "HOUSEHOLD", uses: [] };

describe("eventsFor", () => {
  const events = [
    { id: "native", feedId: null, assignedPersonIds: [] },
    { id: "busy", feedId: "work", assignedPersonIds: [] },
    { id: "busy-cris", feedId: "work", assignedPersonIds: ["cris"] },
    { id: "appt", feedId: "family", assignedPersonIds: [] },
    { id: "bbq", feedId: "shared", assignedPersonIds: null },
    { id: "orphan", feedId: "deleted-feed", assignedPersonIds: [] },
  ];

  it("leaves out feeds not used for that feature", () => {
    expect(eventsFor(events, [work, family, shared], "WEEK").map((e) => e.id)).toEqual(["native", "appt", "bbq", "orphan"]);
    expect(eventsFor(events, [work, family, shared], "CALENDAR").map((e) => e.id)).toEqual(["native", "busy", "busy-cris", "appt", "bbq", "orphan"]);
    expect(feedUsedFor({ id: "x", uses: [null] }, "AGENT")).toBe(true);
  });

  it("fills owners from the feed unless the event has its own", () => {
    const out = new Map(eventsFor(events, [work, family, shared], "CALENDAR").map((e) => [e.id, e]));
    expect(out.get("busy")).toMatchObject({ assignedPersonIds: ["gen"], feedOwned: true });
    expect(out.get("busy-cris")).toMatchObject({ assignedPersonIds: ["cris"], feedOwned: true });
    expect(out.get("appt")).toMatchObject({ assignedPersonIds: [], feedOwned: false }); // ASK: the planner asks
    expect(out.get("bbq")).toMatchObject({ assignedPersonIds: [], feedOwned: true }); // household, nobody asked
    expect(out.get("native")!.feedOwned).toBe(false);
  });

  it("treats PEOPLE with nobody picked as ASK", () => {
    const [e] = eventsFor([{ feedId: "f", assignedPersonIds: [] }], [{ id: "f", ownerMode: "PEOPLE", ownerPersonIds: [] }], "WEEK");
    expect(e.feedOwned).toBe(false);
  });
});

describe("duplicateFeedRows", () => {
  it("keeps one row per UID, preferring a hand-assigned one, then the oldest", () => {
    const rows = [
      { id: "a1", externalUid: "A", createdAt: "2026-11-12T10:00:00Z" },
      { id: "a2", externalUid: "A", createdAt: "2026-11-12T09:00:00Z" },
      { id: "a3", externalUid: "A", createdAt: "2026-11-12T11:00:00Z", assignedPersonIds: ["gen"] },
      { id: "b1", externalUid: "B", createdAt: "2026-11-12T10:00:00Z" },
      { id: "b2", externalUid: "B", createdAt: "2026-11-12T09:30:00Z" },
      { id: "c1", externalUid: "C" },
      { id: "native", externalUid: null },
    ];
    const { keep, extra } = duplicateFeedRows(rows);
    expect([...keep.values()].map((r) => r.id)).toEqual(["a3", "b2", "c1"]);
    expect(extra.map((r) => r.id).sort()).toEqual(["a1", "a2", "b1"]);
  });
});
