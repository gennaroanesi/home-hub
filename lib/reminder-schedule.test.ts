import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  parseItems,
  parseRRULE,
  nextOccurrence,
  earliestNextOccurrence,
  formatScheduleLabel,
  type ReminderItem,
} from "./reminder-schedule";

// ── parseItems ──────────────────────────────────────────────────────────────
// Covers the AWSJSON-scalar round-trip: we stringify on write, but on read
// the data client may hand us either a string or an already-parsed array.
// This is the exact bug that shipped to prod before we caught it.

describe("parseItems", () => {
  it("returns [] for null / undefined", () => {
    expect(parseItems(null)).toEqual([]);
    expect(parseItems(undefined)).toEqual([]);
  });

  it("returns [] for empty string or whitespace", () => {
    expect(parseItems("")).toEqual([]);
    expect(parseItems("   ")).toEqual([]);
  });

  it("returns [] for garbage (non-JSON string)", () => {
    expect(parseItems("not json at all")).toEqual([]);
    expect(parseItems("{broken")).toEqual([]);
  });

  it("returns [] for a JSON value that isn't an array", () => {
    expect(parseItems('"hello"')).toEqual([]);
    expect(parseItems("42")).toEqual([]);
    expect(parseItems('{"not":"an array"}')).toEqual([]);
  });

  it("passes through an array value unchanged", () => {
    const items: ReminderItem[] = [
      { id: "a", name: "B12", rrule: "RRULE:FREQ=DAILY" },
    ];
    expect(parseItems(items)).toEqual(items);
  });

  it("parses a JSON-stringified array", () => {
    const items: ReminderItem[] = [
      { id: "a", name: "B12", rrule: "RRULE:FREQ=DAILY" },
      { id: "b", name: "Omega-3", rrule: "RRULE:FREQ=DAILY;BYHOUR=9,21" },
    ];
    expect(parseItems(JSON.stringify(items))).toEqual(items);
  });

  it("returns [] for non-string non-array inputs", () => {
    expect(parseItems(42)).toEqual([]);
    expect(parseItems(true)).toEqual([]);
    expect(parseItems({ name: "oops" })).toEqual([]);
  });
});

// ── parseRRULE ──────────────────────────────────────────────────────────────

describe("parseRRULE", () => {
  it("strips the RRULE: prefix and parses FREQ", () => {
    expect(parseRRULE("RRULE:FREQ=DAILY")).toMatchObject({ freq: "DAILY" });
    expect(parseRRULE("FREQ=WEEKLY")).toMatchObject({ freq: "WEEKLY" });
  });

  it("parses BYHOUR as a list of numbers", () => {
    expect(parseRRULE("RRULE:FREQ=DAILY;BYHOUR=9,21")).toMatchObject({
      byhour: [9, 21],
    });
  });

  it("parses BYDAY as uppercased strings", () => {
    expect(parseRRULE("RRULE:FREQ=WEEKLY;BYDAY=mo,th")).toMatchObject({
      byday: ["MO", "TH"],
    });
  });

  it("parses BYMONTHDAY", () => {
    expect(parseRRULE("RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15")).toMatchObject({
      bymonthday: [1, 15],
    });
  });

  it("parses INTERVAL", () => {
    expect(parseRRULE("RRULE:FREQ=HOURLY;INTERVAL=6")).toMatchObject({
      interval: 6,
    });
  });

  it("ignores unknown keys silently", () => {
    const result = parseRRULE("RRULE:FREQ=DAILY;UNKNOWN=garbage;BYHOUR=8");
    expect(result.freq).toBe("DAILY");
    expect(result.byhour).toEqual([8]);
  });
});

// ── nextOccurrence ──────────────────────────────────────────────────────────
// Anchor tests against a fixed `now` so they're reproducible. Jan 15, 2026
// was chosen arbitrarily — middle of a month, Thursday, clear of DST.
//
// The rrule library uses the current wall-clock time as DTSTART when none
// is provided in the rule string. That means `rule.after(someDate)` silently
// depends on "now". We freeze the clock here so the test is deterministic.

const NOW = new Date("2026-01-15T12:00:00.000Z");

