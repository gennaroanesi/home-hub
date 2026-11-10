// The week planner (lib/week-plan.ts): the Sunday review of the coming
// week. One computed read (get_week_plan) that the web page, the mobile
// screen, Janet and the Sunday WhatsApp nudge share, and the small writes
// the review is made of: who's in the office which day, who a family
// calendar event is for, where Dolce is, and "reviewed".

import { z } from "zod/v4";
import { listAllPages } from "../list-all";
import { householdMembers } from "../household";
import { getHouseholdTimezone } from "../household-settings";
import { addDays, todayIso } from "../finance/dates";
import { listPaychecks, listSchedules, listTransactions } from "../finance/data";
import { buildWeekSections, type SectionAttention, type WeekSections } from "../week-sections";
import {
  DAY_STATUSES,
  PET_DAY_STATUSES,
  buildWeekPlan,
  mondayOf,
  weekDates,
  weekToPlan,
  type DayRow,
  type EventRow,
  type PetDayRow,
  type TripRow,
  type Attention,
  type WeekPlan,
} from "../week-plan";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

type Person = { id: string; name: string; active?: boolean | null; groups?: (string | null)[] | null };
type Pet = { id: string; name: string; active?: boolean | null };

async function household(ctx: OpContext): Promise<Person[]> {
  return householdMembers(await listAllPages<Person>(ctx.client.models.homePerson));
}

async function activePets(ctx: OpContext): Promise<Pet[]> {
  return (await listAllPages<Pet>(ctx.client.models.homePet)).filter((p) => p.active !== false);
}

/** personIds and/or personNames → household ids. */
async function personIds(ctx: OpContext, ids: string[] | undefined, names: string[] | undefined): Promise<string[]> {
  const folks = await household(ctx);
  const out: string[] = [];
  for (const id of ids ?? []) {
    if (!folks.some((p) => p.id === id)) throw new OpError(`No household member with id ${id}`);
    out.push(id);
  }
  for (const n of names ?? []) {
    const want = n.trim().toLowerCase();
    if (want === "both" || want === "everyone" || want === "household") {
      out.push(...folks.map((p) => p.id));
      continue;
    }
    const p = folks.find((x) => x.name.toLowerCase() === want);
    if (!p) throw new OpError(`No household member named "${n}". Household: ${folks.map((x) => x.name).join(", ")}`);
    out.push(p.id);
  }
  return [...new Set(out)];
}

async function onePerson(ctx: OpContext, input: { personId?: string; personName?: string }): Promise<Person> {
  const folks = await household(ctx);
  const name = (input.personName ?? (input.personId ? "" : ctx.actor.personName ?? "")).trim().toLowerCase();
  const p = input.personId ? folks.find((x) => x.id === input.personId) : folks.find((x) => x.name.toLowerCase() === name);
  if (!p) throw new OpError(input.personId || input.personName ? `No household member ${input.personId ?? input.personName}` : "Say whose: personId or personName");
  return p;
}

