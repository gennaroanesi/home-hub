// Mobile document open / download / reveal flow.
//
// Everything goes through the web's two-step content API (shared client
// in ../../lib/document-content.ts), which hands back a 5-minute signed
// S3 link and the number:
//   - Not sensitive (floor plans, warranties): no Face ID, no Duo; the
//     first GET /api/documents/<id>/content answers 200.
//   - Sensitive: Face ID on the device first (cancel aborts; no hardware
//     or a failed match just moves on), then the server's Duo gate: a
//     push to the signed-in person's own phone, polled until approved,
//     denied or 90s pass. `onStatus` lets the screen show the wait.
//
// The old /api/d/<key> short link redirected to plain S3, which only
// answers on the home network, so it isn't used here any more.

import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as WebBrowser from "expo-web-browser";

import { requireLocalAuth } from "./local-auth";
import { getClient } from "./amplify";
import { resolveCurrentPerson } from "./current-person";
import { authedFetch } from "./authed-fetch";
import {
  documentIsSensitive,
  fetchDocumentContent,
  readDocumentResponse,
  type ContentFetch,
} from "./documents";

const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL ?? "https://home.cristinegennaro.com";

export interface DownloadInput {
  documentId: string;
  s3Key?: string | null;
  documentNumber?: string | null;
  isSensitive?: boolean | null;
}

export type DownloadResult =
  | { ok: true; url?: string; documentNumber?: string; via: "duo" | "open" }
  | { ok: false; error: string };

export interface GateOptions {
  /** Progress text while waiting on Duo ("Approve the Duo push…"); null when done. */
  onStatus?: (message: string | null) => void;
}

/** Waiting copy for the Duo push, shared by the screens. */
export function duoWaitingMessage(duoUsername?: string): string {
  return duoUsername
    ? `Approve the Duo push on your phone (${duoUsername})…`
    : "Approve the Duo push on your phone…";
}

const webFetch: ContentFetch = (path, init) =>
  authedFetch(`${WEB_BASE_URL}${path}`, init);

/** Signed link to the file (as an attachment) when present, else the number. */
export async function downloadDocument(
  input: DownloadInput,
  opts?: GateOptions
): Promise<DownloadResult> {
  return runGated(input, "file", "Confirm document download", true, opts);
}

/** Reveal the document number specifically. Used when a doc has both
 *  a file and a number — the file path doesn't expose the number. */
export async function revealDocumentNumber(
  input: DownloadInput,
  opts?: GateOptions
): Promise<DownloadResult> {
  if (!input.documentNumber) {
    return { ok: false, error: "This document has no number to reveal" };
  }
  return runGated(input, "number", "Reveal document number", false, opts);
}

/** Signed inline link to the file, for viewing / previews. */
export async function documentViewUrl(
  input: DownloadInput,
  opts?: GateOptions
): Promise<DownloadResult> {
  return runGated(input, "file", "View document", false, opts);
}

type RevealMode = "file" | "number";

async function runGated(
  input: DownloadInput,
  mode: RevealMode,
  promptMessage: string,
  download: boolean,
  opts?: GateOptions
): Promise<DownloadResult> {
  const sensitive = documentIsSensitive(input);
  if (sensitive) {
    // Face ID first (the phone's own gate). Cancel aborts rather than
    // surprising the user with a push; anything else moves on to Duo,
    // which the server requires regardless.
    const localAuth = await requireLocalAuth({ promptMessage });
    if (!localAuth.ok && localAuth.reason === "cancelled") {
      return { ok: false, error: "Cancelled" };
    }
    opts?.onStatus?.("Sending Duo push…");
  }

  try {
    const result = await fetchDocumentContent(input.documentId, {
      fetch: webFetch,
      download,
      onDuoPush: (duoUsername) => opts?.onStatus?.(duoWaitingMessage(duoUsername)),
    });
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.reason === "denied"
            ? `Not approved. ${result.error}`
            : result.reason === "timeout"
              ? "No answer to the Duo push within 90 seconds — try again."
              : result.error,
      };
    }
    const { url, documentNumber } = result.content;
    const via = sensitive ? "duo" : "open";
    if (mode === "number") {
      if (!documentNumber) return { ok: false, error: "Document has no number" };
      return { ok: true, documentNumber, via };
    }
    if (url) return { ok: true, url, documentNumber, via };
    if (documentNumber) return { ok: true, documentNumber, via };
    return { ok: false, error: "Document has no file or number" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    opts?.onStatus?.(null);
  }
}