describe("nextOccurrence", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns null for an item with neither firesAt nor rrule", () => {
    expect(nextOccurrence({ id: "x", name: "x" }, NOW)).toBeNull();
  });

  it("returns null for an invalid firesAt", () => {
    expect(
      nextOccurrence({ id: "x", name: "x", firesAt: "not a date" }, NOW)
    ).toBeNull();
  });

  it("returns firesAt verbatim when it's in the future", () => {
    const future = "2026-01-15T18:00:00.000Z";
    expect(
      nextOccurrence({ id: "x", name: "x", firesAt: future }, NOW)?.toISOString()
    ).toBe(future);
  });

  it("returns null for a past firesAt", () => {
    expect(
      nextOccurrence({ id: "x", name: "x", firesAt: "2026-01-15T06:00:00.000Z" }, NOW)
    ).toBeNull();
  });

  it("returns null when firesAt is after the endDate", () => {
    expect(
      nextOccurrence(
        {
          id: "x",
          name: "x",
          firesAt: "2026-02-01T08:00:00.000Z",
          endDate: "2026-01-20",
        },
        NOW
      )
    ).toBeNull();
  });

  it("computes next daily RRULE occurrence in household-local time", () => {
    // NOW = 2026-01-15T12:00Z = 6 AM Central (CST, UTC-6). Rule says
    // BYHOUR=20 meaning 8 PM Central. Next fire = 8 PM CST today =
    // 2026-01-16T02:00Z.
    const next = nextOccurrence(
      {
        id: "x",
        name: "x",
        rrule: "RRULE:FREQ=DAILY;BYHOUR=20;BYMINUTE=0",
      },
      NOW
    );
    expect(next?.toISOString()).toBe("2026-01-16T02:00:00.000Z");
  });

  it("respects CDT summer offset when computing occurrence", () => {
    // Regression test for the 3:49 AM Aspirin reminder bug: BYHOUR=9
    // was being interpreted as 9 UTC (= 4 AM CDT) instead of 9 AM CDT
    // (= 14 UTC). After the fix, the picker's "9:00am" should mean
    // 9 AM household-local regardless of season.
    const aprNow = new Date("2026-04-22T08:00:00.000Z"); // 3 AM CDT
    vi.setSystemTime(aprNow);
    const next = nextOccurrence(
      {
        id: "x",
        name: "x",
        rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      },
      aprNow
    );
    expect(next?.toISOString()).toBe("2026-04-22T14:00:00.000Z");
    vi.setSystemTime(NOW); // restore
  });

  it("skips the TZ shim when RRULE already has a DTSTART with TZID", () => {
    // We don't assert the exact output (rrule.js requires luxon as a
    // peer dep for reliable TZID interpretation, and we don't use it).
    // What we assert is that our naive-UTC shim does NOT get applied
    // when the rule declares its own TZID — the code path is different.
    // Concretely: the output must differ from what our Central shim
    // would produce for the same BYHOUR on the same NOW.
    const ruleWithTz =
      "DTSTART;TZID=America/New_York:20260101T090000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
    const ruleWithoutTz = "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
    const withTz = nextOccurrence({ id: "x", name: "x", rrule: ruleWithTz }, NOW);
    const withoutTz = nextOccurrence({ id: "x", name: "x", rrule: ruleWithoutTz }, NOW);
    expect(withTz).not.toBeNull();
    expect(withoutTz).not.toBeNull();
    // Central shim output (withoutTz): 9 AM CST = 15 UTC on Jan 15.
    expect(withoutTz?.toISOString()).toBe("2026-01-15T15:00:00.000Z");
    // TZID branch takes a different path; assert it's at least different.
    expect(withTz?.toISOString()).not.toBe(withoutTz?.toISOString());
  });

  it("respects startDate — no fire before it", () => {
    // Daily at 8am, but startDate in Feb — next after Jan 15 should be Feb 1.
    const next = nextOccurrence(
      {
        id: "x",
        name: "x",
        rrule: "RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
        startDate: "2026-02-01",
      },
      NOW
    );
    // We don't pin the exact time because startDate is a date-only. What
    // matters is that we don't fire before Feb 1.
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-02-01T00:00:00.000Z").getTime()
    );
  });

  it("respects endDate — no fire after it", () => {
    // Daily rule that ended yesterday → null.
    expect(
      nextOccurrence(
        {
          id: "x",
          name: "x",
          rrule: "RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
          endDate: "2026-01-10",
        },
        NOW
      )
    ).toBeNull();
  });

  it("returns null for an invalid RRULE", () => {
    expect(
      nextOccurrence(
        { id: "x", name: "x", rrule: "not-a-real-rule" },
        NOW
      )
    ).toBeNull();
  });
});

