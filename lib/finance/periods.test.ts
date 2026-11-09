import { describe, expect, it } from "vitest";
import { periodContaining, periodFromParam, periodRange, periodToParam, shiftPeriod, switchKind, type Period } from "./periods";

const today = "2026-11-09";

describe("periods", () => {
  it("gives calendar ranges and labels", () => {
    expect(periodRange({ kind: "month", year: 2027, month: 2 }, today)).toEqual({ fromIso: "2027-02-01", toIso: "2027-02-28", label: "February 2027" });
    expect(periodRange({ kind: "quarter", year: 2026, quarter: 4 }, today)).toMatchObject({ fromIso: "2026-10-01", toIso: "2026-12-31", label: "Q4 2026" });
    expect(periodRange({ kind: "year", year: 2026 }, today)).toMatchObject({ fromIso: "2026-01-01", toIso: "2026-12-31" });
    expect(periodRange({ kind: "last3" }, today)).toMatchObject({ fromIso: "2026-08-10", toIso: "2026-11-09" });
  });

  it("steps across year boundaries", () => {
    expect(shiftPeriod({ kind: "month", year: 2026, month: 12 }, 1)).toEqual({ kind: "month", year: 2027, month: 1 });
    expect(shiftPeriod({ kind: "quarter", year: 2026, quarter: 1 }, -1)).toEqual({ kind: "quarter", year: 2025, quarter: 4 });
    expect(shiftPeriod({ kind: "last3" }, 1)).toEqual({ kind: "last3" });
  });

  it("switches kind around today, or the start of a past period", () => {
    expect(switchKind({ kind: "month", year: 2026, month: 11 }, "quarter", today)).toEqual({ kind: "quarter", year: 2026, quarter: 4 });
    expect(switchKind({ kind: "month", year: 2026, month: 5 }, "quarter", today)).toEqual({ kind: "quarter", year: 2026, quarter: 2 });
    expect(periodContaining("year", today)).toEqual({ kind: "year", year: 2026 });
  });

  it("round-trips through the URL form and rejects junk", () => {
    const all: Period[] = [{ kind: "month", year: 2026, month: 3 }, { kind: "quarter", year: 2026, quarter: 2 }, { kind: "year", year: 2025 }, { kind: "last3" }];
    for (const p of all) expect(periodFromParam(periodToParam(p))).toEqual(p);
    expect(periodFromParam("2026-13")).toBeNull();
    expect(periodFromParam("soon")).toBeNull();
  });
});
