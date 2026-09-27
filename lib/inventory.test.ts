import { describe, expect, it } from "vitest";

import {
  approveDrafts,
  deleteInventoryItems,
  hasDetailModel,
  isLowStock,
  sizeRank,
  spentTotal,
  wishlistSummary,
} from "./inventory";

describe("isLowStock", () => {
  it("is low at or below the threshold, never without one", () => {
    expect(isLowStock(2, 2)).toBe(true);
    expect(isLowStock(0, 1)).toBe(true);
    expect(isLowStock(3, 2)).toBe(false);
    expect(isLowStock(0, null)).toBe(false);
    expect(isLowStock(null, 0)).toBe(true);
  });
});

describe("wishlistSummary", () => {
  it("totals estimates × quantity and counts unpriced items", () => {
    const s = wishlistSummary([
      { status: "WISHLIST", estimatedPrice: 350, priority: "MUST_HAVE" },
      { status: "WISHLIST", estimatedPrice: 12.5, quantity: 4 },
      { status: "WISHLIST" },
      { status: "OWNED", estimatedPrice: 999 },
    ]);
    expect(s).toEqual({ count: 3, estimatedTotal: 400, mustHaveTotal: 350, unpriced: 1 });
  });
});

describe("spentTotal", () => {
  it("counts purchases only", () => {
    expect(
      spentTotal([
        { status: "OWNED", pricePaid: 100, acquiredVia: "PURCHASED" },
        { status: "OWNED", pricePaid: 20, quantity: 3 }, // acquiredVia unset → assume bought
        { status: "OWNED", pricePaid: 500, acquiredVia: "GIFT" },
        { status: "WISHLIST", pricePaid: 70 },
      ]),
    ).toBe(160);
  });
});

describe("sizeRank", () => {
  it("orders baby sizes before toddler, unknown last", () => {
    const sizes = ["3T", "0-3M", "weird", "NB", null];
    const sorted = [...sizes].sort((a, b) => sizeRank(a) - sizeRank(b));
    expect(sorted).toEqual(["NB", "0-3M", "3T", "weird", null]);
  });
});

describe("hasDetailModel", () => {
  it("knows which categories have detail rows", () => {
    expect(hasDetailModel("CLOTHING")).toBe(true);
    expect(hasDetailModel("CONSUMABLE")).toBe(true);
    expect(hasDetailModel("GEAR")).toBe(false);
    expect(hasDetailModel(null)).toBe(false);
  });
});

describe("drafts", () => {
  function fakeClient() {
    const calls: { model: string; op: string; arg: any }[] = [];
    const rows: Record<string, any[]> = {
      homeInventoryClothing: [{ id: "c1", itemId: "a" }],
      homeInventoryConsumable: [],
    };
    const model = (name: string) => ({
      update: async (arg: any) => (calls.push({ model: name, op: "update", arg }), { data: arg }),
      delete: async (arg: any) => (calls.push({ model: name, op: "delete", arg }), { data: arg }),
      list: async ({ filter }: any) => ({ data: (rows[name] ?? []).filter((r) => r.itemId === filter.itemId.eq) }),
    });
    const client = {
      models: {
        homeInventoryItem: model("homeInventoryItem"),
        homeInventoryClothing: model("homeInventoryClothing"),
        homeInventoryConsumable: model("homeInventoryConsumable"),
      },
    };
    return { client, calls };
  }

  it("approves only drafts, to their draftStatus", async () => {
    const { client, calls } = fakeClient();
    const n = await approveDrafts(
      client,
      [
        { id: "a", status: "DRAFT" },
        { id: "b", status: "DRAFT", draftStatus: "WISHLIST" },
        { id: "c", status: "OWNED" },
      ],
      "2026-09-26",
    );
    expect(n).toBe(2);
    expect(calls.map((c) => c.arg)).toEqual([
      { id: "a", status: "OWNED", draftStatus: null, acquiredAt: "2026-09-26" },
      { id: "b", status: "WISHLIST", draftStatus: null },
    ]);
  });

  it("deletes detail rows with the item", async () => {
    const { client, calls } = fakeClient();
    expect(await deleteInventoryItems(client, ["a"])).toBe(1);
    expect(calls.map((c) => `${c.op} ${c.model} ${c.arg.id}`)).toEqual([
      "delete homeInventoryClothing c1",
      "delete homeInventoryItem a",
    ]);
  });
});
