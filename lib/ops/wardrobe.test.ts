import { describe, expect, it } from "vitest";
import type { OpContext } from "./context";
import { OPS, findOp, opJsonSchemas, parseOpInput, runOp, toolDefinition } from "./registry";
import type { OpDef } from "./define";

// In-memory stand-in for the Amplify data client: list/get/create/update
// over plain arrays, with filter support for the eq filters ops use.
function fakeClient(tables: Record<string, any[]>) {
  const matches = (row: any, filter: any) =>
    !filter || Object.entries(filter).every(([k, v]: [string, any]) => row[k] === v.eq);
  const model = (name: string) => ({
    list: async ({ filter }: any = {}) => ({ data: (tables[name] ?? []).filter((r) => matches(r, filter)), nextToken: null }),
    get: async ({ id }: any) => ({ data: (tables[name] ?? []).find((r) => r.id === id) ?? null }),
    create: async (row: any) => {
      const saved = { id: `new-${(tables[name] ??= []).length}`, ...row };
      tables[name].push(saved);
      return { data: saved };
    },
    update: async ({ id, ...patch }: any) => {
      const row = tables[name].find((r) => r.id === id);
      Object.assign(row, patch);
      return { data: row };
    },
  });
  return { models: new Proxy({}, { get: (_t, name: string) => model(name) }) };
}

function setup(items: any[] = []) {
  const tables: Record<string, any[]> = {
    homePerson: [{ id: "p1", name: "Gennaro" }],
    homeWardrobeProfile: [{ personId: "p1", categories: ["Tops", "Knitwear"] }],
    homeWardrobeItem: items.map((i) => ({ ownerPersonId: "p1", ...i })),
  };
  const stored: string[] = [];
  const ctx: OpContext = {
    client: fakeClient(tables),
    storage: {
      storeFromUrl: async (url, prefix) => {
        stored.push(url);
        return `${prefix}from-url-${stored.length}.jpg`;
      },
      copyUpload: async (key, prefix) => `${prefix}copied-${key.split("/").pop()}`,
    },
    actor: { via: "api", personName: "Gennaro" },
  };
  return { ctx, tables, stored };
}

const polo = { id: "i1", category: "Tops", name: "Cotton piqué polo", styleCode: "MPOL1028", url: "https://shop/polo", status: "KEEP", imageKeys: ["home/wardrobe/a.jpg"] };

describe("save_wardrobe_item", () => {
  it("creates a wishlist item for the actor, with photos from links", async () => {
    const { ctx, tables } = setup();
    const out: any = await runOp(ctx, "save_wardrobe_item", {
      name: " Merino polo ",
      category: "Knitwear",
      price: 315,
      colorHex: "",
      imageUrls: ["https://cdn/x.jpg"],
    });
    expect(out.error).toBeUndefined();
    expect(out.result.action).toBe("created");
    expect(tables.homeWardrobeItem[0]).toMatchObject({
      ownerPersonId: "p1",
      name: "Merino polo",
      status: "WISHLIST",
      season: "ALL",
      colorHex: null,
      imageKeys: ["home/wardrobe/from-url-1.jpg"],
    });
    expect(out.result.item.photoUrls).toHaveLength(1);
  });

  it("refuses a duplicate url or style code and returns the existing item", async () => {
    const { ctx } = setup([polo]);
    const out: any = await runOp(ctx, "save_wardrobe_item", { name: "Polo again", category: "Tops", styleCode: "mpol1028" });
    expect(out.error).toMatch(/Already in the wardrobe/);
    expect(out.details.existing.id).toBe("i1");
    const forced: any = await runOp(ctx, "save_wardrobe_item", { name: "Polo again", category: "Tops", styleCode: "mpol1028", allowDuplicate: true });
    expect(forced.result.action).toBe("created");
  });

  it("updates only the fields given and places new photos by photoMode", async () => {
    const { ctx, tables } = setup([polo]);
    const out: any = await runOp(ctx, "save_wardrobe_item", { itemId: "i1", status: "RETIRE", s3Keys: ["home/inventory/u.jpg"], photoMode: "main" });
    expect(out.result.action).toBe("updated");
    expect(tables.homeWardrobeItem[0]).toMatchObject({
      name: "Cotton piqué polo",
      status: "RETIRE",
      imageKeys: ["home/wardrobe/copied-u.jpg", "home/wardrobe/a.jpg"],
    });
  });

  it("takes the web's full photo list as imageKeys", async () => {
    const { ctx, tables } = setup([polo]);
    await runOp(ctx, "save_wardrobe_item", { personId: "p1", itemId: "i1", imageKeys: ["home/wardrobe/b.jpg", "home/wardrobe/a.jpg"] });
    expect(tables.homeWardrobeItem[0].imageKeys).toEqual(["home/wardrobe/b.jpg", "home/wardrobe/a.jpg"]);
    const bad: any = await runOp(ctx, "save_wardrobe_item", { itemId: "i1", imageKeys: ["home/documents/secret.pdf"] });
    expect(bad.error).toMatch(/imageKeys/);
  });

  it("reports every bad field at once and saves nothing", async () => {
    const { ctx, tables } = setup();
    const out: any = await runOp(ctx, "save_wardrobe_item", {
      name: "x",
      category: "Tops",
      status: "OWNED",
      price: -1,
      quantity: 1.5,
      url: "shop.com/x",
      colorHex: "navy",
      lastWornOn: "Oct 3",
    });
    expect(out.error.split("; ")).toHaveLength(6);
    expect(tables.homeWardrobeItem).toHaveLength(0);
  });

  it("needs a name and category to create, and a real itemId to update", async () => {
    const { ctx } = setup();
    expect(((await runOp(ctx, "save_wardrobe_item", { brand: "Sunspel" })) as any).error).toMatch(/name and category required/);
    expect(((await runOp(ctx, "save_wardrobe_item", { itemId: "nope", status: "KEEP" })) as any).error).toMatch(/No wardrobe item nope/);
  });
});

