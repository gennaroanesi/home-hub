// The week planner: one week (Monday–Sunday) for the household, built from
// what's already stored — each person's day status (homeCalendarDay: office,
// home, PTO…), calendar events (native and the Apple family feed, with
// recurring ones expanded), trips, and the pets' days (homePetDay: daycare,
// boarding…). It also lists what needs a decision before the week starts:
// someone double-booked, family-calendar events nobody is assigned to, and
// weekdays without a status.
//
// Pure: callers load the rows (lib/ops/week.ts) and pass them in, so the
// web page, the mobile app, Janet and the Sunday WhatsApp nudge all see the
// same week.

import { RRule } from "rrule";
import type { WeekSections } from "./week-sections";

export const DAY_STATUSES = ["WORKING_OFFICE", "WORKING_HOME", "PTO", "TRAVEL", "VACATION", "CHOICE_DAY", "WEEKEND_HOLIDAY"] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export const DAY_STATUS_LABELS: Record<DayStatus, string> = {
  WORKING_OFFICE: "Office",
  WORKING_HOME: "Home",
  PTO: "PTO",
  TRAVEL: "Travel",
  VACATION: "Vacation",
  CHOICE_DAY: "Choice day",
  WEEKEND_HOLIDAY: "Holiday",
};

export const PET_DAY_STATUSES = ["DAYCARE", "BOARDING", "SITTER", "WITH_US"] as const;
export type PetDayStatus = (typeof PET_DAY_STATUSES)[number];

export const PET_DAY_LABELS: Record<PetDayStatus, string> = {
  DAYCARE: "Daycare",
  BOARDING: "Boarding",
  SITTER: "Sitter",
  WITH_US: "With us",
};

// ── Input rows (loose: they come straight from the data client) ─────────────

export type PersonRow = { id: string; name: string };
export type PetRow = { id: string; name: string };
export type EventRow = {
  id: string;
  title: string;
  startAt: string;
  endAt?: string | null;
  isAllDay?: boolean | null;
  assignedPersonIds?: (string | null)[] | null;
  recurrence?: string | null;
  feedId?: string | null;
  /** The feed's owner setting decides who it's for (lib/calendar-feeds.ts eventsFor). */
  feedOwned?: boolean;
  location?: { city?: string | null } | null;
};
export type DayRow = { id: string; date: string; personId: string; status?: string | null; notes?: string | null };
export type PetDayRow = { id: string; date: string; petId: string; status?: string | null; notes?: string | null };
export type TripRow = { id: string; name: string; startDate: string; endDate: string; participantIds?: (string | null)[] | null };

// ── Output ───────────────────────────────────────────────────────────────────

export type WeekEvent = {
  /** Event id; a recurring event's occurrences share it. */
  id: string;
  /** Unique per occurrence: `<id>@<date>` for recurring events. */
  key: string;
  title: string;
  date: string;
  /** Local HH:MM in the household timezone; null for all-day. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  personIds: string[];
  /** Pets named in the title ("Dolce Barkin Creek"). */
  petIds: string[];
  fromFeed: boolean;
  /** Its feed says whose it is, so the planner doesn't ask. */
  feedOwned: boolean;
  recurring: boolean;
  location: string | null;
};

export type PersonDay = {
  date: string;
  status: DayStatus | null;
  /** set = chosen for that day; trip = implied by a trip; null = nothing. */
  source: "set" | "trip" | null;
  notes: string | null;
  tripName: string | null;
  /** The homeCalendarDay row, when there is one. */
  dayId: string | null;
};

export type PetDay = { date: string; status: PetDayStatus | null; notes: string | null; petDayId: string | null };

export type Attention =
  | { kind: "unassigned"; date: string; eventKeys: string[]; detail: string }
  | { kind: "no-status"; personId: string; dates: string[]; detail: string };

export type WeekPlan = {
  weekStart: string;
  weekEnd: string;
  dates: string[];
  timeZone: string;
  people: Array<PersonRow & { days: PersonDay[] }>;
  pets: Array<PetRow & { days: PetDay[] }>;
  events: WeekEvent[];
  attention: Attention[];
};

// ── Dates ────────────────────────────────────────────────────────────────────

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
function weekdayIndex(iso: string): number {
  return (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7;
}

export function mondayOf(iso: string): string {
  return addDaysIso(iso, -weekdayIndex(iso));
}

/** The week a Sunday review is about: from Friday on, next week; otherwise this one. */
export function weekToPlan(todayIso: string): string {
  return weekdayIndex(todayIso) >= 4 ? addDaysIso(mondayOf(todayIso), 7) : mondayOf(todayIso);
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i));
}

export const isWeekday = (iso: string) => weekdayIndex(iso) < 5;

/** Local date and HH:MM of an instant in `timeZone`. */
export function localParts(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}


// ── Events ───────────────────────────────────────────────────────────────────

const DEFAULT_DURATION_MS = 60 * 60 * 1000;

function mentionsPet(title: string, pet: PetRow): boolean {
  const name = pet.name.trim();
  if (!name) return false;
  return new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu").test(title);
}