/** A loader that fails soft: one missing section shouldn't sink the week. */
async function soft<T>(what: string, p: Promise<T[]>, errors: string[]): Promise<T[]> {
  try {
    return await p;
  } catch (e) {
    errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Loads everything a week needs and builds it. Shared with the week-review Lambda. */
export type LoadedWeek = Omit<WeekPlan, "attention"> & { attention: Array<Attention | SectionAttention>; sections: WeekSections; review: any | null; errors: string[] };

export async function loadWeekPlan(client: any, weekStartInput?: string): Promise<LoadedWeek> {
  const timeZone = await getHouseholdTimezone(client);
  const today = todayIso(timeZone);
  const weekStart = weekStartInput ? mondayOf(weekStartInput) : weekToPlan(today);
  const dates = weekDates(weekStart);
  const weekEnd = dates[6];
  const between = { between: [dates[0], weekEnd] };
  // Instants a little wider than the week, for datetime fields (local-day
  // filtering happens in the builders).
  const wide = { between: [`${addDays(dates[0], -1)}T00:00:00.000Z`, `${addDays(weekEnd, 2)}T00:00:00.000Z`] };
  const errors: string[] = [];
  const [allPeople, pets, events, days, petDays, trips, review] = await Promise.all([
    listAllPages<Person & { birthday?: string | null }>(client.models.homePerson),
    listAllPages<Pet>(client.models.homePet).then((p) => p.filter((x) => x.active !== false)),
    listAllPages<EventRow>(client.models.homeCalendarEvent),
    listAllPages<DayRow>(client.models.homeCalendarDay, { filter: { date: between } }),
    listAllPages<PetDayRow>(client.models.homePetDay, { filter: { date: between } }),
    listAllPages<TripRow>(client.models.homeTrip),
    client.models.homeWeekReview.get({ weekStart }).then((r: any) => r?.data ?? null),
  ]);
  const weekTrips = trips.filter((t) => t.endDate >= dates[0] && t.startDate <= weekEnd);
  const people = householdMembers(allPeople);

  const [schedules, transactions, paychecks, tasks, occurrences, reminders, legs, reservations, checklists, vaccines, medications, visits, pregnancies, shoppingLists, shoppingItems] =
    await Promise.all([
      soft("scheduled transactions", listSchedules(client), errors),
      soft("transactions", listTransactions(client, { fromIso: dates[0], toIso: weekEnd }), errors),
      soft("paychecks", listPaychecks(client), errors),
      soft("tasks", listAllPages<any>(client.models.homeTask), errors),
      soft("task occurrences", listAllPages<any>(client.models.homeTaskOccurrence, { filter: { scheduledFor: { le: wide.between[1] } } }), errors),
      soft("reminders", listAllPages<any>(client.models.homeReminder, { filter: { status: { eq: "PENDING" } } }), errors),
      soft("trip legs", weekTrips.length ? listAllPages<any>(client.models.homeTripLeg) : Promise.resolve([]), errors),
      soft("reservations", weekTrips.length ? listAllPages<any>(client.models.homeTripReservation) : Promise.resolve([]), errors),
      soft("checklists", listAllPages<any>(client.models.homeChecklist, { filter: { entityType: { eq: "TRIP" } } }).then(async (trip) => [
        ...trip,
        ...(await listAllPages<any>(client.models.homeChecklist, { filter: { entityType: { eq: "EVENT" } } })),
      ]), errors),
      soft("pet vaccines", listAllPages<any>(client.models.homePetVaccine), errors),
      soft("pet medications", listAllPages<any>(client.models.homePetMedication), errors),
      soft("medical visits", listAllPages<any>(client.models.homeMedicalVisit, { filter: { visitAt: wide } }), errors),
      soft("pregnancies", listAllPages<any>(client.models.homePregnancy, { filter: { status: { eq: "ACTIVE" } } }), errors),
      soft("shopping lists", listAllPages<any>(client.models.homeShoppingList), errors),
      soft("shopping items", listAllPages<any>(client.models.homeShoppingItem, { filter: { isChecked: { ne: true } } }), errors),
    ]);
  const tripIds = new Set(weekTrips.map((t) => t.id));
  const relevantChecklists = checklists.filter((c) => !c.isArchived && (c.entityType === "EVENT" || tripIds.has(c.entityId)));
  const [checklistItems, careItems] = await Promise.all([
    soft(
      "checklist items",
      Promise.all(relevantChecklists.map((c) => listAllPages<any>(client.models.homeChecklistItem, { filter: { checklistId: { eq: c.id } } }))).then((x) => x.flat()),
      errors,
    ),
    soft("care items", Promise.all(pregnancies.map((p) => listAllPages<any>(client.models.homeCareItem, { filter: { pregnancyId: { eq: p.id } } }))).then((x) => x.flat()), errors),
  ]);

  const plan = buildWeekPlan({
    weekStart,
    timeZone,
    people: people.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
    pets: pets.map((p) => ({ id: p.id, name: p.name })),
    events,
    days,
    petDays,
    trips: weekTrips,
  });
  const weekEventIds = new Set(plan.events.map((e) => e.id));
  const { sections, attention } = buildWeekSections(
    {
      people: allPeople,
      schedules,
      transactions,
      paychecks,
      tasks,
      occurrences,
      reminders,
      trips: weekTrips,
      legs: legs.filter((l) => tripIds.has(l.tripId)),
      reservations: reservations.filter((r) => tripIds.has(r.tripId)),
      checklists: relevantChecklists.filter((c) => c.entityType === "TRIP" || weekEventIds.has(c.entityId)),
      checklistItems,
      events: events.filter((e) => weekEventIds.has(e.id)),
      pets,
      vaccines,
      medications,
      visits,
      pregnancies,
      careItems,
      shoppingLists,
      shoppingItems,
    },
    { weekStart, weekEnd, today, timeZone },
  );
  if (errors.length) console.warn("[week] some sections didn't load:", errors);
  return {
    ...plan,
    attention: [...plan.attention, ...attention],
    sections,
    errors,
    review: review ? { reviewedAt: review.reviewedAt ?? null, reviewedBy: review.reviewedBy ?? null, notes: review.notes ?? null, summary: review.summary ?? null } : null,
  };
}

// ── get_week_plan ─────────────────────────────────────────────────────────────

const SectionsOut = z.object({
  finance: z.object({
    scheduled: z.array(z.object({ id: z.string(), date: z.string(), description: z.string(), amount: z.number(), category: z.string().nullable(), autopay: z.boolean() })),
    transactions: z.array(
      z.object({ id: z.string(), date: z.string(), description: z.string(), amount: z.number(), category: z.string().nullable(), pending: z.boolean(), personId: z.string().nullable() }),
    ),
    paydays: z.array(z.object({ personId: z.string(), date: z.string(), usualNet: z.number().describe("Median take-home of the last regular paychecks"), cadence: z.string() })),
    scheduledOut: z.number(),
    scheduledIn: z.number(),
  }),
  todo: z.object({
    tasks: z.array(
      z.object({ id: z.string(), occurrenceId: z.string().nullable(), title: z.string(), date: z.string(), overdue: z.boolean(), personIds: z.array(z.string()), recurring: z.boolean() }),
    ),
    reminders: z.array(z.object({ id: z.string(), name: z.string(), personId: z.string().nullable(), group: z.boolean(), times: z.array(z.string()), count: z.number() })),
  }),
  travel: z.object({
    trips: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        participantIds: z.array(z.string()),
        starts: z.boolean(),
        ends: z.boolean(),
        checklist: z.object({ done: z.number(), total: z.number() }).nullable(),
      }),
    ),
    legs: z.array(z.object({ id: z.string(), tripName: z.string(), date: z.string(), time: z.string().nullable(), label: z.string(), mode: z.string().nullable() })),
    reservations: z.array(z.object({ id: z.string(), tripName: z.string(), date: z.string(), time: z.string().nullable(), type: z.string().nullable(), name: z.string() })),
  }),
  care: z.object({
    pets: z.array(z.object({ petId: z.string(), title: z.string(), date: z.string().nullable(), overdue: z.boolean() })),
    visits: z.array(z.object({ id: z.string(), personId: z.string(), date: z.string(), time: z.string(), title: z.string() })),
    pregnancy: z.array(
      z.object({
        personId: z.string(),
        weeks: z.string().nullable(),
        items: z.array(z.object({ id: z.string(), title: z.string(), urgency: z.string(), windowStart: z.string(), windowEnd: z.string(), scheduledAt: z.string().nullable() })),
      }),
    ),
  }),
  occasions: z.array(z.object({ personId: z.string(), name: z.string(), date: z.string(), kind: z.literal("birthday"), age: z.number().nullable() })),
  errands: z.object({
    shopping: z.array(z.object({ listId: z.string(), name: z.string(), emoji: z.string().nullable(), open: z.number(), items: z.array(z.string()) })),
    checklists: z.array(z.object({ id: z.string(), name: z.string(), entityType: z.string().nullable(), forName: z.string().nullable(), done: z.number(), total: z.number() })),
  }),
});

