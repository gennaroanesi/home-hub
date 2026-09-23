// Derivations behind the home dashboard: which tasks need attention,
// what's on the calendar this week, which trips are coming up. Kept
// free of React and Amplify so the mobile Today screen can reuse it
// (see feedback: no parallel web/mobile derivation code).
//
// Tasks and events use the "real UTC" timestamp convention, so bucketing
// is done in the viewer's local day via plain Date math. Trip dates are
// date-only (YYYY-MM-DD) and compared as strings.

import { RRule } from "rrule";

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function addLocalDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

export function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export interface TaskLike {
  id: string;
  title: string;
  dueDate?: string | null;
  recurrence?: string | null;
  isCompleted?: boolean | null;
}

export interface DatedTask<T> {
  task: T;
  // Due date, or the next occurrence for an undated recurring task.
  date: Date | null;
}

export interface TaskBuckets<T> {
  overdue: DatedTask<T>[];
  today: DatedTask<T>[];
  upcoming: DatedTask<T>[]; // after today, within the window
  anytime: DatedTask<T>[]; // no due date, not recurring
}

// Next occurrence of an undated recurring task, anchored at `now` — "when
// it'd be due if scheduled fresh today". Null if the rule won't parse.
export function nextRecurrence(rrule: string, now: Date): Date | null {
  try {
    const parsed = RRule.fromString(rrule);
    const rule = new RRule({ ...parsed.origOptions, dtstart: now });
    return rule.after(now);
  } catch {
    return null;
  }
}

export function bucketTasks<T extends TaskLike>(
  tasks: T[],
  now: Date,
  windowDays = 7,
): TaskBuckets<T> {
  const todayStart = startOfLocalDay(now);
  const todayEnd = addLocalDays(todayStart, 1);
  const windowEnd = addLocalDays(todayStart, windowDays + 1);
  const out: TaskBuckets<T> = { overdue: [], today: [], upcoming: [], anytime: [] };

  for (const task of tasks) {
    if (task.isCompleted) continue;
    let date: Date | null = null;
    if (task.dueDate) date = new Date(task.dueDate);
    else if (task.recurrence) {
      date = nextRecurrence(task.recurrence, now);
      // Unparseable rule — surface it rather than hide it.
      if (!date) {
        out.today.push({ task, date: null });
        continue;
      }
    }
    if (!date) out.anytime.push({ task, date: null });
    else if (date < todayStart) out.overdue.push({ task, date });
    else if (date < todayEnd) out.today.push({ task, date });
    else if (date < windowEnd) out.upcoming.push({ task, date });
  }

  const byDate = (a: DatedTask<T>, b: DatedTask<T>) =>
    (a.date?.getTime() ?? Infinity) - (b.date?.getTime() ?? Infinity) ||
    a.task.title.localeCompare(b.task.title);
  out.overdue.sort(byDate);
  out.today.sort(byDate);
  out.upcoming.sort(byDate);
  out.anytime.sort(byDate);
  return out;
}

// ── Calendar events ──────────────────────────────────────────────────────────

export interface EventLike {
  id: string;
  title: string;
  startAt: string;
  endAt?: string | null;
  isAllDay?: boolean | null;
  recurrence?: string | null;
}

export interface EventOccurrence<E> {
  event: E;
  start: Date;
  end: Date;
  allDay: boolean;
}

// Occurrences overlapping [from, to), recurring events expanded the same
// way the calendar page does (rule anchored at the event's startAt).
// Sorted by start; all-day items first within a day.
export function eventOccurrences<E extends EventLike>(
  events: E[],
  from: Date,
  to: Date,
): EventOccurrence<E>[] {
  const out: EventOccurrence<E>[] = [];
  for (const event of events) {
    const start0 = new Date(event.startAt);
    const duration = event.endAt
      ? Math.max(0, new Date(event.endAt).getTime() - start0.getTime())
      : 60 * 60 * 1000;
    const allDay = !!event.isAllDay;

    let starts: Date[] = [start0];
    if (event.recurrence) {
      try {
        const rule = new RRule({
          ...RRule.fromString(event.recurrence).origOptions,
          dtstart: start0,
        });
        // Look back by the duration so a multi-day occurrence that
        // started before `from` still counts.
        starts = rule.between(new Date(from.getTime() - duration), to, true);
      } catch {
        // Bad rule — fall back to the single stored occurrence.
      }
    }

    for (const start of starts) {
      const end = new Date(start.getTime() + duration);
      const overlaps = start < to && (end > from || start >= from);
      if (overlaps) out.push({ event, start, end, allDay });
    }
  }
  return out.sort((a, b) => {
    const dayA = startOfLocalDay(a.start).getTime();
    const dayB = startOfLocalDay(b.start).getTime();
    if (dayA !== dayB) return dayA - dayB;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start.getTime() - b.start.getTime();
  });
}

// ── Trips ────────────────────────────────────────────────────────────────────

export interface TripLike {
  id: string;
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

export interface UpcomingTrip<T> {
  trip: T;
  ongoing: boolean;
  daysAway: number; // 0 when ongoing
}

// Trips in progress or starting within `horizonDays` of today.
export function upcomingTrips<T extends TripLike>(
  trips: T[],
  todayYmd: string,
  horizonDays = 60,
): UpcomingTrip<T>[] {
  const today = Date.parse(`${todayYmd}T00:00:00Z`);
  return trips
    .filter((t) => t.endDate >= todayYmd)
    .map((t) => {
      const daysAway = Math.round((Date.parse(`${t.startDate}T00:00:00Z`) - today) / DAY_MS);
      return { trip: t, ongoing: daysAway <= 0, daysAway: Math.max(0, daysAway) };
    })
    .filter((t) => t.daysAway <= horizonDays)
    .sort((a, b) => a.trip.startDate.localeCompare(b.trip.startDate));
}

// ── Formatting ───────────────────────────────────────────────────────────────

// "Today", "Tomorrow", "Thu", or "Oct 12" relative to `now`.
export function relativeDayLabel(d: Date, now: Date): string {
  const diff = Math.round(
    (startOfLocalDay(d).getTime() - startOfLocalDay(now).getTime()) / DAY_MS,
  );
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
