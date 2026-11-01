import { describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createS3ImageStorage, fetchImageUrl } from "./storage";

const UPLOAD = "home/inventory/123e4567-e89b-42d3-a456-426614174000.jpg";

function image(type = "image/jpeg", bytes = 10, status = 200, length?: number) {
  return (async () =>
    new Response(new Uint8Array(bytes), {
      status,
      headers: { "content-type": type, ...(length ? { "content-length": String(length) } : {}) },
    })) as unknown as typeof fetch;
}

// Records every command; HeadObject answers from `uploads`.
function fakeS3(uploads: Record<string, { ContentType: string; ContentLength: number }> = {}) {
  const sent: { cmd: string; input: any }[] = [];
  const s3 = {
    send: async (c: any) => {
      const cmd = c.constructor.name;
      sent.push({ cmd, input: c.input });
      if (cmd === "HeadObjectCommand") {
        const u = uploads[c.input.Key];
        if (!u) throw new Error("NotFound");
        return u;
      }
      return {};
    },
  } as unknown as S3Client;
  return { s3, sent };
}

describe("fetchImageUrl", () => {
  it("accepts an https image and normalises its type", async () => {
    const img = await fetchImageUrl("https://cdn/x.jpg", image("image/JPEG; charset=binary"));
    expect(img.contentType).toBe("image/jpeg");
    expect(img.data.length).toBe(10);
  });

  it("rejects bad links, failed fetches, oversized and non-image responses", async () => {
    await expect(fetchImageUrl("not a url", image())).rejects.toThrow(/valid image URL/);
    await expect(fetchImageUrl("http://cdn/x.jpg", image())).rejects.toThrow(/https/);
    await expect(fetchImageUrl("https://cdn/x.jpg", image("image/jpeg", 10, 404))).rejects.toThrow(/HTTP 404/);
    await expect(fetchImageUrl("https://cdn/x.jpg", image("image/jpeg", 10, 200, 20 * 1024 * 1024))).rejects.toThrow(/10 MB/);
    await expect(fetchImageUrl("https://cdn/x.html", image("text/html"))).rejects.toThrow(/Unsupported image type/);
  });
});

describe("createS3ImageStorage", () => {
  it("stores a downloaded image under the prefix", async () => {
    const { s3, sent } = fakeS3();
    const key = await createS3ImageStorage(s3, "bucket", image("image/png")).storeFromUrl("https://cdn/x.png", "home/wardrobe/");
    expect(key).toMatch(/^home\/wardrobe\/[0-9a-f-]{36}\.png$/);
    expect(sent).toEqual([{ cmd: "PutObjectCommand", input: expect.objectContaining({ Bucket: "bucket", Key: key, ContentType: "image/png" }) }]);
  });

  it("copies a checked upload under the prefix", async () => {
    const { s3, sent } = fakeS3({ [UPLOAD]: { ContentType: "image/jpeg", ContentLength: 2048 } });
    const key = await createS3ImageStorage(s3, "bucket").copyUpload(UPLOAD, "home/wardrobe/");
    expect(key).toMatch(/^home\/wardrobe\/[0-9a-f-]{36}\.jpg$/);
    expect(sent.map((s) => s.cmd)).toEqual(["HeadObjectCommand", "CopyObjectCommand"]);
    expect(sent[1].input).toEqual({ Bucket: "bucket", Key: key, CopySource: `bucket/${UPLOAD}` });
  });

  it("refuses keys that aren't uploads, missing uploads and non-images", async () => {
    const { s3, sent } = fakeS3({ [UPLOAD]: { ContentType: "application/pdf", ContentLength: 10 } });
    const storage = createS3ImageStorage(s3, "bucket");
    await expect(storage.copyUpload("home/documents/secret.pdf", "home/wardrobe/")).rejects.toThrow(/POST \/uploads/);
    await expect(storage.copyUpload(UPLOAD.replace("123e", "999e"), "home/wardrobe/")).rejects.toThrow(/Nothing uploaded/);
    await expect(storage.copyUpload(UPLOAD, "home/wardrobe/")).rejects.toThrow(/Unsupported image type/);
    expect(sent.some((s) => s.cmd === "CopyObjectCommand")).toBe(false);
  });

  it("fails clearly without a bucket", async () => {
    await expect(createS3ImageStorage(fakeS3().s3, undefined).copyUpload(UPLOAD, "home/wardrobe/")).rejects.toThrow(/HOME_HUB_BUCKET/);
  });
});
