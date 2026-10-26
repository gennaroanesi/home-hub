import type { NextApiRequest, NextApiResponse } from "next";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v7 as uuid } from "uuid";
import { withHomeUserAuth } from "@/lib/api-auth";
import {
  ALLOWED_ATTACHMENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_PARENT_TYPES,
  normalizeContentType,
} from "@/lib/attachment-types";

const REGION = "us-east-1";
const BUCKET = process.env.HOME_HUB_BUCKET ?? "";
const s3 = new S3Client({ region: REGION });

const VALID_PARENT_TYPES = new Set<string>(ATTACHMENT_PARENT_TYPES);

/**
 * POST /api/attachments/upload-url
 * Body: { parentType, parentId, filename, contentType, sizeBytes? }
 * Returns: { uploadUrl, s3Key, contentType, expiresIn }
 *
 * The client uploads the file directly to S3 with the returned URL —
 * sending the returned `contentType` (normalised, e.g. codec params
 * stripped), since that's what was signed — then creates a
 * homeAttachment record via the Amplify data client. Direct-to-S3 keeps
 * large videos off the API (and clear of the WAF body limit).
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { parentType, parentId, filename, sizeBytes } = req.body ?? {};

  if (!parentType || !VALID_PARENT_TYPES.has(parentType)) {
    return res.status(400).json({ error: `parentType must be one of: ${Array.from(VALID_PARENT_TYPES).join(", ")}` });
  }
  if (!parentId || typeof parentId !== "string") {
    return res.status(400).json({ error: "parentId required" });
  }

  const contentType = normalizeContentType(req.body?.contentType, filename);
  if (!contentType) {
    return res.status(400).json({ error: "contentType required" });
  }
  const allowed = ALLOWED_ATTACHMENT_TYPES[contentType];
  if (!allowed) {
    return res.status(400).json({
      error: `Unsupported content type ${contentType}. Allowed: images, PDF, video (mp4/mov/webm), audio (mp3/m4a/wav/ogg…), DICOM/zip.`,
    });
  }
  // Size is advisory (the browser reports it; S3 doesn't enforce it on a
  // presigned PUT) but catches the honest mistake before a long upload.
  const max = ATTACHMENT_MAX_BYTES[allowed.kind];
  if (typeof sizeBytes === "number" && sizeBytes > max) {
    return res.status(400).json({
      error: `File is too large (${Math.round(sizeBytes / 1024 / 1024)} MB). Max for ${allowed.kind} is ${Math.round(max / 1024 / 1024)} MB.`,
    });
  }

  const id = uuid();
  const s3Key = `home/attachments/${parentType.toLowerCase()}/${parentId}/${id}.${allowed.ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    ContentType: contentType,
  });

  // S3 checks expiry when the PUT starts, not when it finishes, so a
  // multi-minute video upload is fine as long as it begins in time.
  const expiresIn = 900;
  try {
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn });
    return res.status(200).json({
      uploadUrl,
      s3Key,
      contentType,
      filename: filename || `${id}.${allowed.ext}`,
      expiresIn,
    });
  } catch (err: any) {
    console.error("presign error", err);
    return res.status(500).json({ error: "Could not generate upload URL" });
  }
}

export default withHomeUserAuth(handler);
