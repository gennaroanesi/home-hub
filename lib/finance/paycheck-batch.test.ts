import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { normalizeExtraction } from "./paycheck-extract";
import { payslipPages, pdfPageCount, pdfPages } from "./pdf-pages";

async function pdfWithPages(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < n; i++) doc.addPage([200 + i, 300]); // distinct widths, to tell pages apart
  return Buffer.from(await doc.save());
}

describe("payslip pages", () => {
  it("cleans the page list and treats all pages (or none) as the whole file", () => {
    expect(payslipPages([3], 3)).toEqual([3]);
    expect(payslipPages([2, 1, 2, "1", 9, 0, -1, 1.5], 3)).toEqual([1, 2]);
    expect(payslipPages([1, 2, 3], 3)).toEqual([]);
    expect(payslipPages([], 3)).toEqual([]);
    expect(payslipPages(undefined, 3)).toEqual([]);
    expect(payslipPages([1], 1)).toEqual([]);
  });

  it("cuts the pages asked for out of a PDF", async () => {
    const batch = await pdfWithPages(3);
    expect(await pdfPageCount(batch)).toBe(3);
    const cut = await pdfPages(batch, [3]);
    expect(await pdfPageCount(cut)).toBe(1);
    expect((await PDFDocument.load(new Uint8Array(cut))).getPage(0).getWidth()).toBe(202);
    const two = await pdfPages(batch, [1, 3]);
    expect(await pdfPageCount(two)).toBe(2);
    await expect(pdfPages(batch, [7])).rejects.toThrow(/No such pages/);
  });
});

describe("extraction shapes", () => {
  const stub = (payDate: string, pages?: number[]) => ({ payDate, employeeName: "Gennaro Anesi", gross: 1, net: 1, ...(pages ? { pages } : {}) });

  it("reads a batch, in order, with each stub's pages", () => {
    const r = normalizeExtraction({ paychecks: [stub("2026-11-09", [1]), stub("2026-11-20", [2]), stub("2026-11-17", [3])] }, 3);
    expect(r.error).toBeNull();
    expect(r.drafts.map((d) => [d.draft.payDate, d.pages])).toEqual([
      ["2026-11-09", [1]],
      ["2026-11-20", [2]],
      ["2026-11-17", [3]],
    ]);
    expect(r.drafts[0].draft).not.toHaveProperty("pages");
  });

  it("still accepts a single stub object, a bare array, and the error shape", () => {
    expect(normalizeExtraction(stub("2026-11-06"), 1)).toEqual({ drafts: [{ draft: stub("2026-11-06"), pages: [] }], error: null });
    expect(normalizeExtraction([stub("2026-11-06", [1, 2])], 2).drafts[0].pages).toEqual([]);
    expect(normalizeExtraction({ error: "not a paystub" }, 1)).toEqual({ drafts: [], error: "not a paystub" });
    expect(normalizeExtraction("nope", 1).error).toMatch(/other than an object/);
    expect(normalizeExtraction({ paychecks: [] }, 1).error).toMatch(/No pay stub/);
    expect(normalizeExtraction({ paychecks: [null, 3] }, 1).error).toMatch(/No pay stub/);
  });
});
