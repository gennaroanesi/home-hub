import { describe, expect, it } from "vitest";
import {
  additionalMedicareTaxOwed,
  additionalMedicareTaxWithheld,
  combinedOutcome,
  contribPctToReachCap,
  extractEmployerMatchPeriod,
  extractEmployerMatchYtd,
  inferPaychecksPerYear,
  irs401kElectiveLimit,
  nextEstimatedDueDate,
  personOutcome,
  project401kWithCap,
  projectFromPaychecks,
  safeHarbor,
  taxOwedFederal,
  type TaxPaycheck,
} from "./tax";

describe("federal tax", () => {
  it("applies the standard deduction and brackets", () => {
    // 2025 MFJ: 100,000 + 31,500 deduction → taxable 100,000
    // 23,850 × 10% + (96,950 − 23,850) × 12% + (100,000 − 96,950) × 22% = 2,385 + 8,772 + 671
    expect(taxOwedFederal({ projectedTaxableWage: 131500, filingStatus: "MFJ", year: 2025 })).toBeCloseTo(11828, 2);
    // 2025 SINGLE at the top of the 10% bracket.
    expect(taxOwedFederal({ projectedTaxableWage: 15750 + 11925, filingStatus: "SINGLE", year: 2025 })).toBeCloseTo(1192.5, 2);
    expect(taxOwedFederal({ projectedTaxableWage: 10000, filingStatus: "SINGLE", year: 2025 })).toBe(0);
  });

  it("falls back to the latest known year", () => {
    expect(taxOwedFederal({ projectedTaxableWage: 200000, filingStatus: "MFJ", year: 2031 })).toBe(taxOwedFederal({ projectedTaxableWage: 200000, filingStatus: "MFJ", year: 2026 }));
    expect(irs401kElectiveLimit(2031)).toBe(24500);
  });

  it("computes Additional Medicare owed and withheld", () => {
    expect(additionalMedicareTaxOwed({ combinedMedicareWages: 300000, filingStatus: "MFJ" })).toBeCloseTo(450, 2);
    expect(additionalMedicareTaxWithheld({ perPersonMedicareWages: [220000, 80000] })).toBeCloseTo(180, 2);
  });
});

describe("projection", () => {
  const stub = (date: string, over: Partial<TaxPaycheck> = {}): TaxPaycheck => ({
    personId: "p",
    payDate: date,
    periodStart: null,
    periodEnd: null,
    gross: 5000,
    ...over,
  });

  it("infers cadence from the period length", () => {
    expect(inferPaychecksPerYear({ periodStart: "2026-01-01", periodEnd: "2026-01-14" })).toBe(26);
    expect(inferPaychecksPerYear({ periodStart: "2026-01-01", periodEnd: "2026-01-15" })).toBe(24);
    expect(inferPaychecksPerYear({ periodStart: "2026-01-01", periodEnd: "2026-01-31" })).toBe(12);
  });

  it("extrapolates salary and projects RSU vests on cadence", () => {
    const paychecks = [
      stub("2026-01-15", { periodStart: "2026-01-01", periodEnd: "2026-01-15" }),
      stub("2026-01-31", { periodStart: "2026-01-16", periodEnd: "2026-01-31" }),
      stub("2026-02-15", { gross: 0, rsuGross: 10000 }),
      stub("2026-02-15", { periodStart: "2026-02-01", periodEnd: "2026-02-15", ytdTaxableWage: 25000, ytdFedWh: 5000, ytdRsuGross: 10000, ytdSupplementalFedWh: 3000 }),
    ];
    const p = projectFromPaychecks({ paychecks, rsuVestCadence: "QUARTERLY" })!;
    expect(p.paychecksPerYear).toBe(24);
    expect(p.ytdSalaryGross).toBe(15000);
    expect(p.projectedGross).toBe(120000);
    expect(p.projectedRsuGross).toBe(40000);
    // Salary taxable 15,000 × 8 + RSU 40,000
    expect(p.projectedTaxableWage).toBe(160000);
    // Salary WH 2,000 × 8 + supplemental 3,000 + 30,000 more RSU at the observed 30%
    expect(p.projectedFedWh).toBeCloseTo(16000 + 3000 + 9000, 6);
  });
});

