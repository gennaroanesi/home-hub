// Inbound finance email (paychecks@ / invoices@import.cristinegennaro.com):
// SES stores the raw message in the inbound bucket and the processors read
// it. This module decides whether a message may be processed at all, and
// pulls out its PDFs. Server-only (mailparser).
//
// Gate, before any parsing work or Claude call:
//   - SES verdicts (the receipt rule has scanning on): spam or virus FAIL → drop.
//   - The sender must be on FINANCE_INBOUND_ALLOWED_SENDERS (comma-separated
//     addresses, case-insensitive), and SES must vouch for the From domain:
//     DMARC pass, or DKIM / SPF pass for that same domain. Anyone can type an
//     address into From; only this ties it to who actually sent the message.
//   - Only the headers SES itself added count. SES puts them above
//     everything else, so the first Authentication-Results / X-SES-*-Verdict
//     is SES's; copies further down were written by the sender. This relies
//     on mail only arriving through the SES receipt rule (the inbound bucket
//     only accepts writes from SES).

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

/** Every value of a header, top of the message first, unfolded. */
function headerValues(mail: ParsedMail, name: string): string[] {
  return (mail.headerLines ?? [])
    .filter((h) => h.key === name)
    .map((h) => h.line.slice(h.line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim());
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
const sameDomain = (d: string, fromDomain: string) => d === fromDomain || d.endsWith(`.${fromDomain}`);

/**
 * SES's verdicts: the topmost Authentication-Results (only if SES wrote it)
 * and X-SES-*-Verdict headers. `aligned` = SES vouches for fromDomain.
 */
export function sesVerdicts(mail: ParsedMail, fromDomain: string): { spam: string; virus: string; aligned: boolean } {
  const first = (name: string) => headerValues(mail, name)[0] ?? "";
  const auth = first("authentication-results").toLowerCase();
  // SES writes SPF as "spf=pass (…) client-ip=…; envelope-from=…; helo=…;",
  // so a segment that doesn't start a new method belongs to the one before.
  const results: string[] = [];
  if (auth.startsWith("amazonses.com")) {
    for (const seg of auth.split(";").slice(1).map((r) => r.trim())) {
      if (!seg) continue;
      if (/^(spf|dkim|dmarc|arc|bimi|iprev|auth|dkim-atps)=/.test(seg)) results.push(seg);
      else if (results.length) results[results.length - 1] += `; ${seg}`;
    }
  }
  const passFor = (method: string, prop: RegExp) =>
    results.some((r) => {
      if (!r.startsWith(`${method}=pass`)) return false;
      const m = r.match(prop);
      return !!m && sameDomain(domainOf(m[1]), fromDomain);
    });
  return {
    spam: first("x-ses-spam-verdict").toUpperCase(),
    virus: first("x-ses-virus-verdict").toUpperCase(),
    aligned:
      passFor("dmarc", /header\.from=(\S+)/) ||
      passFor("dkim", /header\.[id]=@?(\S+)/) ||
      passFor("spf", /(?:smtp\.mailfrom|envelope-from)=([^\s;]+)/),
  };
}

export function gateMail(mail: ParsedMail, allowed: Set<string>): Gate {
  const from = (mail.from?.value?.[0]?.address ?? "").toLowerCase() || null;
  if (headerValues(mail, "from").length > 1 || (mail.from?.value?.length ?? 0) > 1) {
    return { ok: false, reason: "more than one From address", from };
  }
  const v = sesVerdicts(mail, from ? domainOf(from) : "");
  if (v.virus === "FAIL") return { ok: false, reason: "virus verdict FAIL", from };
  if (v.spam === "FAIL") return { ok: false, reason: "spam verdict FAIL", from };
  if (!from) return { ok: false, reason: "no From address", from };
  if (allowed.size === 0) return { ok: false, reason: "FINANCE_INBOUND_ALLOWED_SENDERS is empty", from };
  if (!allowed.has(from)) return { ok: false, reason: `sender ${from} not allowed`, from };
  if (!v.aligned) return { ok: false, reason: `SES didn't verify ${domainOf(from)} (no DMARC, or DKIM/SPF pass for it)`, from };
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
