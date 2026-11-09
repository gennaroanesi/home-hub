// Inbound finance email (paychecks@ / invoices@import.cristinegennaro.com):
// SES stores the raw message in the inbound bucket and the processors read
// it. This module decides whether a message may be processed at all, and
// pulls out its PDFs. Server-only (mailparser).
//
// Gate, before any parsing work or Claude call:
//   - SES verdicts (the receipt rule has scanning on): spam or virus FAIL → drop.
//   - The sender must be on FINANCE_INBOUND_ALLOWED_SENDERS (comma-separated
//     addresses, case-insensitive) AND SES must have seen DKIM or SPF pass
//     for the message, so a forged From header isn't enough.

import { simpleParser, type Attachment, type ParsedMail } from "mailparser";

export type Gate = { ok: true; from: string } | { ok: false; reason: string; from: string | null };

export function parseAllowedSenders(env: string | undefined): Set<string> {
  return new Set(
    (env ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );
}

function header(mail: ParsedMail, name: string): string {
  const v = mail.headers.get(name.toLowerCase());
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(" ");
  return typeof v === "object" && "text" in (v as object) ? String((v as { text: string }).text) : String(v);
}

/** SES's own verdicts, from the headers it adds when scanning is on. */
export function sesVerdicts(mail: ParsedMail): { spam: string; virus: string; dkim: boolean; spf: boolean } {
  const auth = header(mail, "authentication-results").toLowerCase();
  return {
    spam: header(mail, "x-ses-spam-verdict").toUpperCase(),
    virus: header(mail, "x-ses-virus-verdict").toUpperCase(),
    dkim: /\bdkim=pass\b/.test(auth),
    spf: /\bspf=pass\b/.test(auth),
  };
}

export function gateMail(mail: ParsedMail, allowed: Set<string>): Gate {
  const from = (mail.from?.value?.[0]?.address ?? "").toLowerCase() || null;
  const v = sesVerdicts(mail);
  if (v.virus === "FAIL") return { ok: false, reason: "virus verdict FAIL", from };
  if (v.spam === "FAIL") return { ok: false, reason: "spam verdict FAIL", from };
  if (!from) return { ok: false, reason: "no From address", from };
  if (allowed.size === 0) return { ok: false, reason: "FINANCE_INBOUND_ALLOWED_SENDERS is empty", from };
  if (!allowed.has(from)) return { ok: false, reason: `sender ${from} not allowed`, from };
  if (!v.dkim && !v.spf) return { ok: false, reason: `no DKIM/SPF pass for ${from}`, from };
  return { ok: true, from };
}

export function isPdfAttachment(a: { contentType?: string; filename?: string }): boolean {
  if ((a.contentType ?? "").toLowerCase() === "application/pdf") return true;
  return (a.filename ?? "").toLowerCase().endsWith(".pdf");
}

export async function parseMail(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw);
}

/** Every PDF in the message, including inside forwarded-as-attachment messages. */
export async function collectPdfs(mail: ParsedMail): Promise<Attachment[]> {
  const pdfs: Attachment[] = [];
  async function walk(m: ParsedMail, depth: number): Promise<void> {
    for (const a of m.attachments ?? []) {
      if (isPdfAttachment(a)) pdfs.push(a);
      else if ((a.contentType ?? "").toLowerCase() === "message/rfc822" && depth < 3) await walk(await simpleParser(a.content), depth + 1);
    }
  }
  await walk(mail, 0);
  return pdfs;
}

/**
 * The separate emails inside a forward: Gmail's "forward as attachment"
 * nests originals as message/rfc822 (several when multi-selected). The
 * wrapper only counts when it has PDFs of its own.
 */
export async function collectEmailSources(mail: ParsedMail): Promise<ParsedMail[]> {
  const sources: ParsedMail[] = [];
  async function walk(m: ParsedMail, depth: number): Promise<void> {
    const nested = (m.attachments ?? []).filter((a) => (a.contentType ?? "").toLowerCase() === "message/rfc822");
    if (nested.length === 0 || depth >= 3) {
      sources.push(m);
      return;
    }
    if ((m.attachments ?? []).some(isPdfAttachment)) sources.push(m);
    for (const n of nested) await walk(await simpleParser(n.content), depth + 1);
  }
  await walk(mail, 0);
  return sources;
}

/** JSON out of a model reply, tolerating ```json fences. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fence ? fence[1].trim() : trimmed);
}
