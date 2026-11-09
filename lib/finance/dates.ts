// Date, cadence and period helpers for household finance. All dates are
// YYYY-MM-DD strings; arithmetic is done in UTC so the Lambda and the
// browser agree regardless of their time zone.

export const CADENCES = ["ONCE", "WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "SEMIANNUALLY", "ANNUALLY"] as const;
export type Cadence = (typeof CADENCES)[number];

export const CADENCE_LABELS: Record<Cadence, string> = {
  ONCE: "One-time",
  WEEKLY: "Weekly",
  BIWEEKLY: "Every 2 weeks",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  SEMIANNUALLY: "Every 6 months",
  ANNUALLY: "Yearly",
};

/** Monthly-equivalent factor, for "what does this cost per month". */
export const CADENCE_MONTHLY_FACTOR: Record<Cadence, number> = {
  ONCE: 0,
  WEEKLY: 52 / 12,
  BIWEEKLY: 26 / 12,
  MONTHLY: 1,
  QUARTERLY: 1 / 3,
  SEMIANNUALLY: 1 / 6,
  ANNUALLY: 1 / 12,
};

const CADENCE_MONTH_STEP: Record<Cadence, number | null> = {
  ONCE: null,
  WEEKLY: null,
  BIWEEKLY: null,
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUALLY: 6,
  ANNUALLY: 12,
};

export type DateRange = { fromIso: string; toIso: string; label: string };

/** Today in the household's zone (America/Chicago), as YYYY-MM-DD. */
export function todayIso(timeZone = "America/Chicago", now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parse(toIso).getTime() - parse(fromIso).getTime()) / 86_400_000);
}

export function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Add n months keeping the anchor day, clamped to the month's last day (Jan 31 + 1 → Feb 28). */
export function addMonthsAnchored(iso: string, n: number, anchorDay: number): string {
  const [y, m] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(anchorDay, lastDayOfMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}
export function monthEnd(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${iso.slice(0, 7)}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}`;
}
export function previousDay(iso: string): string {
  return addDays(iso, -1);
}

/** One step of a cadence. ONCE returns the same date (callers' loops stop on no progress). */
export function advanceByCadence(iso: string, cadence: Cadence, anchorDate?: string | null): string {
  const step = CADENCE_MONTH_STEP[cadence];
  if (step != null) {
    const anchorDay = Number((anchorDate ?? iso).split("-")[2]);
    return addMonthsAnchored(iso, step, anchorDay);
  }
  if (cadence === "WEEKLY") return addDays(iso, 7);
  if (cadence === "BIWEEKLY") return addDays(iso, 14);
  return iso;
}

/** Every occurrence date of a schedule within [fromIso, toIso]. */
export function occurrencesBetween(
  rule: { cadence?: string | null; startDate?: string | null; nextDate?: string | null; endDate?: string | null },
  fromIso: string,
  toIso: string,
): string[] {
  const cadence = (rule.cadence ?? "MONTHLY") as Cadence;
  const anchor = rule.startDate ?? rule.nextDate ?? null;
  let cur = rule.nextDate ?? rule.startDate ?? null;
  if (!cur) return [];
  const out: string[] = [];
  for (let guard = 0; guard < 1000 && cur <= toIso; guard++) {
    if (rule.endDate && cur > rule.endDate) break;
    if (cur >= fromIso) out.push(cur);
    const next = advanceByCadence(cur, cadence, cadence === "WEEKLY" || cadence === "BIWEEKLY" ? null : anchor);
    if (next <= cur) break;
    cur = next;
  }
  return out;
}

/** Calendar month containing `iso`. */
export function monthRange(iso: string): DateRange {
  const from = monthStart(iso);
  const label = new Date(`${from}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return { fromIso: from, toIso: monthEnd(iso), label };
}

/** The month `n` months from the one containing `iso` (negative = earlier). */
export function shiftMonth(iso: string, n: number): string {
  return addMonthsAnchored(monthStart(iso), n, 1);
}

export function yearRange(year: number): DateRange {
  return { fromIso: `${year}-01-01`, toIso: `${year}-12-31`, label: String(year) };
}

/** YYYY-MM keys from the month of fromIso through the month of toIso. */
export function monthsIn(range: { fromIso: string; toIso: string }): string[] {
  const out: string[] = [];
  let cur = monthStart(range.fromIso);
  for (let guard = 0; guard < 600 && cur <= range.toIso; guard++) {
    out.push(cur.slice(0, 7));
    cur = shiftMonth(cur, 1);
  }
  return out;
}

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  if (!iso) return "—";
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

export function fmtCurrency(amount: number | null | undefined, opts: { sign?: boolean; cents?: boolean } = {}): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const cents = opts.cents ?? true;
  const s = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(Math.abs(amount));
  if (amount < 0) return `-${s}`;
  return opts.sign && amount > 0 ? `+${s}` : s;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Sign an amount by type: INCOME positive, EXPENSE negative, TRANSFER as a positive magnitude. */
export function normalizeAmountSign(amount: number, type: string | null | undefined): number {
  if (!Number.isFinite(amount)) return amount;
  const mag = Math.abs(amount);
  if (type === "INCOME" || type === "TRANSFER") return mag;
  if (type === "EXPENSE") return -mag;
  return amount;
}
