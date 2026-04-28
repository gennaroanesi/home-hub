// Document file upload from the mobile app.
//
// Mirrors the web's two-step flow:
//   1. POST /api/documents/upload-url with { contentType } → returns
//      { uploadUrl, s3key } where uploadUrl is a 5-minute presigned
//      PUT against s3://cristinegennaro.com/home/documents/<id>.<ext>.
//   2. PUT the file body to uploadUrl with the same Content-Type.
//
// We hit the same web endpoint instead of writing a mobile-specific
// presigner Lambda — single source of truth for the allow-list of
// content types and the s3 key shape. The endpoint is currently
// unauthenticated (same as it is for the web), so no extra plumbing.
//
// File source: any file:// URI from expo-image-picker (camera /
// library) or expo-document-picker (PDFs). RN's fetch resolves
// file:// URIs into a blob, which is what S3's presigned PUT
// expects.

const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL ??
  "https://home.cristinegennaro.com";

interface PresignResponse {
  uploadUrl: string;
  s3key: string;
  expiresIn: number;
}

export interface UploadedDocFile {
  s3Key: string;
  contentType: string;
  sizeBytes: number;
  originalFilename: string;
}

/**
 * Two-step upload: presign on the web side, then PUT to S3.
 * Returns the s3 key + content type so the caller can drop them
 * straight into a homeDocument.create() call.
 */
export async function uploadDocumentFile(args: {
  uri: string;
  contentType: string;
  filename?: string;
}): Promise<UploadedDocFile> {
  const { uri, contentType } = args;

  // 1. Presign.
  const presignRes = await fetch(`${WEB_BASE_URL}/api/documents/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType }),
  });
  if (!presignRes.ok) {
    const text = await presignRes.text().catch(() => "");
    throw new Error(`Presign failed (${presignRes.status}): ${text}`);
  }
  const { uploadUrl, s3key } = (await presignRes.json()) as PresignResponse;

  // 2. Read the local file as a blob.
  const fileRes = await fetch(uri);
  if (!fileRes.ok) {
    throw new Error(`Couldn't read local file (${fileRes.status})`);
  }
  const blob = await fileRes.blob();
  const sizeBytes = blob.size;

  // 3. PUT to S3 with the matching content type.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`S3 upload failed (${putRes.status}): ${text}`);
  }

  return {
    s3Key: s3key,
    contentType,
    sizeBytes,
    originalFilename: args.filename ?? extractFilename(uri),
  };
}

function extractFilename(uri: string): string {
  const last = uri.split("/").pop() ?? "document";
  // Strip any query string (rare with file:// but harmless).
  return last.split("?")[0] ?? "document";
}

/**
 * Open the household's web Documents page in Safari. Used as the
 * mobile "Open document" affordance until we port the Duo flow
 * natively — Safari handles Duo Mobile push approval for the file
 * download URL there.
 */
export function webDocumentsUrl(): string {
  return `${WEB_BASE_URL}/documents`;
}
