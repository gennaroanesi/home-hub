// SSR side of the signed /api/d links (lib/file-link.ts): the signing
// key, derived from the Duo integration secret the SSR already reads
// (lib/duo-server.ts approvalSigningKey), and the short presigned S3 GET
// /api/d redirects to. Server-only.

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { approvalSigningKey } from "@/lib/duo-server";
import { deriveFileLinkKey, FILE_LINK_PRESIGN_SECONDS, isLinkableKey, signedFileLink } from "@/lib/file-link";

const BUCKET = process.env.HOME_HUB_BUCKET ?? "";
const s3 = new S3Client({ region: "us-east-1" });

let cachedKey: string | null = null;

export async function fileLinkKey(): Promise<string> {
  if (!cachedKey) cachedKey = deriveFileLinkKey(await approvalSigningKey());
  return cachedKey;
}

/** Signed /api/d link for a home/ file. */
export async function mintFileLink(s3Key: string, opts: { ttlMs: number; baseUrl?: string }): Promise<string> {
  return signedFileLink(s3Key, await fileLinkKey(), opts);
}

/** Short presigned GET for a home/ file, served inline under its own name. */
export async function presignHomeFile(s3Key: string): Promise<string> {
  if (!BUCKET) throw new Error("HOME_HUB_BUCKET is not set");
  if (!isLinkableKey(s3Key)) throw new Error("Not a home/ file");
  const name = (s3Key.split("/").pop() || "file").replace(/["\\\r\n]/g, "");
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: s3Key, ResponseContentDisposition: `inline; filename="${name}"` }),
    { expiresIn: FILE_LINK_PRESIGN_SECONDS },
  );
}
