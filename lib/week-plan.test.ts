import { describe, expect, it } from "vitest";
import { buildWeekPlan, eventsInWeek, mondayOf, weekNudgeText, weekToPlan, type EventRow } from "./week-plan";

const TZ = "America/Chicago";
// Week of Mon 2026-11-16 … Sun 2026-11-22 (CST, UTC−6).
const WEEK = "2026-11-16";
const people = [
  { id: "cris", name: "Cris" },
  { id: "gen", name: "Gennaro" },
];
const pets = [{ id: "dolce", name: "Dolce" }];
const ev = (o: Partial<EventRow>): EventRow => ({ id: Math.random().toString(36).slice(2), title: "x", startAt: "2026-11-17T15:00:00.000Z", ...o });

describe("week dates", () => {
  it("snaps to Monday and plans next week from Friday on", () => {
    expect(mondayOf("2026-11-22")).toBe("2026-11-16"); // Sunday
    expect(mondayOf("2026-11-16")).toBe("2026-11-16");
    expect(weekToPlan("2026-11-15")).toBe("2026-11-16"); // Sunday review → the coming week
    expect(weekToPlan("2026-11-13")).toBe("2026-11-16"); // Friday
    expect(weekToPlan("2026-11-12")).toBe("2026-11-09"); // Thursday → this week
  });
});

describe("events in the week", () => {
  it("places timed events in local time, all-day ones on their dates, and expands recurring ones", () => {
    const events = [
      ev({ id: "ob", title: "OB visit", startAt: "2026-11-17T15:00:00.000Z", endAt: "2026-11-17T16:00:00.000Z" }), // 09:00 CST
      ev({ id: "late", title: "Late call", startAt: "2026-11-19T03:30:00.000Z" }), // Wed 21:30 CST, not Thu
      ev({ id: "show", title: "Air show", isAllDay: true, startAt: "2026-11-21T00:00:00.000Z", endAt: "2026-11-23T00:00:00.000Z" }), // Sat+Sun
      ev({ id: "gym", title: "Gym", startAt: "2026-11-02T13:00:00.000Z", recurrence: "FREQ=WEEKLY;BYDAY=MO,TH" }),
      ev({ id: "old", title: "Last week", startAt: "2026-11-10T15:00:00.000Z" }),
    ];
    const out = eventsInWeek(events, WEEK, TZ);
    expect(out.map((e) => [e.key, e.date, e.start, e.end])).toEqual([
      ["gym@2026-11-16", "2026-11-16", "07:00", "08:00"],
      ["ob", "2026-11-17", "09:00", "10:00"],
      ["late", "2026-11-18", "21:30", "22:30"],
      ["gym@2026-11-19", "2026-11-19", "07:00", "08:00"],
      ["show@2026-11-21", "2026-11-21", null, null],
      ["show@2026-11-22", "2026-11-22", null, null],
    ]);
  });

  it("ties events to a pet named in the title", () => {
    const out = eventsInWeek([ev({ title: "Dolce Barkin Creek" }), ev({ title: "Dolcevita dinner" })], WEEK, TZ, pets);
    expect(out.map((e) => e.petIds)).toEqual([["dolce"], []]);
  });
});

describe("the plan", () => {
  it("fills days from statuses and trips, and lists what needs attention", () => {
    const plan = buildWeekPlan({
      weekStart: "2026-11-18", // any day of the week
      timeZone: TZ,
      people,
      pets,
      events: [
        ev({ id: "a", title: "OB visit", startAt: "2026-11-17T15:00:00.000Z", endAt: "2026-11-17T16:00:00.000Z", assignedPersonIds: ["cris"] }),
        ev({ id: "b", title: "PT", startAt: "2026-11-17T15:30:00.000Z", endAt: "2026-11-17T16:30:00.000Z", assignedPersonIds: ["cris"] }),
        ev({ id: "c", title: "Dentist", startAt: "2026-11-17T16:00:00.000Z", assignedPersonIds: ["cris"] }), // starts as OB ends: no overlap
        ev({ id: "feed", title: "Appt Dr. Crozier", startAt: "2026-11-19T16:00:00.000Z", feedId: "apple" }),
        ev({ id: "dog", title: "Dolce Barkin Creek", startAt: "2026-11-20T14:00:00.000Z", feedId: "apple" }),
        ev({ id: "native", title: "Dinner", startAt: "2026-11-20T00:00:00.000Z" }), // household on purpose
      ],
      days: [
        { id: "d1", date: "2026-11-16", personId: "gen", status: "WORKING_OFFICE" },
        { id: "d2", date: "2026-11-17", personId: "gen", status: "WORKING_HOME", notes: "plumber" },
      ],
      petDays: [{ id: "p1", date: "2026-11-18", petId: "dolce", status: "DAYCARE" }],
      trips: [{ id: "t", name: "Austin", startDate: "2026-11-18", endDate: "2026-11-20", participantIds: ["gen"] }],
    });
    expect(plan.weekStart).toBe("2026-11-16");
    const gen = plan.people.find((p) => p.id === "gen")!;
    expect(gen.days.slice(0, 5).map((d) => [d.status, d.source])).toEqual([
      ["WORKING_OFFICE", "set"],
      ["WORKING_HOME", "set"],
      ["TRAVEL", "trip"],
      ["TRAVEL", "trip"],
      ["TRAVEL", "trip"],
    ]);
    expect(gen.days[1].notes).toBe("plumber");
    expect(plan.pets[0].days.map((d) => d.status)).toEqual([null, null, "DAYCARE", null, null, null, null]);

    expect(plan.attention.map((a) => [a.kind, "eventKeys" in a ? a.eventKeys : a.dates])).toEqual([
      ["overlap", ["a", "b"]],
      ["overlap", ["b", "c"]],
      ["unassigned", ["feed"]], // the Dolce one is tied to the pet; the native one is household
      ["no-status", ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]], // Cris
    ]);
  });
});

describe("the Sunday nudge", () => {
  it("sums up the week and what needs a decision", () => {
    const plan = buildWeekPlan({
      weekStart: WEEK,
      timeZone: TZ,
      people,
      pets,
      events: [
        ev({ id: "a", title: "OB visit", startAt: "2026-11-17T15:00:00.000Z", endAt: "2026-11-17T16:00:00.000Z", assignedPersonIds: ["cris"] }),
        ev({ id: "b", title: "PT", startAt: "2026-11-17T15:30:00.000Z", endAt: "2026-11-17T16:30:00.000Z", assignedPersonIds: ["cris"] }),
        ev({ id: "feed", title: "Appt", startAt: "2026-11-19T16:00:00.000Z", feedId: "apple" }),
      ],
      days: [1, 2, 3, 4, 5].map((i) => ({ id: `g${i}`, date: `2026-11-${15 + i}`, personId: "gen", status: "WORKING_OFFICE" })),
      petDays: [{ id: "p", date: "2026-11-18", petId: "dolce", status: "DAYCARE" }],
    });
    expect(weekNudgeText(plan, "https://home.example/week")).toBe(
      [
        "🗓️ *Week review* · Mon, Nov 16 – Sun, Nov 22",
        "3 events on the calendar.",
        "",
        "🐾 Dolce: daycare Wed",
        "",
        "*Needs a decision*",
        "⚠️ Cris has “OB visit” (09:00–10:00) and “PT” (09:30–10:30) on Tue",
        "👤 1 family-calendar event with nobody assigned",
        "🏢 Office/home not set: Cris (5 days)",
        "",
        "10 minutes to plan it: https://home.example/week",
      ].join("\n"),
    );
  });
});
