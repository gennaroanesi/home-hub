/**
 * POST /api/documents/<id>/approval
 *
 * Sends a Duo push to the caller's own phone for this document and
 * returns a 5-minute approval token to put in `X-Document-Approval` on
 * GET /api/documents/<id>/content (poll it until it stops saying waiting).
 *   202 { approval, duoUsername }
 *   200 { approval: null }   the document isn't sensitive; just GET it
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { withHomeUserAuth, type AuthedUser } from "@/lib/api-auth";
import { preauth, pushAuth, approvalSigningKey } from "@/lib/duo-server";
import { APPROVAL_TTL_MS, signApproval } from "@/lib/document-approval";
import { documentIsSensitive } from "@/lib/documents";
import { duoUsernameFor, loadDocumentAs } from "@/lib/document-access";

async function handler(req: NextApiRequest, res: NextApiResponse, user: AuthedUser) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const id = String(req.query.id ?? "");

  try {
    const doc = await loadDocumentAs(user.accessToken, id);
    if (!doc) return res.status(404).json({ error: "No such document" });
    if (!documentIsSensitive(doc)) return res.status(200).json({ approval: null });

    const duoUsername = await duoUsernameFor(user.accessToken, user.username);
    if (!duoUsername) return res.status(403).json({ error: "Link your Duo account in /security first." });
    const pre = await preauth(duoUsername);
    if (pre.result === "deny") return res.status(403).json({ error: "Duo account is locked or denied" });
    if (pre.result === "enroll") {
      return res.status(403).json({ error: "Duo account is not fully enrolled — complete enrollment in Duo Mobile first" });
    }
    const push = await pushAuth({
      username: duoUsername,
      pushinfo: { Action: "Open document", Document: doc.title.slice(0, 100), Source: "Home Hub" },
      async: "1",
    });
    if (!push.txid) return res.status(502).json({ error: "Duo didn't start the push — try again." });

    const approval = signApproval({ txid: push.txid, documentId: doc.id, sub: user.sub, exp: Date.now() + APPROVAL_TTL_MS }, await approvalSigningKey());
    return res.status(202).json({ approval, duoUsername });
  } catch (err) {
    console.error("Document approval error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
}

export default withHomeUserAuth(handler);
