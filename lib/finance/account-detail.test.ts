import { describe, expect, it } from "vitest";
import { accountSyncRuns, balanceHistory, historyStats, holdingsSummary, lastSyncSummary, listAccountSnapshots, monthFlow, samplePoints, syncEntrySummary } from "./account-detail";

describe("account sync runs", () => {
  const logs = [
    { id: "a", startedAt: "2026-11-20T10:00:00Z", perAccountJson: JSON.stringify([{ accountId: "x", txNew: 2 }]) },
    { id: "b", startedAt: "2026-11-22T10:00:00Z", perAccountJson: JSON.stringify([{ accountId: "y" }, { accountId: "x", txNew: 1 }]) },
    { id: "c", startedAt: "2026-11-23T10:00:00Z", perAccountJson: JSON.stringify([{ accountId: "y" }]) },
    { id: "d", startedAt: "2026-11-24T10:00:00Z", perAccountJson: "not json" },
  ];

  it("keeps the runs that touched the account, newest first", () => {
    const runs = accountSyncRuns(logs, "x");
    expect(runs.map((r) => r.log.id)).toEqual(["b", "a"]);
    expect(runs[0].entry.txNew).toBe(1);
    expect(accountSyncRuns(logs, "x", 1)).toHaveLength(1);
  });

  it("summarizes an entry", () => {
    expect(syncEntrySummary({ txNew: 3, txUpdated: 1, txTotal: 20, linked: 2, holdingsChanged: 1 })).toBe("3 new · 1 updated · 20 seen · 2 matched · 1 position changed");
    expect(syncEntrySummary({})).toBe("0 new · 0 updated · 0 seen");
    expect(lastSyncSummary({ fromIso: "2026-10-25", toIso: "2026-11-24", txNew: 3, txUpdated: 1, txTotal: 40, linked: 2, holdingsChanged: 2 })).toBe("2026-10-25 → 2026-11-24: 3 new, 1 updated, 2 matched of 40; 2 positions changed");
    expect(lastSyncSummary(null)).toBeNull();
  });
});

describe("balance history", () => {
  const snaps = [
    { date: "2026-01-01", balance: 100 },
    { date: "2026-10-01", balance: 300 },
    { date: "2026-11-20", balance: 250 },
  ];

  it("windows by days back from today", () => {
    expect(balanceHistory(snaps, 90, "2026-11-24").map((s) => s.date)).toEqual(["2026-10-01", "2026-11-20"]);
    expect(balanceHistory(snaps, null, "2026-11-24")).toHaveLength(3);
  });

  it("samples evenly keeping both ends, and gives low / high / change", () => {
    const pts = Array.from({ length: 100 }, (_, i) => i);
    const s = samplePoints(pts, 10);
    expect(s).toHaveLength(10);
    expect(s[0]).toBe(0);
    expect(s[9]).toBe(99);
    expect(samplePoints([1, 2], 10)).toEqual([1, 2]);
    expect(historyStats(snaps)).toMatchObject({ min: 100, max: 300, change: 150 });
    expect(historyStats([])).toBeNull();
  });

  it("loads one account's snapshots across pages, oldest first", async () => {
    const calls: any[] = [];
    const client = {
      models: {
        homeFinanceAccountSnapshot: {
          list: async (opts: any) => {
            calls.push(opts);
            return opts.nextToken ? { data: [{ date: "2026-01-01", balance: 1 }], nextToken: null } : { data: [{ date: "2026-02-01", balance: 2 }], nextToken: "t" };
          },
        },
      },
    };
    expect((await listAccountSnapshots(client, "acc")).map((s) => s.date)).toEqual(["2026-01-01", "2026-02-01"]);
    expect(calls.every((c) => c.accountId === "acc")).toBe(true);
  });
});

describe("month flow and positions", () => {
  it("adds posted money in and out, counts pending", () => {
    expect(monthFlow([{ amount: 100 }, { amount: -40.5 }, { amount: -10, status: "PENDING" }, { amount: 5, status: "POSTED" }])).toEqual({ inflow: 105, outflow: -40.5, pending: 1 });
  });

  it("gives each position's gain, the cash left and the latest as-of", () => {
    const s = holdingsSummary(1000, [
      { holdingKey: "a", marketValue: 600, costBasisTotal: 500, asOf: "2026-11-20" },
      { holdingKey: "b", marketValue: 300, asOf: "2026-11-22" },
    ]);
    expect(s.rows.map((r) => r.gain)).toEqual([100, null]);
    expect(s.positions).toBe(900);
    expect(s.cash).toBe(100);
    expect(s.asOf).toBe("2026-11-22");
    expect(holdingsSummary(0, []).asOf).toBeNull();
  });
});
