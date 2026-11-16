// Client side of opening a vault document, shared by web and mobile:
//   GET  /api/documents/<id>/content            200 → done (not sensitive)
//                                                403 duo_required → ask
//   POST /api/documents/<id>/approval           202 { approval } (push sent
//                                                to the caller's own phone)
//   GET  .../content + X-Document-Approval      every 2s up to 90s:
//                                                202 waiting, 200 done, 403 denied
// The fetch is injected (browser fetch with cookies on web, authedFetch
// against the web base URL on mobile), so this stays platform-free.

export interface DocumentContent {
  url?: string;
  documentNumber?: string;
}

export type DocumentContentResult =
  | { ok: true; content: DocumentContent }
  | { ok: false; reason: "denied" | "timeout" | "error"; error: string };

interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

export type ContentFetch = (
  path: string,
  init?: { method?: string; headers?: Record<string, string> }
) => Promise<ResponseLike>;

export interface FetchDocumentContentOptions {
  fetch: ContentFetch;
  /** Signed link as an attachment (download) rather than inline (view). */
  download?: boolean;
  /** The push went out; it's on the caller's phone now. */
  onDuoPush?: (duoUsername: string | undefined) => void;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DUO_TIMEOUT_MESSAGE = "No answer from your phone — try again.";

/** JSON body of a document API response, or an error that explains a non-JSON one (gateway timeouts). */
export async function readDocumentResponse(
  res: ResponseLike
): Promise<DocumentContent & { expiresAt?: string; error?: string }> {
  try {
    return await res.json();
  } catch {
    return {
      error:
        res.status === 504 || res.status === 502
          ? "Timed out waiting for Duo approval — try again and approve the push within ~20 seconds."
          : `Unexpected response (${res.status})`,
    };
  }
}

export async function fetchDocumentContent(
  documentId: string,
  opts: FetchDocumentContentOptions
): Promise<DocumentContentResult> {
  const {
    fetch,
    download = false,
    onDuoPush,
    timeoutMs = 90_000,
    intervalMs = 2000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;
  const path = `/api/documents/${documentId}/content${download ? "?download=1" : ""}`;
  const fail = async (res: ResponseLike, reason: "denied" | "error" = "error"): Promise<DocumentContentResult> => ({
    ok: false,
    reason,
    error: (await readDocumentResponse(res)).error ?? `Error ${res.status}`,
  });

  let res = await fetch(path);
  if (res.ok) return { ok: true, content: await res.json() };
  const first = await readDocumentResponse(res);
  if (res.status !== 403 || first.error !== "duo_required") {
    return { ok: false, reason: "error", error: first.error ?? `Error ${res.status}` };
  }

  const ask = await fetch(`/api/documents/${documentId}/approval`, { method: "POST" });
  const asked = (await ask.json().catch(() => ({}))) as { approval?: string | null; duoUsername?: string; error?: string };
  if (!ask.ok) return { ok: false, reason: "error", error: asked.error ?? `Error ${ask.status}` };
  if (!asked.approval) {
    // Marked not sensitive in the meantime: no push needed.
    res = await fetch(path);
    return res.ok ? { ok: true, content: await res.json() } : fail(res);
  }

  onDuoPush?.(asked.duoUsername);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    res = await fetch(path, { headers: { "X-Document-Approval": asked.approval } });
    if (res.status === 202) continue;
    if (res.ok) return { ok: true, content: await res.json() };
    return fail(res, res.status === 403 ? "denied" : "error");
  }
  return { ok: false, reason: "timeout", error: DUO_TIMEOUT_MESSAGE };
}