/** Every occurrence of the events that falls in the week, in local time. */
export function eventsInWeek(events: EventRow[], weekStart: string, timeZone: string, pets: PetRow[] = []): WeekEvent[] {
  const dates = weekDates(weekStart);
  const first = dates[0];
  const last = dates[6];
  const out: WeekEvent[] = [];

  const push = (e: EventRow, startMs: number, recurring: boolean) => {
    const personIds = (e.assignedPersonIds ?? []).filter((x): x is string => !!x);
    const base = {
      id: e.id,
      title: e.title,
      personIds,
      petIds: pets.filter((p) => mentionsPet(e.title, p)).map((p) => p.id),
      fromFeed: !!e.feedId,
      feedOwned: !!e.feedOwned,
      recurring,
      location: e.location?.city?.trim() || null,
    };
    const duration = e.endAt ? Math.max(0, new Date(e.endAt).getTime() - new Date(e.startAt).getTime()) : DEFAULT_DURATION_MS;
    if (e.isAllDay) {
      // All-day events are stored at midnight UTC of their date; the end is
      // exclusive (a one-day event ends the next midnight).
      const startDate = new Date(startMs).toISOString().slice(0, 10);
      const days = Math.max(1, Math.round(duration / 86_400_000));
      for (let i = 0; i < days; i++) {
        const date = addDaysIso(startDate, i);
        if (date < first || date > last) continue;
        out.push({ ...base, key: recurring || days > 1 ? `${e.id}@${date}` : e.id, date, start: null, end: null, allDay: true });
      }
      return;
    }
    const s = localParts(new Date(startMs), timeZone);
    if (s.date < first || s.date > last) return;
    const en = localParts(new Date(startMs + duration), timeZone);
    out.push({
      ...base,
      key: recurring ? `${e.id}@${s.date}` : e.id,
      date: s.date,
      start: s.time,
      // An event running past midnight ends at the end of its day here.
      end: en.date === s.date ? en.time : "23:59",
      allDay: false,
    });
  };

  // A generous UTC window; occurrences are then filtered by local date.
  const windowFrom = new Date(`${addDaysIso(first, -2)}T00:00:00Z`);
  const windowTo = new Date(`${addDaysIso(last, 2)}T23:59:59Z`);
  for (const e of events) {
    const startMs = new Date(e.startAt).getTime();
    if (Number.isNaN(startMs)) continue;
    if (e.recurrence) {
      try {
        const rule = new RRule({ ...RRule.fromString(e.recurrence).origOptions, dtstart: new Date(startMs) });
        // All-day occurrences can sit days before the window and still cover it.
        const span = e.isAllDay && e.endAt ? new Date(e.endAt).getTime() - startMs : 0;
        for (const occ of rule.between(new Date(windowFrom.getTime() - span), windowTo, true)) push(e, occ.getTime(), true);
        continue;
      } catch {
        // Unparseable rule: show the first occurrence only.
      }
    }
    push(e, startMs, false);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || (a.start ?? "").localeCompare(b.start ?? "") || a.title.localeCompare(b.title));
}

// ── The plan ─────────────────────────────────────────────────────────────────

const fmtDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

export function buildWeekPlan(input: {
  weekStart: string;
  timeZone: string;
  people: PersonRow[];
  pets?: PetRow[];
  events: EventRow[];
  days: DayRow[];
  petDays?: PetDayRow[];
  trips?: TripRow[];
}): WeekPlan {
  const weekStart = mondayOf(input.weekStart);
  const dates = weekDates(weekStart);
  const pets = input.pets ?? [];
  const events = eventsInWeek(input.events, weekStart, input.timeZone, pets);
  const everyone = input.people.map((p) => p.id);

  const people = input.people.map((p) => ({
    id: p.id,
    name: p.name,
    days: dates.map((date): PersonDay => {
      const row = input.days.find((d) => d.personId === p.id && d.date === date);
      const status = row && (DAY_STATUSES as readonly string[]).includes(row.status ?? "") ? (row.status as DayStatus) : null;
      const trip = (input.trips ?? []).find((t) => {
        const who = (t.participantIds ?? []).filter((x): x is string => !!x);
        return t.startDate <= date && t.endDate >= date && (who.length ? who : everyone).includes(p.id);
      });
      if (status) return { date, status, source: "set", notes: row?.notes ?? null, tripName: trip?.name ?? null, dayId: row!.id };
      if (trip) return { date, status: "TRAVEL", source: "trip", notes: row?.notes ?? null, tripName: trip.name, dayId: row?.id ?? null };
      return { date, status: null, source: null, notes: row?.notes ?? null, tripName: null, dayId: row?.id ?? null };
    }),
  }));

  const petPlans = pets.map((pet) => ({
    id: pet.id,
    name: pet.name,
    days: dates.map((date): PetDay => {
      const row = (input.petDays ?? []).find((d) => d.petId === pet.id && d.date === date);
      const status = row && (PET_DAY_STATUSES as readonly string[]).includes(row.status ?? "") ? (row.status as PetDayStatus) : null;
      return { date, status, notes: row?.notes ?? null, petDayId: row?.id ?? null };
    }),
  }));

  const attention: Attention[] = [];

  // Family-calendar events nobody is assigned to. Native events with no one
  // assigned are household events on purpose; feed events just don't say.
  for (const e of events) {
    if (e.fromFeed && !e.feedOwned && e.personIds.length === 0 && e.petIds.length === 0) {
      attention.push({ kind: "unassigned", date: e.date, eventKeys: [e.key], detail: `“${e.title}” on ${fmtDay(e.date)}${e.start ? ` ${e.start}` : ""}: who is it for?` });
    }
  }

  // Weekdays with no status (office / home / PTO…) for someone.
  for (const p of people) {
    const missing = p.days.filter((d) => isWeekday(d.date) && !d.status).map((d) => d.date);
    if (missing.length) {
      attention.push({ kind: "no-status", personId: p.id, dates: missing, detail: `${p.name}: office or home not set for ${missing.map(fmtDay).join(", ")}` });
    }
  }

  return { weekStart, weekEnd: dates[6], dates, timeZone: input.timeZone, people, pets: petPlans, events, attention };
}

