// Paycheck draft helpers safe for the browser (no SDK imports): matching a
// stub's employee name to a household member, and draft → homePaycheck
// fields. The Claude extraction itself is paycheck-extract.ts (server-only).

/**
 * The household member a stub belongs to, by the employee name on it:
 * exact full name, then first name, then a first name that starts the same
 * (Cristina / Cristine). Null when unsure.
 */
export function matchPerson<P extends { id: string; name: string }>(people: P[], employeeName: string | null | undefined): P | null {
  const name = (employeeName ?? "").trim().toLowerCase();
  if (!name) return null;
  const tokens = name.split(/[\s,]+/).filter(Boolean);
  // Stubs print "Last, First" as often as "First Last".
  const firsts = name.includes(",") ? [tokens[1], tokens[0]] : [tokens[0], tokens[tokens.length - 1]];
  const byFull = people.filter((p) => p.name.trim().toLowerCase() === name);
  if (byFull.length === 1) return byFull[0];
  for (const f of firsts) {
    if (!f) continue;
    const hits = people.filter((p) => p.name.trim().toLowerCase().split(/\s+/)[0] === f);
    if (hits.length === 1) return hits[0];
  }
  for (const f of firsts) {
    if (!f || f.length < 4) continue;
    const hits = people.filter((p) => {
      const pf = p.name.trim().toLowerCase().split(/\s+/)[0];
      return pf.length >= 4 && pf.slice(0, 5) === f.slice(0, 5);
    });
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/** Numeric/date fields of a draft that map 1:1 onto homePaycheck columns. */
export const PAYCHECK_FIELDS = [
  "employer", "payDate", "periodStart", "periodEnd", "gross", "taxableWage", "net", "imputedGtl", "fedWh", "stateWh", "oasdi", "medicare",
  "contrib401k", "contribRoth401k", "contribAfterTax401k", "hsa", "fsa", "medical", "dental", "vision",
  "ytdGross", "ytdTaxableWage", "ytdFedWh", "ytdOasdi", "ytdMedicare", "ytd401k", "ytdRoth401k", "ytdAfterTax401k", "ytdNet",
  "bonusGross", "rsuGross", "ytdBonusGross", "ytdRsuGross", "supplementalFedWh", "ytdSupplementalFedWh",
  "w4FilingStatus", "w4ExtraWithholding", "w4Dependents",
] as const;

/** A draft as homePaycheck fields (unknown keys dropped, lineItems kept as JSON). */
export function draftToPaycheck(draft: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PAYCHECK_FIELDS) if (draft[k] !== undefined) out[k] = draft[k];
  if (Array.isArray(draft.lineItems)) out.lineItems = JSON.stringify(draft.lineItems);
  return out;
}
