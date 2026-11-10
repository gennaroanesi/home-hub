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
      delete: async ({ id }: any) => {
        rows.splice(rows.findIndex((r) => r.id === id), 1);
        return { data: { id } };
      },
    },
  };
}

function setup(seed: { people?: any[]; businesses?: any[]; providers?: any[]; relationships?: any[] } = {}) {
  const people = table(seed.people ?? []);
  const relationships = table(seed.relationships ?? []);
  const businesses = table(seed.businesses ?? []);
  const providers = table(seed.providers ?? []);
  const ctx: OpContext = {
    client: { models: { homePerson: people.model, homeBusiness: businesses.model, homeHealthProvider: providers.model, homePersonRelationship: relationships.model } },
    storage: { storeFromUrl: async () => "", copyUpload: async () => "" },
    actor: { via: "whatsapp", personName: "Gennaro" },
  };
  return { ctx, people: people.rows, businesses: businesses.rows, relationships: relationships.rows };
}

const household = { id: "h1", name: "Gennaro", groups: ["home-users"], birthday: "1990-01-01" };
const marco = { id: "c1", name: "Marco", circle: "FRIEND", phoneNumber: "+15125550101", groups: [] };
const ana = { id: "c2", name: "Ana", circle: "FAMILY", birthday: "1900-12-25" };

describe("list_contacts", () => {
  it("leaves household members out", async () => {
    const { ctx } = setup({ people: [household, marco, ana] });
    const out: any = await runOp(ctx, "list_contacts", {});
    expect(out.result.contacts.map((c: any) => c.name)).toEqual(["Ana", "Marco"]);
  });

  it("filters by circle and query", async () => {
    const { ctx } = setup({ people: [household, marco, ana] });
    const fam: any = await runOp(ctx, "list_contacts", { circle: "FAMILY" });
    expect(fam.result.contacts.map((c: any) => c.id)).toEqual(["c2"]);
    const q: any = await runOp(ctx, "list_contacts", { query: "0101" });
    expect(q.result.contacts.map((c: any) => c.id)).toEqual(["c1"]);
  });
});

describe("save_contact", () => {
  it("creates a contact outside the household", async () => {
    const { ctx, people } = setup({ people: [household] });
    const out: any = await runOp(ctx, "save_contact", { name: " Lucia ", circle: "FRIEND", birthday: "1992-05-03" });
    expect(out.result.action).toBe("created");
    expect(people[1]).toMatchObject({ name: "Lucia", circle: "FRIEND", birthday: "1992-05-03", groups: [] });
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
    expect(people[0]).toMatchObject({ name: "Marco", circle: "FRIEND", phoneNumber: null, notes: "Met at work" });
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

describe("relationships ops", () => {
  const pri = { id: "pri", name: "Priscilla", groups: [] };
  const gab = { id: "gab", name: "Gabrielle", groups: [] };
  const eva = { id: "eva", name: "Eva", groups: [] };

  it("records a pair once and shows it from both sides", async () => {
    const { ctx, relationships } = setup({ people: [pri, gab, eva] });
    const s1: any = await runOp(ctx, "save_relationship", { personName: "Priscilla", kind: "SPOUSE", relatedPersonName: "gabrielle" });
    expect(s1.result).toEqual({ action: "created", summary: "Priscilla is Gabrielle's spouse" });
    const s2: any = await runOp(ctx, "save_relationship", { personName: "Eva", kind: "CHILD", relatedPersonName: "Priscilla", label: "daughter" });
    expect(s2.result.summary).toBe("Eva is Priscilla's daughter");
    expect(relationships).toHaveLength(2);
    expect(relationships[1]).toMatchObject({ personId: "pri", relatedPersonId: "eva", kind: "PARENT", inverseLabel: "daughter" });

    const p: any = await runOp(ctx, "list_relationships", { personName: "Priscilla" });
    expect(p.result.relations.map((r: any) => `${r.name}:${r.role}`)).toEqual(["Gabrielle:spouse", "Eva:daughter"]);
    const e: any = await runOp(ctx, "list_contacts", { query: "eva" });
    expect(e.result.contacts[0].relations).toEqual([{ relationshipId: expect.any(String), personId: "pri", name: "Priscilla", kind: "PARENT", role: "parent" }]);
  });

  it("replaces an existing pair, unlinks, and rejects self-links", async () => {
    const { ctx, relationships } = setup({ people: [pri, gab], relationships: [{ id: "r1", personId: "pri", relatedPersonId: "gab", kind: "FRIEND" }] });
    const up: any = await runOp(ctx, "save_relationship", { personId: "gab", kind: "SPOUSE", relatedPersonId: "pri" });
    expect(up.result.action).toBe("updated");
    expect(relationships).toEqual([expect.objectContaining({ id: "r1", personId: "gab", relatedPersonId: "pri", kind: "SPOUSE" })]);
    const self: any = await runOp(ctx, "save_relationship", { personId: "pri", kind: "SPOUSE", relatedPersonId: "pri" });
    expect(self.error).toMatch(/themselves/);
    const rm: any = await runOp(ctx, "save_relationship", { personName: "Priscilla", relatedPersonName: "Gabrielle", remove: true });
    expect(rm.result.action).toBe("removed");
    expect(relationships).toHaveLength(0);
  });
});
