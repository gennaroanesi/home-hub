// Where finance PDFs live in HOME_HUB_BUCKET, shared by the processors and
// the /api/finance routes. Everything sits under home/finance/ so the
// file-serving route can refuse anything else.
//
//   home/finance/staging/<kind>/<uuid>.pdf     page uploads, before parsing
//   home/finance/paychecks/<id>.pdf            a paystub (inbox or saved)
//   home/finance/invoices/<id>/invoice.pdf     an invoice facsimile
//   home/finance/invoices/<id>/original.eml    the email it came in

export const FINANCE_PREFIX = "home/finance/";
export type FinanceUploadKind = "paycheck" | "invoice";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const stagingKey = (kind: FinanceUploadKind, uuid: string) => `${FINANCE_PREFIX}staging/${kind}/${uuid}.pdf`;
export const isStagingKey = (kind: FinanceUploadKind, key: string) => new RegExp(`^${FINANCE_PREFIX}staging/${kind}/${UUID}\\.pdf$`).test(key);
export const paycheckPdfKey = (id: string) => `${FINANCE_PREFIX}paychecks/${id}.pdf`;
export const invoicePdfKey = (id: string) => `${FINANCE_PREFIX}invoices/${id}/invoice.pdf`;
export const invoiceEmlKey = (id: string) => `${FINANCE_PREFIX}invoices/${id}/original.eml`;

/** A key the file route may serve: under home/finance/, no traversal. */
export function isServableFinanceKey(key: string): boolean {
  return key.startsWith(FINANCE_PREFIX) && !key.includes("..") && !key.includes("//") && /\.(pdf|eml)$/.test(key);
}

/** PDF magic bytes, so a renamed file isn't sent to Claude as a PDF. */
export function looksLikePdf(bytes: ArrayLike<number>): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

export const MAX_FINANCE_PDF_BYTES = 20 * 1024 * 1024;

/** Inbound-bucket prefixes the SES receipt rules write to. */
export const INBOUND_PREFIX = { paycheck: "paychecks/", invoice: "invoices/" } as const;
