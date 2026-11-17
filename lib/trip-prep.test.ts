import { describe, expect, it } from "vitest";
import { DEPARTURE_REMINDER_KIND, departureMessage, ensureTripPrep, legInstant, tripDeparture } from "./trip-prep";

describe("leg times", () => {
  it("reads the stored wall clock in the origin's timezone", () => {
    // 7:07 PM in Austin (CST, UTC-6) is 01:07Z the next day.
    expect(legInstant("2026-11-16T19:07:00.000Z", "America/Chicago")?.toISOString()).toBe("2026-11-17T01:07:00.000Z");
    // Summer: CDT, UTC-5.
    expect(legInstant("2026-07-02T16:22:00.000Z", "America/Chicago")?.toISOString()).toBe("2026-07-02T21:22:00.000Z");
    expect(legInstant("2026-07-02T09:00:00.000Z", "Europe/Rome")?.toISOString()).toBe("2026-07-02T07:00:00.000Z");
    expect(legInstant(null, "America/Chicago")).toBeNull();
  });

  it("the trip departs with its earliest leg, whatever the leg order", () => {
    const legs = [
      { departAt: "2026-11-20T08:00:00.000Z", fromLocation: { timezone: "America/Los_Angeles" } }, // return, 16:00Z
      { departAt: "2026-11-16T19:07:00.000Z", fromLocation: { timezone: null } }, // outbound, household tz
      { departAt: null },
    ];
    expect(tripDeparture(legs, "America/Chicago")?.toISOString()).toBe("2026-11-17T01:07:00.000Z");
    expect(tripDeparture([{ departAt: "2026-11-16T19:07:00.000Z", fromLocation: { timezone: "Not/AZone" } }], "America/Chicago")?.toISOString()).toBe(
      "2026-11-17T01:07:00.000Z",
    );
    expect(tripDeparture([])).toBeNull();
  });
});

describe("departure message", () => {
  it("lists what's unchecked, grouped, capped", () => {
    const msg = departureMessage(
      "Seattle",
      [
        { name: "Every trip", items: [{ text: "Power bank", isDone: false }, { text: "Passport", isDone: true }, { text: "Chargers" }] },
        { name: "Packing", items: [{ text: "Jacket", isDone: true }] },
        { name: "Work", items: [{ text: "Laptop" }, { text: "Badge" }] },
      ],
      3,
    );
    expect(msg).toContain("Last look before Seattle");
    expect(msg).toContain("*Every trip*\n• Power bank\n• Chargers\n*Work*\n• Laptop\n…and 1 more");
    expect(msg).not.toContain("Packing");
  });

  it("says when everything is done, or there's nothing to check", () => {
    expect(departureMessage("X", [{ name: "A", items: [{ text: "a", isDone: true }] }])).toContain("Every checklist is done");
    expect(departureMessage("X", [])).toContain("No checklists on this trip");
  });
});

// ── ensureTripPrep against an in-memory client ─────────────────────────────

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function fakeClient(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { homeTrip: [], homeTripLeg: [], homeChecklist: [], homeChecklistItem: [], homeReminder: [], homeSettings: [], ...seed };
  let n = 0;
  const matches = (row: Row, filter?: Row): boolean =>
    !filter ||
    Object.entries(filter).every(([k, cond]) => {
      if (k === "and") return (cond as Row[]).every((f) => matches(row, f));
      return Object.entries(cond as Row).every(([op, v]) => (op === "eq" ? row[k] === v : true));
    });
  const model = (name: string) => ({
    get: async ({ id }: { id: string }) => ({ data: tables[name].find((r) => r.id === id) ?? null }),
    list: async ({ filter }: { filter?: Row } = {}) => ({ data: tables[name].filter((r) => matches(r, filter)), nextToken: null }),
    create: async (row: Row) => {
      const r = { id: `${name}-${++n}`, ...row };
      tables[name].push(r);
      return { data: r };
    },
    update: async (row: Row) => {
      const r = tables[name].find((x) => x.id === row.id)!;
      Object.assign(r, row);
      return { data: r };
    },
  });
  return { tables, client: { models: Object.fromEntries(Object.keys(tables).map((k) => [k, model(k)])) } };
}

