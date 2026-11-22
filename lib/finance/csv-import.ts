// Bank / card CSV exports → transaction rows, for accounts SimpleFIN doesn't
// reach (the H-E-B card). Ported from gennaroanesi.com
// (components/finance/csv-parsers.ts). Pure: used by the
// import_finance_transactions op; the web page sends the file's text.
//
// Every parser returns money leaving the account as negative, whatever the
// bank's own sign convention.

import { importHash } from "./sync-engine";

export type CsvRow = {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number;
  /** A category the export itself settles (a card payment), else null: the rules decide. */
  category: string | null;
  hash: string;
};

type Format = {
  name: string;
  detect: (headers: string[]) => boolean;
  parse: (row: Record<string, string>) => Omit<CsvRow, "hash"> | null;
};

/** "11/05/2026", "2026-11-05", "2026/11/05, 14:02:11" → "2026-11-05"; null when unreadable. */
export function toIsoDate(raw: string): string | null {
  const s = (raw ?? "").split(",")[0].trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

/** "$1,234.50", "(12.00)", "-$5" → number; NaN when there's no number. */
export function parseAmount(raw: string): number {
  const s = (raw ?? "").trim();
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[$\s]/g, ""));
  const n = parseFloat(s.replace(/[()$,\s-]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

const FORMATS: Format[] = [
  {
    // H-E-B credit card "Activity" export. Date,Amount,Type,Merchant,Category,Method
    name: "H-E-B Card",
    detect: (h) => h.includes("Merchant") && h.includes("Method") && h.includes("Type"),
    parse: (row) => {
      const date = toIsoDate(row["Date"]);
      if (!date) return null;
      // Purchases are positive, payments / refunds / rewards negative: flip.
      const amount = -parseAmount(row["Amount"]);
      const description = row["Merchant"]?.trim() || row["Type"]?.trim() || "";
      // Type settles balance-sheet rows: a payment or a statement-credit
      // reward pays the card down, it isn't income or a refund.
      const type = (row["Type"] ?? "").trim().toUpperCase();
      return { date, description, amount, category: type === "PAYMENT" || type === "REWARD" ? "Credit Card Payment" : null };
    },
  },
  {
    // Chase card: Transaction Date,Post Date,Description,Category,Type,Amount,Memo. Signs already ours.
    name: "Chase card",
    detect: (h) => h.includes("Transaction Date") && h.includes("Post Date"),
    parse: (row) => {
      const date = toIsoDate(row["Transaction Date"]);
      return date ? { date, description: row["Description"]?.trim() ?? "", amount: parseAmount(row["Amount"]), category: null } : null;
    },
  },
  {
    // Chase checking: Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
    name: "Chase checking",
    detect: (h) => h.includes("Posting Date") && h.includes("Details"),
    parse: (row) => {
      const date = toIsoDate(row["Posting Date"]);
      return date ? { date, description: row["Description"]?.trim() ?? "", amount: parseAmount(row["Amount"]), category: null } : null;
    },
  },
  {
    name: "Bank of America",
    detect: (h) => h.includes("Posted Date") && h.includes("Reference Number"),
    parse: (row) => {
      const date = toIsoDate(row["Posted Date"]);
      return date ? { date, description: row["Payee"]?.trim() ?? "", amount: parseAmount(row["Amount"]), category: null } : null;
    },
  },
  {
    // American Express: Date,Description,Amount. Charges positive: flip.
    name: "American Express",
    detect: (h) => h.includes("Date") && h.includes("Description") && h.includes("Amount") && !h.includes("Transaction Date") && !h.includes("Posting Date"),
    parse: (row) => {
      const date = toIsoDate(row["Date"]);
      return date ? { date, description: row["Description"]?.trim() ?? "", amount: -parseAmount(row["Amount"]), category: null } : null;
    },
  },
  {
    // Anything with a date and either an amount or debit / credit columns.
    name: "Generic CSV",
    detect: (h) => h.some((c) => /date/i.test(c)) && h.some((c) => /amount|debit|credit/i.test(c)),
    parse: (row) => {
      const keys = Object.keys(row);
      const key = (re: RegExp) => keys.find((k) => re.test(k));
      const date = toIsoDate(row[key(/date/i) ?? ""] ?? "");
      if (!date) return null;
      const desc = row[key(/desc|payee|merchant|memo|name/i) ?? ""]?.trim() ?? "";
      const amtKey = key(/amount/i);
      let amount: number;
      if (amtKey) amount = parseAmount(row[amtKey]);
      else {
        const debit = parseAmount(row[key(/debit/i) ?? ""] ?? "");
        const credit = parseAmount(row[key(/credit/i) ?? ""] ?? "");
        amount = (Number.isFinite(credit) ? Math.abs(credit) : 0) - (Number.isFinite(debit) ? Math.abs(debit) : 0);
      }
      return { date, description: desc, amount, category: null };
    },
  },
];

export const CSV_FORMATS = FORMATS.map((f) => f.name);

/** One CSV line → fields, honoring quotes ("a, b" and "" escapes). */
export function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/**
 * The export's rows, oldest first, with the format that read them.
 * `format` forces one (by name). Rows without a date or an amount, and
 * zero-amount rows, are skipped and counted.
 */
export function parseBankCsv(text: string, format?: string): { format: string; rows: CsvRow[]; skipped: number } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { format: "Unknown", rows: [], skipped: 0 };
  const headers = splitCsvRow(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim());
  const fmt = (format && FORMATS.find((f) => f.name === format)) || FORMATS.find((f) => f.detect(headers));
  if (!fmt) return { format: "Unknown", rows: [], skipped: lines.length - 1 };
  const rows: CsvRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const vals = splitCsvRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = vals[i] ?? ""));
    const p = fmt.parse(row);
    if (!p || !Number.isFinite(p.amount) || p.amount === 0) {
      skipped++;
      continue;
    }
    const amount = Math.round(p.amount * 100) / 100;
    rows.push({ ...p, amount, hash: importHash(p.date, amount, p.description) });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { format: fmt.name, rows, skipped };
}

/**
 * Which rows are new. Two identical charges on one day are both real, so
 * this counts: a row is a duplicate only while the account already holds
 * as many rows with its fingerprint as the file has up to it.
 * `occurrence` (0-based) makes each new row's id stable across re-imports.
 */
export function newCsvRows(rows: CsvRow[], storedHashes: Iterable<string>): { fresh: Array<CsvRow & { occurrence: number }>; duplicates: number } {
  const stored = new Map<string, number>();
  for (const h of storedHashes) stored.set(h, (stored.get(h) ?? 0) + 1);
  const seen = new Map<string, number>();
  const fresh: Array<CsvRow & { occurrence: number }> = [];
  let duplicates = 0;
  for (const r of rows) {
    const n = seen.get(r.hash) ?? 0;
    seen.set(r.hash, n + 1);
    if (n < (stored.get(r.hash) ?? 0)) duplicates++;
    else fresh.push({ ...r, occurrence: n });
  }
  return { fresh, duplicates };
}
