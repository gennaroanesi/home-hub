// Invoice list filters, totals, the detail form and the payment search,
// shared by the web (pages/finance/invoices.tsx,
// components/finance/invoice-detail-modal.tsx) and the phone's Invoices
// screen so both behave the same. Pure.

import { addDays } from "./dates";
import { autoMatchCandidates } from "./invoice-fields";
import { invoiceOwnedBy, invoiceVisibleTo } from "./invoice-owner";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const INVOICE_INBOX = "invoices@import.cristinegennaro.com";

export type InvoiceStatusFilter = "all" | "review" | "parsed";
export type InvoicePaidFilter = "all" | "unpaid" | "paid";

const STATUS_RANK: Record<string, number> = { ERROR: 0, NEEDS_REVIEW: 1, PARSED: 2 };

/** The date an invoice sorts and files under: issue date, else when it arrived. */
export const invoiceDate = (inv: any): string => inv.issueDate ?? inv.receivedAt?.slice(0, 10) ?? inv.createdAt?.slice(0, 10) ?? "";

export const invoiceIsPaid = (inv: { id: string; paid?: boolean | null }, linkedIds: Set<string>) => !!inv.paid || linkedIds.has(inv.id);

/** Years with an invoice, newest first. */
export function invoiceYears(invoices: any[]): string[] {
  return [...new Set(invoices.map((i) => invoiceDate(i).slice(0, 4)).filter(Boolean))].sort().reverse();
}

/**
 * Filtered and sorted like the web list: ones to fix first, then newest.
 * `viewer` (a person id) is who's looking: another member's private invoices
 * are left out (lib/finance/invoice-owner.ts). `owner` narrows to a person's
 * invoices plus the household's.
 */
