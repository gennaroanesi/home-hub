import { describe, expect, it } from "vitest";
import { collectPdfs, gateMail, parseAllowedSenders, parseMail } from "./inbound-mail";
import { draftToPaycheck, matchPerson } from "./paycheck-fields";
import { autoMatchCandidates, normalizeInvoiceFields } from "./invoice-fields";
import { isServableFinanceKey, isStagingKey, looksLikePdf, stagingKey } from "./finance-files";

function eml(opts: { from: string; spam?: string; virus?: string; auth?: string; pdf?: boolean }): Buffer {
  const boundary = "XYZ";
  const headers = [
    `From: Someone <${opts.from}>`,
    "To: paychecks@import.cristinegennaro.com",
    "Subject: Pay stub",
    opts.auth !== undefined ? `Authentication-Results: amazonses.com; ${opts.auth}` : null,
    opts.spam ? `X-SES-Spam-Verdict: ${opts.spam}` : null,
    opts.virus ? `X-SES-Virus-Verdict: ${opts.virus}` : null,
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

  it("accepts an allowed sender with DKIM or SPF pass and clean verdicts", async () => {
    const mail = await parseMail(eml({ from: "GENNARO@example.com", auth: "spf=pass smtp.mailfrom=example.com; dkim=pass header.i=@example.com", spam: "PASS", virus: "PASS", pdf: true }));
    expect(gateMail(mail, allowed)).toEqual({ ok: true, from: "gennaro@example.com" });
    expect((await collectPdfs(mail)).map((a) => a.filename)).toEqual(["stub.pdf"]);
  });

  it("drops unknown senders, forged From without DKIM/SPF, virus/spam FAIL, and everything when the list is empty", async () => {
    const reason = async (o: Parameters<typeof eml>[0], list = allowed) => {
      const g = gateMail(await parseMail(eml(o)), list);
      return g.ok ? "ok" : g.reason;
    };
    expect(await reason({ from: "stranger@example.com", auth: "dkim=pass" })).toMatch(/not allowed/);
    expect(await reason({ from: "cris@example.com", auth: "spf=fail; dkim=fail" })).toMatch(/no DKIM\/SPF pass/);
    expect(await reason({ from: "cris@example.com", auth: "dkim=pass", virus: "FAIL" })).toMatch(/virus/);
    expect(await reason({ from: "cris@example.com", auth: "dkim=pass", spam: "FAIL" })).toMatch(/spam/);
    expect(await reason({ from: "cris@example.com", auth: "dkim=pass" }, new Set())).toMatch(/empty/);
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