const WeekEventOut = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  date: z.string(),
  start: z.string().nullable().describe("Local HH:MM; null for all-day"),
  end: z.string().nullable(),
  allDay: z.boolean(),
  personIds: z.array(z.string()),
  petIds: z.array(z.string()),
  fromFeed: z.boolean().describe("From the Apple family calendar (read-only except who it's for)"),
  recurring: z.boolean(),
  location: z.string().nullable(),
});

export const getWeekPlan = defineOp({
  name: "get_week_plan",
  domain: "calendar",
  description:
    "The household's week (Monday–Sunday) for the Sunday review: each person's day (office, home, PTO, travel — trips fill in travel), every calendar event including the Apple family calendar with recurring ones expanded, where each pet is (daycare, boarding…), plus sections: finance (scheduled bills/contributions due, transactions that posted, projected paydays with usual take-home), to-do (open tasks due this week or overdue, reminders firing), travel (trips, legs, reservations, trip checklist progress), care (pet vaccines/meds, medical visits, pregnancy care due), birthdays, and errands (open shopping items, checklists for this week's trips/events). attention lists what needs a decision: double-bookings, family-calendar events nobody is assigned to, weekdays with no office/home set, overdue tasks, care that needs booking, trips starting with an unfinished checklist. Default week: from Friday on, next week; otherwise this one.",
  access: "read",
  input: z.object({ weekStart: DATE.optional().describe("Any date in the week; snapped to its Monday.") }),
  output: z.object({
    weekStart: z.string(),
    weekEnd: z.string(),
    dates: z.array(z.string()),
    timeZone: z.string(),
    people: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        days: z.array(
          z.object({
            date: z.string(),
            status: z.enum(DAY_STATUSES).nullable(),
            source: z.enum(["set", "trip"]).nullable(),
            notes: z.string().nullable(),
            tripName: z.string().nullable(),
            dayId: z.string().nullable(),
          }),
        ),
      }),
    ),
    pets: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        days: z.array(z.object({ date: z.string(), status: z.enum(PET_DAY_STATUSES).nullable(), notes: z.string().nullable(), petDayId: z.string().nullable() })),
      }),
    ),
    events: z.array(WeekEventOut),
    attention: z.array(
      z.object({
        kind: z.enum(["overlap", "unassigned", "no-status", "overdue", "care", "trip-prep"]),
        detail: z.string(),
        date: z.string().optional(),
        dates: z.array(z.string()).optional(),
        personId: z.string().optional(),
        eventKeys: z.array(z.string()).optional(),
      }),
    ),
    sections: SectionsOut,
    errors: z.array(z.string()).describe("Sections that couldn't be loaded"),
    review: z
      .object({ reviewedAt: z.string().nullable(), reviewedBy: z.string().nullable(), notes: z.string().nullable(), summary: z.string().nullable() })
      .nullable(),
  }),
  async run(ctx, input) {
    return loadWeekPlan(ctx.client, input.weekStart);
  },
});

