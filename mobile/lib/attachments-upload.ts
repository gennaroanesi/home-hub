// Attachment file upload from the mobile app. Mirrors documents-upload
// against the attachments endpoint, which scopes uploads to a parent
// entity (task / event / trip / trip_leg / reservation / bill).
//
//   1. POST /api/attachments/upload-url with { parentType, parentId,
//      filename, contentType } → returns { uploadUrl, s3key, filename }.
//   2. PUT the file body to uploadUrl.
//
// The web endpoint validates parentType against a small allow-list and
// stages the key under home/attachments/<parentType>/<parentId>/<id>.<ext>.

import { authedFetch } from "./authed-fetch";

const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL ?? "https://home.cristinegennaro.com";

export type AttachmentParentType =
  | "TRIP"
  | "TRIP_LEG"
  | "RESERVATION"
  | "EVENT"
  | "TASK"
  | "BILL";

interface PresignResponse {
  uploadUrl: string;
  s3key: string;
  filename: string;
  expiresIn: number;
}

export interface UploadedAttachmentFile {
  s3Key: string;
  contentType: string;
  sizeBytes: number;
  filename: string;
}

export async function uploadAttachmentFile(args: {
  uri: string;
  contentType: string;
  filename: string;
  parentType: AttachmentParentType;
  parentId: string;
}): Promise<UploadedAttachmentFile> {
  const { uri, contentType, filename, parentType, parentId } = args;

  const presignRes = await authedFetch(
    `${WEB_BASE_URL}/api/attachments/upload-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentType, parentId, filename, contentType }),
    }
  );
  if (!presignRes.ok) {
    const text = await presignRes.text().catch(() => "");
    throw new Error(`Attachment presign failed (${presignRes.status}): ${text}`);
  }
  const { uploadUrl, s3key, filename: serverFilename } =
    (await presignRes.json()) as PresignResponse;

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
    filename: serverFilename,
  };
}
