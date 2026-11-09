// Federal tax outlook from paychecks: year-end projection per person, tax
// owed (SINGLE / MFJ), Additional Medicare, 401(k) caps and the
// underpayment-penalty safe harbor. Pure. Ported from gennaroanesi.com's
// components/finance/planning.ts and pages/finance/tax-outlook.tsx, with
// paychecks keyed by personId instead of ME / SPOUSE.
//
// Tax constants are IRS values for 2025 (Rev. Proc. 2024-40 + OBBBA
// standard deduction) and best-effort 2026 estimates (≈ +2.5%), carried
// over unchanged from gennaroanesi.com. An unknown year falls back to the
// latest defined one. Refresh yearly when the Rev. Proc. and the SSA wage
// base come out.

export const TAX_CONSTANTS_SOURCE = "2025 IRS (Rev. Proc. 2024-40 + OBBBA); 2026 estimated, pending Rev. Proc. 2025-32";

export const FILING_STATUSES = ["SINGLE", "MFJ"] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];
export const FILING_STATUS_LABELS: Record<FilingStatus, string> = { SINGLE: "Single", MFJ: "Married filing jointly" };

type Bracket = { rate: number; upTo: number };
type YearTaxConstants = { brackets: Record<FilingStatus, Bracket[]>; standardDeduction: Record<FilingStatus, number>; oasdiCap: number };

const TAX_CONSTANTS_BY_YEAR: Record<number, YearTaxConstants> = {
  2025: {
    brackets: {
      SINGLE: [
        { rate: 0.1, upTo: 11925 },
        { rate: 0.12, upTo: 48475 },
        { rate: 0.22, upTo: 103350 },
        { rate: 0.24, upTo: 197300 },
        { rate: 0.32, upTo: 250525 },
        { rate: 0.35, upTo: 626350 },
        { rate: 0.37, upTo: Infinity },
      ],
      MFJ: [
        { rate: 0.1, upTo: 23850 },
        { rate: 0.12, upTo: 96950 },
        { rate: 0.22, upTo: 206700 },
        { rate: 0.24, upTo: 394600 },
        { rate: 0.32, upTo: 501050 },
        { rate: 0.35, upTo: 751600 },
        { rate: 0.37, upTo: Infinity },
      ],
    },
    standardDeduction: { SINGLE: 15750, MFJ: 31500 },
    oasdiCap: 176100,
  },
  // TODO: verify against Rev. Proc. 2025-32 (same estimates as gennaroanesi.com).
  2026: {
    brackets: {
      SINGLE: [
        { rate: 0.1, upTo: 12225 },
        { rate: 0.12, upTo: 49700 },
        { rate: 0.22, upTo: 105950 },
        { rate: 0.24, upTo: 202250 },
        { rate: 0.32, upTo: 256800 },
        { rate: 0.35, upTo: 642150 },
        { rate: 0.37, upTo: Infinity },
      ],
      MFJ: [
        { rate: 0.1, upTo: 24450 },
        { rate: 0.12, upTo: 99400 },
        { rate: 0.22, upTo: 211900 },
        { rate: 0.24, upTo: 404500 },
        { rate: 0.32, upTo: 513600 },
        { rate: 0.35, upTo: 770400 },
        { rate: 0.37, upTo: Infinity },
      ],
    },
    standardDeduction: { SINGLE: 16150, MFJ: 32300 },
    oasdiCap: 184500,
  },
};

function latestKeyed<T>(table: Record<number, T>, year: number): T {
  if (table[year] != null) return table[year];
  const years = Object.keys(table).map(Number).sort((a, b) => a - b);
  // Before the first year → the first; otherwise the latest at or below.
  const at = years.filter((y) => y <= year);
  return table[at.length ? at[at.length - 1] : years[0]];
}

export function taxConstantsForYear(year: number): YearTaxConstants {
  return latestKeyed(TAX_CONSTANTS_BY_YEAR, year);
}

