import { describe, expect, it } from "vitest";
import type { OpContext } from "./context";
import { runOp } from "./registry";

function table(initial: any[]) {
  const rows = initial.map((r) => ({ ...r }));
  return {
    rows,
    model: {
      list: async () => ({ data: rows, nextToken: null }),
      get: async ({ id }: any) => ({ data: rows.find((r) => r.id === id) ?? null }),
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
    },
  };
}

function setup(seed: { people?: any[]; businesses?: any[]; providers?: any[] } = {}) {
  const people = table(seed.people ?? []);
  const businesses = table(seed.businesses ?? []);
  const providers = table(seed.providers ?? []);
  const ctx: OpContext = {
    client: { models: { homePerson: people.model, homeBusiness: businesses.model, homeHealthProvider: providers.model } },
    storage: { storeFromUrl: async () => "", copyUpload: async () => "" },
    actor: { via: "whatsapp", personName: "Gennaro" },
  };
  return { ctx, people: people.rows, businesses: businesses.rows };
}

const household = { id: "h1", name: "Gennaro", groups: ["home-users"], birthday: "1990-01-01" };
const marco = { id: "c1", name: "Marco", relationship: "FRIEND", phoneNumber: "+15125550101", groups: [] };
const ana = { id: "c2", name: "Ana", relationship: "FAMILY", birthday: "1900-12-25" };

describe("list_contacts", () => {
  it("leaves household members out", async () => {
    const { ctx } = setup({ people: [household, marco, ana] });
    const out: any = await runOp(ctx, "list_contacts", {});
    expect(out.result.contacts.map((c: any) => c.name)).toEqual(["Ana", "Marco"]);
  });

  it("filters by relationship and query", async () => {
    const { ctx } = setup({ people: [household, marco, ana] });
    const fam: any = await runOp(ctx, "list_contacts", { relationship: "FAMILY" });
    expect(fam.result.contacts.map((c: any) => c.id)).toEqual(["c2"]);
    const q: any = await runOp(ctx, "list_contacts", { query: "0101" });
    expect(q.result.contacts.map((c: any) => c.id)).toEqual(["c1"]);
  });
});

describe("save_contact", () => {
  it("creates a contact outside the household", async () => {
    const { ctx, people } = setup({ people: [household] });
    const out: any = await runOp(ctx, "save_contact", { name: " Lucia ", relationship: "FRIEND", birthday: "1992-05-03" });
    expect(out.result.action).toBe("created");
    expect(people[1]).toMatchObject({ name: "Lucia", relationship: "FRIEND", birthday: "1992-05-03", groups: [] });
  });

  it("refuses duplicates and household members", async () => {
    const { ctx } = setup({ people: [household, marco] });
    const dup: any = await runOp(ctx, "save_contact", { name: "marco" });
    expect(dup.error).toMatch(/already/);
    const member: any = await runOp(ctx, "save_contact", { contactId: "h1", notes: "x" });
    expect(member.error).toMatch(/household member/);
  });

  it("updates only what's given and clears with null", async () => {
    const { ctx, people } = setup({ people: [marco] });
    await runOp(ctx, "save_contact", { contactId: "c1", phoneNumber: null, notes: "Met at work" });
    expect(people[0]).toMatchObject({ name: "Marco", relationship: "FRIEND", phoneNumber: null, notes: "Met at work" });
  });
});

describe("businesses", () => {
  const repair = { id: "b1", name: "Austin Appliance Repair", category: "HOME", service: "Fixed the dishwasher pump", contactName: "Mike" };
  const obgyn = { id: "p1", name: "Dr. Lee", specialty: "OB/GYN", practice: "ARC", phones: [{ kind: "CLINIC", number: "+15125550199" }] };

  it("lists businesses with health providers, searchable by service", async () => {
    const { ctx } = setup({ businesses: [repair], providers: [obgyn] });
    const all: any = await runOp(ctx, "list_businesses", {});
    expect(all.result.businesses.map((b: any) => [b.name, b.source])).toEqual([
      ["Austin Appliance Repair", "business"],
      ["Dr. Lee", "health"],
    ]);
    expect(all.result.businesses[1]).toMatchObject({ category: "HEALTH", service: "OB/GYN", phone: "+15125550199" });
    const dish: any = await runOp(ctx, "list_businesses", { query: "dishwasher" });
    expect(dish.result.businesses.map((b: any) => b.id)).toEqual(["b1"]);
    const health: any = await runOp(ctx, "list_businesses", { category: "HEALTH" });
    expect(health.result.businesses.map((b: any) => b.id)).toEqual(["p1"]);
  });

  it("creates, refuses duplicates, and updates", async () => {
    const { ctx, businesses } = setup({ businesses: [repair] });
    const out: any = await runOp(ctx, "save_business", { name: "Joe's Garage", category: "AUTO", lastUsedOn: "2026-11-01" });
    expect(out.result.action).toBe("created");
    expect(businesses[1]).toMatchObject({ name: "Joe's Garage", category: "AUTO", active: true });
    const dup: any = await runOp(ctx, "save_business", { name: "austin appliance repair" });
    expect(dup.error).toMatch(/already saved/);
    await runOp(ctx, "save_business", { businessId: "b1", phone: "+15125550123", contactName: null });
    expect(businesses[0]).toMatchObject({ phone: "+15125550123", contactName: null, service: "Fixed the dishwasher pump" });
  });
});
