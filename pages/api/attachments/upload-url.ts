import type { NextApiRequest, NextApiResponse } from "next";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v7 as uuid } from "uuid";

const REGION = "us-east-1";
const BUCKET = "cristinegennaro.com";
const s3 = new S3Client({ region: REGION });

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

/** Allowed content types and their file extensions. */
const ALLOWED_TYPES: Record<string, string> = {
  // Images
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/gif": "gif",
  // Documents
  "application/pdf": "pdf",
};

const VALID_PARENT_TYPES = new Set(["TRIP", "TRIP_LEG", "EVENT", "TASK", "BILL"]);

/**
 * POST /api/attachments/upload-url
 * Body: { parentType, parentId, filename, contentType }
 * Returns: { uploadUrl, s3Key, expiresIn }
 *
 * The client uploads the file directly to S3 with the returned URL,
 * then creates a homeAttachment record via the Amplify data client.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { parentType, parentId, filename, contentType } = req.body ?? {};

  if (!parentType || !VALID_PARENT_TYPES.has(parentType)) {
    return res.status(400).json({ error: `parentType must be one of: ${Array.from(VALID_PARENT_TYPES).join(", ")}` });
  }
  if (!parentId || typeof parentId !== "string") {
    return res.status(400).json({ error: "parentId required" });
  }
  if (!contentType || typeof contentType !== "string") {
    return res.status(400).json({ error: "contentType required" });
  }

  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    return res.status(400).json({
      error: `Unsupported content type. Allowed: ${Object.keys(ALLOWED_TYPES).join(", ")}`,
    });
  }

  const id = uuid();
  const s3Key = `home/attachments/${parentType.toLowerCase()}/${parentId}/${id}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    ContentType: contentType,
  });

  try {
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    return res.status(200).json({
      uploadUrl,
      s3Key,
      filename: filename || `${id}.${ext}`,
      expiresIn: 300,
    });
  } catch (err: any) {
    console.error("presign error", err);
    return res.status(500).json({ error: "Could not generate upload URL" });
  }
}
