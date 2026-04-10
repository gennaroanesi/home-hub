type ImageLoaderProps = {
  src: string;
  width: number;
  quality?: number;
};

const CLOUDFRONT_URL = "https://d2vnnym2o6bm6m.cloudfront.net";

/**
 * CloudFront image loader for Next.js <Image>. Routes requests through
 * the shared cristinegennaro.com CloudFront distribution which resizes
 * and re-encodes images on demand. The src should be the S3 key (no
 * leading slash), e.g. "home/photos/trips/abc/xyz.jpg".
 */
export function cloudfrontImageLoader(p: ImageLoaderProps): string {
  const url = new URL(`${CLOUDFRONT_URL}/${p.src}`);
  url.searchParams.set("format", "webp");
  url.searchParams.set("width", p.width.toString());
  url.searchParams.set("quality", (p.quality ?? 75).toString());
  return url.href;
}

/**
 * Build a direct CloudFront URL for a photo at a given width. Useful
 * outside of <Image> (e.g. for thumbnails in non-Next.js contexts).
 */
export function photoUrl(s3key: string, width = 800, quality = 75): string {
  const url = new URL(`${CLOUDFRONT_URL}/${s3key}`);
  url.searchParams.set("format", "webp");
  url.searchParams.set("width", width.toString());
  url.searchParams.set("quality", quality.toString());
  return url.href;
}

/**
 * Original (full resolution, no transforms) URL.
 */
export function originalPhotoUrl(s3key: string): string {
  return `${CLOUDFRONT_URL}/${s3key}`;
}
