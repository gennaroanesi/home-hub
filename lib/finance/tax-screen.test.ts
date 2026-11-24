import { describe, expect, it } from "vitest";

import { combinedOutcome, personOutcome } from "./tax";
import { normalizeTaxSettings, parseTaxAmount, paycheckYears, taxOutlook, taxSettingsKey } from "./tax-screen";
import type { TaxPaycheck } from "./tax";

const stub = (personId: string, n: number, over: Partial<TaxPaycheck> = {}): TaxPaycheck => {
  const payDate = `2026-${String(Math.ceil(n / 2)).padStart(2, "0")}-${n % 2 ? "05" : "20"}`;
  return {
    personId,
    payDate,
    periodStart: payDate,
    periodEnd: `2026-${String(Math.ceil(n / 2)).padStart(2, "0")}-${n % 2 ? "18" : "28"}`,
    gross: 5000,
    fedWh: 600,
    contrib401k: 300,
    ytdGross: 5000 * n,
    ytdTaxableWage: 4700 * n,
    ytdFedWh: 600 * n,
    ytd401k: 300 * n,
    ytdNet: 3500 * n,
    ...over,
  };
};

describe("tax outlook view", () => {
  const paychecks = [...[1, 2, 3, 4].map((n) => stub("b", n)), ...[1, 2].map((n) => stub("a", n)), stub("a", 1, { payDate: "2025-12-20" })];

  it("keeps people in order, only the year's stubs, and matches the tax lib", () => {
    const v = taxOutlook({ paychecks, personOrder: ["a", "b"], settings: normalizeTaxSettings(null), year: 2026, today: "2026-03-01" });
    expect(v.people.map((p) => p.personId)).toEqual(["a", "b"]);
    expect(v.people[0].paychecks).toHaveLength(2);
    expect(v.people[1].latest.payDate).toBe("2026-02-20");
    const b = v.people[1];
    const direct = personOutcome({ projection: b.projection, ytd401k: 1200, currentPct: b.currentPct, pct: null, year: 2026 });
    expect(b.adjusted).toEqual(direct);
    expect(b.sliderOn).toBe(false);
    expect(v.combined).toEqual(combinedOutcome(v.people.map((p) => p.adjusted), "MFJ", 2026));
    expect(v.nextDue).toBe("2026-04-15");
    expect(v.isCurrentYear).toBe(true);
  });

  it("applies the what-if and estimated payments", () => {
    const v = taxOutlook({ paychecks, personOrder: ["a", "b"], settings: normalizeTaxSettings({ whatIfPct: 0.2, estimatedPaid: 1000 }), year: 2026, today: "2026-03-01" });
    expect(v.people.every((p) => p.sliderOn)).toBe(true);
    expect(v.people[0].adjusted.taxOwed).toBeLessThan(v.people[0].current.taxOwed);
    expect(v.householdGap).toBeCloseTo(v.combined!.gap + 1000, 6);
  });

  it("is empty without paychecks in the year", () => {
    const v = taxOutlook({ paychecks, personOrder: ["a"], settings: normalizeTaxSettings(null), year: 2024, today: "2026-03-01" });
    expect(v.people).toEqual([]);
    expect(v.combined).toBeNull();
    expect(v.nextDue).toBeNull();
  });

  it("helpers", () => {
    expect(taxSettingsKey(2026)).toBe("tax-outlook:2026");
    expect(parseTaxAmount("$12,500")).toBe(12500);
    expect(parseTaxAmount(" ")).toBeNull();
    expect(parseTaxAmount("abc")).toBeNull();
    expect(paycheckYears(paychecks, 2027)).toEqual([2027, 2026, 2025]);
    expect(normalizeTaxSettings({ rsuVestCadence: { a: "QUARTERLY" } }).filingStatus).toBe("MFJ");
  });
});
