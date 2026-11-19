import { describe, expect, it } from "vitest";
import { caliberTotals, planAmmoUse, thresholdChanges } from "./inventory-ammo";

const lots = [
  { itemId: "new", caliber: "9mm", roundsAvailable: 500, acquiredAt: "2026-06-01" },
  { itemId: "old", caliber: "9mm ", roundsAvailable: 120, acquiredAt: "2025-01-10" },
  { itemId: "empty", caliber: "9MM", roundsAvailable: 0, acquiredAt: "2024-01-01" },
  { itemId: "sold", caliber: "9mm", roundsAvailable: 1000, acquiredAt: "2023-01-01", status: "SOLD" },
  { itemId: "rifle", caliber: "5.56 NATO", roundsAvailable: 300, acquiredAt: "2025-05-05" },
];

describe("planAmmoUse", () => {
  it("drains the oldest owned lots first, matching calibers loosely", () => {
    expect(planAmmoUse(lots, "9mm", 200)).toEqual({ draws: [{ itemId: "old", rounds: 120 }, { itemId: "new", rounds: 80 }], shortfall: 0 });
  });
  it("reports what it couldn't take", () => {
    expect(planAmmoUse(lots, "9mm", 700)).toEqual({ draws: [{ itemId: "old", rounds: 120 }, { itemId: "new", rounds: 500 }], shortfall: 80 });
    expect(planAmmoUse(lots, ".45 ACP", 50)).toEqual({ draws: [], shortfall: 50 });
  });
});

describe("caliberTotals / thresholdChanges", () => {
  const th = [
    { id: "t9", caliber: "9mm", minRounds: 1000, enabled: true, notifiedAt: null },
    { id: "t5", caliber: "5.56 nato", minRounds: 200, enabled: true, notifiedAt: "2026-01-01T00:00:00Z" },
    { id: "off", caliber: "5.56 NATO", minRounds: 5000, enabled: false, notifiedAt: null },
  ];
  it("totals owned rounds per caliber with minimums", () => {
    expect(caliberTotals(lots, th)).toEqual([
      { caliber: "5.56 NATO", rounds: 300, lots: 1, minRounds: 200, below: false },
      { caliber: "9mm", rounds: 620, lots: 2, minRounds: 1000, below: true },
    ]);
  });
  it("alerts once below a minimum and re-arms once back above", () => {
    const { alert, rearm } = thresholdChanges(th, caliberTotals(lots, th));
    expect(alert.map((a) => [a.threshold.id, a.rounds])).toEqual([["t9", 620]]);
    expect(rearm.map((t) => t.id)).toEqual(["t5"]);
    expect(thresholdChanges([{ ...th[0], notifiedAt: "x" }], caliberTotals(lots)).alert).toEqual([]);
  });
});