// ── earliestNextOccurrence ─────────────────────────────────────────────────

describe("earliestNextOccurrence", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns null for an empty items array", () => {
    expect(earliestNextOccurrence([], NOW)).toBeNull();
  });

  it("returns null when all items have no more occurrences", () => {
    const items: ReminderItem[] = [
      { id: "a", name: "a", firesAt: "2026-01-10T08:00:00.000Z" }, // past
      {
        id: "b",
        name: "b",
        rrule: "RRULE:FREQ=DAILY",
        endDate: "2026-01-01",
      }, // past endDate
    ];
    expect(earliestNextOccurrence(items, NOW)).toBeNull();
  });

  it("returns the earliest of multiple future occurrences", () => {
    const items: ReminderItem[] = [
      { id: "a", name: "a", firesAt: "2026-01-15T20:00:00.000Z" },
      { id: "b", name: "b", firesAt: "2026-01-15T14:00:00.000Z" }, // ← earliest
      { id: "c", name: "c", firesAt: "2026-01-16T08:00:00.000Z" },
    ];
    const earliest = earliestNextOccurrence(items, NOW);
    expect(earliest?.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("mixes one-shot and recurring items correctly", () => {
    const items: ReminderItem[] = [
      { id: "a", name: "a", rrule: "RRULE:FREQ=DAILY;BYHOUR=20;BYMINUTE=0" }, // 8pm today
      { id: "b", name: "b", firesAt: "2026-01-15T14:00:00.000Z" }, // 2pm today
    ];
    const earliest = earliestNextOccurrence(items, NOW);
    expect(earliest?.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });
});

// ── formatScheduleLabel ─────────────────────────────────────────────────────

describe("formatScheduleLabel", () => {
  it("renders an empty schedule as an empty string", () => {
    expect(formatScheduleLabel({})).toBe("");
    expect(formatScheduleLabel({ firesAt: null, rrule: null })).toBe("");
  });

  it("renders once/firesAt with locale datetime", () => {
    const label = formatScheduleLabel({ firesAt: "2026-04-21T15:00:00.000Z" });
    expect(label).toMatch(/^once @ /);
  });

  it("renders daily with a single hour", () => {
    expect(
      formatScheduleLabel({ rrule: "RRULE:FREQ=DAILY;BYHOUR=20;BYMINUTE=0" })
    ).toBe("daily @ 8:00pm");
  });

  it("renders daily with multiple hours", () => {
    expect(
      formatScheduleLabel({ rrule: "RRULE:FREQ=DAILY;BYHOUR=9,21;BYMINUTE=0" })
    ).toBe("daily @ 9:00am, 9:00pm");
  });

  it("renders daily at midnight correctly", () => {
    expect(
      formatScheduleLabel({ rrule: "RRULE:FREQ=DAILY;BYHOUR=0;BYMINUTE=0" })
    ).toBe("daily @ 12:00am");
  });

  it("renders daily at noon correctly", () => {
    expect(
      formatScheduleLabel({ rrule: "RRULE:FREQ=DAILY;BYHOUR=12;BYMINUTE=0" })
    ).toBe("daily @ 12:00pm");
  });

  it("renders weekly with days and time", () => {
    expect(
      formatScheduleLabel({
        rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=7;BYMINUTE=0",
      })
    ).toBe("Mon, Thu @ 7:00am");
  });

  it("renders monthly with ordinal day", () => {
    expect(
      formatScheduleLabel({
        rrule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0",
      })
    ).toBe("1st of each month @ 10:00am");
    expect(
      formatScheduleLabel({
        rrule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=10;BYMINUTE=0",
      })
    ).toBe("15th of each month @ 10:00am");
    expect(
      formatScheduleLabel({
        rrule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=22;BYHOUR=10;BYMINUTE=0",
      })
    ).toBe("22nd of each month @ 10:00am");
    expect(
      formatScheduleLabel({
        rrule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=3;BYHOUR=10;BYMINUTE=0",
      })
    ).toBe("3rd of each month @ 10:00am");
  });

  it("falls back to raw rrule for unrecognized FREQ", () => {
    expect(
      formatScheduleLabel({ rrule: "RRULE:FREQ=HOURLY;INTERVAL=6" })
    ).toBe("FREQ=HOURLY;INTERVAL=6");
  });
});