// ── The Sunday nudge ─────────────────────────────────────────────────────────

const money = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

/**
 * The WhatsApp message that starts the Sunday review: the week at a glance
 * (paydays, bills, trips, birthdays, visits, tasks) and what needs a
 * decision, with a link to the planner. The AI summary (later) would
 * replace or follow this.
 */
export function weekNudgeText(
  plan: Omit<WeekPlan, "attention"> & { attention: Array<{ kind: string; detail: string; personId?: string; dates?: string[] }>; sections?: WeekSections },
  url: string,
): string {
  const range = `${new Date(`${plan.weekStart}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })} – ${new Date(`${plan.weekEnd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })}`;
  const lines = [`🗓️ *Week review* · ${range}`];
  const nameOf = (id: string) => plan.people.find((p) => p.id === id)?.name ?? "?";
  const events = new Set(plan.events.map((e) => e.key)).size;
  lines.push(events ? `${events} event${events === 1 ? "" : "s"} on the calendar.` : "Nothing on the calendar yet.");

  const glance: string[] = [];
  const s = plan.sections;
  if (s) {
    for (const p of s.finance.paydays) glance.push(`💵 ${nameOf(p.personId)} paid ${fmtDay(p.date)} (~${money(p.usualNet)})`);
    if (s.finance.scheduled.length) {
      glance.push(`🧾 ${s.finance.scheduled.length} scheduled payment${s.finance.scheduled.length === 1 ? "" : "s"}: ${money(s.finance.scheduledOut)} out${s.finance.scheduledIn ? `, ${money(s.finance.scheduledIn)} in` : ""}`);
    }
    for (const t of s.travel.trips.filter((t) => t.starts)) glance.push(`✈️ ${t.name} starts ${fmtDay(t.startDate)}`);
    for (const o of s.occasions) glance.push(`🎂 ${o.name}'s birthday ${fmtDay(o.date)}${o.age ? ` (${o.age})` : ""}`);
    for (const v of s.care.visits) glance.push(`🩺 ${nameOf(v.personId)}: ${v.title} ${fmtDay(v.date)}`);
    const due = s.todo.tasks.filter((t) => !t.overdue).length;
    if (due) glance.push(`✅ ${due} task${due === 1 ? "" : "s"} due this week`);
  }
  for (const pet of plan.pets) {
    const marked = pet.days.filter((d) => d.status && d.status !== "WITH_US");
    if (marked.length) glance.push(`🐾 ${pet.name}: ${marked.map((d) => `${PET_DAY_LABELS[d.status!].toLowerCase()} ${fmtDay(d.date)}`).join(", ")}`);
  }
  if (glance.length) lines.push("", ...glance);

  const todo: string[] = [];
  const unassigned = plan.attention.filter((a) => a.kind === "unassigned");
  if (unassigned.length) todo.push(`👤 ${unassigned.length} family-calendar event${unassigned.length === 1 ? "" : "s"} with nobody assigned`);
  const noStatus = plan.attention.filter((a) => a.kind === "no-status");
  if (noStatus.length) {
    todo.push(`🏢 Office/home not set: ${noStatus.map((a) => `${nameOf(a.personId ?? "")} (${a.dates?.length ?? 0} day${a.dates?.length === 1 ? "" : "s"})`).join(", ")}`);
  }
  for (const a of plan.attention.filter((a) => a.kind === "overdue" || a.kind === "care" || a.kind === "trip-prep")) {
    todo.push(`${a.kind === "overdue" ? "⏰" : a.kind === "care" ? "🩺" : "🧳"} ${a.detail}`);
  }
  if (todo.length) lines.push("", "*Needs a decision*", ...todo);
  lines.push("", `10 minutes to plan it: ${url}`);
  return lines.join("\n");
}
