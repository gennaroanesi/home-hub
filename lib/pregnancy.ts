// Pregnancy date math + the standard prenatal care timeline.
//
// Everything here works on pure YYYY-MM-DD strings (same convention as
// homeTrip.startDate / homePet.dob) and does its arithmetic in UTC days,
// so there are no timezone games. Shared by the agent Lambda, the
// daily summary, and the /health page.
//
// Gestational age is counted from the LMP (last menstrual period), so
// the due date is LMP + 280 days (Naegele's rule). When a dating
// ultrasound moves the due date, the due date becomes the anchor and the
// "effective LMP" is derived from it — that's why every function below
// takes the due date, not the LMP.
//
// The care timeline reflects ACOG guidance for an average-risk
// pregnancy. It's a checklist of what usually happens when, not medical
// advice — the OB's actual plan overrides it (items can be rescheduled,
// marked N/A, or added by hand).

export const GESTATION_DAYS = 280;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Date primitives ──────────────────────────────────────────────────────────

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today's (or `at`'s) calendar date in `timeZone`, as YYYY-MM-DD. */
export function ymdInTimezone(timeZone: string, at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function addDaysYmd(ymd: string, days: number): string {
  return utcMsToYmd(ymdToUtcMs(ymd) + days * MS_PER_DAY);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((ymdToUtcMs(b) - ymdToUtcMs(a)) / MS_PER_DAY);
}

export function dueDateFromLmp(lmp: string): string {
  return addDaysYmd(lmp, GESTATION_DAYS);
}

export function lmpFromDueDate(dueDate: string): string {
  return addDaysYmd(dueDate, -GESTATION_DAYS);
}

/** Calendar date on which the pregnancy reaches `gestationalDays`. */
export function dateAtGestationalDay(dueDate: string, gestationalDays: number): string {
  return addDaysYmd(lmpFromDueDate(dueDate), gestationalDays);
}

// ── Gestational age ──────────────────────────────────────────────────────────

export interface GestationalAge {
  /** Total days since the (effective) LMP. */
  days: number;
  weeks: number;
  /** 0–6, the "+d" in "7w4d". */
  dayOfWeek: number;
  /** ACOG: 1st through 13w6d, 2nd 14w0d–27w6d, 3rd from 28w0d. */
  trimester: 1 | 2 | 3;
  /** Days until the due date; negative once past it. */
  daysToGo: number;
  /** "7w4d" */
  label: string;
}

export function gestationalAge(dueDate: string, today: string): GestationalAge {
  const days = daysBetween(lmpFromDueDate(dueDate), today);
  const weeks = Math.floor(days / 7);
  const dayOfWeek = days - weeks * 7;
  const trimester = weeks < 14 ? 1 : weeks < 28 ? 2 : 3;
  return {
    days,
    weeks,
    dayOfWeek,
    trimester,
    daysToGo: daysBetween(today, dueDate),
    label: `${weeks}w${dayOfWeek}d`,
  };
}

/** Human label for a gestational-day count, e.g. 53 → "7w4d". */
export function formatGestationalDays(days: number): string {
  const w = Math.floor(days / 7);
  return `${w}w${days - w * 7}d`;
}

// ── Care timeline ────────────────────────────────────────────────────────────

export const CARE_CATEGORIES = [
  "VISIT",
  "LAB",
  "IMAGING",
  "SCREENING",
  "VACCINE",
  "TREATMENT",
  "ADMIN",
] as const;
export type CareCategory = (typeof CARE_CATEGORIES)[number];

export const CARE_STATUSES = [
  "UPCOMING",
  "SCHEDULED",
  "DONE",
  "SKIPPED",
  "NOT_APPLICABLE",
] as const;
export type CareStatus = (typeof CARE_STATUSES)[number];

interface CareTemplateBase {
  key: string;
  title: string;
  category: CareCategory;
  /** Offered / patient's choice rather than routine for everyone. */
  optional?: boolean;
  notes?: string;
}

// Two anchoring modes:
//  - "gestational": window is a range of gestational days (most items).
//  - "season": a vaccine whose window is the intersection of a
//    gestational range with the respiratory-virus season. Resolved per
//    due date by buildCareTimeline — may come back NOT_APPLICABLE.
type CareTemplateItem = CareTemplateBase &
  (
    | { anchor: "gestational"; startDay: number; endDay: number }
    | {
        anchor: "season";
        startDay: number;
        endDay: number;
        /** Months (1–12) in which the vaccine is given. */
        seasonMonths: number[];
        /** Note used when the pregnancy's window misses the season. */
        offSeasonNote: string;
      }
  );

const w = (weeks: number, days = 0) => weeks * 7 + days;

// Flu / COVID season months (Sep → Mar) and maternal RSV (Sep → Jan).
const FLU_SEASON = [9, 10, 11, 12, 1, 2, 3];
const RSV_SEASON = [9, 10, 11, 12, 1];

export const CARE_TIMELINE: CareTemplateItem[] = [
  // ── First trimester ──
  {
    key: "intake_visit",
    title: "First prenatal visit",
    category: "VISIT",
    anchor: "gestational",
    startDay: w(6),
    endDay: w(10),
    notes: "History, exam and dating — ideally before 10 weeks.",
  },
  {
    key: "dating_ultrasound",
    title: "Dating ultrasound",
    category: "IMAGING",
    anchor: "gestational",
    startDay: w(7),
    endDay: w(11),
    notes: "Confirms the due date. If it moves the due date, update it here so every window shifts.",
  },
  {
    key: "initial_labs",
    title: "First-trimester lab panel",
    category: "LAB",
    anchor: "gestational",
    startDay: w(6),
    endDay: w(12),
    notes: "Blood type & Rh, antibody screen, CBC, rubella immunity, hepatitis B, HIV, syphilis, urine culture.",
  },
  {
    key: "carrier_screening",
    title: "Carrier screening",
    category: "SCREENING",
    optional: true,
    anchor: "gestational",
    startDay: w(6),
    endDay: w(14),
    notes: "Cystic fibrosis, SMA, hemoglobinopathies. Usually offered once; partner may be tested too.",
  },
  {
    key: "cfdna",
    title: "Cell-free DNA screening (NIPT)",
    category: "SCREENING",
    optional: true,
    anchor: "gestational",
    startDay: w(10),
    endDay: w(14),
    notes: "Blood test for chromosomal conditions; can also reveal sex. Available from 10 weeks.",
  },
  {
    key: "nt_scan",
    title: "Nuchal translucency (NT) scan",
    category: "IMAGING",
    optional: true,
    anchor: "gestational",
    startDay: w(11),
    endDay: w(13, 6),
  },
  // ── Second trimester ──
  {
    key: "anatomy_scan",
    title: "Anatomy scan",
    category: "IMAGING",
    anchor: "gestational",
    startDay: w(18),
    endDay: w(22),
  },
  {
    key: "glucose_test",
    title: "Glucose screening",
    category: "LAB",
    anchor: "gestational",
    startDay: w(24),
    endDay: w(28),
    notes: "Gestational diabetes screen. Often paired with a CBC and, if Rh-negative, an antibody screen.",
  },
  {
    key: "tdap",
    title: "Tdap vaccine",
    category: "VACCINE",
    anchor: "gestational",
    startDay: w(27),
    endDay: w(36),
    notes: "Every pregnancy, as early in the 27–36 week window as possible.",
  },
  {
    key: "rhogam",
    title: "Rh immune globulin (only if Rh-negative)",
    category: "TREATMENT",
    optional: true,
    anchor: "gestational",
    startDay: w(28),
    endDay: w(29),
    notes: "Mark N/A once blood type comes back Rh-positive.",
  },
  // ── Seasonal vaccines ──
  {
    key: "flu_vaccine",
    title: "Flu vaccine",
    category: "VACCINE",
    anchor: "season",
    startDay: 0,
    endDay: GESTATION_DAYS,
    seasonMonths: FLU_SEASON,
    offSeasonNote: "Pregnancy doesn't overlap flu season.",
    notes: "Safe in any trimester during flu season.",
  },
  {
    key: "covid_vaccine",
    title: "COVID vaccine",
    category: "VACCINE",
    optional: true,
    anchor: "season",
    startDay: 0,
    endDay: GESTATION_DAYS,
    seasonMonths: FLU_SEASON,
    offSeasonNote: "Pregnancy doesn't overlap respiratory-virus season.",
    notes: "ACOG recommends it in pregnancy — discuss with the OB.",
  },
  {
    key: "rsv_vaccine",
    title: "RSV vaccine (Abrysvo)",
    category: "VACCINE",
    anchor: "season",
    startDay: w(32),
    endDay: w(36),
    seasonMonths: RSV_SEASON,
    offSeasonNote:
      "32–36 weeks falls outside RSV vaccine season (Sep–Jan). Plan on nirsevimab for the baby before their first RSV season instead.",
  },
  // ── Third trimester ──
  {
    key: "gbs_swab",
    title: "Group B strep swab",
    category: "LAB",
    anchor: "gestational",
    startDay: w(36),
    endDay: w(37, 6),
  },
  // ── Admin ──
  {
    key: "parental_leave",
    title: "Parental leave / FMLA paperwork",
    category: "ADMIN",
    anchor: "gestational",
    startDay: w(24),
    endDay: w(30),
    notes: "FMLA generally wants 30 days' notice — check both employers' policies.",
  },
  {
    key: "pediatrician",
    title: "Choose a pediatrician",
    category: "ADMIN",
    anchor: "gestational",
    startDay: w(28),
    endDay: w(34),
  },
  {
    key: "hospital_preregistration",
    title: "Pre-register at the hospital",
    category: "ADMIN",
    anchor: "gestational",
    startDay: w(28),
    endDay: w(34),
  },
  {
    key: "car_seat",
    title: "Install car seat (get it inspected)",
    category: "ADMIN",
    anchor: "gestational",
    startDay: w(34),
    endDay: w(37),
  },
  {
    key: "hospital_bag",
    title: "Pack hospital bag",
    category: "ADMIN",
    anchor: "gestational",
    startDay: w(35),
    endDay: w(37),
  },
  // ── After birth (anchored to the due date until there's a birth date) ──
  {
    key: "add_baby_insurance",
    title: "Add baby to health insurance",
    category: "ADMIN",
    anchor: "gestational",
    startDay: GESTATION_DAYS,
    endDay: GESTATION_DAYS + 30,
    notes: "Usually a 30-day window from the birth date.",
  },
  {
    key: "postpartum_visit",
    title: "Postpartum checkup",
    category: "VISIT",
    anchor: "gestational",
    startDay: GESTATION_DAYS + 14,
    endDay: GESTATION_DAYS + 84,
    notes: "First contact within 3 weeks of birth; comprehensive visit by 12 weeks.",
  },
];

export interface ResolvedCareItem {
  key: string;
  title: string;
  category: CareCategory;
  optional: boolean;
  notes: string | null;
  windowStart: string;
  windowEnd: string;
  /** Initial status: NOT_APPLICABLE for off-season vaccines, else UPCOMING. */
  status: CareStatus;
  sortOrder: number;
}

function monthOf(ymd: string): number {
  return Number(ymd.slice(5, 7));
}

// First and last dates within [start, end] whose month is in `months`.
// Returns null when no day in the range qualifies. Walks day by day —
// ranges are at most ~300 days, so this is trivially cheap.
function clampToMonths(
  start: string,
  end: string,
  months: number[],
): { start: string; end: string } | null {
  let first: string | null = null;
  let last: string | null = null;
  for (let d = start; d <= end; d = addDaysYmd(d, 1)) {
    if (months.includes(monthOf(d))) {
      if (!first) first = d;
      last = d;
    } else if (first) {
      break; // only the first contiguous in-season stretch
    }
  }
  return first && last ? { start: first, end: last } : null;
}

/** Resolve the template against a due date into concrete date windows. */
export function buildCareTimeline(dueDate: string): ResolvedCareItem[] {
  return CARE_TIMELINE.map((t, i) => {
    const start = dateAtGestationalDay(dueDate, t.startDay);
    const end = dateAtGestationalDay(dueDate, t.endDay);
    const base = {
      key: t.key,
      title: t.title,
      category: t.category,
      optional: !!t.optional,
      notes: t.notes ?? null,
      sortOrder: i,
    };
    if (t.anchor === "gestational") {
      return { ...base, windowStart: start, windowEnd: end, status: "UPCOMING" as const };
    }
    const inSeason = clampToMonths(start, end, t.seasonMonths);
    if (!inSeason) {
      return {
        ...base,
        notes: t.offSeasonNote,
        windowStart: start,
        windowEnd: end,
        status: "NOT_APPLICABLE" as const,
      };
    }
    return {
      ...base,
      windowStart: inSeason.start,
      windowEnd: inSeason.end,
      status: "UPCOMING" as const,
    };
  }).sort((a, b) =>
    a.windowStart === b.windowStart ? a.sortOrder - b.sortOrder : a.windowStart < b.windowStart ? -1 : 1,
  ).map((item, i) => ({ ...item, sortOrder: i }));
}

// ── Timeline state helpers ───────────────────────────────────────────────────

export type CareUrgency = "OVERDUE" | "DUE_NOW" | "SOON" | "LATER" | "CLOSED";

/**
 * Where an item sits relative to `today`. Only open items (UPCOMING /
 * SCHEDULED) can be overdue or due; everything else is CLOSED.
 * SOON = window opens within `soonDays`.
 */
export function careUrgency(
  item: { status: CareStatus | string | null | undefined; windowStart: string; windowEnd: string },
  today: string,
  soonDays = 21,
): CareUrgency {
  if (item.status !== "UPCOMING" && item.status !== "SCHEDULED") return "CLOSED";
  if (today > item.windowEnd) return "OVERDUE";
  if (today >= item.windowStart) return "DUE_NOW";
  if (daysBetween(today, item.windowStart) <= soonDays) return "SOON";
  return "LATER";
}

export const CARE_CATEGORY_LABELS: Record<CareCategory, string> = {
  VISIT: "Visit",
  LAB: "Lab",
  IMAGING: "Imaging",
  SCREENING: "Screening",
  VACCINE: "Vaccine",
  TREATMENT: "Treatment",
  ADMIN: "Admin",
};

export const CARE_STATUS_LABELS: Record<CareStatus, string> = {
  UPCOMING: "Upcoming",
  SCHEDULED: "Scheduled",
  DONE: "Done",
  SKIPPED: "Skipped",
  NOT_APPLICABLE: "N/A",
};

/** Template keys whose window/status depend on the respiratory-virus season. */
export const SEASONAL_CARE_KEYS: ReadonlySet<string> = new Set(
  CARE_TIMELINE.filter((t) => t.anchor === "season").map((t) => t.key),
);

// ── Due-date changes ─────────────────────────────────────────────────────────

export interface ShiftableCareItem {
  id: string;
  key?: string | null;
  status?: string | null;
  windowStart: string;
  windowEnd: string;
}

export interface CareItemShift {
  id: string;
  windowStart: string;
  windowEnd: string;
  status?: CareStatus;
}

/**
 * Which care items move when the due date changes to `newDueDate`.
 * Only templated items (non-null key) that are still open shift; hand-
 * added items and closed items keep their dates as a record. Seasonal
 * vaccines can move in/out of season, so their UPCOMING ⇄ N/A status is
 * recomputed — any other N/A was a human decision and stays put.
 */
export function planCareShift(items: ShiftableCareItem[], newDueDate: string): CareItemShift[] {
  const fresh = new Map(buildCareTimeline(newDueDate).map((i) => [i.key, i]));
  const out: CareItemShift[] = [];
  for (const item of items) {
    if (!item.key) continue;
    const next = fresh.get(item.key);
    if (!next) continue;
    const isOpen = item.status === "UPCOMING" || item.status === "SCHEDULED";
    const seasonal = SEASONAL_CARE_KEYS.has(item.key);
    const autoFlip = seasonal && (item.status === "UPCOMING" || item.status === "NOT_APPLICABLE");
    if (!isOpen && !autoFlip) continue;
    if (
      next.windowStart === item.windowStart &&
      next.windowEnd === item.windowEnd &&
      (!autoFlip || next.status === item.status)
    ) {
      continue;
    }
    out.push({
      id: item.id,
      windowStart: next.windowStart,
      windowEnd: next.windowEnd,
      ...(autoFlip ? { status: next.status } : {}),
    });
  }
  return out;
}

// ── Writes (shared by the /health page and the agent) ────────────────────────
// Take the Amplify data client as `any` so both the browser (userPool)
// and Lambda (IAM) clients fit — same convention as lib/note-parent.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataClient = any;

/** Create the standard care timeline rows for a new pregnancy. */
export async function seedCareTimeline(
  client: DataClient,
  pregnancyId: string,
  dueDate: string,
): Promise<{ created: number; failed: number }> {
  let created = 0;
  let failed = 0;
  for (const item of buildCareTimeline(dueDate)) {
    const { errors } = await client.models.homeCareItem.create({
      pregnancyId,
      key: item.key,
      title: item.title,
      category: item.category,
      optional: item.optional,
      windowStart: item.windowStart,
      windowEnd: item.windowEnd,
      status: item.status,
      notes: item.notes,
      sortOrder: item.sortOrder,
    });
    if (errors?.length) failed++;
    else created++;
  }
  return { created, failed };
}

/** Apply planCareShift to a pregnancy's care items. Returns how many moved. */
export async function shiftCareTimeline(
  client: DataClient,
  pregnancyId: string,
  newDueDate: string,
): Promise<number> {
  const items: ShiftableCareItem[] = [];
  let nextToken: string | null = null;
  do {
    const res: { data?: ShiftableCareItem[]; nextToken?: string | null } =
      await client.models.homeCareItem.list({
        filter: { pregnancyId: { eq: pregnancyId } },
        limit: 500,
        nextToken,
      });
    items.push(...(res.data ?? []));
    nextToken = res.nextToken ?? null;
  } while (nextToken);
  const shifts = planCareShift(items, newDueDate);
  for (const s of shifts) {
    await client.models.homeCareItem.update(s);
  }
  return shifts.length;
}

export const DUE_DATE_SOURCE_LABELS: Record<string, string> = {
  LMP: "from last period",
  ULTRASOUND: "from ultrasound",
  IVF: "from IVF transfer",
  OTHER: "set manually",
};
