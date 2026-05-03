// Photo file upload from the mobile app. Mirrors the documents-upload
// shape (presign on the web side, PUT to S3) against the photos endpoint.
//
//   1. POST /api/photos/upload-url with { contentType } → returns
//      { uploadUrl, s3key } where uploadUrl is a 5-minute presigned
//      PUT against s3://<HOME_HUB_BUCKET>/home/photos/<id>.<ext>.
//   2. PUT the file body to uploadUrl.
//
// The presign endpoint is auth-gated; authedFetch attaches the Cognito
// access token. The S3 PUT uses plain fetch (presigned URL is its own auth).

import { authedFetch } from "./authed-fetch";

const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL ?? "https://home.cristinegennaro.com";

interface PresignResponse {
  uploadUrl: string;
  s3key: string;
  expiresIn: number;
}

export interface UploadedPhotoFile {
  s3Key: string;
  contentType: string;
  sizeBytes: number;
  originalFilename: string;
}

export async function uploadPhotoFile(args: {
  uri: string;
  contentType: string;
  filename?: string;
}): Promise<UploadedPhotoFile> {
  const { uri, contentType } = args;

  const presignRes = await authedFetch(`${WEB_BASE_URL}/api/photos/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType }),
  });
  if (!presignRes.ok) {
    const text = await presignRes.text().catch(() => "");
    throw new Error(`Photo presign failed (${presignRes.status}): ${text}`);
  }
  const { uploadUrl, s3key } = (await presignRes.json()) as PresignResponse;

  const fileRes = await fetch(uri);
  if (!fileRes.ok) {
    throw new Error(`Couldn't read local file (${fileRes.status})`);
  }
  const blob = await fileRes.blob();

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
    sizeBytes: blob.size,
    originalFilename: args.filename ?? extractFilename(uri),
  };
}

function extractFilename(uri: string): string {
  const last = uri.split("/").pop() ?? "photo";
  return last.split("?")[0] ?? "photo";
}