const OASDI_RATE = 0.062;
const MEDICARE_RATE = 0.0145;
const ADDITIONAL_MEDICARE_RATE = 0.009;
/** Per-employee withholding trigger for Additional Medicare (IRC §3101(b)(2)). */
const ADDITIONAL_MEDICARE_WH_THRESHOLD = 200000;
/** Filing-status thresholds for Additional Medicare owed (Form 8959). */
const ADDITIONAL_MEDICARE_TAX_THRESHOLDS: Record<FilingStatus, number> = { SINGLE: 200000, MFJ: 250000 };
/** IRS supplemental flat rate (Pub 15) — fallback when no observed rate. */
export const SUPPLEMENTAL_FED_RATE = 0.22;

const IRS_401K_ELECTIVE_LIMITS: Record<number, number> = { 2025: 23500, 2026: 24500 };
const IRS_401K_TOTAL_LIMITS: Record<number, number> = { 2025: 70000, 2026: 72000 };

/** §402(g) employee elective-deferral limit (pre-tax + Roth). Catch-up not modeled. */
export function irs401kElectiveLimit(year: number): number {
  return latestKeyed(IRS_401K_ELECTIVE_LIMITS, year);
}
/** §415(c) total annual additions (employee + employer + after-tax). */
export function irs401kTotalLimit(year: number): number {
  return latestKeyed(IRS_401K_TOTAL_LIMITS, year);
}

export function bracketTax(brackets: Bracket[], income: number): number {
  if (income <= 0) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    if (income <= b.upTo) return tax + (income - prev) * b.rate;
    tax += (b.upTo - prev) * b.rate;
    prev = b.upTo;
  }
  return tax;
}

// ── Paychecks ─────────────────────────────────────────────────────────────

/** The homePaycheck fields the projection reads. */
export type TaxPaycheck = {
  personId: string;
  payDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  gross?: number | null;
  contrib401k?: number | null;
  contribRoth401k?: number | null;
  ytdGross?: number | null;
  ytdTaxableWage?: number | null;
  ytdFedWh?: number | null;
  ytdOasdi?: number | null;
  ytdMedicare?: number | null;
  ytd401k?: number | null;
  ytdRoth401k?: number | null;
  ytdAfterTax401k?: number | null;
  ytdNet?: number | null;
  bonusGross?: number | null;
  rsuGross?: number | null;
  ytdBonusGross?: number | null;
  ytdRsuGross?: number | null;
  ytdSupplementalFedWh?: number | null;
  lineItems?: unknown;
};

/** Pay periods per year from the period length; `fallback` when dates are missing. */
export function inferPaychecksPerYear(p: { periodStart?: string | null; periodEnd?: string | null }, fallback = 26): number {
  if (!p.periodStart || !p.periodEnd) return fallback;
  const days = Math.round((Date.parse(`${p.periodEnd}T00:00:00Z`) - Date.parse(`${p.periodStart}T00:00:00Z`)) / 86400000) + 1;
  if (days <= 10) return 52;
  if (days <= 14) return 26;
  if (days <= 22) return 24;
  return 12;
}

