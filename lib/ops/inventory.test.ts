import { describe, expect, it } from "vitest";
import type { OpContext } from "./context";
import { runOp } from "./registry";

function model(rows: any[]) {
  return {
    list: async () => ({ data: rows, nextToken: null }),
    create: async (row: any) => {
      const saved = { id: `new-${rows.length}`, ...row };
      rows.push(saved);
      return { data: saved };
    },
    update: async ({ id, ...patch }: any) => {
      const row = rows.find((r) => r.id === id);
      Object.assign(row, patch);
      return { data: row };
    },
    delete: async ({ id }: any) => {
      rows.splice(rows.findIndex((r) => r.id === id), 1);
      return { data: { id } };
    },
  };
}

function setup() {
  const categories: any[] = [
    { id: "cl", name: "Clothing", detailType: "CLOTHING", sortOrder: 0 },
    { id: "baby", name: "Baby", parentId: "cl", sortOrder: 0 },
    { id: "sleep", name: "Sleepwear", parentId: "baby", sortOrder: 0 },
    { id: "gear", name: "Gear", sortOrder: 1 },
  ];
  const items: any[] = [
    { id: "i1", categoryId: "baby" },
    { id: "i2", categoryId: "sleep" },
    { id: "i3", categoryId: "gear" },
    { id: "i4" },
  ];
  const ctx: OpContext = {
    client: { models: { homeInventoryCategory: model(categories), homeInventoryItem: model(items) } },
    storage: { storeFromUrl: async () => "", copyUpload: async () => "" },
    actor: { via: "whatsapp", personName: "Gennaro" },
  };
  return { ctx, categories, items };
}

const err = async (ctx: OpContext, name: string, input: unknown) => ((await runOp(ctx, name, input)) as any).error;

describe("list_inventory_categories", () => {
  it("returns the tree with paths, inherited detail types and item counts", async () => {
    const { ctx } = setup();
    const out: any = await runOp(ctx, "list_inventory_categories", {});
    expect(out.result.categories.map((c: any) => [c.path, c.itemCount, c.detailType])).toEqual([
      ["Clothing", 2, "CLOTHING"],
      ["Clothing › Baby", 2, "CLOTHING"],
      ["Clothing › Baby › Sleepwear", 1, "CLOTHING"],
      ["Gear", 1, null],
    ]);
  });
});

describe("save_inventory_category", () => {
  it("creates at the end of its siblings", async () => {
    const { ctx, categories } = setup();
    const out: any = await runOp(ctx, "save_inventory_category", { name: " Adult ", parentId: "cl" });
    expect(out.result.action).toBe("created");
    expect(out.result.category).toMatchObject({ path: "Clothing › Adult", detailType: "CLOTHING", itemCount: 0 });
    expect(categories.at(-1)).toMatchObject({ name: "Adult", parentId: "cl", sortOrder: 1 });
  });

  it("renames and moves, keeping what wasn't given", async () => {
    const { ctx, categories } = setup();
    await runOp(ctx, "save_inventory_category", { categoryId: "baby", name: "Kids" });
    expect(categories[1]).toMatchObject({ name: "Kids", parentId: "cl" });
    const moved: any = await runOp(ctx, "save_inventory_category", { categoryId: "baby", parentId: "gear" });
    expect(moved.result.category).toMatchObject({ path: "Gear › Kids", itemCount: 2, detailType: null });
    const top: any = await runOp(ctx, "save_inventory_category", { categoryId: "baby", parentId: null });
    expect(top.result.category.path).toBe("Kids");
  });

  it("refuses loops, duplicates among siblings and bad references", async () => {
    const { ctx } = setup();
    expect(await err(ctx, "save_inventory_category", { categoryId: "cl", parentId: "sleep" })).toMatch(/inside itself/);
    expect(await err(ctx, "save_inventory_category", { categoryId: "cl", parentId: "cl" })).toMatch(/inside itself/);
    expect(await err(ctx, "save_inventory_category", { name: "clothing" })).toMatch(/already a category/);
    expect(await err(ctx, "save_inventory_category", { categoryId: "gear", parentId: "nope" })).toMatch(/No parent/);
    expect(await err(ctx, "save_inventory_category", { categoryId: "nope", name: "x" })).toMatch(/No category/);
    expect(await err(ctx, "save_inventory_category", {})).toMatch(/name is required/);
    expect(await err(ctx, "save_inventory_category", { categoryId: "gear", name: "  " })).toMatch(/needs a name/);
  });

  it("allows the same name under different parents", async () => {
    const { ctx } = setup();
    const out: any = await runOp(ctx, "save_inventory_category", { name: "Baby", parentId: "gear" });
    expect(out.result.category.path).toBe("Gear › Baby");
  });
});

describe("delete_inventory_category", () => {
  it("moves items to the parent and subcategories up", async () => {
    const { ctx, categories, items } = setup();
    const out: any = await runOp(ctx, "delete_inventory_category", { categoryId: "baby" });
    expect(out.result).toEqual({ deleted: "Baby", itemsMoved: 1, subcategoriesMoved: 1 });
    expect(items[0].categoryId).toBe("cl");
    expect(categories.find((c) => c.id === "sleep").parentId).toBe("cl");
    expect(categories.some((c) => c.id === "baby")).toBe(false);
  });

  it("makes a top-level category with items say where they go", async () => {
    const { ctx, categories, items } = setup();
    expect(await err(ctx, "delete_inventory_category", { categoryId: "gear" })).toMatch(/has 1 item/);
    expect(categories.some((c) => c.id === "gear")).toBe(true);
    await runOp(ctx, "delete_inventory_category", { categoryId: "gear", moveToCategoryId: "cl" });
    expect(items[2].categoryId).toBe("cl");
  });

  it("can send items into a subcategory, which survives", async () => {
    const { ctx, categories, items } = setup();
    await runOp(ctx, "delete_inventory_category", { categoryId: "baby", moveToCategoryId: "sleep" });
    expect(items[0].categoryId).toBe("sleep");
    expect(categories.find((c) => c.id === "sleep").parentId).toBe("cl");
  });

  it("refuses a bad target", async () => {
    const { ctx } = setup();
    expect(await err(ctx, "delete_inventory_category", { categoryId: "baby", moveToCategoryId: "baby" })).toMatch(/being deleted/);
    expect(await err(ctx, "delete_inventory_category", { categoryId: "baby", moveToCategoryId: "nope" })).toMatch(/No category/);
  });
});
