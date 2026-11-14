// Proof that a Duo push was sent for one document to one caller, handed
// back to the client by /api/documents/open and required on the follow-up
// call. HMAC-signed so the client can't swap the txid, document or person;
// expires with the push (5 min).

import { createHmac, timingSafeEqual } from "node:crypto";

export interface DocumentApproval {
  txid: string;
  documentId: string;
  sub: string; // Cognito sub of the caller who asked
  exp: number; // epoch ms
}

export const APPROVAL_TTL_MS = 5 * 60 * 1000;

function mac(body: string, key: string): string {
  return createHmac("sha256", key).update(`document-approval:${body}`).digest("base64url");
}

export function signApproval(a: DocumentApproval, key: string): string {
  const body = Buffer.from(JSON.stringify(a)).toString("base64url");
  return `${body}.${mac(body, key)}`;
}

/** The approval if the token is genuine, unexpired and for this document and caller; else null. */
export function verifyApproval(token: string, key: string, expect: { documentId: string; sub: string; now?: number }): DocumentApproval | null {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig) return null;
  const want = new Uint8Array(Buffer.from(mac(body, key)));
  const got = new Uint8Array(Buffer.from(sig));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let a: DocumentApproval;
  try {
    a = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (a.documentId !== expect.documentId || a.sub !== expect.sub) return null;
  if (!(a.exp > (expect.now ?? Date.now()))) return null;
  return a;
}
