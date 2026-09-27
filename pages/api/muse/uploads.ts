/**
 * POST /api/muse/uploads
 *
 * Presigned S3 upload for API clients sending images (inventory photos).
 * Image bytes must NOT go through the JSON API: the app's WAF blocks
 * request bodies over ~8 KB (AWS managed Core rule set,
 * SizeRestrictions_BODY). Instead:
 *   1. POST /uploads { contentType }        → { uploadUrl, s3Key, headers }
 *   2. PUT the raw image bytes to uploadUrl (straight to S3, with those
 *      headers; no bearer key — the URL is the credential, 15 min)
 *   3. POST /tools/add_inventory_photo { itemId | query, s3Key }
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

import { withMuseAuth } from "@/lib/muse-api";
import { INVENTORY_IMAGE_TYPES, extensionForImage } from "@/lib/inventory-images";

const s3 = new S3Client({ region: "us-east-1" });
const EXPIRES_IN = 900;

export default withMuseAuth(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const bucket = process.env.HOME_HUB_BUCKET;
  if (!bucket) return res.status(500).json({ error: "Server misconfigured" });

  const contentType = String(req.body?.contentType ?? "").toLowerCase().trim();
  if (!INVENTORY_IMAGE_TYPES[contentType]) {
    return res.status(400).json({
      error: `contentType must be one of: ${Object.keys(INVENTORY_IMAGE_TYPES).join(", ")}`,
    });
  }

  const s3Key = `home/inventory/${randomUUID()}.${extensionForImage(contentType)}`;
  try {
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: contentType }),
      // Sign Content-Type too, so the URL only accepts the declared image
      // type (unsigned, S3 would take any type).
      { expiresIn: EXPIRES_IN, signableHeaders: new Set(["content-type"]) },
    );
    return res.status(200).json({
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": contentType },
      s3Key,
      expiresIn: EXPIRES_IN,
      next: "PUT the image bytes to uploadUrl, then call POST /tools/add_inventory_photo with this s3Key.",
    });
  } catch (err) {
    console.error("[muse] presign failed:", err);
    return res.status(500).json({ error: "Could not create an upload URL" });
  }
});
