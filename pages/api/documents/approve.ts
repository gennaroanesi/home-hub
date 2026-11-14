/**
 * POST /api/documents/approve
 *
 * Duo push for vault changes that loosen protection: marking a document
 * not sensitive (so it opens without Duo). Same push-and-wait as
 * /api/documents/download; the page saves only after this says yes.
 *
 * Body: { duoUsername: string, documentTitle?: string }
 * Response: { ok: true } or { error: string }
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { preauth, pushAndWait } from "@/lib/duo-server";
import { withHomeUserAuth } from "@/lib/api-auth";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { duoUsername, documentTitle } = req.body ?? {};
  if (!duoUsername) return res.status(400).json({ error: "duoUsername is required" });

  try {
    const pre = await preauth(duoUsername);
    if (pre.result === "deny") return res.status(403).json({ error: "Duo account is locked or denied" });
    if (pre.result === "enroll") {
      return res.status(403).json({ error: "Duo account is not fully enrolled — complete enrollment in Duo Mobile first" });
    }
    // 20s: inside Amplify's ~28s SSR limit (see download.ts).
    const auth = await pushAndWait({
      username: duoUsername,
      pushinfo: { Action: "Mark document not sensitive", Document: String(documentTitle ?? "").slice(0, 100) || "(untitled)", Source: "Home Hub web" },
      maxWaitMs: 20_000,
    });
    if (auth.result === "waiting") {
      return res.status(403).json({ error: `No approval from ${duoUsername}'s phone within 20 seconds — try again.` });
    }
    if (auth.result !== "allow") return res.status(403).json({ error: `Duo push ${auth.result}: ${auth.status_msg}` });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Document approve error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
}

export default withHomeUserAuth(handler);
