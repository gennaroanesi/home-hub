import { describe, expect, it } from "vitest";

import { checkImage, decodeBase64Image, extensionForImage } from "./inventory-images";

const png = Buffer.from("89504e470d0a1a0a", "hex");

describe("inventory images", () => {
  it("decodes plain base64 with a content type and data: URLs", () => {
    const a = decodeBase64Image(png.toString("base64"), "image/png");
    expect(a.data.toString("hex")).toBe(png.toString("hex"));
    const b = decodeBase64Image(`data:image/png;base64,${png.toString("base64")}`);
    expect(b.contentType).toBe("image/png");
    expect(b.data.toString("hex")).toBe(png.toString("hex"));
    // Line-wrapped base64 is fine.
    const wrapped = png.toString("base64").replace(/(.{4})/g, "$1\n");
    expect(decodeBase64Image(wrapped, "image/png").data.toString("hex")).toBe(png.toString("hex"));
  });

  it("requires a type for plain base64 and rejects other types", () => {
    expect(() => decodeBase64Image(png.toString("base64"))).toThrow(/contentType is required/);
    expect(() => decodeBase64Image("AAAA", "application/pdf")).toThrow(/Unsupported image type/);
  });

  it("normalizes content types and enforces size", () => {
    expect(checkImage({ data: png, contentType: "Image/JPEG; charset=binary" }).contentType).toBe("image/jpeg");
    expect(() => checkImage({ data: Buffer.alloc(0), contentType: "image/png" })).toThrow(/empty/);
    expect(() => checkImage({ data: Buffer.alloc(10 * 1024 * 1024 + 1), contentType: "image/png" })).toThrow(/10 MB/);
    expect(extensionForImage("image/heif")).toBe("heic");
  });
});
