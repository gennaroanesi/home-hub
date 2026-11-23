// paycheck-processor — emailed paystubs → homePaycheckInbox (review queue),
// and the parsePaycheckPdf mutation for uploads. See resource.ts.
//
// Per email: gate (SES verdicts, allowed sender with DKIM/SPF pass) → every
// PDF (incl. forwarded-as-attachment) → Claude extraction, which returns
// every stub in the PDF (Workday batches several, one per page) → per stub:
// skip one already in the inbox (sha256 of the file, or of file + pages for
// a cut) or already saved (same person + pay date + net) → match the
// employee to a household member → store that stub's pages as its own PDF
// under home/finance/paychecks/ → NEEDS_REVIEW (or ERROR) inbox row. A
// single-page PDF seen before skips the Claude call; a batch goes through
// again so a re-sent one still yields what was missed. One bad PDF never
// fails the batch: a throw would make S3 retry the whole email.

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import type { S3Event } from "aws-lambda";
import type { Attachment } from "mailparser";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/paycheck-processor";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../lib/list-all.js";
import { financePeople } from "../../../lib/finance/ledger.js";
import { collectPdfs, gateMail, parseAllowedSenders, parseMail } from "../../../lib/finance/inbound-mail.js";
import { extractPaycheckDrafts, matchPerson, type ExtractedPayslip } from "../../../lib/finance/paycheck-extract.js";
import { pdfPageCount, pdfPages } from "../../../lib/finance/pdf-pages.js";
import { extractLoanSchedule } from "../../../lib/finance/loan-schedule-extract.js";
import { INBOUND_PREFIX, isStagingKey, looksLikePdf, MAX_FINANCE_PDF_BYTES, paycheckPdfKey, stagingKey } from "../../../lib/finance/finance-files.js";

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
  if (field === "parsePaycheckPdf") return parseUploaded(String(event.arguments?.s3Key ?? ""));
  if (field === "parseLoanSchedulePdf") return parseLoanSchedule(String(event.arguments?.s3Key ?? ""));
  return handleS3(event as S3Event);
};

/** A lender's amortization / payment-history PDF → rows for import_loan_payments. */
async function parseLoanSchedule(s3Key: string) {
  if (!isStagingKey("loan", s3Key)) return { ok: false, error: "s3Key must come from /api/finance/upload-url (kind loan)" };
  let pdf: Buffer;
  try {
    pdf = await readObject(HOME_BUCKET, s3Key);
  } catch {
    return { ok: false, error: "Nothing uploaded at that key yet" };
  }
  if (!looksLikePdf(pdf)) return { ok: false, error: "That file isn't a PDF" };
  if (pdf.byteLength > MAX_FINANCE_PDF_BYTES) return { ok: false, error: "PDF is larger than 20 MB" };
  const { schedule, error } = await extractLoanSchedule(pdf);
  if (error || !schedule) return { ok: false, error: error ?? "No rows extracted", s3Key };
  return { ok: true, schedule, s3Key };
}

// ── Upload path ─────────────────────────────────────────────────────────────

async function parseUploaded(s3Key: string) {
  if (!isStagingKey("paycheck", s3Key)) return { ok: false, error: "s3Key must come from /api/finance/upload-url (kind paycheck)" };
  let pdf: Buffer;
  try {
    pdf = await readObject(HOME_BUCKET, s3Key);
  } catch {
    return { ok: false, error: "Nothing uploaded at that key yet" };
  }
  if (!looksLikePdf(pdf)) return { ok: false, error: "That file isn't a PDF" };
  if (pdf.byteLength > MAX_FINANCE_PDF_BYTES) return { ok: false, error: "PDF is larger than 20 MB" };
  const { drafts, error } = await extractPaycheckDrafts(pdf);
  if (error || !drafts.length) return { ok: false, error: error ?? "No data extracted", s3Key };
  const client = await getClient();
  const people = financePeople(await listAllPages<any>(client.models.homePerson));
  // One entry per stub in the file. A stub that is only some of the pages
  // gets its own staging PDF, so the saved row points at that stub alone.
  const out = [];
  for (const { draft, pages } of drafts) {
    let key = s3Key;
    if (pages.length) {
      key = stagingKey("paycheck", randomUUID());
      await s3.send(new PutObjectCommand({ Bucket: HOME_BUCKET, Key: key, Body: await pdfPages(pdf, pages), ContentType: "application/pdf" }));
    }
    const person = matchPerson(people, draft.employeeName);
    const duplicateOf = person ? await findSaved(client, person.id, draft) : null;
    out.push({ draft, pages, personId: person?.id ?? null, s3Key: key, duplicateOf });
  }
  // draft / personId / duplicateOf are the first stub, for callers that expect one.
  return { ok: true, drafts: out, s3Key, draft: out[0].draft, personId: out[0].personId, duplicateOf: out[0].duplicateOf };
}

/** An already-saved paycheck with the same person + pay date + net. */
async function findSaved(client: DataClient, personId: string, draft: Record<string, unknown>): Promise<string | null> {
  if (typeof draft.payDate !== "string" || typeof draft.net !== "number") return null;
  const rows = await listAllPages<any>(client.models.homePaycheck, { filter: { personId: { eq: personId }, payDate: { eq: draft.payDate } } });
  return rows.find((r) => Math.abs((r.net ?? 0) - (draft.net as number)) < 0.005)?.id ?? null;
}

// ── Email path ──────────────────────────────────────────────────────────────