describe("list_wardrobe", () => {
  it("defaults to owned items and returns categories", async () => {
    const { ctx } = setup([polo, { id: "i2", category: "Knitwear", name: "Wish", status: "WISHLIST", price: 100 }]);
    const owned: any = await runOp(ctx, "list_wardrobe", {});
    expect(owned.result.items.map((i: any) => i.id)).toEqual(["i1"]);
    expect(owned.result.categories).toEqual(["Tops", "Knitwear"]);
    const wish: any = await runOp(ctx, "list_wardrobe", { status: "WISHLIST" });
    expect(wish.result.wishlistTotalUsd).toBe(100);
  });
});

describe("get_trip_plan", () => {
  function tripSetup(planStatus: string | null) {
    const { ctx, tables } = setup([
      { ...polo, quantity: 4 },
      { id: "i2", category: "Pants", name: "Chino", brand: "Todd Snyder", color: "Stone" },
    ]);
    tables.homeTrip = [
      { id: "past", name: "Austin", startDate: "2020-01-01", endDate: "2020-01-02", participantIds: ["p1"] },
      { id: "t1", name: "Seattle", startDate: "2099-11-16", endDate: "2099-11-18", participantIds: ["p1"], destination: { city: "Seattle" } },
      { id: "t2", name: "Other person", startDate: "2099-01-01", endDate: "2099-01-02", participantIds: ["p9"] },
    ];
    tables.homeWardrobeTripPlan = planStatus
      ? [
          {
            id: "plan",
            tripId: "t1",
            personId: "p1",
            status: planStatus,
            updatedAt: "2099-01-01",
            capacity: "CARRY_ON",
            context: "Seattle",
            packItemIds: ["i1", "i2", "gone"],
            packedItemIds: ["i2"],
            weather: JSON.stringify([{ date: "2099-11-16", source: "TYPICAL", highF: 53, lowF: 40, precipChance: 30, summary: "Some rainy days" }]),
            looks: JSON.stringify([
              { date: "2099-11-16", title: "Travel", occasion: "Flight", itemIds: ["i1", "i2"], why: "Easy." },
              { date: "2099-11-17", title: "Office", occasion: null, itemIds: ["i1"], why: null },
            ]),
            tips: "Bring an umbrella.",
          },
        ]
      : [];
    return ctx;
  }

  it("defaults to the next trip the person is on and serves the saved plan", async () => {
    const out: any = await runOp(tripSetup("READY"), "get_trip_plan", {});
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ trip: "Seattle", dates: "2099-11-16 to 2099-11-18", status: "READY", luggage: "CARRY_ON", tips: "Bring an umbrella." });
    // Items no longer in the closet drop out; copies follow the days worn.
    expect(out.result.packingList.map((p: any) => [p.id, p.copiesToPack, p.packed])).toEqual([
      ["i1", 2, false],
      ["i2", 1, true],
    ]);
    expect(out.result.looks[0].pieces).toEqual(["Cotton piqué polo", "Todd Snyder Chino (Stone)"]);
    expect(out.result.weather[0].forecast).toMatch(/Some rainy days/);
  });

  it("finds a trip by name or city, and says when there's no finished plan", async () => {
    expect(((await runOp(tripSetup("GENERATING"), "get_trip_plan", { tripName: "seattle" })) as any).result).toMatchObject({ status: "GENERATING" });
    expect(((await runOp(tripSetup(null), "get_trip_plan", { tripName: "Seattle" })) as any).result).toMatchObject({ status: "NONE" });
    expect(((await runOp(tripSetup(null), "get_trip_plan", { tripName: "Lisbon" })) as any).error).toMatch(/No trip matching/);
  });
});

describe("registry", () => {
  it("parses runOp's AWSJSON input either way", () => {
    expect(parseOpInput('{"a":1}')).toEqual({ input: { a: 1 } });
    expect(parseOpInput({ a: 1 })).toEqual({ input: { a: 1 } });
    expect(parseOpInput(null)).toEqual({ input: {} });
    expect(parseOpInput("{nope")).toEqual({ error: "input must be JSON" });
  });

  it("keeps sensitive ops off the API and CLI", async () => {
    const { ctx } = setup();
    const op = findOp("list_wardrobe")!;
    const original = op.access;
    (op as { access: string }).access = "sensitive";
    try {
      expect(await runOp(ctx, "list_wardrobe", {})).toEqual({ error: "list_wardrobe isn't available over the API" });
      expect(((await runOp({ ...ctx, actor: { via: "whatsapp", personName: "Gennaro" } }, "list_wardrobe", {})) as any).result).toBeDefined();
    } finally {
      (op as { access: string }).access = original;
    }
  });

  it("rejects unknown ops and people", async () => {
    const { ctx } = setup();
    expect(await runOp(ctx, "nope", {})).toEqual({ error: "Unknown operation: nope" });
    expect(((await runOp(ctx, "list_wardrobe", { personName: "Nobody" })) as any).error).toMatch(/No person named/);
  });

  it("generates tool and API schemas for every op", () => {
    for (const op of OPS) {
      const def = op as unknown as OpDef;
      const tool = toolDefinition(def);
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema).not.toHaveProperty("$schema");
      expect(opJsonSchemas(def).output).toHaveProperty("properties");
    }
    const save = toolDefinition(findOp("save_wardrobe_item")!);
    expect((save.input_schema.properties as any).status.enum).toContain("WISHLIST");
  });
});
