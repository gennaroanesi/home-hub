import { describe, expect, it } from "vitest";
import type { OpContext } from "./context";
import { runOp } from "./registry";

/* eslint-disable @typescript-eslint/no-explicit-any */

// In-memory Amplify models with `eq` filters. Like a Lambda's client, it
// returns every row (owner rules are enforced by AppSync, not here), so
// these tests check that the ops themselves keep owner-only rows to their
// owner.
function setup(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {};
  let n = 0;
  const matches = (row: any, filter: any) => !filter || Object.entries(filter).every(([k, cond]: [string, any]) => row[k] === cond.eq);
  const model = (name: string) => {
    const rows = (tables[name] = (seed[name] ?? []).map((r) => ({ ...r })));
    return {
      list: async (opts: any = {}) => ({ data: rows.filter((r) => matches(r, opts.filter)), nextToken: null }),
      get: async ({ id }: any) => ({ data: rows.find((r) => r.id === id) ?? null }),
      create: async (row: any) => {
        const saved = { id: `${name}-${++n}`, createdAt: `2026-11-19T00:00:${String(n).padStart(2, "0")}Z`, ...row };
        rows.push(saved);
        return { data: saved };
      },
      update: async ({ id, ...patch }: any) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return { data: null, errors: [{ message: "not found" }] };
        Object.assign(row, patch);
        return { data: row };
      },
      delete: async ({ id }: any) => {
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
        return { data: { id } };
      },
    };
  };
  const names = [
    "homePerson", "homePet", "homePregnancy", "homeRoom", "homeShoppingList", "homeShoppingItem", "homeOutboundMessage",
    "homeInventoryCategory", "homeInventoryItem", "homePrivateInventoryItem",
    "homeInventoryClothing", "homeInventoryConsumable", "homeInventoryFirearm", "homeInventoryAmmo", "homeInventoryFilament",
    "homeInventoryInstrument", "homeInventoryPhotography", "homeInventoryElectronic", "homeAmmoUse", "homeAmmoThreshold",
  ];
  const models = Object.fromEntries(names.map((m) => [m, model(m)]));
  const ctx = (actor: Partial<OpContext["actor"]> = {}, extra: Partial<OpContext> = {}): OpContext => ({
    client: { models },
    storage: { storeFromUrl: async () => "home/inventory/url.jpg", copyUpload: async () => "home/inventory/copy.jpg" },
    actor: { via: "whatsapp", personName: "Gennaro", ...actor },
    ...extra,
  });
  return { ctx, tables };
}

const people = [
  { id: "gen", name: "Gennaro", cognitoUsername: "u-gen", groups: ["home-users"] },
  { id: "cris", name: "Cris", cognitoUsername: "u-cris", groups: ["home-users"] },
];
const categories = [
  { id: "guns", name: "Firearms", detailType: "FIREARM" },
  { id: "ammo", name: "Ammo", detailType: "AMMO" },
  { id: "print", name: "3D printing" },
  { id: "fil", name: "Filament", parentId: "print", detailType: "FILAMENT" },
  { id: "pantry", name: "Pantry", detailType: "CONSUMABLE" },
  { id: "gear", name: "Gear" },
];
const base = () => ({
  homePerson: people,
  homeInventoryCategory: categories,
  homeShoppingList: [{ id: "sl", name: "Supermarket" }],
  homeInventoryItem: [
    { id: "pla", name: "Bambu PLA Basic", categoryId: "fil", status: "OWNED", quantity: 3 },
    { id: "rice", name: "Rice", categoryId: "pantry", status: "OWNED", quantity: 3 },
  ],
  homeInventoryFilament: [{ id: "d-pla", itemId: "pla", material: "PLA", color: "Black", weightG: 1000 }],
  homeInventoryConsumable: [{ id: "d-rice", itemId: "rice", unit: "bag", lowStockThreshold: 1 }],
  homePrivateInventoryItem: [
    { id: "g19", name: "Glock 19", categoryId: "guns", status: "OWNED", ownerPersonId: "gen", ownerUsername: "u-gen" },
    { id: "lot-old", name: "Federal 9mm", categoryId: "ammo", status: "OWNED", quantity: 2, acquiredAt: "2025-01-01", ownerPersonId: "gen", ownerUsername: "u-gen" },
    { id: "lot-new", name: "Blazer 9mm", categoryId: "ammo", status: "OWNED", quantity: 1, acquiredAt: "2026-06-01", ownerPersonId: "gen", ownerUsername: "u-gen" },
    { id: "cris-gun", name: "Cris's shotgun", categoryId: "guns", status: "OWNED", ownerPersonId: "cris", ownerUsername: "u-cris" },
  ],
  homeInventoryFirearm: [
    { id: "d-g19", itemId: "g19", type: "HANDGUN", caliber: "9mm", serialNumber: "ABC123", ownerUsername: "u-gen" },
    { id: "d-cris", itemId: "cris-gun", type: "SHOTGUN", caliber: "12 ga", ownerUsername: "u-cris" },
  ],
  homeInventoryAmmo: [
    { id: "d-old", itemId: "lot-old", caliber: "9mm", roundsAvailable: 100, ownerUsername: "u-gen" },
    { id: "d-new", itemId: "lot-new", caliber: "9mm", roundsAvailable: 500, ownerUsername: "u-gen" },
  ],
});

