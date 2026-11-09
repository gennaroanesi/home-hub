// Invoice helpers safe for the browser (no SDK imports): field
// normalization and the transaction auto-match rule. The Claude extraction
// is invoice-extract.ts (server-only).

export type InvoiceFields = {
  vendor: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  category: string | null;
  items: unknown[];
};

export function normalizeInvoiceFields(parsed: any): InvoiceFields { // eslint-disable-line @typescript-eslint/no-explicit-any
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return {
    vendor: str(parsed?.vendor),
    invoiceNumber: str(parsed?.invoiceNumber),
    issueDate: date(parsed?.issueDate),
    dueDate: date(parsed?.dueDate),
    currency: str(parsed?.currency),
    subtotal: num(parsed?.subtotal),
    tax: num(parsed?.tax),
    total: num(parsed?.total),
    category: str(parsed?.category),
    items: Array.isArray(parsed?.items) ? parsed.items : [],
  };
}

/**
 * The one transaction an invoice was paid with: dated within
 * [issueDate − 2d, issueDate + 10d] (or around the due date) with |amount|
 * within $0.01 of the total. Zero or several candidates → null (the page
 * offers them for a person to pick).
 */
export function autoMatchCandidates<T extends { date?: string | null; amount?: number | null }>(txs: T[], issueOrDue: string, total: number): T[] {
  const lo = shift(issueOrDue, -2);
  const hi = shift(issueOrDue, 10);
  return txs.filter((t) => t.date && t.date >= lo && t.date <= hi && Math.abs(Math.abs(t.amount ?? 0) - Math.abs(total)) <= 0.01);
}

function shift(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
