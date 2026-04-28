// CloudFront image URL helpers for mobile. Mirrors the small subset
// of lib/image-loader.ts on the web side that we actually need here
// (rendering a stored s3Key into an <Image src>). Reusing that file
// directly is awkward — it lives outside mobile/ and pulls Next.js
// types via the @/* alias — so a tiny copy is cheaper than aliasing.

const CLOUDFRONT_URL = "https://d2vnnym2o6bm6m.cloudfront.net";

/** Direct CloudFront URL for the original asset. */
export function originalImageUrl(s3Key: string): string {
  return `${CLOUDFRONT_URL}/${s3Key}`;
}

/** Resized + re-encoded CloudFront URL — handy for thumbnails. */
export function resizedImageUrl(
  s3Key: string,
  width = 800,
  quality = 75
): string {
  const url = new URL(`${CLOUDFRONT_URL}/${s3Key}`);
  url.searchParams.set("format", "webp");
  url.searchParams.set("width", String(width));
  url.searchParams.set("quality", String(quality));
  return url.href;
}
