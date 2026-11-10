import { describe, expect, it } from "vitest";
import { buildWeekSections, projectPaydays, zonedMidnight } from "./week-sections";

const TZ = "America/Chicago";
// Week of Mon 2026-11-16 … Sun 2026-11-22; "today" is the Sunday before.
const opts = { weekStart: "2026-11-16", weekEnd: "2026-11-22", today: "2026-11-15", timeZone: TZ };

describe("paydays", () => {
  it("projects a biweekly payday from regular stubs, ignoring bonus/RSU ones", () => {
    const stubs = [
      { personId: "gen", payDate: "2026-09-11", net: 5656 },
      { personId: "gen", payDate: "2026-09-25", net: 5489 },
      { personId: "gen", payDate: "2026-10-09", net: 5489 },
      { personId: "gen", payDate: "2026-10-23", net: 6279 },
      { personId: "gen", payDate: "2026-10-30", net: 24113, rsuGross: 40000 }, // off-cycle RSU stub
    ];
    expect(projectPaydays(stubs, "2026-11-16", "2026-11-22")).toEqual([{ personId: "gen", date: "2026-11-20", usualNet: 5572.5, cadence: "biweekly" }]);
    expect(projectPaydays(stubs, "2026-11-09", "2026-11-15")).toEqual([]); // the off week
  });

  it("handles semimonthly and monthly, and skips stale history", () => {
    const semi = ["2026-09-15", "2026-09-30", "2026-10-15", "2026-10-31"].map((d) => ({ personId: "a", payDate: d, net: 3000 }));
    expect(projectPaydays(semi, "2026-11-09", "2026-11-15").map((p) => [p.date, p.cadence])).toEqual([["2026-11-15", "semimonthly"]]);
    expect(projectPaydays(semi, "2026-11-23", "2026-11-30").map((p) => p.date)).toEqual(["2026-11-30"]);
    const monthly = ["2026-08-01", "2026-09-01", "2026-10-01"].map((d) => ({ personId: "b", payDate: d, net: 4000 }));
    expect(projectPaydays(monthly, "2026-10-26", "2026-11-01").map((p) => p.date)).toEqual(["2026-11-01"]);
    expect(projectPaydays(monthly, "2027-03-01", "2027-03-07")).toEqual([]); // 5 months stale
  });
});

describe("zonedMidnight", () => {
  it("is local midnight in the household timezone", () => {
    expect(zonedMidnight("2026-11-16", TZ).toISOString()).toBe("2026-11-16T06:00:00.000Z"); // CST
    expect(zonedMidnight("2026-07-06", TZ).toISOString()).toBe("2026-07-06T05:00:00.000Z"); // CDT
  });
});

