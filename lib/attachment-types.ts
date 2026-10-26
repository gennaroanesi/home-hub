// What homeAttachment accepts, shared by the presign endpoint
// (pages/api/attachments/upload-url.ts) and the web uploader
// (components/attachment-list.tsx). Keep mobile/lib/attachments-upload.ts
// and the agent's ATTACHMENT_PARENT_TYPES in step when adding parents.

export const ATTACHMENT_PARENT_TYPES = [
  "TRIP",
  "TRIP_LEG",
  "RESERVATION",
  "EVENT",
  "TASK",
  "BILL",
  "VISIT",
  "LAB_RESULT",
  "CARE_ITEM",
  "PREGNANCY",
  "PERSON",
  "PET",
  "PET_MEDICATION",
  "PET_VACCINE",
] as const;
export type AttachmentParentType = (typeof ATTACHMENT_PARENT_TYPES)[number];

export type AttachmentKind = "image" | "pdf" | "video" | "audio" | "archive";

/** Allowed content types → file extension + kind. */
export const ALLOWED_ATTACHMENT_TYPES: Record<string, { ext: string; kind: AttachmentKind }> = {
  // Images
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/jpg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "image/heic": { ext: "heic", kind: "image" },
  "image/heif": { ext: "heic", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
  // Documents
  "application/pdf": { ext: "pdf", kind: "pdf" },
  // Video (ultrasound clips, exam recordings). iPhone records .mov.
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
  "video/x-m4v": { ext: "m4v", kind: "video" },
  "video/3gpp": { ext: "3gp", kind: "video" },
  // Audio (heartbeat recordings, voice memos, WhatsApp voice notes)
  "audio/mpeg": { ext: "mp3", kind: "audio" },
  "audio/mp3": { ext: "mp3", kind: "audio" },
  "audio/mp4": { ext: "m4a", kind: "audio" },
  "audio/x-m4a": { ext: "m4a", kind: "audio" },
  "audio/aac": { ext: "aac", kind: "audio" },
  "audio/wav": { ext: "wav", kind: "audio" },
  "audio/x-wav": { ext: "wav", kind: "audio" },
  "audio/wave": { ext: "wav", kind: "audio" },
  "audio/ogg": { ext: "ogg", kind: "audio" },
  "audio/opus": { ext: "opus", kind: "audio" },
  "audio/webm": { ext: "weba", kind: "audio" },
  "audio/flac": { ext: "flac", kind: "audio" },
  "audio/x-flac": { ext: "flac", kind: "audio" },
  "audio/amr": { ext: "amr", kind: "audio" },
  // Imaging: a single DICOM file, or the zipped CD an imaging center hands out
  "application/dicom": { ext: "dcm", kind: "archive" },
  "application/zip": { ext: "zip", kind: "archive" },
  "application/x-zip-compressed": { ext: "zip", kind: "archive" },
};

const MB = 1024 * 1024;
/** Per-kind upload caps. A single presigned PUT tops out at 5 GB. */
export const ATTACHMENT_MAX_BYTES: Record<AttachmentKind, number> = {
  image: 25 * MB,
  pdf: 25 * MB,
  audio: 200 * MB,
  video: 2048 * MB,
  archive: 2048 * MB,
};

const EXT_TO_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  amr: "audio/amr",
  dcm: "application/dicom",
  zip: "application/zip",
};

/**
 * Normalise a content type: drop parameters ("audio/ogg; codecs=opus" →
 * "audio/ogg"), lowercase, and fall back to the filename extension when
 * the browser reports nothing (common for .dcm, sometimes .heic/.m4a).
 */
export function normalizeContentType(contentType: string | null | undefined, filename?: string | null): string {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (base && base !== "application/octet-stream") return base;
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_TYPE[ext] ?? base;
}

export function attachmentKind(contentType: string | null | undefined): AttachmentKind | null {
  if (!contentType) return null;
  return ALLOWED_ATTACHMENT_TYPES[normalizeContentType(contentType)]?.kind ?? null;
}

/** `accept` attribute for <input type="file">. */
export const ATTACHMENT_ACCEPT = [
  ...Object.keys(ALLOWED_ATTACHMENT_TYPES),
  "image/*",
  "video/*",
  "audio/*",
  ...Object.keys(EXT_TO_TYPE).map((e) => `.${e}`),
].join(",");
