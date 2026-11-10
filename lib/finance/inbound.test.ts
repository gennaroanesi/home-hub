import { describe, expect, it } from "vitest";
import { collectPdfs, gateMail, parseAllowedSenders, parseMail } from "./inbound-mail";
import { draftToPaycheck, matchPerson } from "./paycheck-fields";
import { autoMatchCandidates, normalizeInvoiceFields } from "./invoice-fields";
import { isServableFinanceKey, isStagingKey, looksLikePdf, stagingKey } from "./finance-files";

function eml(opts: { from: string; spam?: string; virus?: string; auth?: string; pdf?: boolean; extra?: string[] }): Buffer {
  const boundary = "XYZ";
  // SES adds its headers on top; anything the sender wrote comes after.
  const headers = [
    opts.auth !== undefined ? `Authentication-Results: amazonses.com; ${opts.auth}` : null,
    opts.spam ? `X-SES-Spam-Verdict: ${opts.spam}` : null,
    opts.virus ? `X-SES-Virus-Verdict: ${opts.virus}` : null,
    ...(opts.extra ?? []),
    `From: Someone <${opts.from}>`,
    "To: paychecks@import.cristinegennaro.com",
    "Subject: Pay stub",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);
  const parts = [`--${boundary}`, "Content-Type: text/plain", "", "See attached.", ""];
  if (opts.pdf) {
    parts.push(`--${boundary}`, 'Content-Type: application/pdf; name="stub.pdf"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="stub.pdf"', "", Buffer.from("%PDF-1.4 fake").toString("base64"), "");
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from([...headers, "", ...parts].join("\r\n"));
}

const allowed = parseAllowedSenders(" Gennaro@example.com, cris@example.com ,junk");

describe("inbound gate", () => {
  it("parses the allow list case-insensitively and ignores junk", () => {
    expect([...allowed]).toEqual(["gennaro@example.com", "cris@example.com"]);
  });

  const reason = async (o: Parameters<typeof eml>[0], list = allowed) => {
    const g = gateMail(await parseMail(eml(o)), list);
    return g.ok ? "ok" : g.reason;
  };

  it("accepts an allowed sender when SES vouches for their domain", async () => {
    const mail = await parseMail(eml({ from: "GENNARO@example.com", auth: "spf=pass smtp.mailfrom=bounce@example.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com", spam: "PASS", virus: "PASS", pdf: true }));
    expect(gateMail(mail, allowed)).toEqual({ ok: true, from: "gennaro@example.com" });
    expect((await collectPdfs(mail)).map((a) => a.filename)).toEqual(["stub.pdf"]);
    // Any one aligned pass is enough, including a subdomain.
    expect(await reason({ from: "cris@example.com", auth: "dmarc=pass header.from=example.com" })).toBe("ok");
    expect(await reason({ from: "cris@example.com", auth: "dkim=pass header.d=mail.example.com" })).toBe("ok");
    expect(await reason({ from: "cris@example.com", auth: "spf=pass smtp.mailfrom=example.com" })).toBe("ok");
  });

  it("reads SES's own SPF format (envelope-from in a later segment)", async () => {
    const ses = (from: string) => `spf=pass (spfCheck: domain of ${from} designates 192.0.2.1 as permitted sender) client-ip=192.0.2.1; envelope-from=bounce@${from}; helo=mail.${from}; dkim=fail; dmarc=none`;
    expect(await reason({ from: "cris@example.com", auth: ses("example.com") })).toBe("ok");
    expect(await reason({ from: "cris@example.com", auth: ses("evil.test") })).toMatch(/didn't verify/);
  });

  it("drops unknown senders, unverified mail, virus/spam FAIL, and everything when the list is empty", async () => {
    expect(await reason({ from: "stranger@example.com", auth: "dkim=pass header.i=@example.com" })).toMatch(/not allowed/);
    expect(await reason({ from: "cris@example.com", auth: "spf=fail; dkim=fail; dmarc=fail" })).toMatch(/didn't verify/);
    expect(await reason({ from: "cris@example.com" })).toMatch(/didn't verify/);
    expect(await reason({ from: "cris@example.com", auth: "dkim=pass header.i=@example.com", virus: "FAIL" })).toMatch(/virus/);
    expect(await reason({ from: "cris@example.com", auth: "dkim=pass header.i=@example.com", spam: "FAIL" })).toMatch(/spam/);
    expect(await reason({ from: "cris@example.com", auth: "dkim=pass header.i=@example.com" }, new Set())).toMatch(/empty/);
  });

  it("doesn't accept a pass for some other domain", async () => {
    // An attacker's own domain passes SPF/DKIM, with our address in From.
    expect(await reason({ from: "cris@example.com", auth: "spf=pass smtp.mailfrom=evil.test; dkim=pass header.i=@evil.test; dmarc=fail header.from=example.com" })).toMatch(/didn't verify/);
    expect(await reason({ from: "cris@example.com", auth: "dkim=pass header.i=@notexample.com" })).toMatch(/didn't verify/);
  });

  it("ignores verdict headers the sender wrote themselves", async () => {
    const forged = ["Authentication-Results: amazonses.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com", "X-SES-Virus-Verdict: PASS", "X-SES-Spam-Verdict: PASS"];
    expect(await reason({ from: "cris@example.com", auth: "spf=fail; dkim=fail; dmarc=fail header.from=example.com", extra: forged })).toMatch(/didn't verify/);
    expect(await reason({ from: "cris@example.com", auth: "dkim=pass header.i=@example.com", virus: "FAIL", extra: forged })).toMatch(/virus/);
    // Only an amazonses.com header counts. (Mail only reaches us through SES,
    // which always adds its own on top, so a sender's copy is never first.)
    expect(await reason({ from: "cris@example.com", extra: ["Authentication-Results: mx.evil.test; dmarc=pass header.from=example.com"] })).toMatch(/didn't verify/);
  });

  it("refuses a second From line", async () => {
    expect(await reason({ from: "stranger@evil.test", auth: "dkim=pass header.i=@evil.test", extra: ["From: cris@example.com"] })).toMatch(/more than one From/);
  });
});

describe("paycheck drafts", () => {
  const people = [
    { id: "g", name: "Gennaro" },
    { id: "c", name: "Cristine" },
  ];
  it("matches the employee to a household member by name, first name or close spelling", () => {
    expect(matchPerson(people, "Gennaro Anesi")?.id).toBe("g");
    expect(matchPerson(people, "ANESI, CRISTINE M")?.id).toBe("c");
    expect(matchPerson(people, "Cristina Anesi")?.id).toBe("c");
    expect(matchPerson(people, "John Smith")).toBeNull();
    expect(matchPerson(people, null)).toBeNull();
  });

  it("keeps known fields and serializes line items", () => {
    expect(draftToPaycheck({ employeeName: "x", payDate: "2026-11-01", gross: 5000, net: 3500, junk: 1, lineItems: [{ name: "ESPP", amount: 100, type: "POSTTAX" }] })).toEqual({
      payDate: "2026-11-01",
      gross: 5000,
      net: 3500,
      lineItems: JSON.stringify([{ name: "ESPP", amount: 100, type: "POSTTAX" }]),
    });
  });
});

describe("invoices", () => {
  it("normalizes model output and drops bad values", () => {
    expect(normalizeInvoiceFields({ vendor: " ABC Plumbing ", total: 450, issueDate: "11/02/2026", items: "nope" })).toMatchObject({ vendor: "ABC Plumbing", total: 450, issueDate: null, items: [] });
  });

  it("matches the payment within the date window and a cent of the total", () => {
    const txs = [
      { id: "a", date: "2026-11-03", amount: -450 },
      { id: "b", date: "2026-11-20", amount: -450 },
      { id: "c", date: "2026-11-04", amount: -450.5 },
      { id: "d", date: "2026-10-30", amount: -450.01 },
    ];
    expect(autoMatchCandidates(txs, "2026-11-01", 450).map((t) => t.id)).toEqual(["a", "d"]);
  });
});

describe("finance files", () => {
  it("only serves PDFs and emails under home/finance, and only accepts our staging keys", () => {
    expect(isServableFinanceKey("home/finance/paychecks/abc.pdf")).toBe(true);
    expect(isServableFinanceKey("home/documents/passport.pdf")).toBe(false);
    expect(isServableFinanceKey("home/finance/../documents/passport.pdf")).toBe(false);
    const key = stagingKey("paycheck", "0b4f7d1e-1c2a-4d3b-9e8f-123456789abc");
    expect(isStagingKey("paycheck", key)).toBe(true);
    expect(isStagingKey("invoice", key)).toBe(false);
    expect(looksLikePdf(Buffer.from("%PDF-1.7"))).toBe(true);
    expect(looksLikePdf(Buffer.from("PK\x03\x04"))).toBe(false);
  });
});