async function handleS3(event: S3Event) {
  let processed = 0;
  let failed = 0;
  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name;
    const key = decodeURIComponent((record.s3?.object?.key ?? "").replace(/\+/g, " "));
    if (!bucket || !key || !key.startsWith(INBOUND_PREFIX.paycheck)) continue;
    if (key.endsWith("AMAZON_SES_SETUP_NOTIFICATION")) continue;
    try {
      await processEmail(bucket, key);
      processed++;
    } catch (err) {
      console.error(`[paycheck-processor] s3://${bucket}/${key} failed:`, err);
      failed++;
    }
  }
  return { ok: failed === 0, processed, failed };
}

async function processEmail(bucket: string, key: string) {
  const mail = await parseMail(await readObject(bucket, key));
  const gate = gateMail(mail, parseAllowedSenders(process.env.FINANCE_INBOUND_ALLOWED_SENDERS));
  if (!gate.ok) {
    // Dropped before any Claude call; nothing is stored beyond the raw email
    // the bucket's lifecycle rule expires.
    console.warn(`[paycheck-processor] dropped ${key}: ${gate.reason}`);
    return;
  }
  const client = await getClient();
  const meta = {
    emailFrom: gate.from,
    emailSubject: mail.subject ?? null,
    receivedAt: (mail.date ?? new Date()).toISOString(),
  };
  const pdfs = await collectPdfs(mail);
  if (pdfs.length === 0) {
    const r = await client.models.homePaycheckInbox.create({ ...meta, status: "ERROR", parseError: "No PDF attached. Forward the paystub PDF itself." });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    return;
  }
  const people = financePeople(await listAllPages<any>(client.models.homePerson));
  for (const pdf of pdfs) {
    try {
      await processPdf(client, people, pdf, meta);
    } catch (err) {
      console.error(`[paycheck-processor] PDF "${pdf.filename ?? "?"}" failed, continuing:`, err);
    }
  }
}

/** The inbox row already holding this content, if any. */
async function inInbox(client: DataClient, contentHash: string): Promise<string | null> {
  const rows = await listAllPages<any>(client.models.homePaycheckInbox, { filter: { contentHash: { eq: contentHash } } });
  return rows[0]?.id ?? null;
}

async function processPdf(client: DataClient, people: Array<{ id: string; name: string }>, pdf: Attachment, meta: { emailFrom: string; emailSubject: string | null; receivedAt: string }) {
  const bytes = pdf.content;
  const fileHash = sha256(bytes);
  const pageCount = await pdfPageCount(bytes).catch(() => 1);
  if (pageCount <= 1) {
    const seen = await inInbox(client, fileHash);
    if (seen) {
      console.log(`[paycheck-processor] already in the inbox (${seen}); skipping`);
      return;
    }
  }
  const { drafts, error } = await extractPaycheckDrafts(bytes);
  if (error || !drafts.length) {
    if (await inInbox(client, fileHash)) return;
    await storeInbox(client, { bytes, contentHash: fileHash, filename: pdf.filename || "paystub.pdf", meta, draft: null, person: null, error: error ?? "No pay stub found in the PDF" });
    return;
  }
  for (const { draft, pages } of drafts) {
    // A stub that is only some of the pages is stored as its own cut; its
    // hash is of the file plus the pages, since a cut's bytes aren't stable.
    const contentHash = pages.length ? sha256(Buffer.from(`${fileHash}#${pages.join(",")}`)) : fileHash;
    const seen = await inInbox(client, contentHash);
    if (seen) {
      console.log(`[paycheck-processor] ${draft.payDate ?? "?"} (pages ${pages.join(",") || "all"}) already in the inbox (${seen}); skipping`);
      continue;
    }
    const person = matchPerson(people, draft.employeeName);
    if (person && (await findSaved(client, person.id, draft))) {
      console.log(`[paycheck-processor] ${person.name} ${draft.payDate} already saved; skipping`);
      continue;
    }
    let stub = bytes;
    try {
      if (pages.length) stub = await pdfPages(bytes, pages);
    } catch (err) {
      console.warn(`[paycheck-processor] couldn't cut pages ${pages.join(",")}; storing the whole file:`, err);
    }
    const base = (pdf.filename || "paystub.pdf").replace(/\.pdf$/i, "");
    const filename = pages.length ? `${base} (p${pages.join("-")}).pdf` : `${base}.pdf`;
    await storeInbox(client, { bytes: stub, contentHash, filename, meta, draft, person, error: null, pages });
  }
}

async function storeInbox(
  client: DataClient,
  args: {
    bytes: Buffer;
    contentHash: string;
    filename: string;
    meta: { emailFrom: string; emailSubject: string | null; receivedAt: string };
    draft: ExtractedPayslip["draft"] | null;
    person: { id: string; name: string } | null;
    error: string | null;
    pages?: number[];
  },
) {
  const { bytes, draft, person, error } = args;
  const id = randomUUID();
  const s3KeyPdf = paycheckPdfKey(id);
  await s3.send(new PutObjectCommand({ Bucket: HOME_BUCKET, Key: s3KeyPdf, Body: bytes, ContentType: "application/pdf" }));
  const r = await client.models.homePaycheckInbox.create({
    id,
    ...args.meta,
    draft: draft ? JSON.stringify(draft) : null,
    personId: person?.id ?? null,
    s3KeyPdf,
    filename: args.filename,
    sizeBytes: bytes.byteLength,
    contentHash: args.contentHash,
    status: error ? "ERROR" : "NEEDS_REVIEW",
    parseError: error ?? (person ? null : `Couldn't tell whose stub this is (${draft?.employeeName ?? "no name found"}); pick the person when reviewing.`),
  });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  console.log(`[paycheck-processor] inbox ${id} ${error ? "ERROR" : "NEEDS_REVIEW"} ${person?.name ?? "?"} ${draft?.payDate ?? "?"}${args.pages?.length ? ` pages ${args.pages.join(",")}` : ""}`);
}
