// Paystub PDF → draft paycheck fields, with Claude. Shared by the emailed
// path (paycheck-processor S3 trigger) and the upload path (parsePaycheckPdf
// mutation). Ported from gennaroanesi.com's parsePaycheckPdf/extract.ts;
// the employee is returned by name and matched to a household member here
// instead of the ME/SPOUSE enum. Server-only.

import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "./inbound-mail";

export { matchPerson, draftToPaycheck, PAYCHECK_FIELDS } from "./paycheck-fields";

export const PAYCHECK_MODEL = "claude-sonnet-5-5";

const PROMPT = `You are extracting structured data from a US pay stub PDF. Read the document carefully and return ONLY a JSON object — no commentary, no markdown fences.

Schema (all monetary fields are USD dollars, no symbols, no commas; null when not present on the stub):

{
  "employeeName":         string | null,
  "employer":             string | null,
  "payDate":              "YYYY-MM-DD",
  "periodStart":          "YYYY-MM-DD" | null,
  "periodEnd":            "YYYY-MM-DD" | null,
  "gross":                number,
  "taxableWage":          number | null,
  "net":                  number,
  "imputedGtl":           number | null,
  "fedWh":                number | null,
  "stateWh":              number | null,
  "oasdi":                number | null,
  "medicare":             number | null,
  "contrib401k":          number | null,
  "contribRoth401k":      number | null,
  "contribAfterTax401k":  number | null,
  "hsa":                  number | null,
  "fsa":                  number | null,
  "medical":              number | null,
  "dental":               number | null,
  "vision":               number | null,
  "ytdGross":             number | null,
  "ytdTaxableWage":       number | null,
  "ytdFedWh":             number | null,
  "ytdOasdi":             number | null,
  "ytdMedicare":          number | null,
  "ytd401k":              number | null,
  "ytdRoth401k":          number | null,
  "ytdAfterTax401k":      number | null,
  "ytdNet":               number | null,
  "bonusGross":           number | null,
  "rsuGross":             number | null,
  "ytdBonusGross":        number | null,
  "ytdRsuGross":          number | null,
  "supplementalFedWh":    number | null,
  "ytdSupplementalFedWh": number | null,
  "w4FilingStatus":       "SINGLE" | "MFJ" | "MFS" | "HOH" | null,
  "w4ExtraWithholding":   number | null,
  "w4Dependents":         number | null,
  "lineItems": [
    { "name": string, "amount": number, "ytd": number | null, "type": "PRETAX" | "POSTTAX" | "IMPUTED" | "EMPLOYER_PAID" | "EARNING" | "OTHER" }
  ]
}

Field guidance:
- "employeeName" is the employee's full name as printed on the stub; "employer" the company paying.
- "gross" is the CASH gross pay this period (the headline "Gross Pay"). Do NOT include imputed income (Imp GTL, GTL coverage, imputed benefits) even when it appears as an earnings line; that goes in "imputedGtl" and as a lineItem of type IMPUTED. Sanity check: gross ≈ pre-tax deductions + employee taxes + post-tax deductions + net pay. Same rule for "ytdGross".
- "taxableWage" is the FEDERAL taxable wage for the period (Workday: "Federal Withholding - Taxable Wages"; not the OASDI or Medicare bases). Same for "ytdTaxableWage".
- "net" is the take-home / direct-deposit total.
- "fedWh" is federal income tax withheld (not FICA); "stateWh" state income tax withheld.
- "oasdi" is Social Security tax; "medicare" includes regular and Additional Medicare.
- "contrib401k" is the EMPLOYEE pre-tax 401k contribution (no employer match); "contribRoth401k" the employee Roth 401k; "contribAfterTax401k" after-tax (mega-backdoor) 401k.
- "rsuGross" sums this period's equity-vest earnings rows ("Restricted Stock Units", "RSU Vest", "Stock Vest"); not the RSU tax offset. RSU-only stubs usually have Gross Pay = $0; rsuGross is still taxable and in taxableWage. "bonusGross" sums explicit bonus rows. YTD versions use the YTD column.
- "supplementalFedWh" is federal tax withheld on supplemental wages (RSU/bonus) when the stub shows it separately.
- W-4 fields come from the W-4 elections box (Federal column): Marital Status → SINGLE / MFJ / MFS / HOH; "Additional Withholding" → w4ExtraWithholding; "Total Dependent Amount" → w4Dependents. 0 when the stub shows 0; null when absent. They're elections, not deductions.
- lineItems: every deduction or earning row not covered above (parking, ESPP, supplemental life, dependent-care FSA, commuter, employer match as EMPLOYER_PAID, adjustments), typed by tax treatment.

If you can't read the document or it isn't a paystub, return {"error": "<short reason>"} and nothing else.`;

export type PaycheckDraft = Record<string, unknown> & { employeeName?: string | null; payDate?: string; net?: number };

let anthropic: Anthropic | null = null;

/** Never throws: { draft } or { error }. */
export async function extractPaycheckFields(pdf: Buffer): Promise<{ draft: PaycheckDraft | null; error: string | null }> {
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let text: string;
  try {
    const resp = await anthropic.messages.create({
      model: PAYCHECK_MODEL,
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
    return { draft: null, error: `Claude call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (err) {
    return { draft: null, error: `Couldn't read Claude's JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { draft: null, error: "Claude returned something other than an object" };
  if ("error" in parsed) return { draft: null, error: String((parsed as { error: unknown }).error) };
  return { draft: parsed as PaycheckDraft, error: null };
}
