// The paycheck form's field spec and the helpers around it, shared by the
// web (components/finance/paycheck-form.tsx, pages/finance/paychecks.tsx)
// and the phone's Paychecks screen so both build the same form and the same
// homePaycheck row. Pure.

import { draftToPaycheck } from "./paycheck-fields";

export const PAYCHECK_LINE_ITEM_TYPES = ["PRETAX", "POSTTAX", "IMPUTED", "EMPLOYER_PAID", "EARNING", "OTHER"] as const;
export type PaycheckLineItemType = (typeof PAYCHECK_LINE_ITEM_TYPES)[number];
/** A line item as typed in the form (amounts as text). */
export type PaycheckLineItemDraft = { name: string; amount: string; ytd: string; type: PaycheckLineItemType };

export const PAYCHECK_FILING_STATUSES = ["SINGLE", "MFJ", "MFS", "HOH"] as const;

/** The form's number fields, grouped as on the web form. */
export const PAYCHECK_NUM_GROUPS: Array<{ title: string; fields: Array<[string, string]> }> = [
  { title: "This period", fields: [["gross", "Gross (cash)"], ["taxableWage", "Federal taxable wage"], ["net", "Net (take-home)"], ["imputedGtl", "Imputed GTL"]] },
  { title: "Taxes", fields: [["fedWh", "Federal WH"], ["stateWh", "State WH"], ["oasdi", "Social Security"], ["medicare", "Medicare"]] },
  {
    title: "Retirement & benefits",
    fields: [["contrib401k", "401k pre-tax"], ["contribRoth401k", "401k Roth"], ["contribAfterTax401k", "401k after-tax"], ["hsa", "HSA"], ["fsa", "FSA"], ["medical", "Medical"], ["dental", "Dental"], ["vision", "Vision"]],
  },
  {
    title: "Year to date",
    fields: [["ytdGross", "Gross"], ["ytdTaxableWage", "Taxable wage"], ["ytdFedWh", "Federal WH"], ["ytdOasdi", "Social Security"], ["ytdMedicare", "Medicare"], ["ytd401k", "401k pre-tax"], ["ytdRoth401k", "401k Roth"], ["ytdAfterTax401k", "401k after-tax"], ["ytdNet", "Net"]],
  },
  {
    title: "Supplemental (bonus / RSU)",
    fields: [["bonusGross", "Bonus"], ["rsuGross", "RSU vest"], ["ytdBonusGross", "YTD bonus"], ["ytdRsuGross", "YTD RSU"], ["supplementalFedWh", "Supplemental fed WH"], ["ytdSupplementalFedWh", "YTD supplemental WH"]],
  },
  { title: "W-4", fields: [["w4ExtraWithholding", "Extra withholding / period"], ["w4Dependents", "Dependents amount"]] },
];
export const PAYCHECK_NUM_FIELDS = PAYCHECK_NUM_GROUPS.flatMap((g) => g.fields.map(([k]) => k));

/** AWSJSON can arrive stringified more than once. */
export function parseJsonLayers(v: unknown): unknown {
  let out = v;
  for (let i = 0; i < 3 && typeof out === "string"; i++) {
    try {
      out = JSON.parse(out);
    } catch {
      return null;
    }
  }
  return out;
}

const toStr = (v: unknown) => (v == null ? "" : String(v));

