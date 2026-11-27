import { describe, expect, it } from "vitest";
import { moveToSectionPatch } from "./checklist";

describe("moveToSectionPatch", () => {
  const items = [
    { id: "a", section: null, sortOrder: 0 },
    { id: "b", section: "Clothes", sortOrder: 3 },
    { id: "c", section: "Clothes", sortOrder: 7 },
    { id: "d", section: "", sortOrder: 2 }, // "" counts as General
  ];
  it("puts the item last in the target section", () => {
    expect(moveToSectionPatch(items, "a", "Clothes")).toEqual({ section: "Clothes", sortOrder: 8 });
    expect(moveToSectionPatch(items, "b", null)).toEqual({ section: null, sortOrder: 3 });
    expect(moveToSectionPatch(items, "a", "Gear")).toEqual({ section: "Gear", sortOrder: 0 });
  });
  it("is a no-op for the same section or an unknown item", () => {
    expect(moveToSectionPatch(items, "d", null)).toBeNull();
    expect(moveToSectionPatch(items, "b", "Clothes")).toBeNull();
    expect(moveToSectionPatch(items, "zzz", null)).toBeNull();
  });
});