export function filterInvoices<I extends { id: string }>(
  invoices: I[],
  linkedIds: Set<string>,
  f: { status: InvoiceStatusFilter; paid: InvoicePaidFilter; year: string; query: string; viewer: string | null; owner?: string },
): I[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return invoices
    .filter((inv: any) => {
      if (!invoiceVisibleTo(inv, f.viewer)) return false;
      if (!invoiceOwnedBy(inv, f.owner)) return false;
      if (f.status === "review" && inv.parseStatus === "PARSED") return false;
      if (f.status === "parsed" && inv.parseStatus !== "PARSED") return false;
      const isPaid = invoiceIsPaid(inv, linkedIds);
      if (f.paid === "paid" && !isPaid) return false;
      if (f.paid === "unpaid" && isPaid) return false;
      if (f.year !== "all" && invoiceDate(inv).slice(0, 4) !== f.year) return false;
      const hay = `${inv.vendor ?? ""} ${inv.invoiceNumber ?? ""} ${inv.category ?? ""} ${inv.notes ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a: any, b: any) => (STATUS_RANK[a.parseStatus ?? "PARSED"] ?? 2) - (STATUS_RANK[b.parseStatus ?? "PARSED"] ?? 2) || invoiceDate(b).localeCompare(invoiceDate(a)));
}

export function invoiceTotals(shown: any[], linkedIds: Set<string>): { sum: number; unpaid: number; review: number } {
  let sum = 0;
  let unpaid = 0;
  let review = 0;
  for (const inv of shown) {
    const t = inv.total ?? 0;
    sum += t;
    if (!invoiceIsPaid(inv, linkedIds)) unpaid += t;
    if (inv.parseStatus !== "PARSED") review++;
  }
  return { sum, unpaid, review };
}

// ── Detail form ─────────────────────────────────────────────────────────────

export type InvoiceItem = { description: string; qty: number | null; unitPrice: number | null; amount: number | null };

export function parseInvoiceItems(raw: unknown): InvoiceItem[] {
  if (!raw) return [];
  try {
    let v: unknown = raw;
    while (typeof v === "string") v = JSON.parse(v);
    if (!Array.isArray(v)) return [];
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
    return v.map((it: any) => ({ description: String(it?.description ?? ""), qty: num(it?.qty), unitPrice: num(it?.unitPrice), amount: num(it?.amount) }));
  } catch {
    return [];
  }
}

/**
 * A line item as typed in the editor: numbers stay text until save, so "12."
 * or "12.0" on the way to "12.05" isn't reparsed away mid-typing.
 */
export type InvoiceItemDraft = { description: string; qty: string; unitPrice: string; amount: string };

export const EMPTY_INVOICE_ITEM: InvoiceItemDraft = { description: "", qty: "", unitPrice: "", amount: "" };

export type InvoiceForm = {
  ownerPersonIds: string[];
  private: boolean;
  vendor: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  category: string;
  spendGroupId: string;
  paid: boolean;
  notes: string;
  items: InvoiceItemDraft[];
};

const toStr = (n: number | null | undefined) => (n == null ? "" : String(n));

/** "$1,234.50" → 1234.5; blank or junk → null. */
export function invoiceNum(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function invoiceForm(inv: any): InvoiceForm {
  return {
    ownerPersonIds: (inv.ownerPersonIds ?? []).filter(Boolean),
    private: !!inv.private,
    vendor: inv.vendor ?? "",
    invoiceNumber: inv.invoiceNumber ?? "",
    issueDate: inv.issueDate ?? "",
    dueDate: inv.dueDate ?? "",
    currency: inv.currency ?? "USD",
    subtotal: toStr(inv.subtotal),
    tax: toStr(inv.tax),
    total: toStr(inv.total),
    category: inv.category ?? "",
    spendGroupId: inv.spendGroupId ?? "",
    paid: !!inv.paid,
    notes: inv.notes ?? "",
    items: parseInvoiceItems(inv.items).map((it) => ({ description: it.description, qty: toStr(it.qty), unitPrice: toStr(it.unitPrice), amount: toStr(it.amount) })),
  };
}

/** What the form's line items add up to. */
export const invoiceItemsSum = (items: InvoiceItemDraft[]): number => items.reduce((s, it) => s + (invoiceNum(it.amount) ?? 0), 0);

/** The homeInvoice fields to write from the form (items JSON for the AWSJSON field). */
export function invoiceUpdate(form: InvoiceForm): Record<string, unknown> {
  const items: InvoiceItem[] = form.items
    .map((it) => ({ description: it.description.trim(), qty: invoiceNum(it.qty), unitPrice: invoiceNum(it.unitPrice), amount: invoiceNum(it.amount) }))
    .filter((it) => it.description || it.amount != null);
  return {
    ownerPersonIds: form.ownerPersonIds,
    // No owner, nobody to keep it private for (invoiceOwnerError warns first).
    private: form.private && form.ownerPersonIds.length > 0,
    vendor: form.vendor.trim() || null,
    invoiceNumber: form.invoiceNumber.trim() || null,
    issueDate: form.issueDate || null,
    dueDate: form.dueDate || null,
    currency: form.currency.trim().toUpperCase() || "USD",
    subtotal: invoiceNum(form.subtotal),
    tax: invoiceNum(form.tax),
    total: invoiceNum(form.total),
    category: form.category.trim() || null,
    spendGroupId: form.spendGroupId || null,
    paid: form.paid,
    notes: form.notes.trim() || null,
    items: items.length ? JSON.stringify(items) : null,
  };
}

/** The date a payment search centers on: issue date, else due date. */
export const invoiceAnchor = (form: Pick<InvoiceForm, "issueDate" | "dueDate">): string | null => form.issueDate || form.dueDate || null;

/** The window of transactions to load for a payment search. */
export const paymentSearchRange = (anchor: string) => ({ fromIso: addDays(anchor, -30), toIso: addDays(anchor, 30) });

/**
 * Transactions that could have paid it, from those loaded over
 * paymentSearchRange: the auto-match rule's exact ones, then anything
 * within 5% of the total (closest first). Already linked ones are left out.
 */
export function paymentCandidates<T extends { id: string; date?: string | null; amount?: number | null }>(
  txs: T[],
  anchor: string,
  total: number,
  linkedTxIds: Set<string>,
): { exact: T[]; loose: T[] } {
  const pool = txs.filter((t) => !linkedTxIds.has(t.id));
  const exact = autoMatchCandidates(pool, anchor, total);
  const exactIds = new Set(exact.map((t) => t.id));
  const off = (t: T) => Math.abs(Math.abs(t.amount ?? 0) - Math.abs(total));
  const loose = pool.filter((t) => !exactIds.has(t.id) && Math.abs(total) > 0 && off(t) / Math.abs(total) <= 0.05).sort((a, b) => off(a) - off(b));
  return { exact, loose };
}
