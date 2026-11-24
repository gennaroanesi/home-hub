import { describe, expect, it } from "vitest";

import { filterInvoices, invoiceForm, invoiceItemsSum, invoiceTotals, invoiceUpdate, invoiceYears, parseInvoiceItems, paymentCandidates } from "./invoice-screen";

const invoices = [
  { id: "1", vendor: "Plumber Co", issueDate: "2026-03-01", total: 200, parseStatus: "PARSED", paid: true },
  { id: "2", vendor: "Electric", issueDate: "2026-05-01", total: 120, parseStatus: "PARSED" },
  { id: "3", vendor: "Roofer", receivedAt: "2025-11-02T10:00:00Z", total: 900, parseStatus: "NEEDS_REVIEW", notes: "gutters" },
  { id: "4", vendor: "Mystery", createdAt: "2026-01-01T00:00:00Z", total: null, parseStatus: "ERROR" },
];

describe("invoice list", () => {
  it("sorts errors and reviews first, then newest", () => {
    expect(filterInvoices(invoices, new Set(), { status: "all", paid: "all", year: "all", query: "" }).map((i) => i.id)).toEqual(["4", "3", "2", "1"]);
  });

  it("filters by status, paid (flag or link), year and words", () => {
    const linked = new Set(["2"]);
    expect(filterInvoices(invoices, linked, { status: "parsed", paid: "paid", year: "all", query: "" }).map((i) => i.id)).toEqual(["2", "1"]);
    expect(filterInvoices(invoices, linked, { status: "all", paid: "unpaid", year: "all", query: "" }).map((i) => i.id)).toEqual(["4", "3"]);
    expect(filterInvoices(invoices, linked, { status: "all", paid: "all", year: "2025", query: "" }).map((i) => i.id)).toEqual(["3"]);
    expect(filterInvoices(invoices, linked, { status: "all", paid: "all", year: "all", query: "GUTTERS roof" }).map((i) => i.id)).toEqual(["3"]);
  });

  it("totals and years", () => {
    expect(invoiceTotals(invoices, new Set(["2"]))).toEqual({ sum: 1220, unpaid: 900, review: 2 });
    expect(invoiceYears(invoices)).toEqual(["2026", "2025"]);
  });
});

describe("invoice detail", () => {
  it("round-trips the form", () => {
    const f = invoiceForm({ vendor: " ACME ", total: 10.5, currency: "usd", items: JSON.stringify(JSON.stringify([{ description: "Bolt", qty: "2", amount: 10.5 }, { description: "" }])) });
    expect(f.items).toEqual([
      { description: "Bolt", qty: "2", unitPrice: "", amount: "10.5" },
      { description: "", qty: "", unitPrice: "", amount: "" },
    ]);
    const u = invoiceUpdate({ ...f, total: "$1,010.50" });
    expect(u.vendor).toBe("ACME");
    expect(u.currency).toBe("USD");
    expect(u.total).toBe(1010.5);
    expect(parseInvoiceItems(u.items)).toHaveLength(1);
    expect(invoiceUpdate({ ...f, items: [] }).items).toBeNull();
  });

  it("keeps cents typed into line items", () => {
    // Mid-typing values stay as typed; they're parsed on save.
    const items = [{ description: "Labor", qty: "1.5", unitPrice: "80.", amount: "120.05" }];
    expect(invoiceItemsSum(items)).toBe(120.05);
    expect(parseInvoiceItems(invoiceUpdate({ ...invoiceForm({}), items }).items)).toEqual([{ description: "Labor", qty: 1.5, unitPrice: 80, amount: 120.05 }]);
  });

  it("finds exact and close payments, leaving out linked ones", () => {
    const txs = [
      { id: "a", date: "2026-03-03", amount: -200 },
      { id: "b", date: "2026-03-20", amount: -205 },
      { id: "c", date: "2026-03-02", amount: -200 },
      { id: "d", date: "2026-03-04", amount: -250 },
      { id: "e", date: "2026-03-05", amount: -199 },
    ];
    const r = paymentCandidates(txs, "2026-03-01", 200, new Set(["c"]));
    expect(r.exact.map((t) => t.id)).toEqual(["a"]);
    expect(r.loose.map((t) => t.id)).toEqual(["e", "b"]);
  });
});
