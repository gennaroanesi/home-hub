import { describe, it, expect } from "vitest";
import {
  careItemFormError,
  cleanProviderPhones,
  defaultHealthPersonId,
  formatYmdShort,
  groupLabResults,
  labResultFields,
  labValueLabel,
  linkableCareItems,
  saveCareItem,
  saveVisit,
  splitVisits,
  visitDisplayTitle,
  visitFields,
  visitVitalsSummary,
} from "./health";
import { sortCareItems } from "./pregnancy";

// Minimal in-memory stand-in for the Amplify data client: one Map per model,
// create/get/update/delete/list with the { data, errors } shape.
function fakeClient() {
  const tables: Record<string, Map<string, any>> = {};
  let seq = 0;
  const model = (name: string) => {
    tables[name] ??= new Map();
    const t = tables[name];
    return {
      async create(row: any) {
        const id = `${name}-${++seq}`;
        const saved = { id, ...row };
        t.set(id, saved);
        return { data: saved };
      },
      async get({ id }: { id: string }) {
        return { data: t.get(id) ?? null };
      },
      async update(row: any) {
        const cur = t.get(row.id);
        if (!cur) return { data: null, errors: [{ message: "not found" }] };
        const next = { ...cur, ...row };
        t.set(row.id, next);
        return { data: next };
      },
      async delete({ id }: { id: string }) {
        t.delete(id);
        return { data: { id } };
      },
      async list() {
        return { data: Array.from(t.values()), nextToken: null };
      },
    };
  };
  const names = ["homeMedicalVisit", "homeCalendarEvent", "homeCareItem", "homeNote", "homeHealthProvider", "homeLabResult"];
  const models = Object.fromEntries(names.map((n) => [n, model(n)]));
  return { models, tables };
}

