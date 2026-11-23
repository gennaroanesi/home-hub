import { describe, expect, it } from "vitest";
import ical from "node-ical";
import { allDayDate, allDayEnd, buildEventIcs, patchEventIcs, rruleOf, syncHashOf } from "./calendar-ics";
import { eventPayloadFromVevent, vevents } from "./calendar-sync";
import { parseMultistatus } from "./caldav";

const NOW = new Date("2026-11-23T15:00:00Z");

describe("syncHashOf", () => {
  it("ignores fields the calendar doesn't hold and normalizes times", () => {
    const a = { title: "Dentist", startAt: "2026-12-01T15:00:00Z", endAt: "2026-12-01T16:00:00.000Z", description: null };
    const b = { ...a, startAt: "2026-12-01T15:00:00.000Z", description: "", assignedPersonIds: ["x"] };
    expect(syncHashOf(a)).toBe(syncHashOf(b));
    expect(syncHashOf({ ...a, title: "Dentist!" })).not.toBe(syncHashOf(a));
    expect(syncHashOf({ ...a, location: { city: "Austin" } })).not.toBe(syncHashOf(a));
  });
});

describe("all-day dates", () => {
  it("reads the pull's midnight UTC as that date and the forms' local times in the household zone", () => {
    expect(allDayDate("2026-12-25T00:00:00.000Z")).toBe("20261225");
    expect(allDayDate("2026-12-25T06:00:00.000Z")).toBe("20261225"); // local midnight, CST
    expect(allDayEnd("2026-12-25T00:00:00.000Z", "2026-12-26T00:00:00.000Z")).toBe("20261226");
    // phone form: end of the last day, local
    expect(allDayEnd("2026-12-25T06:00:00.000Z", "2026-12-27T05:59:59.999Z")).toBe("20261227");
    expect(allDayEnd("2026-12-25T06:00:00.000Z", null)).toBe("20261226");
  });
});

describe("rruleOf", () => {
  it("takes the RRULE out of rrule.js's DTSTART form", () => {
    expect(rruleOf("DTSTART:20261201T150000Z\nRRULE:FREQ=WEEKLY;BYDAY=TU")).toBe("FREQ=WEEKLY;BYDAY=TU");
    expect(rruleOf("RRULE:FREQ=DAILY")).toBe("FREQ=DAILY");
    expect(rruleOf("FREQ=MONTHLY;INTERVAL=2")).toBe("FREQ=MONTHLY;INTERVAL=2");
    expect(rruleOf("")).toBeNull();
  });
});

describe("buildEventIcs", () => {
  it("round-trips through the pull's parser", () => {
    const e = {
      title: "Pediatrician, checkup; bring card",
      description: "Line 1\nLine 2",
      startAt: "2026-12-01T15:30:00.000Z",
      endAt: "2026-12-01T16:15:00.000Z",
      location: { city: "Round Rock, TX" },
      url: "https://example.com/a",
      recurrence: null,
    };
    const ics = buildEventIcs("abc-123", e, NOW);
    expect(ics).toContain("UID:abc-123");
    const [v] = vevents(ics);
    const p = eventPayloadFromVevent(v)!;
    expect(p.title).toBe(e.title);
    expect(p.description).toBe(e.description);
    expect(p.startAt).toBe(e.startAt);
    expect(p.endAt).toBe(e.endAt);
    expect(p.isAllDay).toBe(false);
    expect(p.location?.city).toBe("Round Rock, TX");
    expect(p.url).toBe(e.url);
    expect(syncHashOf(p)).toBe(syncHashOf(e));
  });

  it("writes a new recurring event in the household zone", () => {
    const ics = buildEventIcs("r1", { title: "Swim", startAt: "2026-12-01T15:00:00.000Z", endAt: "2026-12-01T16:00:00.000Z", recurrence: "RRULE:FREQ=WEEKLY" }, NOW);
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("DTSTART;TZID=America/Chicago:20261201T090000");
    const p = eventPayloadFromVevent(vevents(ics)[0])!;
    expect(p.startAt).toBe("2026-12-01T15:00:00.000Z");
    expect(rruleOf(p.recurrence)).toBe("FREQ=WEEKLY");
  });

  it("writes all-day events as dates", () => {
    const ics = buildEventIcs("d1", { title: "Holiday", startAt: "2026-12-25T06:00:00.000Z", endAt: "2026-12-26T05:59:59.999Z", isAllDay: true }, NOW);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261225");
    expect(ics).toContain("DTEND;VALUE=DATE:20261226");
    const p = eventPayloadFromVevent(vevents(ics)[0])!;
    expect(p.isAllDay).toBe(true);
  });

  it("folds long lines", () => {
    const ics = buildEventIcs("f1", { title: "x".repeat(200), startAt: "2026-12-01T15:00:00Z" }, NOW);
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(eventPayloadFromVevent(vevents(ics)[0])!.title).toBe("x".repeat(200));
  });
});