const NOW = new Date("2026-11-10T12:00:00Z");
const seed = () => ({
  homeTrip: [{ id: "t1", name: "Seattle", startDate: "2026-11-16", endDate: "2026-11-20", participantIds: ["p1"] }],
  homeTripLeg: [{ id: "l1", tripId: "t1", departAt: "2026-11-16T19:07:00.000Z", fromLocation: { timezone: "America/Chicago" } }],
  homeChecklist: [
    { id: "tpl", entityType: "TEMPLATE", entityId: "templates", name: "Every trip", autoAttachTrips: true },
    { id: "tpl2", entityType: "TEMPLATE", entityId: "templates", name: "Camping" },
  ],
  homeChecklistItem: [
    { id: "i1", checklistId: "tpl", text: "Power bank", sortOrder: 0 },
    { id: "i2", checklistId: "tpl", text: "Chargers", sortOrder: 1, section: "Tech" },
  ],
});

describe("ensureTripPrep", () => {
  it("copies the auto templates once and places the reminder 5h before departure", async () => {
    const { client, tables } = fakeClient(seed());
    const r = await ensureTripPrep(client, "t1", { now: NOW, householdTz: "America/Chicago" });
    expect(r).toEqual({ checklistsAdded: ["Every trip"], reminder: "created" });
    const copy = tables.homeChecklist.find((l) => l.entityType === "TRIP")!;
    expect(copy).toMatchObject({ entityId: "t1", name: "Every trip", sourceTemplateId: "tpl" });
    expect(tables.homeChecklistItem.filter((i) => i.checklistId === copy.id).map((i) => [i.text, i.isDone, i.section])).toEqual([
      ["Power bank", false, undefined],
      ["Chargers", false, "Tech"],
    ]);
    const rem = tables.homeReminder[0];
    expect(rem).toMatchObject({ kind: DEPARTURE_REMINDER_KIND, parentType: "TRIP", parentId: "t1", targetKind: "PERSON", personId: "p1", status: "PENDING", useLlm: false });
    expect(rem.scheduledAt).toBe("2026-11-16T20:07:00.000Z"); // 7:07 PM CST = 01:07Z, minus 5h

    // Again: nothing new.
    expect(await ensureTripPrep(client, "t1", { now: NOW, householdTz: "America/Chicago" })).toEqual({ checklistsAdded: [], reminder: "kept" });
    expect(tables.homeChecklist.filter((l) => l.entityType === "TRIP")).toHaveLength(1);
    expect(tables.homeReminder).toHaveLength(1);
  });

  it("an archived copy still counts; the reminder follows a moved leg until it fires", async () => {
    const { client, tables } = fakeClient(seed());
    await ensureTripPrep(client, "t1", { now: NOW, householdTz: "America/Chicago" });
    tables.homeChecklist.find((l) => l.entityType === "TRIP")!.isArchived = true;
    tables.homeTripLeg[0].departAt = "2026-11-16T08:00:00.000Z";
    expect(await ensureTripPrep(client, "t1", { now: NOW, householdTz: "America/Chicago" })).toEqual({ checklistsAdded: [], reminder: "moved" });
    expect(tables.homeReminder[0].scheduledAt).toBe("2026-11-16T09:00:00.000Z");

    const items = JSON.parse(tables.homeReminder[0].items);
    items[0].lastFiredAt = "2026-11-16T09:00:00.000Z";
    tables.homeReminder[0].items = JSON.stringify(items);
    tables.homeTripLeg[0].departAt = "2026-11-16T10:00:00.000Z";
    expect((await ensureTripPrep(client, "t1", { now: NOW, householdTz: "America/Chicago" })).reminder).toBe("fired");
    expect(tables.homeReminder[0].scheduledAt).toBe("2026-11-16T09:00:00.000Z");
  });

  it("no reminder without a departure time, or once it's too late; past trips are left alone", async () => {
    const s = seed();
    s.homeTripLeg = [];
    const { client, tables } = fakeClient(s);
    expect((await ensureTripPrep(client, "t1", { now: NOW, householdTz: "America/Chicago" })).reminder).toBe("none");
    expect(tables.homeReminder).toHaveLength(0);

    const late = fakeClient(seed());
    expect((await ensureTripPrep(late.client, "t1", { now: new Date("2026-11-16T22:00:00Z"), householdTz: "America/Chicago" })).reminder).toBe("none");
    expect(late.tables.homeReminder).toHaveLength(0);

    const past = fakeClient(seed());
    expect(await ensureTripPrep(past.client, "t1", { now: new Date("2026-12-01T00:00:00Z") })).toEqual({ checklistsAdded: [], reminder: "none" });
    expect(past.tables.homeChecklist).toHaveLength(2);
  });

  it("a group trip reminds the household", async () => {
    const s = seed();
    s.homeTrip[0].participantIds = ["p1", "p2"];
    const { client, tables } = fakeClient(s);
    await ensureTripPrep(client, "t1", { now: NOW, householdTz: "America/Chicago" });
    expect(tables.homeReminder[0]).toMatchObject({ targetKind: "GROUP", personId: null });
  });
});
