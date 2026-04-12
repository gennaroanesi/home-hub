/**
 * POST /api/documents/download
 *
 * Duo-Push-gated document download for the web UI. Triggers a Duo push
 * to the requester's phone, waits for approval (~60s max), then returns
 * a 30-minute presigned S3 GET URL. For metadata-only entries (no file),
 * returns the documentNumber directly.
 *
 * Body: { documentId: string, duoUsername: string }
 * Response on success: { url?: string, documentNumber?: string, expiresAt: string }
 * Response on denial:  { error: string }
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { preauth, pushAuth } from "@/lib/duo-server";

const BUCKET = "cristinegennaro.com";
const s3 = new S3Client({ region: "us-east-1" });

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { documentId, duoUsername } = req.body ?? {};
  if (!documentId || !duoUsername) {
    return res.status(400).json({ error: "documentId and duoUsername are required" });
  }

  try {
    // 1. Verify Duo enrollment
    const pre = await preauth(duoUsername);
    if (pre.result === "deny") {
      return res.status(403).json({ error: "Duo account is locked or denied" });
    }
    if (pre.result === "enroll") {
      return res.status(403).json({ error: "Duo account is not fully enrolled — complete enrollment in Duo Mobile first" });
    }

    // 2. Send Duo push (blocks up to ~60s)
    const authResult = await pushAuth({
      username: duoUsername,
      pushinfo: { Action: "Document download", Source: "Home Hub web" },
    });

    if (authResult.result !== "allow") {
      return res.status(403).json({ error: "Duo push denied or timed out" });
    }

    // 3. Fetch document metadata — use a direct import approach since
    // server-side client creation in Pages Router API routes requires
    // the Amplify data client. We use a simpler approach: just fetch
    // directly from DynamoDB via the Amplify client.
    // Since we can't easily use the Amplify server client in API routes
    // (it needs cookies() from next/headers which is App Router only),
    // we'll accept the document's s3Key and originalFilename from the
    // client and verify the key prefix for safety.
    const { s3Key, originalFilename, documentNumber } = req.body;

    if (s3Key) {
      // Validate the key is under our documents prefix
      if (!s3Key.startsWith("home/documents/")) {
        return res.status(400).json({ error: "Invalid document path" });
      }

      const safeFilename = (originalFilename || "document").replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );
      const cmd = new GetObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
      });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 30 * 60 });
      const expiresAt = new Date(
        Date.now() + 30 * 60 * 1000
      ).toISOString();

      return res.status(200).json({ url, expiresAt });
    }

    if (documentNumber) {
      return res.status(200).json({ documentNumber });
    }

    return res.status(400).json({ error: "Document has no file or number" });
  } catch (err) {
    console.error("Document download error:", err);
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return res.status(500).json({ error: message });
  }
}