describe("401(k)", () => {
  it("caps the projection and reports the excess", () => {
    const r = project401kWithCap({ ytd401k: 20000, ytdGross: 150000, projectedGross: 200000, contributionPct: 0.2, year: 2026 });
    expect(r.projected401k).toBe(24500);
    expect(r.capReached).toBe(true);
    expect(r.excessOverCap).toBe(5500);
    expect(contribPctToReachCap({ ytd401k: 20000, ytdGross: 150000, projectedGross: 200000, year: 2026 })).toBeCloseTo(0.09, 6);
    expect(contribPctToReachCap({ ytd401k: 24500, ytdGross: 150000, projectedGross: 200000, year: 2026 })).toBeNull();
  });

  it("reads the employer match from line items, JSON or parsed", () => {
    const items = [
      { name: "401k Employer Match", type: "EMPLOYER_PAID", amount: 400, ytd: 8000 },
      { name: "Medical", type: "EMPLOYER_PAID", amount: 600, ytd: 12000 },
    ];
    expect(extractEmployerMatchYtd(items)).toBe(8000);
    expect(extractEmployerMatchYtd(JSON.stringify(items))).toBe(8000);
    expect(extractEmployerMatchPeriod(JSON.stringify(JSON.stringify(items)))).toBe(400);
  });
});

describe("household outcome", () => {
  const proj = (taxable: number, wh: number) =>
    projectFromPaychecks({
      paychecks: [{ personId: "x", payDate: "2026-12-31", periodStart: "2026-12-16", periodEnd: "2026-12-31", gross: taxable / 24, ytdTaxableWage: taxable, ytdFedWh: wh, ytd401k: 0 }],
      rsuVestCadence: "IRREGULAR",
      paychecksPerYearOverride: 1,
    })!;

  it("taxes MFJ on combined wages, which is no more than two single returns", () => {
    const a = personOutcome({ projection: proj(150000, 25000), ytd401k: 0, currentPct: 0, pct: null, year: 2026 });
    const b = personOutcome({ projection: proj(60000, 6000), ytd401k: 0, currentPct: 0, pct: null, year: 2026 });
    const mfj = combinedOutcome([a, b], "MFJ", 2026);
    const single = combinedOutcome([a, b], "SINGLE", 2026);
    expect(mfj.taxableWage).toBe(210000);
    expect(mfj.taxOwed).toBeCloseTo(taxOwedFederal({ projectedTaxableWage: 210000, filingStatus: "MFJ", year: 2026 }), 6);
    expect(mfj.taxOwed).toBeLessThanOrEqual(single.taxOwed);
    expect(mfj.fedWh).toBe(31000);
  });
});

describe("safe harbor", () => {
  it("uses the smaller of 90% of this year and 110% of last year when AGI > $150k", () => {
    const s = safeHarbor({ taxOwed: 50000, withheld: 30000, priorYearTax: 30000, priorYearAgi: 300000 });
    expect(s.binding).toBe("110% of last year's tax");
    expect(s.floor).toBeCloseTo(33000, 6);
    expect(s.safe).toBe(false);
    expect(s.shortfall).toBeCloseTo(3000, 6);
    expect(safeHarbor({ taxOwed: 50000, withheld: 30000, estimatedPaid: 3000, priorYearTax: 30000, priorYearAgi: 300000 }).safe).toBe(true);
  });

  it("uses 100% of last year below $150k AGI, 90% without a prior year, and the $1,000 de minimis", () => {
    expect(safeHarbor({ taxOwed: 20000, withheld: 0, priorYearTax: 10000, priorYearAgi: 100000 }).floor).toBe(10000);
    expect(safeHarbor({ taxOwed: 20000, withheld: 15000 }).floor).toBe(18000);
    expect(safeHarbor({ taxOwed: 5000, withheld: 4200 }).safe).toBe(true);
  });

  it("finds the next estimated-tax due date", () => {
    expect(nextEstimatedDueDate(2026, "2026-11-09")).toBe("2027-01-15");
    expect(nextEstimatedDueDate(2026, "2026-05-01")).toBe("2026-06-15");
    expect(nextEstimatedDueDate(2025, "2026-11-09")).toBeNull();
  });
});
