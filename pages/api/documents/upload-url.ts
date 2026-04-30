import type { NextApiRequest, NextApiResponse } from "next";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v7 as uuid } from "uuid";
import { withHomeUserAuth } from "@/lib/api-auth";

const REGION = "us-east-1";
const BUCKET = process.env.HOME_HUB_BUCKET ?? "";
const s3 = new S3Client({ region: REGION });

// Documents are a flat prefix under home/documents/ — no album/unfiled
// split. The agent Lambda doesn't parse document files (it only hands
// back signed URLs), so HEIC is accepted here even though the photos
// uploader path processes images more aggressively.
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

function extensionFor(contentType: string): string {
  switch (contentType) {
    case "application/pdf":
      return "pdf";
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
    default:
      return "bin";
  }
}

/**
 * POST /api/documents/upload-url
 * Body: { contentType: string }
 * Returns: { uploadUrl, s3key, expiresIn }
 *
 * DELETE /api/documents/upload-url
 * Body: { s3key: string }
 * Returns: { ok: true }
 *
 * Mirrors /api/photos/upload-url — client presigns a PUT against the
 * home/documents/ prefix, uploads directly, then creates a homeDocument
 * row via the Amplify data client. Wave 2 will add the Duo-gated
 * read path at the agent tool layer.
 */
// Allow-listed prefixes the caller can land their upload in. Keeps
// callers from picking arbitrary paths under home/ via the body —
// each surface that needs presigned uploads gets a known sub-prefix.
const ALLOWED_PREFIXES = new Set(["documents", "pets"]);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") {
    const { contentType, prefix } = req.body ?? {};
    if (!contentType || typeof contentType !== "string") {
      return res.status(400).json({ error: "contentType required" });
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return res.status(400).json({
        error: "Unsupported content type. Allowed: PDF, JPEG, PNG, WebP, HEIC.",
      });
    }
    // Default to the original "documents" prefix so existing callers
    // (web Documents page, mobile DocumentFormModal) keep working
    // without sending a prefix.
    const subPrefix =
      typeof prefix === "string" && ALLOWED_PREFIXES.has(prefix)
        ? prefix
        : "documents";

    const ext = extensionFor(contentType);
    const id = uuid();
    const s3key = `home/${subPrefix}/${id}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3key,
      ContentType: contentType,
    });

    try {
      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
      return res.status(200).json({ uploadUrl, s3key, expiresIn: 300 });
    } catch (err: any) {
      console.error("document presign error", err);
      return res.status(500).json({ error: "Could not generate upload URL" });
    }
  }

  if (req.method === "DELETE") {
    const { s3key } = req.body ?? {};
    if (!s3key || typeof s3key !== "string") {
      return res.status(400).json({ error: "s3key required" });
    }
    // Scope check — never allow deleting anything outside the documents
    // prefix from this endpoint, even though the compute role only has
    // home/* access anyway.
    if (!s3key.startsWith("home/documents/")) {
      return res.status(400).json({ error: "s3key must be under home/documents/" });
    }
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: s3key }));
      return res.status(200).json({ ok: true });
    } catch (err: any) {
      console.error("document delete error", err);
      return res.status(500).json({ error: "Could not delete object" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default withHomeUserAuth(handler);
