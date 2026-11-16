// Signed short links to files under home/ in the S3 bucket:
//
//   https://home.cristinegennaro.com/api/d/<file>?t=<exp>.<sig>          home/documents/<file>
//   https://home.cristinegennaro.com/api/d/<prefix>/<...rest>?t=<exp>.<sig>  home/<prefix>/<...rest>
//
// /api/d verifies the token and 302s to a short presigned S3 GET; the
// bucket itself only answers unsigned requests from the home IP, so this
// is what makes the links work anywhere. The token is
//   <exp: epoch seconds, base36>.<HMAC-SHA256(key, "file-link:v1|<s3 key>|<exp>"), first 16 bytes, base64url>
// so a link only opens the one key it was minted for, until it expires.
// ~30 characters, which keeps Janet's WhatsApp links short.
//
// Not single-use, on purpose: WhatsApp (and iMessage) fetch a URL to
// build its link preview before the person taps it, which would burn a
// one-shot token. A short expiry bounds the exposure instead.
//
// The HMAC key is derived from the Duo integration secret
// (home-hub/duo-auth-api `secretKey`), which both the agent Lambda
// (amplify/functions/agent/duo.ts) and the SSR (lib/duo-server.ts) can
// already read, so there's no new secret to provision. The "file-link:"
// derivation keeps these tokens from ever being interchangeable with
// the Duo request signatures or document-approval tokens.
//
// Pure (node:crypto only), shared by the SSR and the agent Lambda.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Links Janet DMs on WhatsApp: long enough to tap later in the chat. */
export const FILE_LINK_DM_TTL_MS = 15 * 60 * 1000;
/** Links the apps fetch right before showing / opening a file. */
export const FILE_LINK_APP_TTL_MS = 15 * 60 * 1000;
/** The presigned S3 URL /api/d redirects to: only has to survive the redirect. */
export const FILE_LINK_PRESIGN_SECONDS = 120;

const SIG_BYTES = 16;

/** The link-signing key (hex), derived from the shared Duo secret. */
export function deriveFileLinkKey(duoSecretKey: string): string {
  if (!duoSecretKey) throw new Error("file-link: empty secret");
  return createHmac("sha256", duoSecretKey).update("file-link:v1").digest("hex");
}

function mac(s3Key: string, exp: number, key: string): string {
  return createHmac("sha256", key)
    .update(`file-link:v1|${s3Key}|${exp}`)
    .digest()
    .subarray(0, SIG_BYTES)
    .toString("base64url");
}

/** A key /api/d may serve: under home/, no empty / dot segments. */
export function isLinkableKey(s3Key: string): boolean {
  if (typeof s3Key !== "string" || !s3Key.startsWith("home/")) return false;
  const parts = s3Key.split("/");
  if (parts.length < 3) return false;
  return parts.every((p) => p.length > 0 && p !== "." && p !== "..");
}

/**
 * Prefixes /api/files/link will sign for any home-users session: where
 * homeAttachment rows point (allow.group("home-users"), so the whole
 * group can already read them): app uploads under home/attachments/,
 * and WhatsApp files Janet attached (home/messages/, home/agent-uploads/).
 * Vault documents (home/documents/) are deliberately not here: those go
 * through the Duo-gated document routes.
 */
export const APP_LINK_PREFIXES = ["home/attachments/", "home/messages/", "home/agent-uploads/"] as const;

export function isAppLinkableKey(s3Key: string): boolean {
  return isLinkableKey(s3Key) && APP_LINK_PREFIXES.some((p) => s3Key.startsWith(p));
}

/** Path segments of /api/d → the S3 key (one segment = a vault document). */
export function s3KeyFromLinkPath(segments: string[]): string | null {
  if (!segments.length) return null;
  const joined = segments.join("/");
  const key = segments.length === 1 ? `home/documents/${joined}` : `home/${joined}`;
  return isLinkableKey(key) ? key : null;
}

/** The S3 key → the /api/d path (inverse of s3KeyFromLinkPath). */
export function linkPathForKey(s3Key: string): string {
  if (!isLinkableKey(s3Key)) throw new Error(`file-link: not a linkable key: ${s3Key}`);
  const rest = s3Key.slice("home/documents/".length);
  const path = s3Key.startsWith("home/documents/") && !rest.includes("/") ? rest : s3Key.slice("home/".length);
  return `/api/d/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function signFileLinkToken(s3Key: string, key: string, opts: { ttlMs: number; now?: number }): string {
  const exp = Math.floor(((opts.now ?? Date.now()) + opts.ttlMs) / 1000);
  return `${exp.toString(36)}.${mac(s3Key, exp, key)}`;
}

export type FileLinkCheck =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: "missing" | "invalid" | "expired" };

export function verifyFileLinkToken(s3Key: string, token: unknown, key: string, now = Date.now()): FileLinkCheck {
  if (typeof token !== "string" || !token) return { ok: false, reason: "missing" };
  const m = /^([0-9a-z]{1,11})\.([A-Za-z0-9_-]{1,64})$/.exec(token);
  if (!m) return { ok: false, reason: "invalid" };
  const exp = parseInt(m[1], 36);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "invalid" };
  const want = Buffer.from(mac(s3Key, exp, key));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(new Uint8Array(want), new Uint8Array(got))) {
    return { ok: false, reason: "invalid" };
  }
  if (exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, expiresAt: exp * 1000 };
}

export const FILE_LINK_BASE_URL = "https://home.cristinegennaro.com";

/** Full signed URL for a file, e.g. for a WhatsApp DM or an app preview. */
export function signedFileLink(
  s3Key: string,
  key: string,
  opts: { ttlMs: number; baseUrl?: string; now?: number },
): string {
  return `${opts.baseUrl ?? FILE_LINK_BASE_URL}${linkPathForKey(s3Key)}?t=${signFileLinkToken(s3Key, key, opts)}`;
}