describe("sections", () => {
  it("collects the week's money, to-dos, travel, care, birthdays and errands, and what needs attention", () => {
    const { sections: s, attention } = buildWeekSections(
      {
        people: [
          { id: "gen", name: "Gennaro", birthday: "1990-11-18" },
          { id: "cris", name: "Cris" },
          { id: "mom", name: "Marilene", birthday: "1900-11-21" }, // year unknown
        ],
        schedules: [
          { id: "mort", accountId: "joint", description: "Mortgage", amount: -3660, cadence: "MONTHLY", nextDate: "2026-11-17", active: true },
          { id: "c", accountId: "joint", description: "Gennaro contribution", amount: 11000, cadence: "MONTHLY", nextDate: "2026-12-01", active: true },
        ],
        transactions: [
          { id: "t1", accountId: "joint", date: "2026-11-16", description: "HEB", amount: -84.12, category: "Groceries", status: "POSTED" },
          { id: "t2", accountId: "joint", date: "2026-11-16", description: "To savings", amount: -500, category: "Transfers", status: "POSTED" },
        ],
        tasks: [
          { id: "late", title: "Renew registration", dueDate: "2026-11-10T18:00:00.000Z", assignedPersonIds: ["gen"] },
          { id: "wk", title: "Call plumber", dueDate: "2026-11-19T18:00:00.000Z" },
          { id: "later", title: "Taxes", dueDate: "2027-04-01T18:00:00.000Z" },
          { id: "done", title: "Done", dueDate: "2026-11-17T18:00:00.000Z", isCompleted: true },
          { id: "rec", title: "Water plants", recurrence: "FREQ=WEEKLY", assignedPersonIds: ["cris"] },
          // Series ended (marked completed) with its last occurrence still open: not overdue.
          { id: "ended", title: "Take trash out", recurrence: "FREQ=WEEKLY", isCompleted: true },
        ],
        occurrences: [
          { id: "o1", taskId: "rec", scheduledFor: "2026-11-18T15:00:00.000Z" },
          { id: "o0", taskId: "rec", scheduledFor: "2026-11-11T15:00:00.000Z", completedAt: "2026-11-11T16:00:00.000Z" },
          { id: "o9", taskId: "ended", scheduledFor: "2026-04-30T15:00:00.000Z" },
        ],
        reminders: [
          { id: "pill", name: "Dolce's pill", status: "PENDING", targetKind: "GROUP", items: [{ id: "i", name: "pill", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0" }] },
          { id: "paused", name: "Paused", status: "PAUSED", items: [{ id: "i", name: "x", rrule: "FREQ=DAILY" }] },
        ],
        trips: [{ id: "aus", name: "Austin", startDate: "2026-11-20", endDate: "2026-11-22", participantIds: ["gen"] }],
        legs: [
          {
            id: "l1",
            tripId: "aus",
            mode: "COMMERCIAL_FLIGHT",
            airline: "AA",
            flightNumber: "1234",
            departAt: "2026-11-20T14:30:00.000Z",
            fromLocation: { airportCode: "DFW", timezone: "America/Chicago" },
            toLocation: { airportCode: "AUS" },
          },
        ],
        reservations: [{ id: "h", tripId: "aus", type: "HOTEL", name: "Hotel Van Zandt", startAt: "2026-11-20T21:00:00.000Z" }],
        checklists: [{ id: "pack", entityType: "TRIP", entityId: "aus", name: "Packing" }],
        checklistItems: [
          { id: "1", checklistId: "pack", text: "Charger", isDone: true },
          { id: "2", checklistId: "pack", text: "Suit", isDone: false },
        ],
        pets: [{ id: "dolce", name: "Dolce" }],
        vaccines: [
          { petId: "dolce", name: "Rabies", administeredAt: "2025-11-01", nextDueAt: "2026-11-01" },
          { petId: "dolce", name: "Rabies", administeredAt: "2024-11-01", nextDueAt: "2025-11-01" }, // superseded
          { petId: "dolce", name: "Bordetella", administeredAt: "2026-05-19", nextDueAt: "2026-11-19" },
        ],
        medications: [{ petId: "dolce", name: "Apoquel", isActive: true, refillsRemaining: 0 }],
        visits: [{ id: "v", personId: "cris", visitAt: "2026-11-17T15:00:00.000Z", title: "OB visit", status: "PLANNED" }],
        pregnancies: [{ id: "p", personId: "cris", dueDate: "2027-05-20", status: "ACTIVE" }],
        careItems: [
          { id: "nt", pregnancyId: "p", title: "NT scan", status: "UPCOMING", windowStart: "2026-11-01", windowEnd: "2026-11-14" },
          { id: "gl", pregnancyId: "p", title: "Glucose test", status: "UPCOMING", windowStart: "2027-02-10", windowEnd: "2027-03-10" },
        ],
        shoppingLists: [{ id: "heb", name: "HEB", emoji: "🛒" }, { id: "empty", name: "Home Depot" }],
        shoppingItems: [
          { id: "a", listId: "heb", name: "Milk", sortOrder: 1 },
          { id: "b", listId: "heb", name: "Eggs", sortOrder: 0 },
          { id: "c", listId: "heb", name: "Bread", isChecked: true },
        ],
      },
      opts,
    );

    expect(s.finance.scheduled.map((x) => [x.description, x.date, x.amount])).toEqual([["Mortgage", "2026-11-17", -3660]]);
    expect(s.finance).toMatchObject({ scheduledOut: 3660, scheduledIn: 0 });
    expect(s.finance.transactions.map((t) => t.id)).toEqual(["t1"]); // the transfer is internal

    expect(s.todo.tasks.map((t) => [t.title, t.date, t.overdue])).toEqual([
      ["Renew registration", "2026-11-10", true],
      ["Water plants", "2026-11-18", false],
      ["Call plumber", "2026-11-19", false],
    ]);
    expect(s.todo.reminders).toEqual([
      expect.objectContaining({ name: "Dolce's pill", group: true, count: 7, times: expect.arrayContaining(["2026-11-16T14:00:00.000Z"]) }),
    ]);

    expect(s.travel.trips[0]).toMatchObject({ name: "Austin", starts: true, ends: true, checklist: { done: 1, total: 2 } });
    expect(s.travel.legs).toEqual([{ id: "l1", tripName: "Austin", date: "2026-11-20", time: "08:30", label: "AA 1234 DFW → AUS", mode: "COMMERCIAL_FLIGHT" }]);
    expect(s.travel.reservations.map((r) => [r.name, r.date, r.time])).toEqual([["Hotel Van Zandt", "2026-11-20", "15:00"]]);

    expect(s.care.pets.map((p) => [p.title, p.overdue])).toEqual([
      ["Rabies vaccine due", true],
      ["Bordetella vaccine due", false],
      ["Apoquel: no refills left", false],
    ]);
    expect(s.care.visits.map((v) => [v.title, v.date, v.time])).toEqual([["OB visit", "2026-11-17", "09:00"]]);
    expect(s.care.pregnancy).toEqual([{ personId: "cris", weeks: expect.stringMatching(/^1\dw\dd$/), items: [expect.objectContaining({ title: "NT scan", urgency: "OVERDUE" })] }]);

    expect(s.occasions).toEqual([
      { personId: "gen", name: "Gennaro", date: "2026-11-18", kind: "birthday", age: 36 },
      { personId: "mom", name: "Marilene", date: "2026-11-21", kind: "birthday", age: null },
    ]);
    expect(s.errands.shopping).toEqual([{ listId: "heb", name: "HEB", emoji: "🛒", open: 2, items: ["Eggs", "Milk"] }]);
    expect(s.errands.checklists).toEqual([{ id: "pack", name: "Packing", entityType: "TRIP", forName: "Austin", done: 1, total: 2 }]);

    expect(attention.map((a) => a.kind)).toEqual(["overdue", "trip-prep", "care", "care"]);
    expect(attention.map((a) => a.detail)).toEqual([
      "1 overdue task: Renew registration",
      "Austin starts Fri: checklist 1/2 done",
      "Dolce: Rabies vaccine was due 2026-11-01",
      "Cris: NT scan was due by 2026-11-14, not booked",
    ]);
  });
});
