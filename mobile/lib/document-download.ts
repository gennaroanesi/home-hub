// Mobile document download flow with Face ID gate + Duo fallback.
//
// Default path: Face ID → if pass, construct the /api/d/<key> redirect
// URL locally and hand it to Linking. The unguessable s3 key is the
// shared secret; revealing it requires the local biometric gate.
//
// Fallback (no Face ID hardware / not enrolled / user cancelled): hit
// the existing /api/documents/download endpoint with the user's
// homePersonAuth.duoUsername. The web's Duo flow handles the rest —
// fires a push to the user's Duo Mobile app, waits ~60s, returns the
// same URL on approval.
//
// Web has no Face ID equivalent worth wiring; the web Documents page
// keeps using Duo directly. Both surfaces gate the same backend act.

import { requireLocalAuth, type LocalAuthOutcome } from "./local-auth";
import { getClient } from "./amplify";
import { resolveCurrentPerson } from "./current-person";

const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL ?? "https://home.cristinegennaro.com";

export interface DownloadInput {
  documentId: string;
  s3Key?: string | null;
  documentNumber?: string | null;
}

export type DownloadResult =
  | { ok: true; url?: string; documentNumber?: string; via: "faceid" | "duo" }
  | { ok: false; error: string };

/** Construct the short-link redirect URL from an s3 key. The redirect
 *  itself is unauthenticated (UUID is the secret); revealing the URL
 *  is what the Face ID / Duo gate protects. */
function urlFromS3Key(s3Key: string): string {
  const filename = s3Key.replace(/^home\/documents\//, "");
  return `${WEB_BASE_URL}/api/d/${filename}`;
}

/** Open the file (s3Key) when present, else fall back to the number. */
export async function downloadDocument(
  input: DownloadInput
): Promise<DownloadResult> {
  return runGated(input, "file", "Confirm document download");
}

/** Reveal the document number specifically. Used when a doc has both
 *  a file and a number — the file path doesn't expose the number. */
export async function revealDocumentNumber(
  input: DownloadInput
): Promise<DownloadResult> {
  if (!input.documentNumber) {
    return { ok: false, error: "This document has no number to reveal" };
  }
  return runGated(input, "number", "Reveal document number");
}

type RevealMode = "file" | "number";

async function runGated(
  input: DownloadInput,
  mode: RevealMode,
  promptMessage: string
): Promise<DownloadResult> {
  const localAuth = await requireLocalAuth({ promptMessage });

  if (localAuth.ok) {
    return revealAfterAuth(input, mode, "faceid");
  }

  // Face ID gate didn't pass. If the user explicitly cancelled, don't
  // surprise them by escalating to Duo — abort. If hardware/enrollment
  // is missing, fall through to Duo as the second factor.
  if (localAuth.reason === "cancelled") {
    return { ok: false, error: "Cancelled" };
  }

  return runDuoFallback(input, mode, localAuth);
}

function revealAfterAuth(
  input: DownloadInput,
  mode: RevealMode,
  via: "faceid" | "duo"
): DownloadResult {
  if (mode === "number") {
    if (!input.documentNumber) {
      return { ok: false, error: "Document has no number" };
    }
    return { ok: true, documentNumber: input.documentNumber, via };
  }
  // mode === "file"
  if (input.s3Key) {
    return { ok: true, url: urlFromS3Key(input.s3Key), via };
  }
  if (input.documentNumber) {
    return { ok: true, documentNumber: input.documentNumber, via };
  }
  return { ok: false, error: "Document has no file or number" };
}

async function runDuoFallback(
  input: DownloadInput,
  mode: RevealMode,
  authOutcome: LocalAuthOutcome
): Promise<DownloadResult> {
  if (authOutcome.ok) {
    return revealAfterAuth(input, mode, "faceid");
  }

  const client = getClient();
  const { person } = await resolveCurrentPerson();
  if (!person) {
    return {
      ok: false,
      error:
        "Couldn't identify the signed-in person — link your account on the web first.",
    };
  }

  const { data: authRows, errors } = await client.models.homePersonAuth.list({
    filter: { personId: { eq: person.id } },
  });
  if (errors?.length) {
    return { ok: false, error: errors[0].message };
  }
  const duoUsername = authRows?.[0]?.duoUsername;
  if (!duoUsername) {
    return {
      ok: false,
      error:
        "Face ID isn't set up and no Duo account is linked. Link Duo on the web's /security page.",
    };
  }

  // For "number" mode skip s3Key in the request so the web endpoint
  // returns the number rather than a download URL.
  const res = await fetch(`${WEB_BASE_URL}/api/documents/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      documentId: input.documentId,
      duoUsername,
      s3Key: mode === "file" ? input.s3Key ?? undefined : undefined,
      documentNumber: input.documentNumber ?? undefined,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string }
      | null;
    return { ok: false, error: body?.error ?? `Duo request failed (${res.status})` };
  }
  const body = (await res.json()) as {
    url?: string;
    documentNumber?: string;
  };
  return { ok: true, url: body.url, documentNumber: body.documentNumber, via: "duo" };
}
