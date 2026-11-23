// Page-level PDF helpers for the paycheck pipeline (server-only, pdf-lib).
// Workday's "Payslip to Print" export batches several payslips into one
// PDF, one per page; each stub is stored as its own cut so the record a
// paycheck row points at is that stub, not the batch.

import { PDFDocument } from "pdf-lib";

type Bytes = Uint8Array | Buffer;
// A copy into a plain Uint8Array: pdf-lib's typings don't take Node's Buffer.
const load = (bytes: Bytes) => PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true, updateMetadata: false });

export async function pdfPageCount(bytes: Bytes): Promise<number> {
  return (await load(bytes)).getPageCount();
}

/** A new PDF holding just `pages` (1-based, in the order given) of `bytes`. */
export async function pdfPages(bytes: Bytes, pages: number[]): Promise<Buffer> {
  const src = await load(bytes);
  const count = src.getPageCount();
  const indices = pages.filter((p) => Number.isInteger(p) && p >= 1 && p <= count).map((p) => p - 1);
  if (!indices.length) throw new Error(`No such pages ${JSON.stringify(pages)} in a ${count}-page PDF`);
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const page of await out.copyPages(src, indices)) out.addPage(page);
  return Buffer.from(await out.save());
}

/**
 * The pages a payslip takes out of a `pageCount`-page PDF: 1-based, unique,
 * ascending, within range; `[]` means the whole file (unknown pages, or all
 * of them), so a single-stub PDF is never re-cut.
 */
export function payslipPages(pages: unknown, pageCount: number): number[] {
  if (!Array.isArray(pages)) return [];
  const clean = [...new Set(pages.map(Number).filter((p) => Number.isInteger(p) && p >= 1 && p <= pageCount))].sort((a, b) => a - b);
  return clean.length === 0 || clean.length >= pageCount ? [] : clean;
}
