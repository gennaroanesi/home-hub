import { describe, expect, it } from "vitest";
import type { OpContext } from "./context";
import { runOp } from "./registry";

function setup(notes: any[] = []) {
  const rows = notes.map((n) => ({ ...n }));
  const homeNote = {
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
  };
  const ctx: OpContext = {
    client: { models: { homeNote } },
    storage: { storeFromUrl: async () => "", copyUpload: async () => "" },
    actor: { via: "whatsapp", personName: "Gennaro" },
  };
  return { ctx, rows };
}

const stores = { id: "n1", title: "Clothing stores", content: "- Todd Snyder\n", updatedAt: "2026-10-30T00:00:00Z" };
const tripNote = { id: "n2", title: null, content: "Hotel wifi is slow", parentType: "TRIP", parentId: "t1", updatedAt: "2026-10-31T00:00:00Z" };

describe("list_notes", () => {
  it("lists newest first and filters by query, parent and standalone", async () => {
    const { ctx } = setup([stores, tripNote]);
    const all: any = await runOp(ctx, "list_notes", {});
    expect(all.result.notes.map((n: any) => n.id)).toEqual(["n2", "n1"]);
    const q: any = await runOp(ctx, "list_notes", { query: "clothing todd" });
    expect(q.result.notes.map((n: any) => n.id)).toEqual(["n1"]);
    const alone: any = await runOp(ctx, "list_notes", { standalone: true });
    expect(alone.result.notes.map((n: any) => n.id)).toEqual(["n1"]);
    const trip: any = await runOp(ctx, "list_notes", { parentType: "TRIP", parentId: "t1" });
    expect(trip.result.notes[0]).toMatchObject({ id: "n2", title: null, parentType: "TRIP" });
  });

  it("caps results but reports the full count", async () => {
    const { ctx } = setup([stores, tripNote]);
    const out: any = await runOp(ctx, "list_notes", { limit: 1 });
    expect(out.result.count).toBe(2);
    expect(out.result.notes).toHaveLength(1);
  });
});

describe("save_note", () => {
  it("creates a standalone note and records who made it", async () => {
    const { ctx, rows } = setup();
    const out: any = await runOp(ctx, "save_note", { title: " Clothing stores ", content: "- Sunspel" });
    expect(out.result.action).toBe("created");
    expect(rows[0]).toMatchObject({ title: "Clothing stores", content: "- Sunspel", parentId: null, createdBy: "agent" });
  });

  it("appends a line without touching the rest", async () => {
    const { ctx, rows } = setup([stores]);
    const out: any = await runOp(ctx, "save_note", { noteId: "n1", appendText: "- Sunspel" });
    expect(out.result.action).toBe("updated");
    expect(rows[0]).toMatchObject({ title: "Clothing stores", content: "- Todd Snyder\n- Sunspel" });
  });

  it("replaces content, renames, and clears a title", async () => {
    const { ctx, rows } = setup([stores]);
    await runOp(ctx, "save_note", { noteId: "n1", content: "New" });
    expect(rows[0]).toMatchObject({ title: "Clothing stores", content: "New" });
    await runOp(ctx, "save_note", { noteId: "n1", title: "Shops" });
    expect(rows[0]).toMatchObject({ title: "Shops", content: "New" });
    await runOp(ctx, "save_note", { noteId: "n1", title: null });
    expect(rows[0].title).toBeNull();
  });

  it("refuses a second standalone note with the same title and points at the first", async () => {
    const { ctx, rows } = setup([stores]);
    const out: any = await runOp(ctx, "save_note", { title: "clothing STORES", content: "x" });
    expect(out.error).toMatch(/already a note/);
    expect(out.details.existing.id).toBe("n1");
    expect(rows).toHaveLength(1);
    const forced: any = await runOp(ctx, "save_note", { title: "clothing STORES", content: "x", allowDuplicate: true });
    expect(forced.result.action).toBe("created");
    // Attached notes can share titles.
    const attached: any = await runOp(ctx, "save_note", { title: "Clothing stores", content: "x", parentType: "TRIP", parentId: "t1" });
    expect(attached.result.note.parentId).toBe("t1");
  });

  it("rejects contradictory or empty requests", async () => {
    const { ctx } = setup([stores]);
    const err = async (input: unknown) => ((await runOp(ctx, "save_note", input)) as any).error;
    expect(await err({ noteId: "n1", content: "a", appendText: "b" })).toMatch(/not both/);
    expect(await err({ noteId: "n1", content: "   " })).toMatch(/can't be empty/);
    expect(await err({ noteId: "n1", appendText: "  " })).toMatch(/appendText is empty/);
    expect(await err({ noteId: "n1" })).toMatch(/Nothing to change/);
    expect(await err({ noteId: "nope", appendText: "x" })).toMatch(/No note nope/);
    expect(await err({ noteId: "n1", parentId: "t1", content: "x" })).toMatch(/can't be changed/);
    expect(await err({ title: "No body" })).toMatch(/content is required/);
    expect(await err({ content: "x", parentType: "TRIP" })).toMatch(/provided together/);
  });
});
