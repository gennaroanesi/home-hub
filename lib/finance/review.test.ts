import { describe, expect, it } from "vitest";
import { buildReview, defaultReviewPeriod, reviewWindow } from "./review";
import { ALL_LEDGERS, HOUSEHOLD } from "./ledger";

const accounts = [
  { id: "joint", ownerPersonIds: [] },
  { id: "gCard", ownerPersonIds: ["g"] },
];
const range = { fromIso: "2026-11-01", toIso: "2026-11-30", label: "November 2026" };
const tx = (o: Record<string, unknown>) => ({ id: String(Math.random()), status: "POSTED", accountId: "joint", ...o }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("review", () => {
  it("defaults to last month on the 1st", () => {
    expect(defaultReviewPeriod("2026-11-24")).toEqual({ kind: "month", year: 2026, month: 11 });
    expect(defaultReviewPeriod("2026-11-01")).toEqual({ kind: "month", year: 2026, month: 10 });
  });

  it("loads from the earlier of trend and usual", () => {
    expect(reviewWindow(range)).toEqual({ endMonth: "2026-11-01", trendFrom: "2025-12-01", usualFrom: "2026-05-01", loadFrom: "2025-12-01" });
  });

  it("builds the household's month", () => {
    const rawTxs = [
      tx({ date: "2026-11-05", amount: 3000, category: "Contribution", personId: "g" }),
      tx({ date: "2026-11-06", amount: -200, category: "Groceries" }),
      tx({ date: "2026-11-07", amount: -50, category: "Dining", recurringId: "r1" }),
      tx({ date: "2026-10-06", amount: -180, category: "Groceries" }),
      tx({ date: "2026-11-08", amount: -40, category: "Gadgets", accountId: "gCard" }),
    ];
    const schedules = [
      { id: "r1", description: "Netflix", amount: -50, frequency: "MONTHLY", startDate: "2026-01-07", active: true },
    ];
    const r = buildReview({ rawTxs, accounts, lines: [], schedules, groups: [], ledger: HOUSEHOLD, range, today: "2026-11-24" });
    expect(r.totalIn).toBe(3000);
    expect(r.totalOut).toBe(250);
    expect(r.biggest.map((t) => t.amount)).toEqual([-200, -50]);
    expect(r.byCategory[0]).toMatchObject({ category: "Groceries", spent: 200, median: 180 });
    expect(r.trend.rows).toHaveLength(12);
    expect(r.scheduled[0]).toMatchObject({ done: true, actual: -50 });

    const all = buildReview({ rawTxs, accounts, lines: [], schedules: [], groups: [], ledger: ALL_LEDGERS, range, today: "2026-11-24" });
    expect(all.totalOut).toBe(290);
    expect(all.totalIn).toBe(0);
  });
});
