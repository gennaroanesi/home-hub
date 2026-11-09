// Invoice / receipt / bill PDF → fields, with Claude, plus the auto-match
// rule against household transactions. Ported from gennaroanesi.com's
// invoiceProcessor. Server-only.

import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "./inbound-mail";
import { normalizeInvoiceFields, type InvoiceFields } from "./invoice-fields";

export { autoMatchCandidates, normalizeInvoiceFields, type InvoiceFields } from "./invoice-fields";

export const INVOICE_MODEL = "claude-sonnet-5-5";

const PROMPT = `You are extracting structured data from an invoice (or receipt/bill) PDF for a household. Return ONLY a JSON object — no commentary, no markdown fences.

Schema (monetary fields are plain numbers in the invoice's currency, no symbols or separators; null when not present — never guess):

{
  "vendor":        string | null,
  "invoiceNumber": string | null,
  "issueDate":     "YYYY-MM-DD" | null,
  "dueDate":       "YYYY-MM-DD" | null,
  "currency":      string | null,
  "subtotal":      number | null,
  "tax":           number | null,
  "total":         number | null,
  "category":      string | null,
  "items": [ { "description": string, "qty": number | null, "unitPrice": number | null, "amount": number | null } ]
}

Guidance:
- "total" is the headline amount due or paid for this invoice.
- "issueDate" is the invoice/receipt date; "dueDate" only when stated. Convert any date format to YYYY-MM-DD.
- "category": one short household spending category if obvious (e.g. Home, Utilities, Medical, Baby, Pets, Car, Insurance, Groceries, Dining), else null.
- "items" is the line-item table, or [] when there is none.

If you can't read the document or it isn't an invoice/receipt/bill, return {"error": "<short reason>"} and nothing else.`;


let anthropic: Anthropic | null = null;

/** Never throws: { fields } or { error }. */
export async function extractInvoiceFields(pdf: Buffer): Promise<{ fields: InvoiceFields | null; error: string | null }> {
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let text: string;
  try {
    const resp = await anthropic.messages.create({
      model: INVOICE_MODEL,
      max_tokens: 4096,
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
    return { fields: null, error: `Claude call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    parsed = extractJson(text);
  } catch (err) {
    return { fields: null, error: `Couldn't read Claude's JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) return { fields: null, error: String(parsed.error) };
  return { fields: normalizeInvoiceFields(parsed), error: null };
}
