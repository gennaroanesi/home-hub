/**
 * GET /api/files/link?key=home/attachments/…[&key=…]
 *
 * Signed /api/d links (lib/file-link.ts) for files the apps show or
 * open, e.g. mobile attachment thumbnails and the open-in-browser sheet.
 * Needs a home-users session (cookie or Bearer). Only keys under
 * APP_LINK_PREFIXES (lib/file-link.ts): where attachments live, whose
 * rows every home-user can read. Vault documents stay behind the
 * Duo-gated /api/documents routes.
 *
 * Response: { links: { [key]: url }, skipped: key[], expiresAt: epoch ms }
 * Several keys per call so a list of thumbnails costs one request.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { withHomeUserAuth } from "@/lib/api-auth";
import { FILE_LINK_APP_TTL_MS, FILE_LINK_BASE_URL, isAppLinkableKey, signedFileLink } from "@/lib/file-link";
import { fileLinkKey } from "@/lib/file-link-server";

const MAX_KEYS = 100;

/**
 * The public host, except on a local dev server, where links point back
 * at it. (Behind Amplify Hosting the Host header isn't reliably the
 * custom domain, so production always uses FILE_LINK_BASE_URL.)
 */
function baseUrl(req: NextApiRequest): string {
  const host = String(req.headers.host ?? "");
  return /^(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/.test(host) ? `http://${host}` : FILE_LINK_BASE_URL;
}

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const raw = req.query.key;
  const keys = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean))];
  if (keys.length === 0) {
    res.status(400).json({ error: "key is required" });
    return;
  }
  if (keys.length > MAX_KEYS) {
    res.status(400).json({ error: `At most ${MAX_KEYS} keys per request` });
    return;
  }
  // Keys outside APP_LINK_PREFIXES are left out (listed in `skipped`)
  // rather than failing the batch, so one odd row doesn't cost a whole
  // list its previews.
  const linkable = keys.filter(isAppLinkableKey);
  const skipped = keys.filter((k) => !isAppLinkableKey(k));
  if (linkable.length === 0) {
    res.status(400).json({ error: "None of these files can be linked", skipped });
    return;
  }

  try {
    const signingKey = await fileLinkKey();
    const now = Date.now();
    const base = baseUrl(req);
    const links: Record<string, string> = {};
    for (const k of linkable) links[k] = signedFileLink(k, signingKey, { ttlMs: FILE_LINK_APP_TTL_MS, baseUrl: base, now });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ links, skipped, expiresAt: Math.floor((now + FILE_LINK_APP_TTL_MS) / 1000) * 1000 });
  } catch (err) {
    console.error("[api/files/link] failed:", err);
    res.status(500).json({ error: "Couldn't sign file links" });
  }
}

export default withHomeUserAuth(handler);
