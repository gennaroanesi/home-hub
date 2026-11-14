/**
 * GET /api/documents/<id>/content[?download=1]
 *
 * A document's file (5-minute signed link) and number. Never sends a
 * push. Sensitive documents need the `X-Document-Approval` header from
 * POST /api/documents/<id>/approval:
 *   200 { url?, documentNumber? }          released
 *   403 { error: "duo_required" }          sensitive, no approval sent
 *   202 { status: "waiting" }              push not answered yet; poll again
 *   403 { error }                          denied, expired, not yours
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { withHomeUserAuth, type AuthedUser } from "@/lib/api-auth";
import { authStatus, approvalSigningKey } from "@/lib/duo-server";
import { verifyApproval } from "@/lib/document-approval";
import { documentIsSensitive } from "@/lib/documents";
import { loadDocumentAs, signedDocumentUrl } from "@/lib/document-access";

async function handler(req: NextApiRequest, res: NextApiResponse, user: AuthedUser) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");
  const id = String(req.query.id ?? "");

  try {
    const doc = await loadDocumentAs(user.accessToken, id);
    if (!doc) return res.status(404).json({ error: "No such document" });

    if (documentIsSensitive(doc)) {
      const header = req.headers["x-document-approval"];
      const token = Array.isArray(header) ? header[0] : header;
      if (!token) return res.status(403).json({ error: "duo_required" });
      const approval = verifyApproval(token, await approvalSigningKey(), { documentId: doc.id, sub: user.sub });
      if (!approval) return res.status(403).json({ error: "Approval expired or not for this document — ask again." });
      const status = await authStatus(approval.txid);
      if (status.result === "waiting") return res.status(202).json({ status: "waiting" });
      if (status.result !== "allow") return res.status(403).json({ error: `Duo push ${status.result}: ${status.status_msg}` });
    }

    const url = await signedDocumentUrl(doc, req.query.download === "1");
    if (!url && !doc.documentNumber) return res.status(404).json({ error: "This document has no file or number" });
    return res.status(200).json({ url: url ?? undefined, documentNumber: doc.documentNumber ?? undefined });
  } catch (err) {
    console.error("Document content error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
}

export default withHomeUserAuth(handler);
