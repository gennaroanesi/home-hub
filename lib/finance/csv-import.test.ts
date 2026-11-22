import { describe, expect, it } from "vitest";
import { newCsvRows, parseAmount, parseBankCsv, toIsoDate } from "./csv-import";

describe("csv import", () => {
  it("reads dates and amounts the ways banks write them", () => {
    expect([toIsoDate("2026/11/02, 10:11:12"), toIsoDate("11/2/2026"), toIsoDate("11/02/26"), toIsoDate("2026-11-02"), toIsoDate("soon")]).toEqual(["2026-11-02", "2026-11-02", "2026-11-02", "2026-11-02", null]);
    expect([parseAmount("$1,234.50"), parseAmount("(12.00)"), parseAmount("-$5"), Number.isNaN(parseAmount(""))]).toEqual([1234.5, -12, -5, true]);
  });

  it("detects Chase checking and a debit / credit CSV, oldest first", () => {
    const chase = parseBankCsv("Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,11/05/2026,\"H-E-B, AUSTIN\",-42.10,DEBIT_CARD,100,\nCREDIT,11/01/2026,PAYROLL,2000,ACH_CREDIT,142,");
    expect(chase.format).toBe("Chase checking");
    expect(chase.rows.map((r) => [r.date, r.description, r.amount])).toEqual([["2026-11-01", "PAYROLL", 2000], ["2026-11-05", "H-E-B, AUSTIN", -42.1]]);
    const generic = parseBankCsv("Date,Description,Debit,Credit\n2026-11-03,Coffee,4.50,\n2026-11-04,Refund,,10\n2026-11-04,Nothing,,");
    expect(generic.rows.map((r) => r.amount)).toEqual([-4.5, 10]);
    expect(generic.skipped).toBe(1);
    expect(parseBankCsv("foo,bar\n1,2").format).toBe("Unknown");
  });

  it("keeps two identical charges unless both are already stored", () => {
    const { rows } = parseBankCsv("Date,Description,Amount\n11/02/2026,Coffee,4.99\n11/02/2026,Coffee,4.99");
    expect(newCsvRows(rows, []).fresh.map((r) => r.occurrence)).toEqual([0, 1]);
    const one = newCsvRows(rows, [rows[0].hash]);
    expect([one.duplicates, one.fresh.map((r) => r.occurrence)]).toEqual([1, [1]]);
  });
});
