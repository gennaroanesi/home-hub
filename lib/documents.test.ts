import { describe, expect, it } from "vitest";
import { documentFileUrl, documentIsSensitive } from "./documents";

describe("document vault helpers", () => {
  it("treats unset as sensitive", () => {
    expect(documentIsSensitive({})).toBe(true);
    expect(documentIsSensitive({ isSensitive: null })).toBe(true);
    expect(documentIsSensitive({ isSensitive: true })).toBe(true);
    expect(documentIsSensitive({ isSensitive: false })).toBe(false);
  });

  it("builds the short link from the key", () => {
    expect(documentFileUrl("home/documents/abc.pdf")).toBe("https://home.cristinegennaro.com/api/d/abc.pdf");
    expect(documentFileUrl("home/documents/abc.pdf", "http://localhost:3001")).toBe("http://localhost:3001/api/d/abc.pdf");
  });
});