const run = async (c: OpContext, name: string, input: unknown) => (await runOp(c, name, input)) as any;
const names = (out: any) => out.result.items.map((i: any) => i.name).sort();

describe("owner-only firearms and ammo", () => {
  it("lists them only to their owner, never in a group chat", async () => {
    const { ctx } = setup(base());
    expect(names(await run(ctx(), "list_inventory", {}))).toEqual(["Bambu PLA Basic", "Blazer 9mm", "Federal 9mm", "Glock 19", "Rice"]);
    expect(names(await run(ctx({ personName: "Cris" }), "list_inventory", {}))).toEqual(["Bambu PLA Basic", "Cris's shotgun", "Rice"]);
    const group = await run(ctx({ groupChat: true }), "list_inventory", {});
    expect(names(group)).toEqual(["Bambu PLA Basic", "Rice"]);
    expect(group.result.hiddenPrivate).toBe(true);
    // The phone: the verified login wins over a name.
    expect(names(await run(ctx({ via: "mobile", personName: null, username: "u-cris" }), "list_inventory", { detailType: "FIREARM" }))).toEqual(["Cris's shotgun"]);
  });

  it("returns details and a summary", async () => {
    const { ctx } = setup(base());
    const g = (await run(ctx(), "get_inventory_item", { query: "glock" })).result.item;
    expect(g).toMatchObject({ private: true, detailType: "FIREARM", summary: "Handgun · 9mm", details: { serialNumber: "ABC123", type: "HANDGUN" } });
    const pla = (await run(ctx(), "list_inventory", { query: "black" })).result.items[0];
    expect(pla).toMatchObject({ name: "Bambu PLA Basic", summary: "PLA · Black · 3 spools", private: false });
  });

  it("creates them in the private table, owned by whoever asks; refuses in a group chat", async () => {
    const { ctx, tables } = setup(base());
    const out = await run(ctx(), "manage_inventory_item", { action: "create", name: "AR-15", category: "Firearms", details: { type: "rifle", caliber: "5.56 NATO" } });
    expect(out.error).toBeUndefined();
    const row = tables.homePrivateInventoryItem.find((r) => r.name === "AR-15");
    expect(row).toMatchObject({ ownerUsername: "u-gen", ownerPersonId: "gen" });
    expect(tables.homeInventoryItem.some((r) => r.name === "AR-15")).toBe(false);
    expect(tables.homeInventoryFirearm.find((d) => d.itemId === row.id)).toMatchObject({ type: "RIFLE", ownerUsername: "u-gen" });
    expect((await run(ctx({ groupChat: true }), "manage_inventory_item", { action: "create", name: "x", category: "Firearms" })).error).toMatch(/direct message/);
    expect((await run(ctx(), "manage_inventory_item", { action: "create", name: "x", category: "Firearms", ownerName: "Cris" })).error).toMatch(/person asking/);
    expect((await run(ctx({ personName: "Cris" }), "manage_inventory_item", { action: "update", query: "Glock 19", notes: "mine now" })).error).toMatch(/No inventory item/);
  });

  it("moves an item between tables when its category changes", async () => {
    const { ctx, tables } = setup({ ...base(), homeInventoryItem: [...base().homeInventoryItem, { id: "case", name: "Pistol case", categoryId: "gear", status: "OWNED" }] });
    const out = await run(ctx(), "manage_inventory_item", { action: "update", query: "Pistol case", category: "Firearms", details: { type: "other" } });
    expect(out.result.item).toMatchObject({ name: "Pistol case", private: true, detailType: "FIREARM" });
    expect(tables.homeInventoryItem.some((r) => r.id === "case")).toBe(false);
    expect(tables.homePrivateInventoryItem.find((r) => r.name === "Pistol case")).toMatchObject({ ownerUsername: "u-gen" });
  });
});

