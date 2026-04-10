import type { NextApiRequest, NextApiResponse } from "next";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v7 as uuid } from "uuid";

const REGION = "us-east-1";
const BUCKET = "cristinegennaro.com";
const s3 = new S3Client({ region: REGION });

function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
    case "image/heif":
      return "heic";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

/**
 * POST /api/photos/upload-url
 * Body: { contentType: string, albumId?: string }
 * Returns: { uploadUrl, s3key, expiresIn }
 *
 * The client uploads the file directly to S3 with the returned URL,
 * then creates a homePhoto record via the Amplify data client.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { contentType, albumId } = req.body ?? {};
  if (!contentType || typeof contentType !== "string") {
    return res.status(400).json({ error: "contentType required" });
  }
  if (!contentType.startsWith("image/")) {
    return res.status(400).json({ error: "Only image/* content types allowed" });
  }

  const ext = extensionFor(contentType);
  const id = uuid();
  const prefix = albumId ? `home/photos/albums/${albumId}` : `home/photos/unfiled`;
  const s3key = `${prefix}/${id}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3key,
    ContentType: contentType,
  });

  try {
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 min
    return res.status(200).json({ uploadUrl, s3key, expiresIn: 300 });
  } catch (err: any) {
    console.error("presign error", err);
    return res.status(500).json({ error: "Could not generate upload URL" });
  }
}
