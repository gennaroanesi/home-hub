import { describe, expect, it } from "vitest";
import { round2 } from "./dates";
import { accountGroup, assetEquity, assetValueOn, changeSince, historyDates, netWorthHistory, netWorthNow } from "./net-worth";

const accounts = [
  { id: "chk", name: "Joint checking", type: "CHECKING", currentBalance: 6000 },
  { id: "401k", name: "401(k)", type: "RETIREMENT", currentBalance: 300000 },
  { id: "mort", name: "Mortgage", type: "LOAN", currentBalance: -418505.21 },
  { id: "car", name: "BMW", type: "LOAN", currentBalance: -36409.33 },
  { id: "card", name: "Card", type: "CREDIT", currentBalance: -500 },
  { id: "old", name: "Closed", type: "SAVINGS", currentBalance: 999, active: false },
];
const home = { id: "home", name: "Home", type: "REAL_ESTATE", currentValue: 520000, purchaseDate: "2022-10-14" };
const bmw = { id: "bmw", name: "2023 m850i", type: "VEHICLE", currentValue: 55000, purchaseDate: "2023-12-17" };
const sold = { id: "sold", name: "Old car", type: "VEHICLE", currentValue: 9000, active: false, soldDate: "2025-01-10" };
const loans = [
  { id: "l1", accountId: "mort", assetId: "home" },
  { id: "l2", accountId: "car", assetId: "bmw" },
];

describe("groups and totals", () => {
  it("buckets accounts", () => {
    expect(["CHECKING", "SAVINGS", "BROKERAGE", "RETIREMENT", "LOAN", "CREDIT", "OTHER", null].map(accountGroup)).toEqual(["cash", "cash", "invested", "invested", "debt", "debt", "other", "other"]);
  });

  it("adds live accounts and assets; skips inactive ones", () => {
    expect(netWorthNow(accounts, [home, bmw, sold])).toEqual({
      total: round2(6000 + 300000 - 418505.21 - 36409.33 - 500 + 520000 + 55000),
      assets: 6000 + 300000 + 520000 + 55000,
      liabilities: round2(418505.21 + 36409.33 + 500),
      cash: 6000,
      invested: 300000,
      property: 575000,
      debt: -455414.54,
      other: 0,
    });
  });

  it("shows each asset's equity against the loans it secures", () => {
    const eq = assetEquity([home, bmw, sold], loans, accounts);
    expect(eq.map((e) => [e.asset.id, e.value, e.owed, e.equity])).toEqual([
      ["home", 520000, 418505.21, 101494.79],
      ["bmw", 55000, 36409.33, 18590.67],
    ]);
    expect(eq[0].ltv).toBeCloseTo(0.8048, 4);
    expect(eq[0].loans).toEqual([{ loanId: "l1", accountId: "mort", name: "Mortgage", owed: 418505.21 }]);
  });
});

describe("asset value over time", () => {
  const vals = [
    { assetId: "home", date: "2022-10-14", value: 499900 },
    { assetId: "home", date: "2026-11-16", value: 520000 },
  ];
  it("steps through valuations between purchase and sale", () => {
    expect(assetValueOn(home, vals, "2022-10-13")).toBe(0);
    expect(assetValueOn(home, vals, "2025-01-01")).toBe(499900);
    expect(assetValueOn(home, vals, "2026-11-16")).toBe(520000);
    expect(assetValueOn({ ...home, soldDate: "2027-06-01" }, vals, "2027-06-01")).toBe(0);
    // Owned (bought 2023) but first valued later: the earliest valuation stands in.
    expect(assetValueOn(bmw, [{ assetId: "bmw", date: "2026-01-01", value: 60000 }], "2024-05-01")).toBe(60000);
    // No valuations at all: the current value.
    expect(assetValueOn(bmw, [], "2024-05-01")).toBe(55000);
  });
});

describe("history", () => {
  it("plots daily, then weekly, ending on today", () => {
    expect(historyDates("2026-11-14", "2026-11-16")).toEqual(["2026-11-14", "2026-11-15", "2026-11-16"]);
    const weekly = historyDates("2025-11-16", "2026-11-16");
    expect(weekly[0]).toBe("2025-11-16");
    expect(weekly.at(-1)).toBe("2026-11-16");
    expect(weekly.at(-2)).toBe("2026-11-09");
  });

  it("carries each account's last snapshot forward and uses live balances today", () => {
    const h = netWorthHistory({
      accounts: [accounts[0], accounts[2]],
      snapshots: [
        { accountId: "chk", date: "2026-11-14", balance: 5000 },
        { accountId: "mort", date: "2026-11-15", balance: -419000 },
      ],
      assets: [home],
      valuations: [{ assetId: "home", date: "2022-10-14", value: 499900 }],
      today: "2026-11-16",
    });
    expect(h.map((p) => [p.date, p.total])).toEqual([
      ["2026-11-14", 5000 + 499900], // the mortgage wasn't tracked yet
      ["2026-11-15", 5000 - 419000 + 499900],
      ["2026-11-16", round2(6000 - 418505.21 + 520000)], // live
    ]);
    expect(changeSince(h, 1)).toEqual({ from: "2026-11-15", amount: round2(6000 - 418505.21 + 520000 - (5000 - 419000 + 499900)) });
    expect(changeSince(h, 30)).toBeNull();
  });
});