describe("detail fields", () => {
  it("validates against the category's spec", async () => {
    const { ctx, tables } = setup(base());
    expect((await run(ctx(), "manage_inventory_item", { action: "update", query: "Bambu PLA", details: { caliber: "9mm" } })).error).toMatch(/isn't a 3d-printer filament field/i);
    expect((await run(ctx(), "manage_inventory_item", { action: "update", query: "Bambu PLA", details: { material: "unobtanium" } })).error).toMatch(/one of PLA/);
    await run(ctx(), "manage_inventory_item", { action: "update", query: "Bambu PLA", details: { material: "pla cf", weightG: "750", diameter: "1.75" } });
    expect(tables.homeInventoryFilament[0]).toMatchObject({ material: "PLA_CF", weightG: 750, diameter: "1.75", color: "Black" });
  });

  it("restocks a consumable that runs low", async () => {
    const { ctx, tables } = setup(base());
    const out = await run(ctx(), "adjust_inventory_quantity", { query: "rice", delta: -2 });
    expect(out.result).toMatchObject({ before: 3, after: 1, restock: { lowStock: true, addedToList: "Supermarket" } });
    expect(tables.homeShoppingItem.map((i) => i.name)).toEqual(["Rice"]);
  });

  it("drafts from a photo, but never firearms or ammo", async () => {
    const { ctx, tables } = setup(base());
    const c = ctx({}, { messageImageKeys: ["home/inventory/shelf.jpg"] });
    const out = await run(c, "add_inventory_items", { items: [{ name: "Sunlu PETG", category: "Filament", quantity: 2, details: { material: "PETG", color: "White" } }] });
    expect(out.result).toMatchObject({ photoAttached: true, created: [{ name: "Sunlu PETG", quantity: 2 }] });
    expect(tables.homeInventoryItem.find((i) => i.name === "Sunlu PETG")).toMatchObject({ status: "DRAFT", imageKeys: ["home/inventory/shelf.jpg"] });
    expect((await run(c, "add_inventory_items", { items: [{ name: "Ammo can", category: "Ammo" }] })).error).toMatch(/can't be drafted/);
  });

  it("deletes an item with its detail row and detaches its parts", async () => {
    const { ctx, tables } = setup(base());
    await run(ctx(), "manage_inventory_item", { action: "create", name: "Holosun 507C", category: "Firearms", partOf: "Glock 19", details: { type: "other" } });
    const out = await run(ctx(), "manage_inventory_item", { action: "delete", query: "Glock 19" });
    expect(out.result.deleted).toBe("Glock 19");
    expect(tables.homeInventoryFirearm.some((d) => d.itemId === "g19")).toBe(false);
    expect(tables.homePrivateInventoryItem.find((i) => i.name === "Holosun 507C").parentItemId).toBeNull();
  });

  it("links parts to what they're installed on", async () => {
    const { ctx } = setup(base());
    await run(ctx(), "manage_inventory_item", { action: "create", name: "Holosun 507C", category: "Firearms", partOf: "Glock 19", details: { type: "other" } });
    const g = (await run(ctx(), "get_inventory_item", { query: "Glock 19" })).result;
    expect(g.item.partCount).toBe(1);
    expect(g.parts.map((p: any) => [p.name, p.parentName])).toEqual([["Holosun 507C", "Glock 19"]]);
  });
});

describe("ammo", () => {
  it("logs use from the oldest lot first, DMs once below the minimum, and undoes", async () => {
    const { ctx, tables } = setup(base());
    expect((await run(ctx(), "save_ammo_threshold", { caliber: "9MM", minRounds: 450 })).result).toMatchObject({ currentRounds: 600, below: false });
    const use = (await run(ctx(), "log_ammo_use", { caliber: "9mm", rounds: 200, note: "range" })).result;
    expect(use).toMatchObject({ caliber: "9mm", rounds: 200, shortfall: 0, remaining: 400, lowAmmo: ["9MM"] });
    expect(tables.homeInventoryAmmo.map((d) => [d.itemId, d.roundsAvailable])).toEqual([["lot-old", 0], ["lot-new", 400]]);
    expect(tables.homeOutboundMessage).toHaveLength(1);
    expect(tables.homeOutboundMessage[0]).toMatchObject({ target: "PERSON", personId: "gen", kind: "ammo_low" });
    // Still below: no second DM.
    await run(ctx(), "log_ammo_use", { caliber: "9mm", rounds: 10 });
    expect(tables.homeOutboundMessage).toHaveLength(1);

    const summary = (await run(ctx(), "get_ammo_summary", {})).result;
    expect(summary.calibers).toEqual([{ caliber: "9mm", rounds: 390, lots: 1, minRounds: 450, below: true }]);
    expect(summary.recentUses.map((u: any) => u.rounds).sort()).toEqual([10, 200]);

    const undone = (await run(ctx(), "log_ammo_use", { undoUseId: use.useId })).result;
    expect(undone).toMatchObject({ rounds: 200, remaining: 590 });
    expect(tables.homeInventoryAmmo.map((d) => d.roundsAvailable)).toEqual([100, 490]);
    // Back above: re-armed for the next drop.
    expect(tables.homeAmmoThreshold[0].notifiedAt).toBeNull();
  });

  it("is owner-only", async () => {
    const { ctx } = setup(base());
    expect((await run(ctx({ groupChat: true }), "get_ammo_summary", {})).error).toMatch(/direct message/);
    expect((await run(ctx({ personName: "Cris" }), "get_ammo_summary", {})).result.calibers).toEqual([]);
    expect((await run(ctx({ personName: "Cris" }), "log_ammo_use", { caliber: "9mm", rounds: 5 })).error).toMatch(/No ammo of caliber/);
  });
});

describe("get_inventory_overview", () => {
  const seed = () => {
    const b = base();
    return {
      ...b,
      homeInventoryItem: [
        { ...b.homeInventoryItem[0], pricePaid: 20, imageKeys: ["home/inventory/pla.jpg"], createdAt: "2026-01-01T00:00:00Z" },
        { ...b.homeInventoryItem[1], pricePaid: 5, ownerPersonId: "cris", createdAt: "2026-02-01T00:00:00Z" },
        { id: "nozzle", name: "Hardened nozzle", categoryId: "print", status: "WISHLIST", estimatedPrice: 30 },
        { id: "loose", name: "Mystery cable", status: "OWNED", createdAt: "2026-03-01T00:00:00Z" },
        { id: "old", name: "Old printer", categoryId: "print", status: "SOLD" },
      ],
      homePrivateInventoryItem: b.homePrivateInventoryItem.map((i) => ({ ...i, pricePaid: i.id === "g19" ? 500 : 0 })),
    };
  };

  it("rolls subcategories into their parent and counts private items only for their owner", async () => {
    const { ctx } = setup(seed());
    const r = (await run(ctx(), "get_inventory_overview", {})).result;
    const cat = (label: string) => r.categories.find((c: any) => c.label === label);
    expect(cat("3D printing")).toMatchObject({ count: 1, value: 60, wishlist: 1, imageKey: "home/inventory/pla.jpg", depth: 0 });
    expect(cat("Filament")).toMatchObject({ count: 1, parentId: "print", depth: 1 });
    expect(cat("Firearms")).toMatchObject({ count: 1, value: 500, private: true });
    expect(cat("Uncategorized")).toMatchObject({ key: "none", count: 1 });
    expect(cat("Gear")).toBeUndefined();
    expect(r.statusCounts).toEqual({ WISHLIST: 1, DRAFT: 0, PAST: 1 });
    expect(r.lowStock).toBe(0);
    expect(r.owners.map((o: any) => o.label).sort()).toEqual(["Cris", "Gennaro", "Household"]);
    expect(r.recent[0].name).toBe("Mystery cable");

    const group = (await run(ctx({ groupChat: true }), "get_inventory_overview", {})).result;
    expect(group.categories.some((c: any) => c.private)).toBe(false);
    expect(group.hiddenPrivate).toBe(true);
  });

  it("list_inventory filters by category and room ids, 'none' for unset", async () => {
    const { ctx } = setup(seed());
    expect(names(await run(ctx(), "list_inventory", { categoryId: "print", status: "ALL" }))).toEqual(["Bambu PLA Basic", "Hardened nozzle", "Old printer"]);
    expect(names(await run(ctx(), "list_inventory", { categoryId: "none" }))).toEqual(["Mystery cable"]);
    expect((await run(ctx(), "list_inventory", { roomId: "none" })).result.count).toBe(6);
  });
});