const APPLE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//iPhone OS 18.0//EN",
  "BEGIN:VTIMEZONE",
  "TZID:America/Chicago",
  "BEGIN:STANDARD",
  "DTSTART:20071104T020000",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0600",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:APPLE-1",
  "DTSTAMP:20261101T000000Z",
  "DTSTART;TZID=America/Chicago:20261201T090000",
  "DTEND;TZID=America/Chicago:20261201T100000",
  "SUMMARY:Swim class",
  "SEQUENCE:2",
  "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
  "RRULE:FREQ=WEEKLY;COUNT=6",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Reminder",
  "TRIGGER:-PT30M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:APPLE-1",
  "RECURRENCE-ID;TZID=America/Chicago:20261208T090000",
  "DTSTART;TZID=America/Chicago:20261208T100000",
  "DTEND;TZID=America/Chicago:20261208T110000",
  "SUMMARY:Swim class (moved)",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("patchEventIcs", () => {
  it("replaces the app's fields on the main event and keeps the rest", () => {
    const [v] = vevents(APPLE);
    const pulled = eventPayloadFromVevent(v)!;
    expect(pulled.startAt).toBe("2026-12-01T15:00:00.000Z");
    const edited = { ...pulled, title: "Swim lessons", startAt: "2026-12-01T16:00:00.000Z", endAt: "2026-12-01T17:00:00.000Z" };
    const out = patchEventIcs(APPLE, edited, NOW);

    expect(out).toContain("SUMMARY:Swim lessons");
    expect(out).toContain("DTSTART;TZID=America/Chicago:20261201T100000"); // zone kept
    expect(out).toContain("SEQUENCE:3");
    expect(out).toContain("X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC");
    expect(out).toContain("TRIGGER:-PT30M"); // alarm kept
    expect(out).toContain("BEGIN:VTIMEZONE");
    expect(out).toContain("SUMMARY:Swim class (moved)"); // override untouched
    expect(out).toContain("RRULE:FREQ=WEEKLY;COUNT=6");
    expect(out.match(/^DTSTART/gm)?.length).toBe(3); // time zone, main, override: nothing doubled
    expect(out.match(/^SUMMARY:/gm)?.length).toBe(2);

    const parsed = Object.values(ical.sync.parseICS(out)).find((x) => (x as { type?: string }).type === "VEVENT") as Record<string, unknown>;
    const back = eventPayloadFromVevent(parsed)!;
    expect(back.title).toBe("Swim lessons");
    expect(back.startAt).toBe("2026-12-01T16:00:00.000Z");
    expect(syncHashOf(back)).toBe(syncHashOf(edited));
  });

  it("drops the RRULE when the app clears the recurrence", () => {
    const pulled = eventPayloadFromVevent(vevents(APPLE)[0])!;
    const out = patchEventIcs(APPLE, { ...pulled, recurrence: null }, NOW);
    const main = out.split("BEGIN:VEVENT")[1];
    expect(main).not.toContain("RRULE:FREQ=WEEKLY");
    expect(out).toContain("RRULE:FREQ=YEARLY"); // the time zone's rule stays
  });
});

describe("parseMultistatus", () => {
  it("reads iCloud-style responses with any namespace prefix and escaped data", () => {
    const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/123/calendars/home/APPLE-1.ics</href><propstat><prop><getetag>"C=1@U=2"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR&#13;
SUMMARY:A &amp; B&#13;
END:VCALENDAR</calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response><D:response xmlns:D="DAV:"><D:href>/x/</D:href><D:propstat><D:prop><D:getetag/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></multistatus>`;
    const r = parseMultistatus(xml);
    expect(r).toHaveLength(2);
    expect(r[0].href).toBe("/123/calendars/home/APPLE-1.ics");
    expect(r[0].props).toContain('"C=1@U=2"');
    expect(r[1].props).toBe("");
  });
});
