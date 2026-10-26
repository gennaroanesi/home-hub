import { describe, expect, it, vi } from "vitest";
import { isWardrobeImageKey, normalizeRenderInputs, renderCacheId, renderPrompt, type RenderInputs } from "./wardrobe-try-on";
import { renderWardrobeImage } from "./wardrobe-image-renderer";
const input: RenderInputs = {
  personId: "person-a", referenceImageKeys: ["home/wardrobe/body.jpg", "home/wardrobe/face.png"],
  garments: [
    { id: "shirt", imageKey: "home/wardrobe/shirt.jpg", description: "Linen shirt" },
    { id: "pants", imageKey: "home/wardrobe/pants.png", description: "Olive trousers" },
  ],
  fitNotes: "Relaxed fit", stylingInstructions: "Shirt tucked in", model: "gpt-image-2.5-sunburst",
};
describe("try-on cache identity", () => {
  it("reuses a render regardless of selection order and surrounding whitespace", () => {
    expect(renderCacheId(input)).toBe(renderCacheId({ ...input, garments: [...input.garments].reverse(), stylingInstructions: " Shirt tucked in  " }));
    expect(input.garments[0].id).toBe("shirt");
  });
  it.each([
    { personId: "person-b" }, { referenceImageKeys: [...input.referenceImageKeys].reverse() },
    { referenceImageKeys: ["home/wardrobe/new-body.jpg"] }, { fitNotes: "Slim fit" },
    { stylingInstructions: "Untucked" }, { model: "different-renderer" },
    { garments: [{ ...input.garments[0], imageKey: "home/wardrobe/new-shirt.jpg" }, input.garments[1]] },
    { garments: [{ ...input.garments[0], description: "Blue linen shirt" }, input.garments[1]] },
  ])("invalidates when visual inputs change: %j", change => {
    expect(renderCacheId(input)).not.toBe(renderCacheId({ ...input, ...change }));
  });
  it("restricts source keys to supported wardrobe images", () => {
    expect(isWardrobeImageKey("home/wardrobe/abc-123.jpg")).toBe(true);
    for (const key of ["https://example.com/a.jpg", "home/documents/a.jpg", "home/wardrobe/../secret.jpg", "home/wardrobe/a.heic", "home/wardrobe/a.jpg?x=1"]) expect(isWardrobeImageKey(key)).toBe(false);
  });
});
describe("OpenAI wardrobe renderer", () => {
  it("sends ordered images and a single explicit portrait edit, then decodes the result", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: "AQID" }] }), { status: 200 }));
    const normalized = normalizeRenderInputs(input);
    const result = await renderWardrobeImage(normalized, [
      { bytes: new Uint8Array([1]), contentType: "image/jpeg" },
      { bytes: new Uint8Array([2]), contentType: "image/png" },
      { bytes: new Uint8Array([3]), contentType: "image/png" },
      { bytes: new Uint8Array([4]), contentType: "image/jpeg" },
    ], "test-key", fetcher);
    expect(Array.from(result)).toEqual([1, 2, 3]);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    const form = options.body as FormData;
    expect(form.get("n")).toBe("1");
    expect(form.get("size")).toBe("1024x1536");
    expect(form.get("prompt")).toBe(renderPrompt(normalized));
    expect(form.getAll("image[]")).toHaveLength(4);
    expect(renderPrompt(normalized)).toContain("Garment 1: Olive trousers");
  });
  it("handles provider failures without storing raw error content", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("sensitive provider details", { status: 429 }));
    await expect(renderWardrobeImage(input, [], "key", fetcher)).rejects.toThrow("Image generation failed (429)");
  });
  it("reports missing output rather than saving an empty preview", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await expect(renderWardrobeImage(input, [], "key", fetcher)).rejects.toThrow("returned no image");
  });
});
