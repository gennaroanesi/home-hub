// Reporting periods for the finance pages (Budget, Review): a calendar
// month, quarter or year, or the last 3 months ending today. Same model as
// gennaroanesi.com's review.ts Period. Pure; the picker UI is
// components/finance/period-picker.tsx.

import { addDays, addMonthsAnchored, lastDayOfMonth, type DateRange } from "./dates";

export type Period =
  | { kind: "month"; year: number; month: number } // month: 1–12
  | { kind: "quarter"; year: number; quarter: number } // quarter: 1–4
  | { kind: "year"; year: number }
  | { kind: "last3" }; // rolling 3 months ending today

export type PeriodKind = Period["kind"];

export const PERIOD_KINDS: Array<{ kind: PeriodKind; label: string }> = [
  { kind: "month", label: "Month" },
  { kind: "quarter", label: "Quarter" },
  { kind: "year", label: "Year" },
  { kind: "last3", label: "Last 3 mo" },
];

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad2 = (n: number) => String(n).padStart(2, "0");

export function periodRange(p: Period, todayIso: string): DateRange {
  switch (p.kind) {
    case "month":
      return { fromIso: `${p.year}-${pad2(p.month)}-01`, toIso: `${p.year}-${pad2(p.month)}-${pad2(lastDayOfMonth(p.year, p.month))}`, label: `${MONTH_NAMES[p.month - 1]} ${p.year}` };
    case "quarter": {
      const first = (p.quarter - 1) * 3 + 1;
      const last = first + 2;
      return { fromIso: `${p.year}-${pad2(first)}-01`, toIso: `${p.year}-${pad2(last)}-${pad2(lastDayOfMonth(p.year, last))}`, label: `Q${p.quarter} ${p.year}` };
    }
    case "year":
      return { fromIso: `${p.year}-01-01`, toIso: `${p.year}-12-31`, label: String(p.year) };
    case "last3":
      return { fromIso: addDays(addMonthsAnchored(todayIso, -3, Number(todayIso.slice(8, 10))), 1), toIso: todayIso, label: "Last 3 months" };
  }
}

/** The period of `kind` that contains `iso`. */
export function periodContaining(kind: PeriodKind, iso: string): Period {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  if (kind === "month") return { kind, year, month };
  if (kind === "quarter") return { kind, year, quarter: Math.floor((month - 1) / 3) + 1 };
  if (kind === "year") return { kind, year };
  return { kind: "last3" };
}

/** n periods later (negative = earlier). The rolling window doesn't move. */
export function shiftPeriod(p: Period, n: number): Period {
  if (p.kind === "month") {
    const total = p.year * 12 + (p.month - 1) + n;
    return { kind: "month", year: Math.floor(total / 12), month: (total % 12) + 1 };
  }
  if (p.kind === "quarter") {
    const total = p.year * 4 + (p.quarter - 1) + n;
    return { kind: "quarter", year: Math.floor(total / 4), quarter: (total % 4) + 1 };
  }
  if (p.kind === "year") return { kind: "year", year: p.year + n };
  return p;
}

/** Switch kind while staying near the date being looked at (today if the period contains it). */
export function switchKind(p: Period, kind: PeriodKind, todayIso: string): Period {
  const r = periodRange(p, todayIso);
  const near = todayIso >= r.fromIso && todayIso <= r.toIso ? todayIso : r.fromIso;
  return periodContaining(kind, near);
}

export function containsToday(p: Period, todayIso: string): boolean {
  const r = periodRange(p, todayIso);
  return todayIso >= r.fromIso && todayIso <= r.toIso;
}

/** "this month" / "this quarter" / "this year" / "these 3 months", for copy. */
export function periodNoun(p: Period): string {
  return p.kind === "last3" ? "these 3 months" : `this ${p.kind}`;
}

/** URL form: 2026-11, 2026-Q3, 2026, last3. */
export function periodToParam(p: Period): string {
  if (p.kind === "month") return `${p.year}-${pad2(p.month)}`;
  if (p.kind === "quarter") return `${p.year}-Q${p.quarter}`;
  if (p.kind === "year") return String(p.year);
  return "last3";
}

export function periodFromParam(s: string | null | undefined): Period | null {
  if (!s) return null;
  if (s === "last3") return { kind: "last3" };
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { kind: "month", year: Number(m[1]), month: Number(m[2]) };
  m = /^(\d{4})-Q([1-4])$/i.exec(s);
  if (m) return { kind: "quarter", year: Number(m[1]), quarter: Number(m[2]) };
  m = /^(\d{4})$/.exec(s);
  if (m) return { kind: "year", year: Number(m[1]) };
  return null;
}
