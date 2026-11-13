// The week planner's sections beyond the calendar grid (lib/week-plan.ts):
// money that moves this week and who gets paid, open tasks and reminders,
// trips, pet and health care, birthdays, shopping and checklists. Each
// section also contributes to "needs attention" (overdue tasks, care that
// needs booking, a trip starting with an unfinished checklist…).
//
// Pure: lib/ops/week.ts loads the rows and passes them in.

import { gestationalAge, careUrgency } from "./pregnancy";
import { parseLegIso } from "./trip";
import { nextOccurrence, parseItems } from "./reminder-schedule";
import { effectiveCategory, isExcludedFromBudget } from "./finance/categories";
import { occurrencesBetween } from "./finance/dates";
import { isScheduleLive } from "./finance/recurring";
import type { RecurringLike } from "./finance/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

export type SectionAttention = { kind: "overdue" | "care" | "trip-prep"; detail: string; date?: string; personId?: string };

export type WeekSections = {
  finance: {
    /** Scheduled transactions (bills, contributions…) due this week. */
    scheduled: Array<{ id: string; date: string; description: string; amount: number; category: string | null; autopay: boolean }>;
    /** What actually posted (or is pending) this week, internal transfers left out. */
    transactions: Array<{ id: string; date: string; description: string; amount: number; category: string | null; pending: boolean; personId: string | null }>;
    /** Projected paydays from each person's paycheck history. */
    paydays: Array<{ personId: string; date: string; usualNet: number; cadence: string }>;
    /** Sums of the scheduled rows. */
    scheduledOut: number;
    scheduledIn: number;
  };
  todo: {
    tasks: Array<{ id: string; occurrenceId: string | null; title: string; date: string; overdue: boolean; personIds: string[]; recurring: boolean }>;
    reminders: Array<{ id: string; name: string; personId: string | null; group: boolean; times: string[]; count: number }>;
  };
  travel: {
    trips: Array<{ id: string; name: string; startDate: string; endDate: string; participantIds: string[]; starts: boolean; ends: boolean; checklist: { done: number; total: number } | null }>;
    legs: Array<{ id: string; tripName: string; date: string; time: string | null; label: string; mode: string | null }>;
    reservations: Array<{ id: string; tripName: string; date: string; time: string | null; type: string | null; name: string }>;
  };
  care: {
    pets: Array<{ petId: string; title: string; date: string | null; overdue: boolean }>;
    visits: Array<{ id: string; personId: string; date: string; time: string; title: string }>;
    pregnancy: Array<{ personId: string; weeks: string | null; items: Array<{ id: string; title: string; urgency: string; windowStart: string; windowEnd: string; scheduledAt: string | null }> }>;
  };
  occasions: Array<{ personId: string; name: string; date: string; kind: "birthday"; age: number | null }>;
  errands: {
    shopping: Array<{ listId: string; name: string; emoji: string | null; open: number; items: string[] }>;
    checklists: Array<{ id: string; name: string; entityType: string | null; forName: string | null; done: number; total: number }>;
  };
};

// ── Time helpers ─────────────────────────────────────────────────────────────

