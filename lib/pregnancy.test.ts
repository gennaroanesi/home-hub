import { describe, it, expect } from "vitest";
import {
  addDaysYmd,
  buildCareTimeline,
  careUrgency,
  daysBetween,
  dueDateFromLmp,
  gestationalAge,
  lmpFromDueDate,
} from "./pregnancy";

// Reference pregnancy: LMP 2026-08-20 → due 2027-05-27.
const LMP = "2026-08-20";
const DUE = "2027-05-27";

describe("date math", () => {
  it("due date is LMP + 280 days", () => {
    expect(dueDateFromLmp(LMP)).toBe(DUE);
    expect(lmpFromDueDate(DUE)).toBe(LMP);
  });

  it("crosses month / year / DST boundaries cleanly", () => {
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysYmd("2027-03-13", 1)).toBe("2027-03-14"); // US DST start
    expect(daysBetween("2026-11-01", "2026-11-02")).toBe(1); // US DST end
  });
});

describe("gestationalAge", () => {
  it("computes weeks + days", () => {
    const ga = gestationalAge(DUE, "2026-09-23");
    expect(ga.label).toBe("4w6d");
    expect(ga.trimester).toBe(1);
    expect(ga.daysToGo).toBe(246);
  });

  it("matches the first OB appointments", () => {
    expect(gestationalAge(DUE, "2026-10-12").label).toBe("7w4d");
    expect(gestationalAge(DUE, "2026-10-14").label).toBe("7w6d");
  });

  it("switches trimester at 14w0d and 28w0d", () => {
    expect(gestationalAge(DUE, addDaysYmd(LMP, 14 * 7 - 1)).trimester).toBe(1);
    expect(gestationalAge(DUE, addDaysYmd(LMP, 14 * 7)).trimester).toBe(2);
    expect(gestationalAge(DUE, addDaysYmd(LMP, 28 * 7)).trimester).toBe(3);
  });

  it("goes negative daysToGo past the due date", () => {
    expect(gestationalAge(DUE, "2027-05-30").daysToGo).toBe(-3);
  });
});

describe("buildCareTimeline", () => {
  const items = buildCareTimeline(DUE);
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));

  it("places gestational windows on the right dates", () => {
    expect(byKey.anatomy_scan.windowStart).toBe("2026-12-24"); // 18w
    expect(byKey.anatomy_scan.windowEnd).toBe("2027-01-21"); // 22w
    expect(byKey.glucose_test.windowStart).toBe("2027-02-04"); // 24w
    expect(byKey.gbs_swab.windowStart).toBe("2027-04-29"); // 36w
    expect(byKey.gbs_swab.windowEnd).toBe("2027-05-12"); // 37w6d
  });

  it("clamps flu vaccine to flu season", () => {
    expect(byKey.flu_vaccine.status).toBe("UPCOMING");
    expect(byKey.flu_vaccine.windowStart).toBe("2026-09-01");
    expect(byKey.flu_vaccine.windowEnd).toBe("2027-03-31");
  });

  it("marks RSV N/A when 32–36w misses Sep–Jan", () => {
    expect(byKey.rsv_vaccine.status).toBe("NOT_APPLICABLE");
    expect(byKey.rsv_vaccine.notes).toMatch(/nirsevimab/);
  });

  it("keeps RSV when 32–36w lands in season", () => {
    // Due mid-December → 32–36w is Oct 20 to Nov 17.
    const dec = Object.fromEntries(buildCareTimeline("2026-12-15").map((i) => [i.key, i]));
    expect(dec.rsv_vaccine.status).toBe("UPCOMING");
    expect(dec.rsv_vaccine.windowStart).toBe("2026-10-20");
  });

  it("returns items sorted by window start with dense sortOrder", () => {
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].windowStart <= items[i].windowStart).toBe(true);
      expect(items[i].sortOrder).toBe(i);
    }
  });
});

describe("careUrgency", () => {
  const item = { status: "UPCOMING", windowStart: "2026-12-24", windowEnd: "2027-01-21" };

  it("classifies relative to today", () => {
    expect(careUrgency(item, "2026-10-01")).toBe("LATER");
    expect(careUrgency(item, "2026-12-10")).toBe("SOON");
    expect(careUrgency(item, "2027-01-01")).toBe("DUE_NOW");
    expect(careUrgency(item, "2027-01-22")).toBe("OVERDUE");
  });

  it("treats closed statuses as CLOSED", () => {
    expect(careUrgency({ ...item, status: "DONE" }, "2027-01-22")).toBe("CLOSED");
    expect(careUrgency({ ...item, status: "NOT_APPLICABLE" }, "2027-01-01")).toBe("CLOSED");
  });
});
