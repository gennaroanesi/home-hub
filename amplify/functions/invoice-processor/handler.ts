// invoice-processor — emailed and uploaded invoices → homeInvoice. See
// resource.ts. Ported from gennaroanesi.com's invoiceProcessor.
//
// Per email: gate (SES verdicts, allowed sender with DKIM/SPF pass) → one
// source per forwarded message → its PDFs, or the body rendered to PDF →
// per PDF: skip identical bytes (sha256), Claude extraction, skip the same
// invoice seen before (vendor + number/date + total), store the PDF (+ raw
// email) under home/finance/invoices/<id>/, create the row, and link the
// one transaction that matches it, if exactly one does. Every source and
// PDF is isolated: a throw would make S3 retry (and re-render) the email.

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import type { S3Event } from "aws-lambda";
import type { ParsedMail } from "mailparser";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/invoice-processor";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../lib/list-all.js";
import { listTransactions } from "../../../lib/finance/data.js";
import { collectEmailSources, gateMail, isPdfAttachment, parseAllowedSenders, parseMail } from "../../../lib/finance/inbound-mail.js";
import { autoMatchCandidates, extractInvoiceFields } from "../../../lib/finance/invoice-extract.js";
import { INBOUND_PREFIX, invoiceEmlKey, invoicePdfKey, isStagingKey, looksLikePdf, MAX_FINANCE_PDF_BYTES } from "../../../lib/finance/finance-files.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const s3 = new S3Client({ region: "us-east-1" });
const HOME_BUCKET = process.env.HOME_HUB_BUCKET ?? "";

type DataClient = ReturnType<typeof generateClient<Schema>>;
let _client: DataClient | null = null;
async function getClient(): Promise<DataClient> {
  if (_client) return _client;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _client = generateClient<Schema>();
  return _client;
}

async function readObject(bucket: string, key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`S3 object has no body: ${key}`);
  const bytes = await out.Body.transformToByteArray();
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

const sha256 = (b: Buffer) => createHash("sha256").update(b as unknown as Uint8Array).digest("hex");

export const handler = async (event: any) => {
  const field: string | undefined = event?.fieldName ?? event?.info?.fieldName;
  if (field === "ingestInvoicePdf") return ingestUploaded(String(event.arguments?.s3Key ?? ""));
  return handleS3(event as S3Event);
};

// ── Upload path ─────────────────────────────────────────────────────────────

async function ingestUploaded(s3Key: string) {
  if (!isStagingKey("invoice", s3Key)) return { ok: false, error: "s3Key must come from /api/finance/upload-url (kind invoice)" };
  let pdf: Buffer;
  try {
    pdf = await readObject(HOME_BUCKET, s3Key);
  } catch {
    return { ok: false, error: "Nothing uploaded at that key yet" };
  }
  if (!looksLikePdf(pdf)) return { ok: false, error: "That file isn't a PDF" };
  if (pdf.byteLength > MAX_FINANCE_PDF_BYTES) return { ok: false, error: "PDF is larger than 20 MB" };
  const r = await ingest(await getClient(), pdf, { source: "UPLOAD" });
  return r.status === "created" ? { ok: true, invoiceId: r.id, linkedTransactionId: r.linked } : { ok: false, error: `Already have this invoice`, invoiceId: r.id };
}

// ── Email path ──────────────────────────────────────────────────────────────

async function handleS3(event: S3Event) {
  let processed = 0;
  let failed = 0;
  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name;
    const key = decodeURIComponent((record.s3?.object?.key ?? "").replace(/\+/g, " "));
    if (!bucket || !key || !key.startsWith(INBOUND_PREFIX.invoice)) continue;
    if (key.endsWith("AMAZON_SES_SETUP_NOTIFICATION")) continue;
    try {
      await processEmail(bucket, key);
      processed++;
    } catch (err) {
      console.error(`[invoice-processor] s3://${bucket}/${key} failed:`, err);
      failed++;
    }
  }
  return { ok: failed === 0, processed, failed };
}

async function processEmail(bucket: string, key: string) {
  const raw = await readObject(bucket, key);
  const mail = await parseMail(raw);
  const gate = gateMail(mail, parseAllowedSenders(process.env.FINANCE_INBOUND_ALLOWED_SENDERS));
  if (!gate.ok) {
    console.warn(`[invoice-processor] dropped ${key}: ${gate.reason}`);
    return;
  }
  const client = await getClient();
  for (const source of await collectEmailSources(mail)) {
    try {
      const attached = (source.attachments ?? []).filter(isPdfAttachment).map((a) => a.content);
      const pdfs = attached.length ? attached : [await renderBodyToPdf(source)];
      for (const pdf of pdfs) {
        try {
          const r = await ingest(client, pdf, {
            source: "EMAIL",
            raw,
            emailFrom: gate.from,
            emailSubject: source.subject ?? mail.subject ?? null,
            receivedAt: (mail.date ?? new Date()).toISOString(),
          });
          console.log(`[invoice-processor] ${r.status} ${r.id}`);
        } catch (err) {
          console.error("[invoice-processor] PDF failed, continuing:", err);
        }
      }
    } catch (err) {
      console.error(`[invoice-processor] source "${source.subject ?? "(no subject)"}" failed, continuing:`, err);
    }
  }
}

