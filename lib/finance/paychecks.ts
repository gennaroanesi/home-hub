// Paycheck aggregates shared by the Paychecks page, Review and the tax
// outlook. Pure. "Contribution share" answers the question this section was
// built for: of what each of us took home, how much went into the joint
// account?

import { receivedByPerson } from "./budget";
import type { DateRange } from "./dates";
import type { TxLike } from "./types";

export type PaycheckLike = {
  id: string;
  personId: string;
  payDate: string;
  gross?: number | null;
  net?: number | null;
  taxableWage?: number | null;
  fedWh?: number | null;
  stateWh?: number | null;
  oasdi?: number | null;
  medicare?: number | null;
  contrib401k?: number | null;
  contribRoth401k?: number | null;
  contribAfterTax401k?: number | null;
  bonusGross?: number | null;
  rsuGross?: number | null;
  ytdGross?: number | null;
  ytdNet?: number | null;
};

export type PayTotals = { count: number; gross: number; net: number; taxes: number; retirement: number; supplemental: number };

const n = (v: number | null | undefined) => v ?? 0;

export function payTotals(rows: PaycheckLike[]): PayTotals {
  return rows.reduce<PayTotals>(
    (t, p) => ({
      count: t.count + 1,
      gross: t.gross + n(p.gross),
      net: t.net + n(p.net),
      taxes: t.taxes + n(p.fedWh) + n(p.stateWh) + n(p.oasdi) + n(p.medicare),
      retirement: t.retirement + n(p.contrib401k) + n(p.contribRoth401k) + n(p.contribAfterTax401k),
      supplemental: t.supplemental + n(p.bonusGross) + n(p.rsuGross),
    }),
    { count: 0, gross: 0, net: 0, taxes: 0, retirement: 0, supplemental: 0 },
  );
}

/** Paychecks paid within the range, per person. */
export function payByPerson(paychecks: PaycheckLike[], range: { fromIso: string; toIso: string }): Map<string, PayTotals> {
  const by = new Map<string, PaycheckLike[]>();
  for (const p of paychecks) {
    if (p.payDate < range.fromIso || p.payDate > range.toIso) continue;
    by.set(p.personId, [...(by.get(p.personId) ?? []), p]);
  }
  return new Map([...by].map(([id, rows]) => [id, payTotals(rows)]));
}

export type ContributionShare = {
  personId: string;
  net: number; // take-home in the range
  gross: number;
  contributed: number; // money in to the joint account attributed to them
  /** contributed ÷ net; null without pay in the range. */
  shareOfNet: number | null;
  shareOfGross: number | null;
};

/**
 * Per person: take-home pay vs what they put into the household accounts
 * over the same range. Contributions are income-category money in with that
 * personId (lib/finance/budget.ts receivedByPerson), so set the person
 * rules up for each person's transfers.
 */
export function contributionShare(paychecks: PaycheckLike[], txs: TxLike[], range: DateRange, personIds: string[]): ContributionShare[] {
  const pay = payByPerson(paychecks, range);
  const got = receivedByPerson(txs, range);
  return personIds.map((personId) => {
    const p = pay.get(personId);
    const contributed = got.get(personId) ?? 0;
    return {
      personId,
      net: p?.net ?? 0,
      gross: p?.gross ?? 0,
      contributed,
      shareOfNet: p && p.net > 0 ? contributed / p.net : null,
      shareOfGross: p && p.gross > 0 ? contributed / p.gross : null,
    };
  });
}

/** The most recent stub per person (YTD columns are the source of truth for the year). */
export function latestByPerson<P extends PaycheckLike>(paychecks: P[], year?: number): Map<string, P> {
  const out = new Map<string, P>();
  for (const p of paychecks) {
    if (year && Number(p.payDate.slice(0, 4)) !== year) continue;
    const cur = out.get(p.personId);
    if (!cur || p.payDate > cur.payDate) out.set(p.personId, p);
  }
  return out;
}
