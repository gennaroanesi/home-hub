import type { NextApiRequest, NextApiResponse } from "next";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { withHomeUserAuth } from "@/lib/api-auth";
import { isServableFinanceKey } from "@/lib/finance/finance-files";

const BUCKET = process.env.HOME_HUB_BUCKET ?? "";
const s3 = new S3Client({ region: "us-east-1" });

/**
 * GET /api/finance/file?key=home/finance/…
 * Redirects to a 5-minute presigned URL for a paystub or invoice file.
 * Unlike /api/d (unauthenticated, for WhatsApp links), this requires a
 * home-users session: these are pay stubs and bills.
 */
async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const key = typeof req.query.key === "string" ? req.query.key : "";
  if (!isServableFinanceKey(key)) {
    res.status(400).json({ error: "Not a finance file" });
    return;
  }
  const download = req.query.download === "1";
  const name = key.split("/").pop() ?? "file";
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: `${download ? "attachment" : "inline"}; filename="${name}"`,
    }),
    { expiresIn: 300 },
  );
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, url);
}

export default withHomeUserAuth(handler);