// ── set_day_status ────────────────────────────────────────────────────────────

export const setDayStatus = defineOp({
  name: "set_day_status",
  domain: "calendar",
  description:
    "Set where a household member is on one or more days: WORKING_OFFICE, WORKING_HOME, PTO, TRAVEL, VACATION, CHOICE_DAY or WEEKEND_HOLIDAY ('Gennaro is in the office Tuesday and Thursday'). status null clears the day. Notes are kept unless given.",
  access: "write",
  input: z.object({
    dates: z.array(DATE).min(1).max(31),
    status: z.enum(DAY_STATUSES).nullable(),
    personId: z.string().optional(),
    personName: z.string().optional(),
    notes: z.string().optional(),
  }),
  output: z.object({ person: z.string(), status: z.string().nullable(), dates: z.array(z.string()) }),
  async run(ctx, input) {
    const p = await onePerson(ctx, input);
    const dates = [...new Set(input.dates)].sort();
    const existing = await listAllPages<DayRow>(ctx.client.models.homeCalendarDay, {
      filter: { personId: { eq: p.id }, date: { between: [dates[0], dates[dates.length - 1]] } },
    });
    for (const date of dates) {
      const row = existing.find((d) => d.date === date);
      const notes = input.notes !== undefined ? input.notes || null : row?.notes ?? null;
      let r: any = null;
      if (input.status === null && !notes) {
        if (row) r = await ctx.client.models.homeCalendarDay.delete({ id: row.id });
      } else if (row) {
        r = await ctx.client.models.homeCalendarDay.update({ id: row.id, status: input.status, notes });
      } else {
        r = await ctx.client.models.homeCalendarDay.create({ date, personId: p.id, status: input.status, notes });
      }
      if (r?.errors?.length) throw new Error(`${date}: ${r.errors[0].message}`);
    }
    return { person: p.name, status: input.status, dates };
  },
});

// ── assign_event_people ───────────────────────────────────────────────────────

export const assignEventPeople = defineOp({
  name: "assign_event_people",
  domain: "calendar",
  description:
    "Say who a calendar event is for. Works on Apple family calendar events too (their other fields stay read-only; the assignment survives syncs). Replaces the event's people; an empty list makes it a household event. personNames accepts 'both'.",
  access: "write",
  input: z.object({
    eventId: z.string(),
    personIds: z.array(z.string()).optional(),
    personNames: z.array(z.string()).optional(),
  }),
  output: z.object({ eventId: z.string(), title: z.string(), people: z.array(z.string()) }),
  async run(ctx, input) {
    const { data: event } = await ctx.client.models.homeCalendarEvent.get({ id: input.eventId });
    if (!event) throw new OpError(`No event ${input.eventId}`);
    const ids = await personIds(ctx, input.personIds, input.personNames);
    const r = await ctx.client.models.homeCalendarEvent.update({ id: event.id, assignedPersonIds: ids });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    const folks = await household(ctx);
    return { eventId: event.id, title: event.title, people: ids.map((id) => folks.find((p) => p.id === id)?.name ?? id) };
  },
});