export function isPaycheckStale(payDateIso: string, todayIso: string, staleDays = 30): boolean {
  return (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${payDateIso}T00:00:00Z`)) / 86400000 > staleDays;
}

export const RSU_VEST_CADENCES = ["QUARTERLY", "MONTHLY", "SEMIANNUAL", "ANNUAL", "IRREGULAR"] as const;
export type RsuVestCadence = (typeof RSU_VEST_CADENCES)[number];
export const RSU_VEST_CADENCE_LABELS: Record<RsuVestCadence, string> = {
  QUARTERLY: "Quarterly (4/yr)",
  MONTHLY: "Monthly (12/yr)",
  SEMIANNUAL: "Semi-annual (2/yr)",
  ANNUAL: "Annual (1/yr)",
  IRREGULAR: "Irregular (no extrapolation)",
};
const VESTS_PER_YEAR: Record<RsuVestCadence, number> = { QUARTERLY: 4, MONTHLY: 12, SEMIANNUAL: 2, ANNUAL: 1, IRREGULAR: 0 };

export type YtdProjection = {
  paychecksPerYear: number;
  paychecksElapsed: number;
  /** Σ per stub of max(0, gross − bonus − RSU): salary only (Workday's ytdGross folds bonuses in). */
  ytdSalaryGross: number;
  projectedGross: number; // salary only
  projectedTaxableWage: number; // salary taxable + projected supplemental
  projectedFedWh: number;
  projectedOasdi: number;
  projectedMedicare: number;
  projected401k: number;
  projectedAfterTax401k: number;
  projectedNet: number;
  ytdRsuGross: number;
  ytdBonusGross: number;
  vestsCompleted: number;
  vestsExpected: number;
  projectedRsuGross: number;
  projectedBonusGross: number; // held flat
  projectedTotalEarnings: number;
};

/**
 * Newest first. Stubs paid the same day (an RSU stub next to the regular
 * one) tie on date; the one with the larger YTD taxable wage is the later
 * cumulative snapshot, so it wins.
 */
export function sortLatestFirst<P extends TaxPaycheck>(paychecks: P[]): P[] {
  return [...paychecks].sort((a, b) => b.payDate.localeCompare(a.payDate) || (b.ytdTaxableWage ?? -1) - (a.ytdTaxableWage ?? -1));
}

const salaryOf = (p: TaxPaycheck) => Math.max(0, (p.gross ?? 0) - (p.bonusGross ?? 0) - (p.rsuGross ?? 0));

/**
 * One person's full-year projection from their paychecks for the year.
 * Salary extrapolates linearly from the count of regular stubs; RSU vests
 * on the chosen cadence; bonuses held flat. Federal withholding on
 * supplemental wages uses the observed rate when the stubs show it.
 */
export function projectFromPaychecks(args: { paychecks: TaxPaycheck[]; rsuVestCadence: RsuVestCadence; paychecksPerYearOverride?: number }): YtdProjection | null {
  const { paychecks, rsuVestCadence } = args;
  if (paychecks.length === 0) return null;
  const sorted = sortLatestFirst(paychecks);
  const latest = sorted[0];
  const latestRegular = sorted.find((p) => (p.gross ?? 0) > 0) ?? latest;
  const ppy = args.paychecksPerYearOverride ?? inferPaychecksPerYear(latestRegular);
  const regularCount = paychecks.filter((p) => salaryOf(p) > 0).length;
  const elapsed = Math.min(ppy, Math.max(1, regularCount));
  const scale = ppy / elapsed;

  const ytdRsuGross = latest.ytdRsuGross ?? paychecks.reduce((s, p) => s + (p.rsuGross ?? 0), 0);
  const ytdBonusGross = latest.ytdBonusGross ?? paychecks.reduce((s, p) => s + (p.bonusGross ?? 0), 0);
  const supplementalYtd = ytdRsuGross + ytdBonusGross;
  const ytdSalaryGross = paychecks.reduce((s, p) => s + salaryOf(p), 0);
  const ytdTaxableSalary = Math.max(0, (latest.ytdTaxableWage ?? 0) - supplementalYtd);
  const ytdSupplementalFedWh = latest.ytdSupplementalFedWh != null ? Math.max(0, latest.ytdSupplementalFedWh) : supplementalYtd * SUPPLEMENTAL_FED_RATE;
  const ytdSalaryFedWh = Math.max(0, (latest.ytdFedWh ?? 0) - ytdSupplementalFedWh);

  const projectedGross = ytdSalaryGross * scale;
  const projectedSalaryTaxable = ytdTaxableSalary * scale;
  const projectedSalaryFedWh = ytdSalaryFedWh * scale;
  const projected401k = ((latest.ytd401k ?? 0) + (latest.ytdRoth401k ?? 0)) * scale;
  const projectedAfterTax401k = (latest.ytdAfterTax401k ?? 0) * scale;
  const projectedNet = (latest.ytdNet ?? 0) * scale;

  let vestsCompleted = paychecks.filter((p) => (p.rsuGross ?? 0) > 0).length;
  if (vestsCompleted === 0 && ytdRsuGross > 0) vestsCompleted = 1;
  const vestsExpected = VESTS_PER_YEAR[rsuVestCadence];
  const additionalRsu = rsuVestCadence !== "IRREGULAR" && vestsCompleted > 0 && vestsCompleted < vestsExpected ? (ytdRsuGross / vestsCompleted) * (vestsExpected - vestsCompleted) : 0;
  const projectedRsuGross = ytdRsuGross + additionalRsu;
  const projectedBonusGross = ytdBonusGross;
  const supplementalRate = supplementalYtd > 0 && ytdSupplementalFedWh > 0 ? ytdSupplementalFedWh / supplementalYtd : SUPPLEMENTAL_FED_RATE;

  const projectedTaxableWage = projectedSalaryTaxable + projectedRsuGross + projectedBonusGross;
  const projectedFedWh = projectedSalaryFedWh + ytdSupplementalFedWh + additionalRsu * supplementalRate;
  const projectedTotalEarnings = projectedGross + projectedRsuGross + projectedBonusGross;

  // FICA from projected year-end wages (OASDI caps; Medicare adds 0.9% over $200k per employer).
  const year = Number(latest.payDate.slice(0, 4));
  const { oasdiCap } = taxConstantsForYear(year);
  const projectedOasdi = Math.min(projectedTotalEarnings, oasdiCap) * OASDI_RATE;
  const projectedMedicare = projectedTotalEarnings * MEDICARE_RATE + Math.max(0, projectedTotalEarnings - ADDITIONAL_MEDICARE_WH_THRESHOLD) * ADDITIONAL_MEDICARE_RATE;

  return {
    paychecksPerYear: ppy,
    paychecksElapsed: elapsed,
    ytdSalaryGross,
    projectedGross,
    projectedTaxableWage,
    projectedFedWh,
    projectedOasdi,
    projectedMedicare,
    projected401k,
    projectedAfterTax401k,
    projectedNet,
    ytdRsuGross,
    ytdBonusGross,
    vestsCompleted,
    vestsExpected,
    projectedRsuGross,
    projectedBonusGross,
    projectedTotalEarnings,
  };
}

/** Single-stub projection (no RSU extrapolation). Kept for parity with gennaroanesi.com. */
export function projectFromYTD(paycheck: TaxPaycheck, paychecksPerYearOverride?: number): YtdProjection {
  const out = projectFromPaychecks({ paychecks: [paycheck], rsuVestCadence: "IRREGULAR", paychecksPerYearOverride });
  if (out) return out;
  return {
    paychecksPerYear: paychecksPerYearOverride ?? 26,
    paychecksElapsed: 1,
    ytdSalaryGross: 0,
    projectedGross: 0,
    projectedTaxableWage: 0,
    projectedFedWh: 0,
    projectedOasdi: 0,
    projectedMedicare: 0,
    projected401k: 0,
    projectedAfterTax401k: 0,
    projectedNet: 0,
    ytdRsuGross: 0,
    ytdBonusGross: 0,
    vestsCompleted: 0,
    vestsExpected: 0,
    projectedRsuGross: 0,
    projectedBonusGross: 0,
    projectedTotalEarnings: 0,
  };
}

/** Employee 401(k) contribution rate so far: YTD elective ÷ YTD salary (falls back to the latest regular stub). */
export function current401kPct(paychecks: TaxPaycheck[], ytdSalaryGross: number): number {
  const sorted = sortLatestFirst(paychecks);
  const latest = sorted[0];
  if (!latest) return 0;
  const ytd = (latest.ytd401k ?? 0) + (latest.ytdRoth401k ?? 0);
  if (ytdSalaryGross > 0) return ytd / ytdSalaryGross;
  const reg = sorted.find((p) => salaryOf(p) > 0);
  return reg ? ((reg.contrib401k ?? 0) + (reg.contribRoth401k ?? 0)) / salaryOf(reg) : 0;
}

// ── Tax owed ──────────────────────────────────────────────────────────────

/** Additional Medicare liability on combined Medicare wages over the filing threshold. */
export function additionalMedicareTaxOwed(args: { combinedMedicareWages: number; filingStatus: FilingStatus }): number {
  return Math.max(0, args.combinedMedicareWages - ADDITIONAL_MEDICARE_TAX_THRESHOLDS[args.filingStatus]) * ADDITIONAL_MEDICARE_RATE;
}

/** Additional Medicare already withheld: 0.9% of each person's wages over $200k. */
export function additionalMedicareTaxWithheld(args: { perPersonMedicareWages: number[] }): number {
  return args.perPersonMedicareWages.reduce((s, w) => s + Math.max(0, w - ADDITIONAL_MEDICARE_WH_THRESHOLD) * ADDITIONAL_MEDICARE_RATE, 0);
}

/** Regular federal income tax on wages after the standard deduction. */
export function taxOwedFederal(args: { projectedTaxableWage: number; filingStatus: FilingStatus; year: number }): number {
  const c = taxConstantsForYear(args.year);
  return bracketTax(c.brackets[args.filingStatus], Math.max(0, args.projectedTaxableWage - c.standardDeduction[args.filingStatus]));
}

/** Positive = refund, negative = owed at filing. */
export function taxGap(projectedFedWh: number, taxOwed: number): number {
  return projectedFedWh - taxOwed;
}

// ── 401(k) ────────────────────────────────────────────────────────────────

export type Contribution401kProjection = {
  projected401k: number;
  uncapped: number;
  irsLimit: number;
  headroom: number;
  capReached: boolean;
  /** What the linear projection would have deferred past the cap (it stays taxable). */
  excessOverCap: number;
};

/** Year-end elective deferral at `contributionPct` of the remaining salary, capped at §402(g). */
export function project401kWithCap(args: { ytd401k: number; ytdGross: number; projectedGross: number; contributionPct: number; year: number }): Contribution401kProjection {
  const irsLimit = irs401kElectiveLimit(args.year);
  const remaining = Math.max(0, args.projectedGross - args.ytdGross);
  const headroomBefore = Math.max(0, irsLimit - args.ytd401k);
  const desired = remaining * args.contributionPct;
  const actual = Math.min(desired, headroomBefore);
  const projected = args.ytd401k + actual;
  return {
    projected401k: projected,
    uncapped: args.ytd401k + desired,
    irsLimit,
    headroom: Math.max(0, irsLimit - projected),
    capReached: actual >= headroomBefore && headroomBefore > 0,
    excessOverCap: Math.max(0, desired - actual),
  };
}

/** The rate that just reaches the cap by year-end; null when already there or no salary left. */
export function contribPctToReachCap(args: { ytd401k: number; ytdGross: number; projectedGross: number; year: number }): number | null {
  const headroom = irs401kElectiveLimit(args.year) - args.ytd401k;
  if (headroom <= 0) return null;
  const remaining = Math.max(0, args.projectedGross - args.ytdGross);
  if (remaining <= 0) return null;
  return Math.min(1, headroom / remaining);
}

type LineItemLike = { name?: string | null; type?: string | null; ytd?: number | null; amount?: number | null };

function readLineItems(lineItems: unknown): LineItemLike[] {
  let v = lineItems;
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as LineItemLike[]) : [];
}

const isMatch = (it: LineItemLike) => it?.type === "EMPLOYER_PAID" && !!it.name && /match/i.test(it.name);

/** Employer 401(k) match YTD from a stub's lineItems (EMPLOYER_PAID rows named "…match…"). */
export function extractEmployerMatchYtd(lineItems: unknown): number {
  return readLineItems(lineItems)
    .filter(isMatch)
    .reduce((s, it) => s + (Number.isFinite(it.ytd ?? it.amount ?? 0) ? (it.ytd ?? it.amount ?? 0) : 0), 0);
}

/** Employer match on this stub alone; 0 with a positive YTD means the match has capped out. */
export function extractEmployerMatchPeriod(lineItems: unknown): number {
  return readLineItems(lineItems)
    .filter(isMatch)
    .reduce((s, it) => s + (Number.isFinite(it.amount ?? 0) ? (it.amount ?? 0) : 0), 0);
}

export type Mega401kProjection = {
  irsLimit: number;
  ytdTotal: number;
  projectedEmployee: number;
  projectedEmployerMatch: number;
  projectedAfterTax: number;
  projectedTotal: number;
  headroom: number;
  /** Room left for more after-tax (mega-backdoor) contributions this year. */
  afterTaxHeadroom: number;
  capReached: boolean;
};

/** §415(c) total additions at year-end, and mega-backdoor headroom. */
export function project415cTotal(args: {
  ytdEmployee: number;
  ytdEmployerMatch: number;
  ytdAfterTax: number;
  ytdGross: number;
  projectedGross: number;
  projectedEmployee: number;
  latestPeriodMatch?: number | null;
  year: number;
}): Mega401kProjection {
  const irsLimit = irs401kTotalLimit(args.year);
  const scale = args.ytdGross > 0 ? args.projectedGross / args.ytdGross : 1;
  const plateaued = args.latestPeriodMatch != null && args.latestPeriodMatch === 0 && args.ytdEmployerMatch > 0;
  // Conservative ceiling: most plans cap the match at 50% of the elective limit.
  const matchCeiling = irs401kElectiveLimit(args.year) * 0.5;
  const projectedEmployerMatch = plateaued ? args.ytdEmployerMatch : Math.min(args.ytdEmployerMatch * scale, Math.max(matchCeiling, args.ytdEmployerMatch));
  const projectedAfterTax = args.ytdAfterTax * scale;
  const uncapped = args.projectedEmployee + projectedEmployerMatch + projectedAfterTax;
  const projectedTotal = Math.min(irsLimit, uncapped);
  return {
    irsLimit,
    ytdTotal: args.ytdEmployee + args.ytdEmployerMatch + args.ytdAfterTax,
    projectedEmployee: args.projectedEmployee,
    projectedEmployerMatch,
    projectedAfterTax,
    projectedTotal,
    headroom: Math.max(0, irsLimit - projectedTotal),
    afterTaxHeadroom: Math.max(0, irsLimit - uncapped),
    capReached: uncapped >= irsLimit,
  };
}

// ── Per-person and combined outcomes ──────────────────────────────────────

export type PersonOutcome = {
  taxableWage: number;
  fedWh: number;
  taxOwed: number;
  gap: number;
  new401k: number;
  irsLimit: number;
  capReached: boolean;
  medicareWages: number;
};

/**
 * One person's year-end at a 401(k) rate (null = their current rate),
 * cap-aware: a rate that would have hit the cap leaves the excess taxable,
 * and a higher what-if rate only lowers taxable wages up to the cap.
 * `filingStatus` is for the standalone (single-filer) view.
 */
export function personOutcome(args: {
  projection: YtdProjection;
  ytd401k: number;
  currentPct: number;
  pct: number | null;
  year: number;
  filingStatus?: FilingStatus;
}): PersonOutcome {
  const { projection: p, year } = args;
  const base = { ytd401k: args.ytd401k, ytdGross: p.ytdSalaryGross, projectedGross: p.projectedGross, year };
  const cur = project401kWithCap({ ...base, contributionPct: args.currentPct });
  const adj = project401kWithCap({ ...base, contributionPct: args.pct ?? args.currentPct });
  const taxableWage = Math.max(0, p.projectedTaxableWage + cur.excessOverCap - (adj.projected401k - cur.projected401k));
  const filingStatus = args.filingStatus ?? "SINGLE";
  const addl =
    additionalMedicareTaxOwed({ combinedMedicareWages: p.projectedTotalEarnings, filingStatus }) - additionalMedicareTaxWithheld({ perPersonMedicareWages: [p.projectedTotalEarnings] });
  const taxOwed = taxOwedFederal({ projectedTaxableWage: taxableWage, filingStatus, year }) + addl;
  return {
    taxableWage,
    fedWh: p.projectedFedWh,
    taxOwed,
    gap: taxGap(p.projectedFedWh, taxOwed),
    new401k: adj.projected401k,
    irsLimit: adj.irsLimit,
    capReached: adj.capReached,
    medicareWages: p.projectedTotalEarnings,
  };
}

export type CombinedOutcome = {
  filingStatus: FilingStatus;
  taxableWage: number;
  fedWh: number;
  bracketTax: number;
  /** Additional Medicare owed minus what payroll already withheld (negative = refund of over-withholding). */
  addlMedicare: number;
  taxOwed: number;
  gap: number;
};

/** The household return: MFJ on combined wages, or the per-person SINGLE results summed. */
export function combinedOutcome(people: PersonOutcome[], filingStatus: FilingStatus, year: number): CombinedOutcome {
  const fedWh = people.reduce((s, o) => s + o.fedWh, 0);
  if (filingStatus === "SINGLE") {
    const taxOwed = people.reduce((s, o) => s + o.taxOwed, 0);
    const taxableWage = people.reduce((s, o) => s + o.taxableWage, 0);
    const bracketTax = people.reduce((s, o) => s + taxOwedFederal({ projectedTaxableWage: o.taxableWage, filingStatus: "SINGLE", year }), 0);
    return { filingStatus, taxableWage, fedWh, bracketTax, addlMedicare: taxOwed - bracketTax, taxOwed, gap: taxGap(fedWh, taxOwed) };
  }
  const taxableWage = people.reduce((s, o) => s + o.taxableWage, 0);
  const bracketTax = taxOwedFederal({ projectedTaxableWage: taxableWage, filingStatus: "MFJ", year });
  const wages = people.map((o) => o.medicareWages);
  const addlMedicare =
    additionalMedicareTaxOwed({ combinedMedicareWages: wages.reduce((s, w) => s + w, 0), filingStatus: "MFJ" }) - additionalMedicareTaxWithheld({ perPersonMedicareWages: wages });
  const taxOwed = bracketTax + addlMedicare;
  return { filingStatus, taxableWage, fedWh, bracketTax, addlMedicare, taxOwed, gap: taxGap(fedWh, taxOwed) };
}

// ── Underpayment penalty (safe harbor) ────────────────────────────────────

/** Estimated-tax due dates for a tax year: Apr 15, Jun 15, Sep 15, Jan 15 of the next year. */
export function estimatedTaxDueDates(year: number): string[] {
  return [`${year}-04-15`, `${year}-06-15`, `${year}-09-15`, `${year + 1}-01-15`];
}

/** The next estimated-tax due date on or after today for that tax year, or null when past. */
export function nextEstimatedDueDate(year: number, todayIso: string): string | null {
  return estimatedTaxDueDates(year).find((d) => d >= todayIso) ?? null;
}

export type SafeHarbor = {
  /** Total paid in: withholding + estimated payments. */
  paid: number;
  /** The required annual payment: the smaller of the current- and prior-year tests. */
  floor: number;
  binding: "90% of this year's tax" | "100% of last year's tax" | "110% of last year's tax";
  t90: number;
  priorTest: number | null;
  /** True when paid clears the floor or the balance due is under $1,000. */
  safe: boolean;
  shortfall: number;
  /** How much can be owed at filing with no penalty. */
  cushion: number;
  balanceDue: number;
  /** 110% when prior-year AGI was over $150k ($75k MFS), else 100%. */
  priorMultiplier: number;
};

/**
 * Whether withholding + estimated payments avoid the underpayment penalty
 * (IRC §6654): pay at least the smaller of 90% of this year's tax or
 * 100% (110% if prior-year AGI > $150k) of last year's tax, or owe under
 * $1,000. Withholding counts as paid evenly through the year, so extra
 * withholding before December fixes earlier quarters; estimated payments
 * count from the date paid (not modeled per quarter here).
 */
export function safeHarbor(args: { taxOwed: number; withheld: number; estimatedPaid?: number; priorYearTax?: number | null; priorYearAgi?: number | null }): SafeHarbor {
  const paid = args.withheld + (args.estimatedPaid ?? 0);
  const t90 = 0.9 * Math.max(0, args.taxOwed);
  const prior = args.priorYearTax && args.priorYearTax > 0 ? args.priorYearTax : null;
  const priorMultiplier = args.priorYearAgi != null && args.priorYearAgi > 150000 ? 1.1 : args.priorYearAgi != null ? 1.0 : 1.1;
  const priorTest = prior != null ? prior * priorMultiplier : null;
  const usePrior = priorTest != null && priorTest < t90;
  const floor = usePrior ? priorTest! : t90;
  const binding: SafeHarbor["binding"] = usePrior ? (priorMultiplier > 1 ? "110% of last year's tax" : "100% of last year's tax") : "90% of this year's tax";
  const balanceDue = args.taxOwed - paid;
  return {
    paid,
    floor,
    binding,
    t90,
    priorTest,
    safe: paid >= floor - 0.5 || balanceDue < 1000,
    shortfall: Math.max(0, floor - paid),
    cushion: Math.max(0, args.taxOwed - floor),
    balanceDue,
    priorMultiplier,
  };
}
