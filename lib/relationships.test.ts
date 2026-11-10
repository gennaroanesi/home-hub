import { describe, expect, it } from "vitest";
import { findPairRow, normalizeRelationship, relationsOf } from "./relationships";

describe("relationships", () => {
  it("stores inverse kinds swapped, words included", () => {
    expect(normalizeRelationship({ personId: "eva", relatedPersonId: "pri", kind: "CHILD", label: "daughter" })).toEqual({
      personId: "pri",
      relatedPersonId: "eva",
      kind: "PARENT",
      label: null,
      inverseLabel: "daughter",
    });
    const spouse = { personId: "pri", relatedPersonId: "gab", kind: "SPOUSE" as const };
    expect(normalizeRelationship(spouse)).toBe(spouse);
  });

  it("derives both sides from one row", () => {
    const rows = [
      { id: "r1", personId: "pri", relatedPersonId: "gab", kind: "SPOUSE" },
      { id: "r2", personId: "pri", relatedPersonId: "eva", kind: "PARENT", label: "mother", inverseLabel: "daughter" },
    ];
    expect(relationsOf("pri", rows).map((r) => [r.otherPersonId, r.kind, r.role])).toEqual([
      ["gab", "SPOUSE", "spouse"],
      ["eva", "CHILD", "daughter"],
    ]);
    expect(relationsOf("gab", rows).map((r) => [r.otherPersonId, r.role])).toEqual([["pri", "spouse"]]);
    expect(relationsOf("eva", rows).map((r) => [r.otherPersonId, r.kind, r.role])).toEqual([["pri", "PARENT", "mother"]]);
  });

  it("falls back to the neutral word and finds a pair either way", () => {
    const rows = [{ id: "r1", personId: "a", relatedPersonId: "b", kind: "GRANDPARENT" }];
    expect(relationsOf("a", rows)[0].role).toBe("grandchild");
    expect(findPairRow(rows, "b", "a")?.id).toBe("r1");
  });
});
