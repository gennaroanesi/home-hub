import { describe, expect, it } from "vitest";
import type { OpContext } from "./context";
import { runOp } from "./registry";

/* eslint-disable @typescript-eslint/no-explicit-any */

// In-memory Amplify client: list (with the date/personId/petId filters the
// week ops use), get, create, update, delete.
function setup(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {};
  let n = 0;
  const matches = (row: any, filter: any) =>
    Object.entries(filter ?? {}).every(([k, cond]: [string, any]) => {
      if (cond.eq !== undefined) return row[k] === cond.eq;
      if (cond.between) return row[k] >= cond.between[0] && row[k] <= cond.between[1];
      return true;
    });
  const model = (name: string, key = "id") => {
    tables[name] = (seed[name] ?? []).map((r) => ({ ...r }));
    const rows = tables[name];
    return {
      list: async ({ filter }: any = {}) => ({ data: rows.filter((r) => matches(r, filter)), nextToken: null }),
      get: async (k: any) => ({ data: rows.find((r) => r[key] === k[key]) ?? null }),
      create: async (row: any) => {
        const saved = { id: `${name}-${++n}`, ...row };
        rows.push(saved);
        return { data: saved };
      },
      update: async ({ ...patch }: any) => {
        const row = rows.find((r) => r[key] === patch[key]);
        if (!row) return { data: null, errors: [{ message: "not found" }] };
        Object.assign(row, patch);
        return { data: row };
      },
      delete: async ({ id }: any) => {
        const i = rows.findIndex((r) => r.id === id);
        const [gone] = rows.splice(i, 1);
        return { data: gone };
      },
    };
  };
  const models: Record<string, any> = Object.fromEntries(
    [
      "homePerson",
      "homePet",
      "homeCalendarEvent",
      "homeCalendarDay",
      "homePetDay",
      "homeTrip",
      "homeSettings",
      "homeFinanceAccount",
      "homeFinanceRecurring",
      "homePaycheck",
      "homeTask",
      "homeTaskOccurrence",
      "homeReminder",
      "homeTripLeg",
      "homeTripReservation",
      "homeChecklist",
      "homeChecklistItem",
      "homePetVaccine",
      "homePetMedication",
      "homeMedicalVisit",
      "homePregnancy",
      "homeCareItem",
      "homeShoppingList",
      "homeShoppingItem",
    ].map((m) => [m, model(m)]),
  );
  models.homeWeekReview = model("homeWeekReview", "weekStart");
  const ctx: OpContext = {
    client: { models },
    storage: { storeFromUrl: async () => "", copyUpload: async () => "" },
    actor: { via: "whatsapp", personName: "Gennaro" },
  };
  return { ctx, tables };
}

const people = [
  { id: "gen", name: "Gennaro", groups: ["home-users"] },
  { id: "cris", name: "Cris", groups: ["home-users"] },
  { id: "guest", name: "Paulo", groups: [] }, // not household
];

describe("week ops", () => {
  it("builds the week, then the review's writes change it", async () => {
    const { ctx, tables } = setup({
      homePerson: people,
      homePet: [{ id: "dolce", name: "Dolce" }],
      homeSettings: [{ id: "s", householdTimezone: "America/Chicago" }],
      homeCalendarEvent: [{ id: "feed", title: "Appt Dr. Crozier", startAt: "2026-11-19T16:00:00.000Z", feedId: "apple" }],
    });
    const plan: any = (await runOp(ctx, "get_week_plan", { weekStart: "2026-11-18" })).valueOf();
    expect(plan.result.weekStart).toBe("2026-11-16");
    expect(plan.result.people.map((p: any) => p.name)).toEqual(["Cris", "Gennaro"]);
    expect(plan.result.attention.map((a: any) => a.kind)).toEqual(["unassigned", "no-status", "no-status"]);
    expect(plan.result.review).toBeNull();
    expect(plan.result.errors).toEqual([]);
    expect(Object.keys(plan.result.sections)).toEqual(["finance", "todo", "travel", "care", "occasions", "errands"]);

    // Gennaro (the caller) in the office Tue + Thu; then Thu cleared.
    expect((await runOp(ctx, "set_day_status", { dates: ["2026-11-17", "2026-11-19"], status: "WORKING_OFFICE" })).valueOf()).toMatchObject({
      result: { person: "Gennaro", dates: ["2026-11-17", "2026-11-19"] },
    });
    await runOp(ctx, "set_day_status", { dates: ["2026-11-19"], status: null });
    expect(tables.homeCalendarDay.map((d) => [d.personId, d.date, d.status])).toEqual([["gen", "2026-11-17", "WORKING_OFFICE"]]);

    // The family-calendar event is Cris's; "both" works too; guests can't be assigned.
    const assigned: any = await runOp(ctx, "assign_event_people", { eventId: "feed", personNames: ["cris"] });
    expect(assigned.result).toEqual({ eventId: "feed", title: "Appt Dr. Crozier", people: ["Cris"] });
    expect(((await runOp(ctx, "assign_event_people", { eventId: "feed", personNames: ["Paulo"] })) as any).error).toMatch(/No household member/);
    await runOp(ctx, "assign_event_people", { eventId: "feed", personNames: ["both"] });
    expect(tables.homeCalendarEvent[0].assignedPersonIds).toEqual(["gen", "cris"]);

    // Dolce (the only pet) at daycare Wednesday.
    expect(((await runOp(ctx, "set_pet_day", { dates: ["2026-11-18"], status: "DAYCARE" })) as any).result).toEqual({ pet: "Dolce", status: "DAYCARE", dates: ["2026-11-18"] });

    // Reviewed.
    const reviewed: any = await runOp(ctx, "mark_week_reviewed", { weekStart: "2026-11-20", notes: "light week" });
    expect(reviewed.result).toMatchObject({ weekStart: "2026-11-16", reviewedBy: "Gennaro", notes: "light week" });

    const after: any = await runOp(ctx, "get_week_plan", { weekStart: "2026-11-16" });
    expect(after.result.attention.map((a: any) => a.kind)).toEqual(["no-status", "no-status"]);
    expect(after.result.pets[0].days[2].status).toBe("DAYCARE");
    expect(after.result.people.find((p: any) => p.name === "Gennaro").days[1].status).toBe("WORKING_OFFICE");
    expect(after.result.review).toMatchObject({ reviewedBy: "Gennaro", notes: "light week" });
  });
});
