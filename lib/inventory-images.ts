// Validation for inventory photos that arrive as bytes (API / chat):
// allowed types, size cap, and base64 / data-URL decoding. Storage (S3,
// home/inventory/) lives in the agent handler.

export const INVENTORY_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/gif": "gif",
};

export const MAX_INVENTORY_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ImageBytes {
  data: Buffer;
  contentType: string;
}

/** Normalizes the content type and enforces type + size limits. */
export function checkImage(img: ImageBytes): ImageBytes {
  const contentType = img.contentType.toLowerCase().split(";")[0].trim();
  if (!INVENTORY_IMAGE_TYPES[contentType]) {
    throw new Error(`Unsupported image type "${img.contentType}" (JPEG, PNG, WebP, HEIC or GIF)`);
  }
  if (img.data.length === 0) throw new Error("Image is empty");
  if (img.data.length > MAX_INVENTORY_IMAGE_BYTES) throw new Error("Image is larger than 10 MB");
  return { data: img.data, contentType };
}

/** Plain base64 (needs contentType) or a data: URL (carries its own type). */
export function decodeBase64Image(raw: string, contentType?: string): ImageBytes {
  const m = raw.match(/^data:([^;,]+);base64,([\s\S]*)$/);
  const type = m ? m[1] : contentType;
  if (!type) throw new Error("contentType is required with imageBase64");
  const data = Buffer.from((m ? m[2] : raw).replace(/\s/g, ""), "base64");
  return checkImage({ data, contentType: type });
}

export function extensionForImage(contentType: string): string {
  return INVENTORY_IMAGE_TYPES[contentType] ?? "bin";
}
