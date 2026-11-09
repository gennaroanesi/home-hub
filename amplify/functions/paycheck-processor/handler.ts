// paycheck-processor — emailed paystubs → homePaycheckInbox (review queue),
// and the parsePaycheckPdf mutation for uploads. See resource.ts.
//
// Per email: gate (SES verdicts, allowed sender with DKIM/SPF pass) → every
// PDF (incl. forwarded-as-attachment) → skip a PDF already in the inbox
// (sha256) → Claude extraction → match the employee to a household member →
// skip a stub already saved (same person + pay date + net) → store the PDF
// under home/finance/paychecks/ → NEEDS_REVIEW (or ERROR) inbox row.
// One bad PDF never fails the batch: a throw would make S3 retry the whole
// email.

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
import { householdMembers } from "../../../lib/household.js";
import { collectPdfs, gateMail, parseAllowedSenders, parseMail } from "../../../lib/finance/inbound-mail.js";
import { extractPaycheckFields, matchPerson } from "../../../lib/finance/paycheck-extract.js";
import { INBOUND_PREFIX, isStagingKey, looksLikePdf, MAX_FINANCE_PDF_BYTES, paycheckPdfKey } from "../../../lib/finance/finance-files.js";

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
  return handleS3(event as S3Event);
};

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
  const { draft, error } = await extractPaycheckFields(pdf);
  if (error || !draft) return { ok: false, error: error ?? "No data extracted", s3Key };
  const client = await getClient();
  const people = householdMembers(await listAllPages<any>(client.models.homePerson));
  const person = matchPerson(people, draft.employeeName);
  const duplicate = person ? await findSaved(client, person.id, draft) : null;
  return { ok: true, draft, personId: person?.id ?? null, s3Key, duplicateOf: duplicate };
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
  const people = householdMembers(await listAllPages<any>(client.models.homePerson));
  for (const pdf of pdfs) {
    try {
      await processPdf(client, people, pdf, meta);
    } catch (err) {
      console.error(`[paycheck-processor] PDF "${pdf.filename ?? "?"}" failed, continuing:`, err);
    }
  }
}

async function processPdf(client: DataClient, people: Array<{ id: string; name: string }>, pdf: Attachment, meta: { emailFrom: string; emailSubject: string | null; receivedAt: string }) {
  const bytes = pdf.content;
  const contentHash = sha256(bytes);
  const dupes = await listAllPages<any>(client.models.homePaycheckInbox, { filter: { contentHash: { eq: contentHash } } });
  if (dupes.length) {
    console.log(`[paycheck-processor] already in the inbox (${dupes[0].id}); skipping`);
    return;
  }
  const { draft, error } = await extractPaycheckFields(bytes);
  const person = draft ? matchPerson(people, draft.employeeName) : null;
  if (person && draft && (await findSaved(client, person.id, draft))) {
    console.log(`[paycheck-processor] ${person.name} ${draft.payDate} already saved; skipping`);
    return;
  }
  const id = randomUUID();
  const s3KeyPdf = paycheckPdfKey(id);
  await s3.send(new PutObjectCommand({ Bucket: HOME_BUCKET, Key: s3KeyPdf, Body: bytes, ContentType: "application/pdf" }));
  const r = await client.models.homePaycheckInbox.create({
    id,
    ...meta,
    draft: draft ? JSON.stringify(draft) : null,
    personId: person?.id ?? null,
    s3KeyPdf,
    filename: pdf.filename || "paystub.pdf",
    sizeBytes: bytes.byteLength,
    contentHash,
    status: error ? "ERROR" : "NEEDS_REVIEW",
    parseError: error ?? (person ? null : `Couldn't tell whose stub this is (${draft?.employeeName ?? "no name found"}); pick the person when reviewing.`),
  });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  console.log(`[paycheck-processor] inbox ${id} ${error ? "ERROR" : "NEEDS_REVIEW"} ${person?.name ?? "?"} ${draft?.payDate ?? "?"}`);
}
