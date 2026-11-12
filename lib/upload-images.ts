// Browser uploads of images to S3 through the presigned
// /api/documents/upload-url route. `prefix` must be one of that route's
// allowed sub-prefixes (wardrobe, people, …); keys land under home/<prefix>/.

import { addToast } from "@heroui/react";

export const WEB_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_WEB_IMAGE_BYTES = 10 * 1024 * 1024;

/** Uploads each file and returns the keys that made it; failures show a toast. */
export async function uploadImages(files: File[], prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for (const file of files) {
    const contentType = file.type || "image/jpeg";
    try {
      const urlRes = await fetch("/api/documents/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType, prefix }),
      });
      if (!urlRes.ok) {
        const err = await urlRes.json().catch(() => ({}));
        throw new Error(err.error ?? `Upload URL failed: ${urlRes.status}`);
      }
      const { uploadUrl, s3key } = await urlRes.json();
      const putRes = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
      keys.push(s3key);
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      addToast({ title: `Couldn't upload ${file.name}`, description: err?.message ?? String(err), color: "danger" });
    }
  }
  return keys;
}
