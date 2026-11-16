import { describe, expect, it } from "vitest";
import { documentIsSensitive } from "./documents";

describe("document vault helpers", () => {
  it("treats unset as sensitive", () => {
    expect(documentIsSensitive({})).toBe(true);
    expect(documentIsSensitive({ isSensitive: null })).toBe(true);
    expect(documentIsSensitive({ isSensitive: true })).toBe(true);
    expect(documentIsSensitive({ isSensitive: false })).toBe(false);
  });
});