/** "$1,234.50" → 1234.5; blank or junk → null. */
export function paycheckNum(s: string | null | undefined): number | null {
  const t = (s ?? "").replace(/[$,\s]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** What the form edits, as text. */
export type PaycheckFormState = {
  personId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  employer: string;
  filing: string;
  notes: string;
  nums: Record<string, string>;
  items: PaycheckLineItemDraft[];
};

/** Form state from homePaycheck-shaped values (a saved row or draftToPaycheck output). */
export function paycheckFormState(values: Record<string, unknown> | null | undefined, personId?: string | null): PaycheckFormState {
  const v = values ?? {};
  const raw = parseJsonLayers(v.lineItems);
  return {
    personId: personId ?? "",
    payDate: toStr(v.payDate),
    periodStart: toStr(v.periodStart),
    periodEnd: toStr(v.periodEnd),
    employer: toStr(v.employer),
    filing: toStr(v.w4FilingStatus),
    notes: toStr(v.notes),
    nums: Object.fromEntries(PAYCHECK_NUM_FIELDS.map((k) => [k, toStr(v[k])])),
    items: Array.isArray(raw)
      ? raw.map((it: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
          name: toStr(it?.name),
          amount: toStr(it?.amount),
          ytd: toStr(it?.ytd),
          type: (PAYCHECK_LINE_ITEM_TYPES as readonly string[]).includes(it?.type) ? it.type : "OTHER",
        }))
      : [],
  };
}

/**
 * gross − (taxes + deductions + pre/post-tax line items + net) when it's off
 * by more than a dollar; null when it adds up or there's nothing to check.
 */
export function paycheckSanityGap(f: Pick<PaycheckFormState, "nums" | "items">): number | null {
  const num = (k: string) => paycheckNum(f.nums[k]);
  const gross = num("gross");
  const net = num("net");
  if (gross == null || net == null || gross === 0) return null;
  const sum = (ks: string[]) => ks.reduce((s, k) => s + (num(k) ?? 0), 0);
  const itemSum = (t: PaycheckLineItemType) => f.items.filter((i) => i.type === t).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const parts = sum(["fedWh", "stateWh", "oasdi", "medicare", "contrib401k", "contribRoth401k", "contribAfterTax401k", "hsa", "fsa", "medical", "dental", "vision"]) + itemSum("PRETAX") + itemSum("POSTTAX") + net;
  const diff = gross - parts;
  return Math.abs(diff) > 1 ? diff : null;
}

/** Why the form can't be saved yet, or null. */
export function paycheckFormProblem(f: PaycheckFormState): string | null {
  if (!f.personId) return "Pick whose paycheck this is";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.payDate)) return "Pay date is required";
  if (paycheckNum(f.nums.gross) == null || paycheckNum(f.nums.net) == null) return "Gross and net are required";
  return null;
}

/** The homePaycheck fields to write (lineItems already JSON for the AWSJSON field). */
export function paycheckRow(f: PaycheckFormState): Record<string, unknown> {
  const row: Record<string, unknown> = {
    personId: f.personId,
    payDate: f.payDate,
    periodStart: f.periodStart || null,
    periodEnd: f.periodEnd || null,
    employer: f.employer.trim() || null,
    w4FilingStatus: f.filing || null,
    notes: f.notes.trim() || null,
    lineItems: JSON.stringify(
      f.items
        .filter((i) => i.name.trim() || i.amount)
        .map((i) => ({ name: i.name.trim(), amount: Number(i.amount) || 0, ytd: i.ytd === "" ? null : Number(i.ytd), type: i.type })),
    ),
  };
  for (const k of PAYCHECK_NUM_FIELDS) row[k] = paycheckNum(f.nums[k]);
  return row;
}

// ── Inbox (emailed stubs) ───────────────────────────────────────────────────

/** Inbox rows still waiting on a person (NEEDS_REVIEW / ERROR), newest first. */
export function inboxToReview<R extends { status?: string | null; receivedAt?: string | null }>(rows: R[]): R[] {
  return rows.filter((r) => r.status === "NEEDS_REVIEW" || r.status === "ERROR").sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));
}

/** An inbox row's draft as homePaycheck values. */
export function inboxDraftValues(row: { draft?: unknown }): Record<string, unknown> {
  return draftToPaycheck((parseJsonLayers(row.draft) ?? {}) as Record<string, unknown>);
}

/** A paycheck's bonus + RSU gross, with a label: "RSU" when there's any RSU, else "bonus". */
export function supplementalOf(p: { bonusGross?: number | null; rsuGross?: number | null }): { amount: number; label: string } | null {
  const amount = (p.bonusGross ?? 0) + (p.rsuGross ?? 0);
  if (amount <= 0) return null;
  return { amount, label: (p.rsuGross ?? 0) > 0 ? "RSU" : "bonus" };
}

/** 0.42 → "42%"; null → "—". */
export const sharePct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