function localParts(instant: Date, timeZone: string): { date: string; time: string } {
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

/** The UTC instant of local midnight on `date` in `timeZone`. */
export function zonedMidnight(date: string, timeZone: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  const p = localParts(guess, timeZone);
  const asUtc = Date.parse(`${p.date}T${p.time}:00Z`);
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const fmtDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

// ── Paydays ──────────────────────────────────────────────────────────────────

/**
 * Projects each person's paydays in [from, to] from their regular paychecks
 * (bonus / RSU-only stubs left out): the median gap between recent ones
 * sets the cadence (weekly, biweekly, semimonthly 15th + month end, or
 * monthly), and the median of the last four is the usual take-home.
 * History older than 60 days before `from` isn't projected.
 */
export function projectPaydays(paychecks: Row[], from: string, to: string): WeekSections["finance"]["paydays"] {
  const out: WeekSections["finance"]["paydays"] = [];
  const byPerson = new Map<string, Row[]>();
  for (const p of paychecks) {
    if (!p.personId || !p.payDate || !(Number(p.net) > 0) || Number(p.bonusGross) > 0 || Number(p.rsuGross) > 0) continue;
    if (!byPerson.has(p.personId)) byPerson.set(p.personId, []);
    byPerson.get(p.personId)!.push(p);
  }
  for (const [personId, rows] of byPerson) {
    const dates = [...new Set(rows.map((r) => r.payDate as string))].sort();
    const last = dates[dates.length - 1];
    if (dates.length < 2 || daysBetween(last, from) > 60) continue;
    const recent = dates.slice(-7);
    const gap = median(recent.slice(1).map((d, i) => daysBetween(recent[i], d)));
    const usualNet = r2(median(rows.filter((r) => recent.slice(-4).includes(r.payDate)).map((r) => Number(r.net))));
    const projected: string[] = [];
    // 15th + month end comes 15–16 days apart, so check the dates first.
    const monthEnd = (d: string) => addDays(d, 1).endsWith("-01");
    const semimonthly = recent.length >= 3 && recent.every((d) => d.endsWith("-15") || monthEnd(d));
    let cadence: string;
    if (semimonthly) cadence = "semimonthly";
    else if (gap >= 6 && gap <= 8) cadence = "weekly";
    else if (gap >= 13 && gap <= 15) cadence = "biweekly";
    else if (gap > 15 && gap < 18) cadence = "semimonthly";
    else if (gap >= 27 && gap <= 33) cadence = "monthly";
    else continue;
    if (cadence === "weekly" || cadence === "biweekly") {
      const step = cadence === "weekly" ? 7 : 14;
      for (let d = addDays(last, step); d <= to; d = addDays(d, step)) if (d >= from) projected.push(d);
    } else if (cadence === "semimonthly") {
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const nextDay = addDays(d, 1);
        if (d > last && (d.endsWith("-15") || nextDay.endsWith("-01"))) projected.push(d);
      }
    } else {
      const dom = Number(last.slice(8, 10));
      for (let d = from; d <= to; d = addDays(d, 1)) if (d > last && Number(d.slice(8, 10)) === dom) projected.push(d);
    }
    for (const date of projected) out.push({ personId, date, usualNet, cadence });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Build ────────────────────────────────────────────────────────────────────

export type SectionRows = {
  people?: Row[]; // everyone (for birthdays), not just the household
  schedules?: RecurringLike[];
  transactions?: Row[];
  paychecks?: Row[];
  tasks?: Row[];
  occurrences?: Row[];
  reminders?: Row[];
  trips?: Row[];
  legs?: Row[];
  reservations?: Row[];
  checklists?: Row[];
  checklistItems?: Row[];
  events?: Array<{ id: string; title: string }>;
  pets?: Row[];
  vaccines?: Row[];
  medications?: Row[];
  visits?: Row[];
  pregnancies?: Row[];
  careItems?: Row[];
  shoppingLists?: Row[];
  shoppingItems?: Row[];
};

export function buildWeekSections(
  rows: SectionRows,
  opts: { weekStart: string; weekEnd: string; today: string; timeZone: string },
): { sections: WeekSections; attention: SectionAttention[] } {
  const { weekStart, weekEnd, today, timeZone } = opts;
  const inWeek = (d: string | null | undefined) => !!d && d >= weekStart && d <= weekEnd;
  const localDate = (iso: string) => localParts(new Date(iso), timeZone).date;
  const attention: SectionAttention[] = [];
  const nameOf = (id: string) => (rows.people ?? []).find((p) => p.id === id)?.name ?? "?";

  // Finance
  const scheduled: WeekSections["finance"]["scheduled"] = [];
  for (const r of rows.schedules ?? []) {
    if (!isScheduleLive(r, today)) continue;
    for (const date of occurrencesBetween(r, weekStart, weekEnd)) {
      scheduled.push({ id: r.id, date, description: r.description ?? "Scheduled", amount: Number(r.amount ?? 0), category: r.category ?? null, autopay: !!(r as any).autopay });
    }
  }
  scheduled.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  const transactions = (rows.transactions ?? [])
    .filter((t) => inWeek(t.date) && !isExcludedFromBudget(effectiveCategory(t as any)))
    .map((t) => ({ id: t.id, date: t.date, description: t.description ?? "", amount: Number(t.amount ?? 0), category: effectiveCategory(t as any) ?? null, pending: t.status === "PENDING", personId: t.personId ?? null }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  const paydays = projectPaydays(rows.paychecks ?? [], weekStart, weekEnd);

  // To-do: open tasks due by the end of the week (overdue included).
  const tasks: WeekSections["todo"]["tasks"] = [];
  const taskById = new Map((rows.tasks ?? []).map((t) => [t.id, t]));
  for (const t of rows.tasks ?? []) {
    if (t.recurrence || t.isCompleted || !t.dueDate) continue;
    const date = localDate(t.dueDate);
    if (date > weekEnd) continue;
    tasks.push({ id: t.id, occurrenceId: null, title: t.title, date, overdue: date < today, personIds: (t.assignedPersonIds ?? []).filter(Boolean), recurring: false });
  }
  for (const o of rows.occurrences ?? []) {
    const t = taskById.get(o.taskId);
    // A completed task is a finished series, even with an occurrence left open (as on the home page).
    if (!t || t.isCompleted || o.completedAt || o.skippedAt || !o.scheduledFor) continue;
    const date = localDate(o.scheduledFor);
    if (date > weekEnd) continue;
    tasks.push({ id: t.id, occurrenceId: o.id, title: t.title, date, overdue: date < today, personIds: (t.assignedPersonIds ?? []).filter(Boolean), recurring: true });
  }
  tasks.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const overdue = tasks.filter((t) => t.overdue);
  if (overdue.length) {
    attention.push({ kind: "overdue", detail: `${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}: ${overdue.slice(0, 3).map((t) => t.title).join(", ")}${overdue.length > 3 ? "…" : ""}` });
  }

  // Reminders firing this week.
  const reminders: WeekSections["todo"]["reminders"] = [];
  const from = zonedMidnight(weekStart, timeZone);
  const until = zonedMidnight(addDays(weekEnd, 1), timeZone);
  for (const r of rows.reminders ?? []) {
    if (r.status !== "PENDING") continue;
    const times: Date[] = [];
    for (const item of parseItems(r.items)) {
      let after = new Date(from.getTime() - 1);
      for (let i = 0; i < 60; i++) {
        const next = nextOccurrence(item, after, timeZone);
        if (!next || next >= until) break;
        times.push(next);
        after = next;
      }
    }
    if (!times.length) continue;
    times.sort((a, b) => a.getTime() - b.getTime());
    const toMinute = (t: Date) => new Date(Math.floor(t.getTime() / 60_000) * 60_000).toISOString();
    reminders.push({ id: r.id, name: r.name, personId: r.personId ?? null, group: r.targetKind === "GROUP", times: times.slice(0, 7).map(toMinute), count: times.length });
  }

  // Travel
  const trips = (rows.trips ?? [])
    .filter((t) => t.startDate <= weekEnd && t.endDate >= weekStart)
    .map((t) => {
      const cls = (rows.checklists ?? []).filter((c) => c.entityType === "TRIP" && c.entityId === t.id && !c.isArchived);
      const items = (rows.checklistItems ?? []).filter((i) => cls.some((c) => c.id === i.checklistId));
      return {
        id: t.id,
        name: t.name,
        startDate: t.startDate,
        endDate: t.endDate,
        participantIds: (t.participantIds ?? []).filter(Boolean),
        starts: inWeek(t.startDate),
        ends: inWeek(t.endDate),
        checklist: items.length ? { done: items.filter((i) => i.isDone).length, total: items.length } : null,
      };
    });
  for (const t of trips) {
    if (t.starts && t.checklist && t.checklist.done < t.checklist.total) {
      attention.push({ kind: "trip-prep", date: t.startDate, detail: `${t.name} starts ${fmtDay(t.startDate)}: checklist ${t.checklist.done}/${t.checklist.total} done` });
    }
  }
  const tripName = (id: string) => (rows.trips ?? []).find((t) => t.id === id)?.name ?? "Trip";
  const place = (l: Row | null | undefined) => l?.airportCode || l?.city || "?";
  // Leg and reservation times are the local wall clock at that place; the
  // trailing Z is a placeholder (see lib/trip.ts). Read them as written,
  // never through a timezone conversion.
  const wallClock = (iso: string) => {
    const p = parseLegIso(iso);
    if (!p) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
  };
  const legs: WeekSections["travel"]["legs"] = [];
  for (const l of rows.legs ?? []) {
    const at = l.departAt ?? l.arriveAt;
    if (!at) continue;
    const p = wallClock(at);
    if (!p || !inWeek(p.date)) continue;
    const route = `${place(l.fromLocation)} → ${place(l.toLocation)}`;
    const what = l.mode === "COMMERCIAL_FLIGHT" ? [l.airline, l.flightNumber].filter(Boolean).join(" ") || "Flight" : l.mode === "PERSONAL_FLIGHT" ? `Flight${l.aircraft ? ` ${l.aircraft}` : ""}` : l.mode === "CAR" ? "Drive" : (l.mode ?? "Leg").toLowerCase().replace(/^./, (c: string) => c.toUpperCase());
    legs.push({ id: l.id, tripName: tripName(l.tripId), date: p.date, time: l.departAt ? p.time : null, label: `${what} ${route}`, mode: l.mode ?? null });
  }
  legs.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  const reservations: WeekSections["travel"]["reservations"] = [];
  for (const r of rows.reservations ?? []) {
    if (!r.startAt) continue;
    const p = wallClock(r.startAt);
    if (!p || !inWeek(p.date)) continue;
    reservations.push({ id: r.id, tripName: tripName(r.tripId), date: p.date, time: p.time === "00:00" ? null : p.time, type: r.type ?? null, name: r.name });
  }
  reservations.sort((a, b) => a.date.localeCompare(b.date));

  // Care: pets
  const petCare: WeekSections["care"]["pets"] = [];
  const latestVaccine = new Map<string, Row>();
  for (const v of rows.vaccines ?? []) {
    const key = `${v.petId}|${String(v.name).toLowerCase()}`;
    const cur = latestVaccine.get(key);
    if (!cur || (v.administeredAt ?? "") > (cur.administeredAt ?? "")) latestVaccine.set(key, v);
  }
  const petName = (id: string) => (rows.pets ?? []).find((p) => p.id === id)?.name ?? "Pet";
  for (const v of latestVaccine.values()) {
    if (!v.nextDueAt || v.nextDueAt > weekEnd) continue;
    const late = v.nextDueAt < today;
    petCare.push({ petId: v.petId, title: `${v.name} vaccine due`, date: v.nextDueAt, overdue: late });
    if (late) attention.push({ kind: "care", date: v.nextDueAt, detail: `${petName(v.petId)}: ${v.name} vaccine was due ${v.nextDueAt}` });
  }
  for (const m of rows.medications ?? []) {
    if (m.isActive === false) continue;
    if (inWeek(m.endDate)) petCare.push({ petId: m.petId, title: `${m.name} ends`, date: m.endDate, overdue: false });
    else if (m.refillsRemaining === 0 && (!m.endDate || m.endDate >= weekStart)) petCare.push({ petId: m.petId, title: `${m.name}: no refills left`, date: null, overdue: false });
  }

  // Care: medical visits this week.
  const visits = (rows.visits ?? [])
    .filter((v) => v.status !== "CANCELLED" && v.visitAt)
    .map((v) => ({ v, p: localParts(new Date(v.visitAt), timeZone) }))
    .filter(({ p }) => inWeek(p.date))
    .map(({ v, p }) => ({ id: v.id, personId: v.personId, date: p.date, time: p.time, title: v.title || (v.kind ? String(v.kind).toLowerCase().replace(/_/g, " ") : "Visit") }))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  // Care: pregnancy — gestational age on Monday, and care items that are
  // due, overdue, booked this week, or open up during it.
  const pregnancy: WeekSections["care"]["pregnancy"] = [];
  for (const preg of rows.pregnancies ?? []) {
    if (preg.status && preg.status !== "ACTIVE") continue;
    let weeks: string | null = null;
    try {
      const ga: any = gestationalAge(preg.dueDate, weekStart);
      weeks = ga?.label ?? (ga?.weeks != null ? `${ga.weeks}w${ga.days ?? 0}d` : null);
    } catch {
      weeks = null;
    }
    const items: WeekSections["care"]["pregnancy"][number]["items"] = [];
    for (const c of (rows.careItems ?? []).filter((x) => x.pregnancyId === preg.id)) {
      const urgency = careUrgency(c as any, today, 21, timeZone);
      const booked = urgency === "BOOKED" && c.scheduledAt && inWeek(localDate(c.scheduledAt));
      const opens = urgency === "SOON" && c.windowStart <= weekEnd;
      if (urgency === "OVERDUE" || urgency === "DUE_NOW" || urgency === "CONFIRM" || booked || opens) {
        items.push({ id: c.id, title: c.title, urgency, windowStart: c.windowStart, windowEnd: c.windowEnd, scheduledAt: c.scheduledAt ?? null });
        if ((urgency === "OVERDUE" || urgency === "DUE_NOW") && c.status === "UPCOMING" && !c.optional) {
          attention.push({ kind: "care", personId: preg.personId, detail: `${nameOf(preg.personId)}: ${c.title} ${urgency === "OVERDUE" ? `was due by ${c.windowEnd}` : `is due by ${c.windowEnd}`}, not booked` });
        }
      }
    }
    if (weeks || items.length) pregnancy.push({ personId: preg.personId, weeks, items });
  }

  // Occasions: birthdays in the week (any year; 1900 = year unknown).
  const occasions: WeekSections["occasions"] = [];
  const weekDays: string[] = [];
  for (let d = weekStart; d <= weekEnd; d = addDays(d, 1)) weekDays.push(d);
  for (const p of rows.people ?? []) {
    if (!p.birthday || p.active === false) continue;
    const md = String(p.birthday).slice(5, 10);
    const date = weekDays.find((d) => d.slice(5, 10) === md) ?? (md === "02-29" ? weekDays.find((d) => d.slice(5, 10) === "02-28") : undefined);
    if (!date) continue;
    const year = Number(String(p.birthday).slice(0, 4));
    occasions.push({ personId: p.id, name: p.name, date, kind: "birthday", age: year > 1900 ? Number(date.slice(0, 4)) - year : null });
  }
  occasions.sort((a, b) => a.date.localeCompare(b.date));

  // Errands: open shopping items, and checklists tied to this week's trips / events.
  const shopping = (rows.shoppingLists ?? [])
    .filter((l) => !l.isArchived)
    .map((l) => {
      const open = (rows.shoppingItems ?? []).filter((i) => i.listId === l.id && !i.isChecked).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      return { listId: l.id, name: l.name, emoji: l.emoji ?? null, open: open.length, items: open.slice(0, 6).map((i) => i.name) };
    })
    .filter((l) => l.open > 0)
    .sort((a, b) => b.open - a.open);
  const eventIds = new Set((rows.events ?? []).map((e) => e.id));
  const tripIds = new Set(trips.map((t) => t.id));
  const checklists = (rows.checklists ?? [])
    .filter((c) => !c.isArchived && ((c.entityType === "TRIP" && tripIds.has(c.entityId)) || (c.entityType === "EVENT" && eventIds.has(c.entityId))))
    .map((c) => {
      const items = (rows.checklistItems ?? []).filter((i) => i.checklistId === c.id);
      const forName = c.entityType === "TRIP" ? tripName(c.entityId) : (rows.events ?? []).find((e) => e.id === c.entityId)?.title ?? null;
      return { id: c.id, name: c.name, entityType: c.entityType ?? null, forName, done: items.filter((i) => i.isDone).length, total: items.length };
    })
    .filter((c) => c.total > 0 && c.done < c.total);

  return {
    sections: {
      finance: {
        scheduled,
        transactions,
        paydays,
        scheduledOut: r2(scheduled.filter((s) => s.amount < 0).reduce((s, x) => s - x.amount, 0)),
        scheduledIn: r2(scheduled.filter((s) => s.amount > 0).reduce((s, x) => s + x.amount, 0)),
      },
      todo: { tasks, reminders },
      travel: { trips, legs, reservations },
      care: { pets: petCare, visits, pregnancy },
      occasions,
      errands: { shopping, checklists },
    },
    attention,
  };
}
