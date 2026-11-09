import type { NextApiRequest, NextApiResponse } from "next";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { withHomeUserAuth } from "@/lib/api-auth";
import { MAX_FINANCE_PDF_BYTES, stagingKey, type FinanceUploadKind } from "@/lib/finance/finance-files";

const BUCKET = process.env.HOME_HUB_BUCKET ?? "";
const s3 = new S3Client({ region: "us-east-1" });
const KINDS = new Set<FinanceUploadKind>(["paycheck", "invoice"]);

/**
 * POST /api/finance/upload-url
 * Body: { kind: "paycheck" | "invoice", sizeBytes? }
 * Returns: { uploadUrl, s3Key, expiresIn }
 *
 * The page PUTs the PDF to uploadUrl (Content-Type application/pdf), then
 * calls parsePaycheckPdf / ingestInvoicePdf with s3Key. PDFs only; the
 * processors check the bytes too.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { kind, sizeBytes } = req.body ?? {};
  if (!KINDS.has(kind)) return res.status(400).json({ error: "kind must be paycheck or invoice" });
  if (typeof sizeBytes === "number" && sizeBytes > MAX_FINANCE_PDF_BYTES) return res.status(400).json({ error: "PDF is larger than 20 MB" });
  const s3Key = stagingKey(kind, randomUUID());
  const expiresIn = 600;
  try {
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: "application/pdf" }), { expiresIn });
    return res.status(200).json({ uploadUrl, s3Key, expiresIn });
  } catch (err) {
    console.error("[finance upload-url] presign failed", err);
    return res.status(500).json({ error: "Could not generate upload URL" });
  }
}

export default withHomeUserAuth(handler);
