import { describe, expect, it } from "vitest";
import { inferGenders, reviewWords, suggestRelationships } from "./relationship-review";

const names = new Map(Object.entries({ dad: "Nadyr", mom: "Anamaria", gen: "Gennaro", gio: "Gio", cris: "Cris", carol: "Caroline", dani: "Danielle", baby: "Baby1", mari: "Marilene", paulo: "Paulo", arg: "Argemiro" }));
const row = (id: string, personId: string, kind: string, relatedPersonId: string, label?: string, inverseLabel?: string) => ({ id, personId, relatedPersonId, kind, label: label ?? null, inverseLabel: inverseLabel ?? null });

const rows = [
  row("r1", "dad", "PARENT", "gen", "father", "son"),
  row("r2", "dad", "PARENT", "gio"),
  row("r3", "mom", "PARENT", "gen"),
  row("r4", "mom", "PARENT", "gio"),
  row("r5", "gio", "SIBLING", "gen", "brother", "brother"),
  row("r6", "cris", "SIBLING", "carol"),
  row("r7", "dani", "COUSIN", "carol"),
  row("r8", "gen", "PARENT", "baby"),
  row("r9", "cris", "PARENT", "baby"),
  row("r10", "mari", "PARENT", "cris"),
  row("r11", "mari", "SIBLING", "arg", "sister", "brother"),
];

describe("relationship review", () => {
  it("reads gender from the words used", () => {
    const g = inferGenders(rows);
    expect([g.get("gen"), g.get("gio"), g.get("dad"), g.get("mari"), g.get("mom")]).toEqual(["m", "m", "m", "f", undefined]);
    expect(inferGenders([row("x", "a", "SIBLING", "b", "brother"), row("y", "a", "PARENT", "c", "mother")]).get("a")).toBe("conflict");
  });

  it("fills missing words where the gender is known (the son / child mix-up)", () => {
    const { fixes } = reviewWords(rows, names);
    const byId = new Map(fixes.map((f) => [f.relationshipId, f]));
    expect(byId.get("r2")).toMatchObject({ label: "father", inverseLabel: "son", changes: ["Nadyr: parent → father", "Gio: child → son"] });
    expect(byId.get("r4")).toMatchObject({ label: null, inverseLabel: "son" }); // the mother's gender isn't written anywhere yet
    expect(byId.get("r8")).toMatchObject({ label: "father", inverseLabel: null });
    expect(byId.get("r10")).toMatchObject({ label: "mother" });
    expect(byId.has("r1")).toBe(false);
  });

  it("replaces a word from another relationship when the gender says which, and reports it otherwise", () => {
    const n = new Map([["p", "P"], ["k", "K"]]);
    expect(reviewWords([row("a", "p", "PARENT", "k", "sister")], n).fixes[0]).toMatchObject({ label: "mother", changes: ["P: sister → mother"] });
    const { fixes, conflicts } = reviewWords([row("a", "p", "PARENT", "k", "cousin")], n);
    expect(fixes).toEqual([]);
    expect(conflicts[0].note).toMatch(/"cousin" on a parent link/);
  });

  it("suggests what the rows imply: a sibling's cousins, grandparents, aunts / uncles", () => {
    const s = suggestRelationships(rows, names);
    const has = (a: string, b: string, kind: string) => s.find((x) => ((x.personId === a && x.relatedPersonId === b) || (x.personId === b && x.relatedPersonId === a)) && x.kind === kind);
    expect(has("dani", "cris", "COUSIN")?.reason).toBe("Caroline's cousin, and Cris is Caroline's sibling");
    expect(has("mari", "baby", "GRANDPARENT")).toMatchObject({ personId: "mari", label: "grandmother" });
    expect(has("dad", "baby", "GRANDPARENT")).toMatchObject({ label: "grandfather" });
    expect(has("gio", "baby", "AUNT_UNCLE")).toMatchObject({ label: "uncle" });
    expect(has("arg", "cris", "AUNT_UNCLE")).toMatchObject({ label: "uncle" });
    expect(has("cris", "gen", "SPOUSE")?.confidence).toBe("maybe");
    expect(has("gen", "gio", "SIBLING")).toBeUndefined(); // already linked
  });
});