// ── set_pet_day ───────────────────────────────────────────────────────────────

export const setPetDay = defineOp({
  name: "set_pet_day",
  domain: "calendar",
  description:
    "Mark where a pet is on one or more days: DAYCARE, BOARDING, SITTER or WITH_US ('Dolce has daycare Wednesday'). status null clears it. With one pet, the pet can be left out.",
  access: "write",
  input: z.object({
    dates: z.array(DATE).min(1).max(31),
    status: z.enum(PET_DAY_STATUSES).nullable(),
    petId: z.string().optional(),
    petName: z.string().optional(),
    notes: z.string().optional(),
  }),
  output: z.object({ pet: z.string(), status: z.string().nullable(), dates: z.array(z.string()) }),
  async run(ctx, input) {
    const pets = await activePets(ctx);
    const pet = input.petId
      ? pets.find((p) => p.id === input.petId)
      : input.petName
        ? pets.find((p) => p.name.toLowerCase() === input.petName!.trim().toLowerCase())
        : pets.length === 1
          ? pets[0]
          : undefined;
    if (!pet) throw new OpError(input.petId || input.petName ? `No pet ${input.petId ?? input.petName}` : `Which pet? ${pets.map((p) => p.name).join(", ")}`);
    const dates = [...new Set(input.dates)].sort();
    const existing = await listAllPages<PetDayRow>(ctx.client.models.homePetDay, {
      filter: { petId: { eq: pet.id }, date: { between: [dates[0], dates[dates.length - 1]] } },
    });
    for (const date of dates) {
      const row = existing.find((d) => d.date === date);
      const notes = input.notes !== undefined ? input.notes || null : row?.notes ?? null;
      let r: any = null;
      if (input.status === null && !notes) {
        if (row) r = await ctx.client.models.homePetDay.delete({ id: row.id });
      } else if (row) {
        r = await ctx.client.models.homePetDay.update({ id: row.id, status: input.status, notes });
      } else {
        r = await ctx.client.models.homePetDay.create({ date, petId: pet.id, status: input.status, notes });
      }
      if (r?.errors?.length) throw new Error(`${date}: ${r.errors[0].message}`);
    }
    return { pet: pet.name, status: input.status, dates };
  },
});

// ── mark_week_reviewed ────────────────────────────────────────────────────────

export const markWeekReviewed = defineOp({
  name: "mark_week_reviewed",
  domain: "calendar",
  description: "Record that the household reviewed a week (the Sunday review), with optional notes. reviewed false clears the mark; notes are kept unless given.",
  access: "write",
  input: z.object({
    weekStart: DATE.describe("Any date in the week; snapped to its Monday."),
    reviewed: z.boolean().default(true),
    notes: z.string().optional(),
    personName: z.string().optional().describe("Who reviewed it; default the caller."),
  }),
  output: z.object({ weekStart: z.string(), reviewedAt: z.string().nullable(), reviewedBy: z.string().nullable(), notes: z.string().nullable() }),
  async run(ctx, input) {
    const weekStart = mondayOf(input.weekStart);
    const { data: existing } = await ctx.client.models.homeWeekReview.get({ weekStart });
    const row = {
      weekStart,
      reviewedAt: input.reviewed ? new Date().toISOString() : null,
      reviewedBy: input.reviewed ? input.personName ?? ctx.actor.personName ?? null : null,
      notes: input.notes !== undefined ? input.notes || null : existing?.notes ?? null,
    };
    const r = existing ? await ctx.client.models.homeWeekReview.update(row) : await ctx.client.models.homeWeekReview.create(row);
    if (r.errors?.length) throw new Error(r.errors[0].message);
    return { weekStart, reviewedAt: row.reviewedAt, reviewedBy: row.reviewedBy, notes: row.notes };
  },
});

export const weekOps = [getWeekPlan, setDayStatus, assignEventPeople, setPetDay, markWeekReviewed] as const;
