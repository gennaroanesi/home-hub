// S3-backed image storage for ops, shared by the ops and agent Lambdas.
// Images API clients upload go to home/inventory/ via POST /uploads
// (presigned); ops copy them under their own prefix after checking them.

import { randomUUID } from "node:crypto";
import { CopyObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { MAX_INVENTORY_IMAGE_BYTES, checkImage, extensionForImage, type ImageBytes } from "../inventory-images";
import type { OpImageStorage } from "./context";
import { OpError } from "./define";

const UPLOAD_KEY = /^home\/inventory\/[0-9a-f-]{36}\.[a-z]+$/;

export async function fetchImageUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<ImageBytes> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OpError(`"${url}" isn't a valid image URL`);
  }
  if (parsed.protocol !== "https:") throw new OpError("Image URLs must be https");
  const res = await fetchImpl(parsed, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
  if (!res.ok) throw new OpError(`Couldn't fetch the image (HTTP ${res.status})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_INVENTORY_IMAGE_BYTES) throw new OpError("Image is larger than 10 MB");
  const data = Buffer.from(await res.arrayBuffer());
  try {
    return checkImage({ data, contentType: res.headers.get("content-type") ?? "" });
  } catch (err) {
    throw new OpError(err instanceof Error ? err.message : String(err));
  }
}

/** Checks an API upload key is ours, exists, and is an allowed image type. */
export async function verifyUploadedImage(s3: S3Client, bucket: string, key: string): Promise<string> {
  if (!UPLOAD_KEY.test(key)) throw new OpError("s3Key must be a key returned by POST /uploads (home/inventory/…)");
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    throw new OpError("Nothing uploaded at that s3Key yet — PUT the image to the uploadUrl first");
  }
  try {
    checkImage({ data: Buffer.alloc(Math.max(1, head.ContentLength ?? 0)), contentType: head.ContentType ?? "" });
  } catch (err) {
    throw new OpError(err instanceof Error ? err.message : String(err));
  }
  return key;
}

export function createS3ImageStorage(s3: S3Client, bucket: string | undefined, fetchImpl: typeof fetch = fetch): OpImageStorage {
  const need = () => {
    if (!bucket) throw new Error("HOME_HUB_BUCKET env var not set");
    return bucket;
  };
  return {
    async storeFromUrl(url, prefix) {
      const b = need();
      const img = await fetchImageUrl(url, fetchImpl);
      const key = `${prefix}${randomUUID()}.${extensionForImage(img.contentType)}`;
      await s3.send(new PutObjectCommand({ Bucket: b, Key: key, Body: img.data, ContentType: img.contentType }));
      return key;
    },
    async copyUpload(uploadKey, prefix) {
      const b = need();
      const src = await verifyUploadedImage(s3, b, uploadKey);
      const key = `${prefix}${randomUUID()}${src.slice(src.lastIndexOf("."))}`;
      await s3.send(new CopyObjectCommand({ Bucket: b, Key: key, CopySource: `${b}/${src}` }));
      return key;
    },
  };
}
