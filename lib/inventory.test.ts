import { describe, expect, it } from "vitest";

import {
  categoriesAlphabetical,
  categoryMatches,
  newCategoryFromText,
  approveDrafts,
  categoryAndDescendants,
  categoryTree,
  isLowStock,
  matchCategory,
  planCategoryBackfill,
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

describe("categories", () => {
  const cats = [
    { id: "gear", name: "Gear", sortOrder: 1 },
    { id: "cl", name: "Clothing", detailType: "CLOTHING", sortOrder: 0 },
    { id: "baby", name: "Baby", parentId: "cl" },
    { id: "sleep", name: "Sleepwear", parentId: "baby" },
    { id: "kit", name: "Kitchen", sortOrder: 2 },
    { id: "kitbaby", name: "Baby", parentId: "kit" },
    { id: "orphan", name: "Orphan", parentId: "gone", sortOrder: 3 },
  ];

  it("builds paths in tree order and inherits the detail type", () => {
    const tree = categoryTree(cats);
    expect(tree.map((n) => n.path)).toEqual([
      "Clothing",
      "Clothing › Baby",
      "Clothing › Baby › Sleepwear",
      "Gear",
      "Kitchen",
      "Kitchen › Baby",
      "Orphan",
    ]);
    expect(tree[2]).toMatchObject({ depth: 2, detailType: "CLOTHING" });
    expect(tree[3].detailType).toBeNull();
  });

  it("lets a subcategory set its own detail type", () => {
    const tree = categoryTree([{ id: "a", name: "A", detailType: "CLOTHING" }, { id: "b", name: "B", parentId: "a", detailType: "CONSUMABLE" }]);
    expect(tree[1].detailType).toBe("CONSUMABLE");
  });

  it("still lists rows caught in a parent loop", () => {
    const tree = categoryTree([{ id: "a", name: "A", parentId: "b" }, { id: "b", name: "B", parentId: "a" }]);
    expect(tree).toHaveLength(2);
  });

  it("collects descendants", () => {
    expect(categoryAndDescendants("cl", cats)).toEqual(new Set(["cl", "baby", "sleep"]));
    expect(categoryAndDescendants("gear", cats)).toEqual(new Set(["gear"]));
  });

  it("matches old enum values, names and paths", () => {
    const seeded = [...cats, { id: "co", name: "Consumables", detailType: "CONSUMABLE" }];
    expect(matchCategory(seeded, "CONSUMABLE")?.category.id).toBe("co");
    expect(matchCategory(seeded, "clothing")?.category.id).toBe("cl");
    expect(matchCategory(seeded, "sleepwear")?.category.id).toBe("sleep");
    expect(matchCategory(seeded, "Clothing > Baby")?.category.id).toBe("baby");
    expect(matchCategory(seeded, "kitchen/baby")?.category.id).toBe("kitbaby");
  });

  it("won't guess between two categories with the same name", () => {
    expect(matchCategory(cats, "Baby")).toBeUndefined();
    expect(matchCategory(cats, "nope")).toBeUndefined();
    expect(matchCategory(cats, "  ")).toBeUndefined();
    expect(matchCategory([...cats, { id: "top", name: "Baby" }], "Baby")?.category.id).toBe("top");
  });

  it("plans the backfill and is safe to run twice", () => {
    const first = planCategoryBackfill([{ id: "x", name: "clothing" }], [
      { id: "1", category: "CLOTHING" },
      { id: "2", category: "CONSUMABLE" },
      { id: "3", category: null },
      { id: "4", category: "GEAR", categoryId: "already" },
    ]);
    expect(first.createCategories.map((c) => c.name)).not.toContain("Clothing");
    expect(first.createCategories[0]).toEqual({ name: "Consumables", detailType: "CONSUMABLE", sortOrder: 1 });
    expect(first.moves).toEqual([
      { itemId: "1", categoryName: "Clothing" },
      { itemId: "2", categoryName: "Consumables" },
      { itemId: "3", categoryName: "Other" },
    ]);
    const all = ["Clothing", "Consumables", "Gear", "Furniture", "Kitchen", "Electronics", "Toys", "Books", "Tools", "Other"];
    expect(planCategoryBackfill(all.map((name, i) => ({ id: `${i}`, name })), [{ id: "1", categoryId: "0" }])).toEqual({ createCategories: [], moves: [] });
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
});

describe("category picker", () => {
  const cats = [
    { id: "p", name: "3D printing" },
    { id: "f", name: "Filament", parentId: "p" },
    { id: "a", name: "Ammo", sortOrder: 9 },
    { id: "z", name: "Zebra stuff", sortOrder: 0 },
    { id: "c", name: "clothing" },
    { id: "b", name: "Baby", parentId: "c" },
  ];
  it("sorts alphabetically by path, children under their parent", () => {
    expect(categoriesAlphabetical(cats).map((n) => n.path)).toEqual(["3D printing", "3D printing › Filament", "Ammo", "clothing", "clothing › Baby", "Zebra stuff"]);
  });
  it("matches words of the path", () => {
    expect(categoryMatches("3D printing › Filament", "print fil")).toBe(true);
    expect(categoryMatches("3D printing › Filament", "ammo")).toBe(false);
  });
  it("plans a new category, under a parent when given", () => {
    expect(newCategoryFromText(cats, " Tools ")).toEqual({ name: "Tools", parentId: null, path: "Tools" });
    expect(newCategoryFromText(cats, "3D printing > Resin")).toEqual({ name: "Resin", parentId: "p", path: "3D printing › Resin" });
    expect(newCategoryFromText(cats, "Clothing › Socks")).toMatchObject({ parentId: "c" });
    expect(newCategoryFromText(cats, "ammo")).toBeNull();
    expect(newCategoryFromText(cats, "Nope > Thing")).toBeNull();
    expect(newCategoryFromText(cats, "  ")).toBeNull();
  });
});
