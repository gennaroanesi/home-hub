// Signed links to home/ files (attachments) for previews and opening.
// The bucket only answers unsigned requests from the home network, so
// the app asks the web for signed /api/d links (GET /api/files/link,
// home-users session via authedFetch; lib/file-link.ts on the server).
// Links last 15 minutes; callers refetch when they're close to expiry.

import { authedFetch } from "./authed-fetch";

const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL ?? "https://home.cristinegennaro.com";

export interface FileLinks {
  links: Record<string, string>;
  /** Epoch ms. */
  expiresAt: number;
}

/** Treat links as stale a minute early so an open never races the expiry. */
export function fileLinksFresh(f: FileLinks | null, keys: string[], now = Date.now()): boolean {
  return !!f && f.expiresAt - 60_000 > now && keys.every((k) => !!f.links[k]);
}

export async function fetchFileLinks(keys: string[]): Promise<FileLinks> {
  if (keys.length === 0) return { links: {}, expiresAt: Number.MAX_SAFE_INTEGER };
  const qs = keys.map((k) => `key=${encodeURIComponent(k)}`).join("&");
  let res: Response;
  try {
    res = await authedFetch(`${WEB_BASE_URL}/api/files/link?${qs}`);
  } catch {
    throw new Error("Couldn't reach Home Hub. Check your connection and try again.");
  }
  let body: { links?: Record<string, string>; expiresAt?: number; error?: string } = {};
  try {
    body = await res.json();
  } catch {
    // Non-JSON (e.g. an HTML error page) — fall through to the status.
  }
  if (!res.ok || !body.links) {
    if (res.status === 401) throw new Error("Your session expired. Sign in again to open files.");
    throw new Error(body.error ?? `Couldn't get a link to the file (${res.status}).`);
  }
  return { links: body.links, expiresAt: body.expiresAt ?? Date.now() + 10 * 60_000 };
}
