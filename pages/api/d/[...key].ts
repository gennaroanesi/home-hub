/**
 * GET /api/d/<...key>?t=<token>
 *
 * Signed short links to files under home/ (lib/file-link.ts):
 *
 *   /api/d/<filename>.<ext>?t=…      → home/documents/<filename>.<ext>
 *   /api/d/<prefix>/<...rest>?t=…    → home/<prefix>/<...rest>
 *
 * The token is an HMAC over the S3 key and an expiry. A good one gets a
 * 302 to a 2-minute presigned S3 GET signed by the SSR role, which works
 * from anywhere (the bucket only answers unsigned requests from the home
 * IP, which is why the old bare links broke away from home Wi-Fi).
 *
 * Who mints them:
 *   - Janet's WhatsApp DMs, after the Duo approval (or straight away for
 *     a document marked not sensitive), valid 15 minutes.
 *   - /api/files/link, for the apps (home-users session), e.g. mobile
 *     attachment previews.
 *   - /api/documents/download (Duo-gated web download).
 *
 * Links aren't single-use: WhatsApp's link preview fetches the URL before
 * anyone taps it, so the expiry is what bounds them. Unsigned links
 * (everything handed out before this change, and old app installs that
 * build /api/d URLs themselves) now get a 403 — intended, they only ever
 * worked at home.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { s3KeyFromLinkPath, verifyFileLinkToken } from "@/lib/file-link";
import { fileLinkKey, presignHomeFile } from "@/lib/file-link-server";

const MESSAGES = {
  missing:
    "This file link isn't signed. Home Hub file links are now signed and expire: ask Janet for the file again, or open it in the app (update the app if attachments don't open).",
  invalid: "This file link isn't valid. Ask Janet for the file again, or open it in the app.",
  expired: "This file link has expired. Ask Janet for the file again, or open it in the app.",
} as const;

function deny(res: NextApiResponse, status: number, message: string) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res
    .status(status)
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Home Hub</title></head>` +
        `<body style="font-family:-apple-system,system-ui,sans-serif;padding:24px;color:#333;line-height:1.4"><p>${message}</p></body></html>`,
    );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return deny(res, 405, "Method not allowed.");
  }

  const raw = req.query.key;
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const s3Key = s3KeyFromLinkPath(segments);
  if (!s3Key) return deny(res, 404, "There's no file at this link.");

  try {
    const check = verifyFileLinkToken(s3Key, req.query.t, await fileLinkKey());
    if (!check.ok) return deny(res, 403, MESSAGES[check.reason]);
    const url = await presignHomeFile(s3Key);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(302, url);
  } catch (err) {
    console.error("[api/d] failed:", err);
    return deny(res, 500, "Couldn't open this file right now. Try again in a minute.");
  }
}
