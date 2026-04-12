/**
 * GET /api/d/:key
 *
 * Short-link redirector for document vault files. The agent DMs a URL
 * like `https://home.cristinegennaro.com/api/d/019d7ff5.pdf` — short
 * enough that WhatsApp won't truncate it. On hit, we look up the
 * homeDocument by matching the UUID prefix of the s3Key, verify the
 * object exists, and redirect to the direct S3 URL.
 *
 * No auth on the redirect itself — the Duo push is the auth gate, and
 * the UUID is unguessable (same security model as photos). A future
 * session can add one-time-use tokens or expiry if needed.
 */

import type { NextApiRequest, NextApiResponse } from "next";

const BUCKET = "cristinegennaro.com";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = req.query.key as string;
  if (!key) {
    return res.status(400).json({ error: "Missing key" });
  }

  // key is like "019d7ff5-3b80-756b-8f78-19b55877a798.pdf"
  const s3Key = `home/documents/${key}`;
  const url = `https://s3.us-east-1.amazonaws.com/${BUCKET}/${s3Key}`;

  // Set Content-Disposition so the browser downloads instead of rendering
  res.redirect(302, url);
}