describe("display helpers", () => {
  it("formats a YYYY-MM-DD without timezone drift", () => {
    expect(formatYmdShort("2027-01-01")).toBe("Jan 1");
    expect(formatYmdShort(null)).toBe("");
  });

  it("titles a visit by title, then kind", () => {
    expect(visitDisplayTitle({ title: "Intake", kind: "PRENATAL" })).toBe("Intake");
    expect(visitDisplayTitle({ title: null, kind: "ULTRASOUND" })).toBe("Ultrasound");
    expect(visitDisplayTitle({})).toBe("Visit");
  });

  it("summarises vitals, or null", () => {
    expect(visitVitalsSummary({})).toBeNull();
    expect(visitVitalsSummary({ weightLb: 142, bpSystolic: 118, bpDiastolic: 76, fetalHeartRate: 150 })).toBe(
      "142 lb · BP 118/76 · FHR 150 bpm",
    );
  });

  it("picks the pregnant person first, then the household", () => {
    expect(defaultHealthPersonId([{ personId: "c", status: "ACTIVE" }], [{ id: "a" }])).toBe("c");
    expect(defaultHealthPersonId([{ personId: "c", status: "DELIVERED" }], [{ id: "a" }])).toBe("a");
    expect(defaultHealthPersonId([], [], [{ id: "z" }])).toBe("z");
  });

  it("splits upcoming (planned, future) from past", () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const { upcoming, past } = splitVisits(
      [
        { id: "a", visitAt: "2026-12-01T15:00:00.000Z", status: "PLANNED" },
        { id: "b", visitAt: "2026-11-20T15:00:00.000Z", status: "PLANNED" },
        { id: "c", visitAt: "2026-11-10T15:00:00.000Z", status: "PLANNED" },
        { id: "d", visitAt: "2026-12-05T15:00:00.000Z", status: "CANCELLED" },
        { id: "e", visitAt: "2026-10-01T15:00:00.000Z", status: "COMPLETED" },
      ],
      now,
    );
    expect(upcoming.map((v) => v.id)).toEqual(["b", "a"]);
    expect(past.map((v) => v.id)).toEqual(["d", "c", "e"]);
  });

  it("offers open care items plus the linked one", () => {
    const items = [
      { id: "1", status: "UPCOMING" },
      { id: "2", status: "DONE" },
      { id: "3", status: "SKIPPED" },
    ];
    expect(linkableCareItems(items, "2").map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("sorts care items by window then template order", () => {
    const out = sortCareItems([
      { id: "b", windowStart: "2027-01-02", sortOrder: 0 },
      { id: "c", windowStart: "2027-01-01", sortOrder: 2 },
      { id: "a", windowStart: "2027-01-01", sortOrder: 1 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["a", "c", "b"]);
  });
});

describe("lab results", () => {
  it("groups by panel + date, newest first", () => {
    const groups = groupLabResults([
      { id: "1", panel: "CBC", collectedAt: "2026-10-12", createdAt: "x" },
      { id: "2", panel: "Urine", collectedAt: "2026-11-01", createdAt: "x" },
      { id: "3", panel: "CBC", collectedAt: "2026-10-12", createdAt: "x" },
      { id: "4", panel: null, collectedAt: null, createdAt: "2026-09-01T00:00:00Z" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Urine", "CBC", "Results"]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("labels values and pending rows", () => {
    expect(labValueLabel({ id: "1", createdAt: "", valueText: "11.8", unit: "g/dL" })).toBe("11.8 g/dL");
    expect(labValueLabel({ id: "1", createdAt: "", flag: "PENDING", valueText: "x" })).toBe("pending");
  });

  it("sets valueNum only for numeric values", () => {
    expect(labResultFields({ personId: "p", testName: " Hgb ", value: "11.8" })).toMatchObject({
      testName: "Hgb",
      valueText: "11.8",
      valueNum: 11.8,
      flag: null,
      createdBy: "ui",
    });
    expect(labResultFields({ personId: "p", testName: "Type", value: "O+" }).valueNum).toBeNull();
  });
});

describe("forms", () => {
  it("parses vitals and blanks", () => {
    const f = visitFields({
      visitAt: "2026-11-20T15:00:00.000Z",
      kind: "PRENATAL",
      status: "COMPLETED",
      title: "  ",
      weight: "142.5",
      bpSystolic: "118.4",
      bpDiastolic: "",
    });
    expect(f).toMatchObject({ title: null, weightLb: 142.5, bpSystolic: 118, bpDiastolic: null, fetalHeartRate: null });
  });

  it("cleans provider phones", () => {
    expect(
      cleanProviderPhones([
        { kind: null, number: " 555 ", label: " " },
        { kind: "FAX", number: "  " },
      ]),
    ).toEqual([{ kind: "OTHER", number: "555", label: null }]);
  });

  it("validates care items", () => {
    const base = { title: "Scan", windowStart: "2027-01-01", windowEnd: "2027-01-10", status: "UPCOMING" };
    expect(careItemFormError(base)).toBeNull();
    expect(careItemFormError({ ...base, windowEnd: "2026-12-31" })).toMatch(/ends before/);
    expect(careItemFormError({ ...base, status: "SCHEDULED" })).toMatch(/booked/);
  });
});

describe("saveVisit", () => {
  it("creates the visit, its calendar event and links the care item", async () => {
    const client = fakeClient();
    const { data: item } = await client.models.homeCareItem.create({ title: "Anatomy scan", status: "UPCOMING" });
    const res = await saveVisit(client, {
      personId: "p1",
      pregnancyId: "preg",
      values: { visitAt: "2026-12-01T15:00:00.000Z", kind: "ULTRASOUND", status: "PLANNED" },
      careItemId: item.id,
      provider: { name: "Dr. Lee" },
    });
    expect(res.syncError).toBeNull();
    expect(res.eventId).toBeTruthy();
    const event = client.tables.homeCalendarEvent.get(res.eventId!);
    expect(event.title).toBe("Ultrasound visit · Dr. Lee");
    const care = client.tables.homeCareItem.get(item.id);
    expect(care).toMatchObject({ status: "SCHEDULED", scheduledAt: "2026-12-01T15:00:00.000Z", visitId: res.visit.id });
  });

  it("cancelling removes the event", async () => {
    const client = fakeClient();
    const first = await saveVisit(client, {
      personId: "p1",
      values: { visitAt: "2026-12-01T15:00:00.000Z", kind: "CHECKUP", status: "PLANNED" },
    });
    const visit = client.tables.homeMedicalVisit.get(first.visit.id);
    const res = await saveVisit(client, {
      visitId: visit.id,
      personId: "p1",
      values: { visitAt: visit.visitAt, kind: "CHECKUP", status: "CANCELLED" },
    });
    expect(res.eventId).toBeNull();
    expect(client.tables.homeCalendarEvent.size).toBe(0);
  });
});

describe("saveCareItem", () => {
  it("scheduling creates a planned visit on the calendar", async () => {
    const client = fakeClient();
    const { visitId } = await saveCareItem(client, {
      pregnancyId: "preg",
      personId: "p1",
      details: { title: "Glucose screening", category: "LAB", windowStart: "2027-01-01", windowEnd: "2027-01-28", optional: false },
      status: "SCHEDULED",
      scheduledAt: "2027-01-10T16:00:00.000Z",
      withVisit: true,
      today: "2026-11-15",
    });
    expect(visitId).toBeTruthy();
    expect(client.tables.homeMedicalVisit.get(visitId!)).toMatchObject({ kind: "LAB_DRAW", status: "PLANNED" });
  });

  it("other statuses clear the dates", async () => {
    const client = fakeClient();
    const { data: item } = await client.models.homeCareItem.create({
      title: "RhoGAM",
      status: "SCHEDULED",
      scheduledAt: "2027-01-10T16:00:00.000Z",
    });
    await saveCareItem(client, {
      itemId: item.id,
      pregnancyId: "preg",
      personId: "p1",
      details: { title: "RhoGAM", category: "TREATMENT", windowStart: "2027-01-01", windowEnd: "2027-01-08", optional: true },
      status: "NOT_APPLICABLE",
      today: "2026-11-15",
    });
    expect(client.tables.homeCareItem.get(item.id)).toMatchObject({ status: "NOT_APPLICABLE", scheduledAt: null, completedAt: null });
  });
});
