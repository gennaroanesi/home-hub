import { describe, expect, it } from "vitest";

import {
  bucketTasks,
  eventOccurrences,
  relativeDayLabel,
  upcomingTrips,
} from "./dashboard";

// Local-time constructor so tests don't depend on the machine's TZ.
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);

const NOW = at(2026, 9, 23, 10, 0); // Wed Sep 23 2026, 10:00 local

describe("bucketTasks", () => {
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: id,
    ...extra,
  });

  it("buckets by due date relative to the local day", () => {
    const b = bucketTasks(
      [
        task("overdue", { dueDate: at(2026, 9, 22, 18).toISOString() }),
        task("earlier-today", { dueDate: at(2026, 9, 23, 8).toISOString() }),
        task("tonight", { dueDate: at(2026, 9, 23, 23, 30).toISOString() }),
        task("friday", { dueDate: at(2026, 9, 25, 9).toISOString() }),
        task("next-month", { dueDate: at(2026, 10, 20).toISOString() }),
        task("whenever"),
        task("done", { dueDate: at(2026, 9, 20).toISOString(), isCompleted: true }),
      ],
      NOW,
    );
    expect(b.overdue.map((t) => t.task.id)).toEqual(["overdue"]);
    // Due earlier today is "today", not overdue.
    expect(b.today.map((t) => t.task.id)).toEqual(["earlier-today", "tonight"]);
    expect(b.upcoming.map((t) => t.task.id)).toEqual(["friday"]);
    expect(b.anytime.map((t) => t.task.id)).toEqual(["whenever"]);
  });

  it("places undated recurring tasks by their next occurrence", () => {
    const b = bucketTasks(
      [
        task("daily", { recurrence: "RRULE:FREQ=DAILY" }),
        task("yearly", { recurrence: "RRULE:FREQ=YEARLY" }),
        task("broken", { recurrence: "not a rule" }),
      ],
      NOW,
    );
    expect(b.upcoming.map((t) => t.task.id)).toEqual(["daily"]);
    expect(b.today.map((t) => t.task.id)).toEqual(["broken"]);
    expect([...b.overdue, ...b.anytime]).toHaveLength(0);
  });
});

describe("eventOccurrences", () => {
  const from = at(2026, 9, 23);
  const to = at(2026, 9, 30);

  it("keeps events in the window and expands recurrences", () => {
    const occ = eventOccurrences(
      [
        { id: "past", title: "past", startAt: at(2026, 9, 20, 9).toISOString() },
        { id: "later", title: "later", startAt: at(2026, 10, 5, 9).toISOString() },
        { id: "fri", title: "fri", startAt: at(2026, 9, 25, 14).toISOString() },
        {
          id: "weekly",
          title: "weekly",
          startAt: at(2026, 9, 1, 8).toISOString(), // a Tuesday
          endAt: at(2026, 9, 1, 9).toISOString(),
          recurrence: "RRULE:FREQ=WEEKLY",
        },
      ],
      from,
      to,
    );
    expect(occ.map((o) => o.event.id)).toEqual(["fri", "weekly"]);
    expect(occ[1].start.getDate()).toBe(29);
  });

  it("includes a multi-day event already in progress, all-day first", () => {
    const occ = eventOccurrences(
      [
        { id: "timed", title: "timed", startAt: at(2026, 9, 23, 9).toISOString() },
        {
          id: "conference",
          title: "conference",
          startAt: at(2026, 9, 22).toISOString(),
          endAt: at(2026, 9, 25).toISOString(),
          isAllDay: true,
        },
        {
          id: "allday-today",
          title: "allday-today",
          startAt: at(2026, 9, 23).toISOString(),
          isAllDay: true,
        },
      ],
      from,
      to,
    );
    expect(occ.map((o) => o.event.id)).toEqual(["conference", "allday-today", "timed"]);
  });
});

describe("upcomingTrips", () => {
  const trips = [
    { id: "done", name: "done", startDate: "2026-09-01", endDate: "2026-09-10" },
    { id: "now", name: "now", startDate: "2026-09-20", endDate: "2026-09-23" },
    { id: "soon", name: "soon", startDate: "2026-10-10", endDate: "2026-10-12" },
    { id: "far", name: "far", startDate: "2027-03-01", endDate: "2027-03-05" },
  ];

  it("returns ongoing and upcoming trips within the horizon", () => {
    const res = upcomingTrips(trips, "2026-09-23", 60);
    expect(res.map((t) => [t.trip.id, t.ongoing, t.daysAway])).toEqual([
      ["now", true, 0],
      ["soon", false, 17],
    ]);
  });
});

describe("relativeDayLabel", () => {
  it("labels nearby days by name", () => {
    expect(relativeDayLabel(at(2026, 9, 23, 22), NOW)).toBe("Today");
    expect(relativeDayLabel(at(2026, 9, 24, 1), NOW)).toBe("Tomorrow");
    expect(relativeDayLabel(at(2026, 9, 26), NOW)).toBe("Sat");
    expect(relativeDayLabel(at(2026, 10, 12), NOW)).toBe("Oct 12");
  });
});
