// The tax outlook's view model: what /finance/tax-outlook shows
// (per person with paychecks in the year: projection, current 401(k) rate,
// staleness; their single-filer outcomes at the current and what-if rate,
// the 415(c) total and the rate that reaches the cap; the household return
// and the safe-harbor check). Pure; the math is lib/finance/tax.ts. Used by
// the web page and the phone's tax outlook
// (mobile/app/(tabs)/finance/tax-outlook.tsx).
//
// Settings persist in homeFinanceSetting "tax-outlook:<year>" (taxSettingsKey).

import {
  combinedOutcome,
  contribPctToReachCap,
  current401kPct,
  extractEmployerMatchPeriod,
  extractEmployerMatchYtd,
  isPaycheckStale,
  nextEstimatedDueDate,
  personOutcome,
  project415cTotal,
  projectFromPaychecks,
  safeHarbor,
  sortLatestFirst,
  type CombinedOutcome,
  type FilingStatus,
  type Mega401kProjection,
  type PersonOutcome,
  type RsuVestCadence,
  type SafeHarbor,
  type TaxPaycheck,
  type YtdProjection,
} from "./tax";

export type TaxSettings = {
  filingStatus: FilingStatus;
  rsuVestCadence: Record<string, RsuVestCadence>; // personId → cadence
  priorYearTax?: number | null; // last year's TOTAL federal tax (return's total tax line)
  priorYearAgi?: number | null; // decides 100% vs 110% of last year
  estimatedPaid?: number | null; // estimated payments already made for this year
  whatIfPct?: number | null; // 401(k) what-if, 0..0.5; null = each person's current rate
};

export const DEFAULT_TAX_SETTINGS: TaxSettings = { filingStatus: "MFJ", rsuVestCadence: {} };

export const taxSettingsKey = (year: number) => `tax-outlook:${year}`;

/** A stored setting merged over the defaults. */
export function normalizeTaxSettings(v: Partial<TaxSettings> | null | undefined): TaxSettings {
  return { ...DEFAULT_TAX_SETTINGS, ...(v ?? {}), rsuVestCadence: { ...(v?.rsuVestCadence ?? {}) } };
}

/** "$1,234" style input → number; blank or junk → null. */
export function parseTaxAmount(s: string): number | null {
  if (s.trim() === "") return null;
  const v = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? v : null;
}

export type TaxPersonView<P extends TaxPaycheck = TaxPaycheck> = {
  personId: string;
  paychecks: P[];
  latest: P;
  projection: YtdProjection;
  currentPct: number;
  stale: boolean;
  cadence: RsuVestCadence;
  /** Outcome at the person's current 401(k) rate. */
  current: PersonOutcome;
  /** Outcome at the what-if rate (same as current without one). */
  adjusted: PersonOutcome;
  mega: Mega401kProjection;
  /** Rate that reaches the elective cap; null = already there. */
  capPct: number | null;
  /** The what-if differs from this person's own rate. */
  sliderOn: boolean;
};

export type TaxOutlookView<P extends TaxPaycheck = TaxPaycheck> = {
  people: TaxPersonView<P>[];
  combined: CombinedOutcome | null;
  harbor: SafeHarbor | null;
  /** Combined gap with estimated payments counted: ≥ 0 refund, < 0 owed. */
  householdGap: number | null;
  nextDue: string | null;
  /** The slider's position without a what-if: the people's average current rate. */
  defaultPct: number;
  isCurrentYear: boolean;
};

/**
 * Everything the tax outlook shows for `year`. `personOrder` lists people
 * in display order (others with paychecks follow).
 */
export function taxOutlook<P extends TaxPaycheck>(args: { paychecks: P[]; personOrder: string[]; settings: TaxSettings; year: number; today: string }): TaxOutlookView<P> {
  const { paychecks, settings, year, today } = args;
  const thisYear = Number(today.slice(0, 4));
  const isCurrentYear = year === thisYear;
  const whatIf = settings.whatIfPct ?? null;

  const ids = new Set<string>(args.personOrder);
  for (const p of paychecks) if (p.personId) ids.add(p.personId);

  const people: TaxPersonView<P>[] = [];
  for (const personId of ids) {
    const mine = sortLatestFirst(paychecks.filter((p) => p.personId === personId && p.payDate?.startsWith(`${year}`)));
    if (!mine.length) continue;
    const cadence = settings.rsuVestCadence[personId] ?? "IRREGULAR";
    const projection = projectFromPaychecks({ paychecks: mine, rsuVestCadence: cadence });
    if (!projection) continue;
    const latest = mine[0];
    const currentPct = current401kPct(mine, projection.ytdSalaryGross);
    const ytd401k = (latest.ytd401k ?? 0) + (latest.ytdRoth401k ?? 0);
    const base = { projection, ytd401k, currentPct, year };
    const current = personOutcome({ ...base, pct: null });
    const adjusted = personOutcome({ ...base, pct: whatIf });
    const mega = project415cTotal({
      ytdEmployee: ytd401k,
      ytdEmployerMatch: extractEmployerMatchYtd(latest.lineItems),
      ytdAfterTax: latest.ytdAfterTax401k ?? 0,
      ytdGross: projection.ytdSalaryGross,
      projectedGross: projection.projectedGross,
      projectedEmployee: adjusted.new401k,
      latestPeriodMatch: extractEmployerMatchPeriod(latest.lineItems),
      year,
    });
    const capPct = contribPctToReachCap({ ytd401k, ytdGross: projection.ytdSalaryGross, projectedGross: projection.projectedGross, year });
    people.push({
      personId,
      paychecks: mine,
      latest,
      projection,
      currentPct,
      stale: isCurrentYear && isPaycheckStale(latest.payDate, today),
      cadence,
      current,
      adjusted,
      mega,
      capPct,
      sliderOn: whatIf != null && Math.abs(whatIf - currentPct) > 1e-6,
    });
  }
  const order = new Map(args.personOrder.map((id, i) => [id, i]));
  people.sort((a, b) => (order.get(a.personId) ?? 99) - (order.get(b.personId) ?? 99));

  const combined = people.length ? combinedOutcome(people.map((p) => p.adjusted), settings.filingStatus, year) : null;
  const harbor = combined
    ? safeHarbor({ taxOwed: combined.taxOwed, withheld: combined.fedWh, estimatedPaid: settings.estimatedPaid ?? 0, priorYearTax: settings.priorYearTax, priorYearAgi: settings.priorYearAgi })
    : null;
  return {
    people,
    combined,
    harbor,
    householdGap: combined ? combined.gap + (settings.estimatedPaid ?? 0) : null,
    nextDue: isCurrentYear || year === thisYear - 1 ? nextEstimatedDueDate(year, today) : null,
    defaultPct: people.length ? people.reduce((s, p) => s + p.currentPct, 0) / people.length : 0,
    isCurrentYear,
  };
}

/** Years to offer: this one plus every year with a paycheck, newest first. */
export function paycheckYears(paychecks: { payDate?: string | null }[], thisYear: number): number[] {
  const ys = new Set<number>([thisYear]);
  for (const p of paychecks) if (p.payDate) ys.add(Number(p.payDate.slice(0, 4)));
  return [...ys].sort((a, b) => b - a);
}
