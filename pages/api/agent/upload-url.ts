import type { NextApiRequest, NextApiResponse } from "next";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v7 as uuid } from "uuid";
import { withHomeUserAuth } from "@/lib/api-auth";

const REGION = "us-east-1";
const BUCKET = process.env.HOME_HUB_BUCKET ?? "";
const s3 = new S3Client({ region: REGION });

// Strict allow-list for what the agent will accept. We deliberately do
// NOT accept HEIC/HEIF here — Claude can't read it and the iPhone Photos
// app routinely produces it. Force users to share a screenshot or JPG.
const ACCEPTED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * POST /api/agent/upload-url
 * Body: { contentType: string }
 * Returns: { uploadUrl, s3key, expiresIn }
 *
 * Mints a presigned PUT URL targeting home/agent-uploads/{uuid}.{ext}.
 * The agent Lambda has s3:GetObject scoped to that exact prefix, so
 * uploads MUST land there.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { contentType } = req.body ?? {};
  if (!contentType || typeof contentType !== "string") {
    return res.status(400).json({ error: "contentType required" });
  }

  const ext = ACCEPTED_TYPES[contentType];
  if (!ext) {
    return res.status(400).json({
      error:
        "Unsupported image type. Allowed: image/jpeg, image/png, image/gif, image/webp. HEIC is not supported — share a screenshot or JPG instead.",
    });
  }

  const id = uuid();
  const s3key = `home/agent-uploads/${id}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3key,
    ContentType: contentType,
  });

  try {
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 min
    return res.status(200).json({ uploadUrl, s3key, expiresIn: 300 });
  } catch (err: any) {
    console.error("agent upload-url presign error", err);
    return res.status(500).json({ error: "Could not generate upload URL" });
  }
}

export default withHomeUserAuth(handler);
