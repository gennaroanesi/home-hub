import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

// The agent Lambda has read-only access to the home/agent-uploads/ prefix.
// The web UI uploader (phase 2) writes to the same prefix via a presigned
// endpoint. We mirror that here so WA images land in the exact same place
// the agent handler already knows how to rehydrate from.
const s3 = new S3Client({});
const BUCKET = process.env.PHOTOS_BUCKET ?? "cristinegennaro.com";
const PREFIX = "home/agent-uploads";

// Claude's image-block API accepts jpeg/png/gif/webp only. HEIC (common on
// iPhone) would round-trip through WA as image/jpeg after the phone's
// share sheet, but if it ever arrives as image/heic the agent handler
// will choke — reject early here with a clear error.
const ALLOWED_MIMETYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function extFromMimetype(mimetype: string): string {
  switch (mimetype) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      // Should be unreachable thanks to the allow-list check above, but
      // defend anyway.
      throw new Error(`Unsupported image mimetype: ${mimetype}`);
  }
}

/**
 * Uploads an image buffer to the agent-uploads prefix and returns the full
 * S3 key (e.g. `home/agent-uploads/<uuid>.jpg`). The caller passes this key
 * to invokeHomeAgent via imageS3Keys.
 */
export async function uploadAgentImage(
  buffer: Buffer,
  mimetype: string
): Promise<string> {
  if (!ALLOWED_MIMETYPES.has(mimetype)) {
    throw new Error(
      `Unsupported image mimetype ${mimetype} (allowed: ${[...ALLOWED_MIMETYPES].join(", ")})`
    );
  }

  const ext = extFromMimetype(mimetype);
  const key = `${PREFIX}/${randomUUID()}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    })
  );

  return key;
}