// ── Loosening approval ────────────────────────────────────────────────────
//
// Marking a document not sensitive (so it opens without Duo) needs a Duo
// push first, same as the web form: POST /api/documents/approve waits up
// to 20s for the phone and says yes or no. The push goes to the
// signed-in person's linked Duo account.

async function myDuoUsername(): Promise<
  { ok: true; duoUsername: string } | { ok: false; error: string }
> {
  const { person } = await resolveCurrentPerson();
  if (!person) {
    return {
      ok: false,
      error:
        "Couldn't identify the signed-in person — link your account on the web first.",
    };
  }
  const { data: authRows, errors } = await getClient().models.homePersonAuth.list({
    filter: { personId: { eq: person.id } },
  });
  if (errors?.length) return { ok: false, error: errors[0].message };
  const duoUsername = authRows?.[0]?.duoUsername;
  if (!duoUsername) {
    return {
      ok: false,
      error:
        "Marking a document not sensitive needs Duo. Link it on the web's /security page first.",
    };
  }
  return { ok: true, duoUsername };
}

export async function approveMarkNotSensitive(
  documentTitle: string,
  opts?: GateOptions
): Promise<{ ok: true } | { ok: false; error: string }> {
  const who = await myDuoUsername();
  if (!who.ok) return who;
  opts?.onStatus?.(duoWaitingMessage(who.duoUsername));
  try {
    const res = await authedFetch(`${WEB_BASE_URL}/api/documents/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentTitle }),
    });
    const body = await readDocumentResponse(res);
    if (!res.ok) return { ok: false, error: body.error ?? "Duo approval failed" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    opts?.onStatus?.(null);
  }
}

// ── View + share helpers ──────────────────────────────────────────────────
//
// Both go through the same Face ID / Duo gate as downloadDocument. View
// renders the file inline via the in-app Safari sheet (handles PDF and
// images natively). Share downloads the bytes to a cache file and hands
// it to the iOS share sheet so the user can AirDrop / save to Files /
// send via Messages with the actual file payload (not just a link).

/** Open the file in an in-app browser sheet. Face ID / Duo gated. */
export async function viewDocument(
  input: DownloadInput,
  opts?: GateOptions
): Promise<{ ok: boolean; error?: string }> {
  const result = await documentViewUrl(input, opts);
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.url) return { ok: false, error: "This document has no file to view." };
  await WebBrowser.openBrowserAsync(result.url);
  return { ok: true };
}

/** Download the file to a local cache and trigger the iOS share sheet. */
export async function shareDocument(
  input: DownloadInput & { filename?: string | null },
  opts?: GateOptions
): Promise<{ ok: boolean; error?: string }> {
  const result = await downloadDocument(input, opts);
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.url) return { ok: false, error: "This document has no file to share." };

  const available = await Sharing.isAvailableAsync();
  if (!available) {
    return { ok: false, error: "Sharing isn't available on this device." };
  }

  const filename =
    input.filename?.trim() ||
    extractFilenameFromS3Key(input.s3Key ?? null) ||
    "document";
  const dest = new File(Paths.cache, filename);

  try {
    // expo-file-system v19: downloads to the destination File and
    // returns the resulting File. The previous (`exists`) file is
    // overwritten if present.
    if (dest.exists) dest.delete();
    const downloaded = await File.downloadFileAsync(result.url, dest);
    await Sharing.shareAsync(downloaded.uri);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function extractFilenameFromS3Key(s3Key: string | null): string | null {
  if (!s3Key) return null;
  const last = s3Key.split("/").pop();
  return last && last.length > 0 ? last : null;
}