// ── HTML → PDF for emails without an attachment ─────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function renderBodyToPdf(mail: ParsedMail): Promise<Buffer> {
  const chromium = (await import("@sparticuz/chromium")).default;
  const puppeteer = (await import("puppeteer-core")).default;
  const html =
    typeof mail.html === "string" && mail.html.trim()
      ? mail.html
      : `<html><body><pre style="font-family: monospace; white-space: pre-wrap;">${escapeHtml(mail.text ?? "")}</pre></body></html>`;
  const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath() });
  try {
    const page = await browser.newPage();
    // Static facsimile: don't wait on tracking pixels.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return Buffer.from(await page.pdf({ format: "letter", printBackground: true }));
  } finally {
    await browser.close();
  }
}

// ── Shared ingest ───────────────────────────────────────────────────────────

type IngestMeta =
  | { source: "UPLOAD" }
  | { source: "EMAIL"; raw: Buffer; emailFrom: string; emailSubject: string | null; receivedAt: string };

async function ingest(client: DataClient, pdf: Buffer, meta: IngestMeta): Promise<{ status: "created" | "duplicate"; id: string; linked?: string | null }> {
  const contentHash = sha256(pdf);
  const same = await listAllPages<any>(client.models.homeInvoice, { filter: { contentHash: { eq: contentHash } } });
  if (same.length) return { status: "duplicate", id: same[0].id };

  const { fields, error } = await extractInvoiceFields(pdf);
  // Same invoice in different bytes (re-rendered email, re-exported PDF).
  if (fields?.vendor && fields.total != null) {
    const filter: any = { vendor: { eq: fields.vendor }, total: { eq: fields.total } };
    if (fields.invoiceNumber) filter.invoiceNumber = { eq: fields.invoiceNumber };
    else if (fields.issueDate) filter.issueDate = { eq: fields.issueDate };
    const seen = await listAllPages<any>(client.models.homeInvoice, { filter });
    if (seen.length) return { status: "duplicate", id: seen[0].id };
  }

  const id = randomUUID();
  const s3KeyPdf = invoicePdfKey(id);
  await s3.send(new PutObjectCommand({ Bucket: HOME_BUCKET, Key: s3KeyPdf, Body: pdf, ContentType: "application/pdf" }));
  let s3KeyOriginal: string | null = null;
  if (meta.source === "EMAIL") {
    s3KeyOriginal = invoiceEmlKey(id);
    await s3.send(new PutObjectCommand({ Bucket: HOME_BUCKET, Key: s3KeyOriginal, Body: meta.raw, ContentType: "message/rfc822" }));
  }
  const parseStatus = error ? "ERROR" : fields?.total != null ? "PARSED" : "NEEDS_REVIEW";
  const r = await client.models.homeInvoice.create({
    id,
    vendor: fields?.vendor ?? null,
    invoiceNumber: fields?.invoiceNumber ?? null,
    issueDate: fields?.issueDate ?? null,
    dueDate: fields?.dueDate ?? null,
    currency: fields?.currency ?? "USD",
    subtotal: fields?.subtotal ?? null,
    tax: fields?.tax ?? null,
    total: fields?.total ?? null,
    category: fields?.category ?? null,
    items: fields?.items.length ? JSON.stringify(fields.items) : null,
    s3KeyPdf,
    s3KeyOriginal,
    contentHash,
    source: meta.source,
    emailFrom: meta.source === "EMAIL" ? meta.emailFrom : null,
    emailSubject: meta.source === "EMAIL" ? meta.emailSubject : null,
    receivedAt: meta.source === "EMAIL" ? meta.receivedAt : new Date().toISOString(),
    parseStatus,
    parseError: error ?? (fields?.total == null ? "Total not found in the document" : null),
    paid: false,
  });
  if (r.errors?.length) throw new Error(r.errors[0].message);

  let linked: string | null = null;
  const on = fields?.issueDate ?? fields?.dueDate;
  if (fields?.total != null && on) {
    try {
      linked = await autoLink(client, id, on, fields.total);
    } catch (err) {
      console.error(`[invoice-processor] auto-match for ${id} failed:`, err);
    }
  }
  return { status: "created", id, linked };
}

/** Link the single transaction matching amount ± $0.01 near the invoice date. */
async function autoLink(client: DataClient, invoiceId: string, on: string, total: number): Promise<string | null> {
  const lo = new Date(`${on}T00:00:00Z`);
  lo.setUTCDate(lo.getUTCDate() - 2);
  const hi = new Date(`${on}T00:00:00Z`);
  hi.setUTCDate(hi.getUTCDate() + 10);
  const txs = await listTransactions(client, { fromIso: lo.toISOString().slice(0, 10), toIso: hi.toISOString().slice(0, 10) });
  const hits = autoMatchCandidates(txs, on, total);
  if (hits.length !== 1) return null;
  const r = await client.models.homeInvoiceLink.create({ invoiceId, transactionId: hits[0].id, amount: total });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  await client.models.homeInvoice.update({ id: invoiceId, paid: true });
  return hits[0].id;
}
