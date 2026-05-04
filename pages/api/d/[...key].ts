/**
 * GET /api/d/<...key>
 *
 * Short-link redirector for files under the home/* S3 prefix. Two URL
 * shapes are supported:
 *
 *   /api/d/<filename>.<ext>
 *     Single-segment — backwards-compat with the document-vault URLs
 *     the agent DMs to WhatsApp. The key resolves to
 *     `home/documents/<filename>.<ext>`.
 *
 *   /api/d/<prefix>/<...rest>
 *     Multi-segment — for attachments, photos, anything else under
 *     `home/`. The key resolves to `home/<prefix>/<...rest>`.
 *     Mobile uses this shape for AttachmentSection previews.
 *
 * AUTH MODEL: no Cognito session required — the URL is shared via
 * WhatsApp DM (agent) or used by the mobile app for inline previews.
 * The "auth" is the unguessable UUID + the upstream Duo/Face-ID gate
 * (for documents) or the parent's auth scope (for attachments). This
 * is the WEAKEST gate in the system — TODO before going wide:
 * generate a single-use token at approval time, validate it here,
 * and consume it on the redirect.
 */

import type { NextApiRequest, NextApiResponse } from "next";

const BUCKET = process.env.HOME_HUB_BUCKET ?? "";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const raw = req.query.key;
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (segments.length === 0) {
    return res.status(400).json({ error: "Missing key" });
  }

  // Single segment with no slash → assume the document-vault prefix
  // (backwards compat with agent DM URLs). Multi-segment → the first
  // segment IS the prefix under home/.
  const joined = segments.join("/");
  const s3Key =
    segments.length === 1 ? `home/documents/${joined}` : `home/${joined}`;

  const url = `https://s3.us-east-1.amazonaws.com/${BUCKET}/${s3Key}`;
  res.redirect(302, url);
}
