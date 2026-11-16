// A lender's amortization / payment-history PDF → its payment rows, with
// Claude. Used by the parseLoanSchedulePdf mutation (paycheck-processor
// Lambda) behind the loan page's "Import lender schedule". Server-only.
//
// Lenders print these differently (BMW FS: "Actual Amortization Schedule"
// with payment number, date, payment made, principal, other charges,
// interest, days, daily interest, balance; a mortgage servicer's history
// has escrow too), so the rows are read by the model rather than by a
// per-lender parser. Numbers are checked here: principal + interest +
// fees + escrow must equal the total, or the row is flagged.

import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "./inbound-mail";
import { round2 } from "./dates";

export const LOAN_SCHEDULE_MODEL = "claude-sonnet-5-5";

const PROMPT = `You are extracting a loan's payment history from a lender's PDF (an amortization schedule, "actual amortization schedule", payment history or statement). Return ONLY a JSON object — no commentary, no markdown fences.

Schema (monetary fields are USD dollars as plain numbers, no symbols or commas; null when not on the document):

{
  "lender":        string | null,
  "accountRef":    string | null,          // masked account / reference number as printed
  "asOf":          "YYYY-MM-DD" | null,    // the document's date
  "balanceAfter":  number | null,          // principal balance after the last row listed
  "rows": [
    {
      "number":    number | null,          // the lender's payment number, when printed
      "date":      "YYYY-MM-DD",           // date the payment was made / posted
      "total":     number,                 // the amount paid
      "principal": number,
      "interest":  number,
      "fees":      number | null,          // "other charges", late fees
      "escrow":    number | null,          // taxes + insurance, mortgages only
      "days":      number | null,          // interest days, when printed
      "balance":   number | null           // principal balance after this payment
    }
  ]
}

Rules:
- Only payments that were actually made. Skip projected / scheduled future rows and "Total" lines.
- Dates in the document may be MM/DD/YYYY; convert to YYYY-MM-DD.
- Keep every row, in the document's order, across all pages. Do not merge or summarize.
- If you can't read the document or it has no payment rows, return {"error": "<short reason>"} and nothing else.`;

export type ExtractedLoanRow = {
  number: number | null;
  date: string;
  total: number;
  principal: number;
  interest: number;
  fees: number | null;
  escrow: number | null;
  days: number | null;
  balance: number | null;
  /** Set when principal + interest + fees + escrow ≠ total. */
  problem?: string;
};

export type ExtractedLoanSchedule = {
  lender: string | null;
  accountRef: string | null;
  asOf: string | null;
  balanceAfter: number | null;
  rows: ExtractedLoanRow[];
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/[$,]/g, ""))) ? Number(v.replace(/[$,]/g, "")) : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalize and check what the model returned. Throws when it isn't usable. */
export function normalizeLoanSchedule(parsed: unknown): ExtractedLoanSchedule {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Not an object");
  const p = parsed as Record<string, unknown>;
  if ("error" in p) throw new Error(String(p.error));
  if (!Array.isArray(p.rows) || !p.rows.length) throw new Error("No payment rows found");
  const rows: ExtractedLoanRow[] = [];
  p.rows.forEach((r: any, i: number) => {
    const date = typeof r?.date === "string" ? r.date : "";
    const total = num(r?.total);
    const principal = num(r?.principal);
    const interest = num(r?.interest);
    if (!DATE.test(date) || total == null || principal == null || interest == null) {
      throw new Error(`Row ${i + 1} is missing its date, total, principal or interest`);
    }
    const row: ExtractedLoanRow = {
      number: num(r?.number) == null ? null : Math.round(num(r.number)!),
      date,
      total: round2(total),
      principal: round2(principal),
      interest: round2(interest),
      fees: num(r?.fees) == null ? null : round2(num(r.fees)!),
      escrow: num(r?.escrow) == null ? null : round2(num(r.escrow)!),
      days: num(r?.days) == null ? null : Math.round(num(r.days)!),
      balance: num(r?.balance) == null ? null : round2(num(r.balance)!),
    };
    const sum = round2(row.principal + row.interest + (row.fees ?? 0) + (row.escrow ?? 0));
    if (Math.abs(sum - row.total) > 0.01) row.problem = `principal + interest + fees + escrow = ${sum.toFixed(2)}, not ${row.total.toFixed(2)}`;
    rows.push(row);
  });
  return {
    lender: typeof p.lender === "string" ? p.lender : null,
    accountRef: typeof p.accountRef === "string" ? p.accountRef : null,
    asOf: typeof p.asOf === "string" && DATE.test(p.asOf) ? p.asOf : null,
    balanceAfter: num(p.balanceAfter) == null ? (rows[rows.length - 1]?.balance ?? null) : round2(num(p.balanceAfter)!),
    rows,
  };
}

let anthropic: Anthropic | null = null;

/** Never throws: { schedule } or { error }. */
export async function extractLoanSchedule(pdf: Buffer): Promise<{ schedule: ExtractedLoanSchedule | null; error: string | null }> {
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let text: string;
  try {
    const resp = await anthropic.messages.create({
      model: LOAN_SCHEDULE_MODEL,
      max_tokens: 16_000,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
    text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (err) {
    return { schedule: null, error: `Claude call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { schedule: normalizeLoanSchedule(extractJson(text)), error: null };
  } catch (err) {
    return { schedule: null, error: err instanceof Error ? err.message : String(err) };
  }
}
