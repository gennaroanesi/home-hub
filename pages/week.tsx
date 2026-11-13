"use client";

// /week — the Sunday review: who's in the office which day, what everyone
// has on, where Dolce is, and what needs a decision before Monday
// (double-bookings, family-calendar events nobody is assigned to, weekdays
// without a status). Everything comes from get_week_plan (lib/week-plan.ts)
// and every change goes through the week ops, the same ones Janet and the
// mobile app use.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Spinner, addToast } from "@heroui/react";
import { FaCheck, FaChevronLeft, FaChevronRight, FaExclamationTriangle, FaPaw, FaPen, FaPlus, FaSyncAlt } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { WeekSectionCards } from "@/components/week/week-sections";
import { EventModal } from "@/components/event-modal";
import { TaskModal } from "@/components/task-modal";
import { toggleTaskCompleted } from "@/lib/task-actions";
import type { Schema } from "@/amplify/data/resource";
import { callOp, type OpCallResult } from "@/lib/ops-client";
import { resolveCurrentPerson } from "@/lib/current-person";
import { DAY_STATUS_LABELS, DAY_STATUSES, PET_DAY_LABELS, PET_DAY_STATUSES, mondayOf, type DayStatus, type PetDayStatus } from "@/lib/week-plan";
import { listAllPages } from "@/lib/list-all";

const client = generateClient<Schema>({ authMode: "userPool" });

type Plan = Extract<OpCallResult<"get_week_plan">, { result: unknown }>["result"];
type WeekEvent = Plan["events"][number];
type PersonLook = { id: string; name: string; color?: string | null; emoji?: string | null };
type PersonRow = Schema["homePerson"]["type"];
type TripRow = Schema["homeTrip"]["type"];
type EventRow = Schema["homeCalendarEvent"]["type"];
type EventModalState = { event: EventRow | null; defaults?: { startAt?: string; isAllDay?: boolean; assignedPersonIds?: string[] } } | null;
type TaskModalState = { defaults?: { dueDate?: string; assignedPersonIds?: string[] } } | null;

const ATTENTION_LABELS: Record<string, string> = {
  overlap: "Double-booked",
  unassigned: "Who's it for?",
  "no-status": "Not set",
  overdue: "Overdue",
  care: "Care",
  "trip-prep": "Trip prep",
};

const STATUS_COLORS: Record<DayStatus, string> = {
  WORKING_OFFICE: "#2a5a45",
  WORKING_HOME: "#3b6ea5",
  PTO: "#b7791f",
  TRAVEL: "#7b4fa0",
  VACATION: "#c05621",
  CHOICE_DAY: "#5a6b7b",
  WEEKEND_HOLIDAY: "#8a8a8a",
};

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
const dayName = (iso: string) => fmt(iso, { weekday: "short" });
const dayNum = (iso: string) => fmt(iso, { month: "short", day: "numeric" });
function fmtTime(hhmm: string | null): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

export default function WeekPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [looks, setLooks] = useState<PersonLook[]>([]);
  const [loading, setLoading] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [me, setMe] = useState<string | null>(null);
  const [personRows, setPersonRows] = useState<PersonRow[]>([]);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [eventModal, setEventModal] = useState<EventModalState>(null);
  const [taskModal, setTaskModal] = useState<TaskModalState>(null);

  const weekParam = typeof router.query.week === "string" ? router.query.week : undefined;

  useEffect(() => {
    getCurrentUser()
      .then(() => {
        setReady(true);
        resolveCurrentPerson(client).then((p) => setMe(p?.name ?? null));
      })
      .catch(() => router.push("/login"));
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    const [r, folks, tripRows] = await Promise.all([
      callOp(client, "get_week_plan", weekParam ? { weekStart: weekParam } : {}),
      listAllPages<PersonRow>(client.models.homePerson, { limit: 1000 }),
      client.models.homeTrip.list(),
    ]);
    setLoading(false);
    if ("error" in r) return addToast({ title: "Couldn't load the week", description: r.error, color: "danger" });
    setPlan(r.result);
    setNotes(r.result.review?.notes ?? "");
    setPersonRows(folks);
    setTrips(tripRows.data ?? []);
    setLooks(folks.map((p) => ({ id: p.id, name: p.name, color: p.color, emoji: p.emoji })));
  }, [weekParam]);

  // Quick actions: new event on a day (for someone), edit an event, new task, tick a task, add to a shopping list.
  const newEvent = (date: string, personIds: string[] = [], time = "09:00") => setEventModal({ event: null, defaults: { startAt: `${date}T${time}`, assignedPersonIds: personIds } });
  const editEvent = async (id: string) => {
    const { data } = await client.models.homeCalendarEvent.get({ id });
    if (data) setEventModal({ event: data });
  };
  const newTask = (date?: string, personIds: string[] = []) => setTaskModal({ defaults: { dueDate: date ? `${date}T17:00` : undefined, assignedPersonIds: personIds } });
  const completeTask = async (t: { id: string; recurring: boolean }) => {
    try {
      const r = await toggleTaskCompleted(client, { id: t.id, isCompleted: false, recurrence: t.recurring ? "recurring" : null });
      addToast({ title: r.title, description: r.description, color: "success" });
    } catch (e) {
      addToast({ title: "Couldn't complete it", description: e instanceof Error ? e.message : String(e), color: "danger" });
    }
    await load();
  };
  const addShoppingItem = async (listId: string, name: string) => {
    const { errors } = await client.models.homeShoppingItem.create({ listId, name, isChecked: false, addedBy: me ?? undefined });
    if (errors?.length) addToast({ title: "Couldn't add it", description: errors[0].message, color: "danger" });
    await load();
  };

  useEffect(() => {
    if (ready && router.isReady) load();
  }, [ready, router.isReady, load]);

  const go = (weekStart: string) => router.replace({ pathname: "/week", query: { week: weekStart } }, undefined, { shallow: true, scroll: false });

  async function run<N extends Parameters<typeof callOp>[1]>(name: N, input: Parameters<typeof callOp<N>>[2], ok?: string) {
    const r = await callOp(client, name, input);
    if ("error" in r) {
      addToast({ title: "Couldn't save", description: r.error, color: "danger" });
      return false;
    }
    if (ok) addToast({ title: ok, color: "success" });
    await load();
    return true;
  }

  const setStatus = (personId: string, date: string, status: DayStatus | null) => {
    // Show it right away; the reload confirms.
    setPlan((p) =>
      p && {
        ...p,
        people: p.people.map((x) => (x.id !== personId ? x : { ...x, days: x.days.map((d) => (d.date === date ? { ...d, status, source: status ? ("set" as const) : null } : d)) })),
      },
    );
    return run("set_day_status", { personId, dates: [date], status });
  };
  const setPet = (petId: string, date: string, status: PetDayStatus | null) => run("set_pet_day", { petId, dates: [date], status });
  const assign = async (e: WeekEvent, personIds: string[]) => {
    setAssigning(null);
    await run("assign_event_people", { eventId: e.id, personIds });
  };

  const lookOf = useCallback((id: string) => looks.find((p) => p.id === id), [looks]);

  if (!ready || !plan) {
    return (
      <DefaultLayout>
        <div className="flex justify-center py-24">
          <Spinner />
        </div>
      </DefaultLayout>
    );
  }

  // Today in the household's timezone (not UTC, which is already tomorrow on a US evening).
  const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: plan.timeZone });
  const thisMonday = mondayOf(todayLocal);
  const householdEvents = plan.events.filter((e) => e.personIds.length === 0 && e.petIds.length === 0);
  const eventsFor = (date: string, f: (e: WeekEvent) => boolean) => plan.events.filter((e) => e.date === date && f(e));
  const flagged = new Set(plan.attention.flatMap((a) => a.eventKeys ?? []));
  const reviewed = !!plan.review?.reviewedAt;
  const nameOfId = (id: string) => plan.people.find((p) => p.id === id)?.name ?? lookOf(id)?.name ?? "?";
  // Small markers on each day: paydays, birthdays, trips starting.
  const markers = (d: string) => [
    ...plan.sections.finance.paydays.filter((p) => p.date === d).map((p) => `💵 ${nameOfId(p.personId)}`),
    ...plan.sections.occasions.filter((o) => o.date === d).map((o) => `🎂 ${o.name}`),
    ...plan.sections.travel.trips.filter((t) => t.startDate === d).map((t) => `✈️ ${t.name}`),
  ];

  const eventPill = (e: WeekEvent, showPeople = false) => (
    <div key={e.key} className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setAssigning(assigning === e.key ? null : e.key)}
        className={`text-left text-xs rounded-md px-1.5 py-1 bg-default-100 hover:bg-default-200 ${flagged.has(e.key) ? "ring-1 ring-warning-400" : ""}`}
        title={e.fromFeed ? "From a calendar feed: tap to say who it's for" : "Tap to change who it's for"}
      >
        {!e.allDay && <span className="tabular-nums text-default-500 mr-1">{fmtTime(e.start)}</span>}
        <span className="font-medium">{e.title}</span>
        {showPeople && e.personIds.length > 0 && <span className="text-default-500"> · {e.personIds.map((id) => lookOf(id)?.name ?? "?").join(", ")}</span>}
      </button>
      {assigning === e.key && (
        <div className="flex flex-wrap gap-1 pl-1">
          {plan.people.map((p) => (
            <Button key={p.id} size="sm" variant={e.personIds.length === 1 && e.personIds[0] === p.id ? "solid" : "flat"} className="h-6 min-w-0 px-2 text-xs" onPress={() => assign(e, [p.id])}>
              {p.name}
            </Button>
          ))}
          <Button size="sm" variant={e.personIds.length === plan.people.length ? "solid" : "flat"} className="h-6 min-w-0 px-2 text-xs" onPress={() => assign(e, plan.people.map((p) => p.id))}>
            Both
          </Button>
          <Button size="sm" variant="light" className="h-6 min-w-0 px-2 text-xs" onPress={() => assign(e, [])}>
            Household
          </Button>
          <Button
            size="sm"
            variant="light"
            className="h-6 min-w-0 px-2 text-xs"
            startContent={<FaPen className="text-[10px]" />}
            onPress={() => {
              setAssigning(null);
              editEvent(e.id);
            }}
          >
            {e.fromFeed ? "Details" : "Edit"}
          </Button>
        </div>
      )}
    </div>
  );

  // Weekend columns get a light tint so the work week reads as one block.
  const weekendBg = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() % 6 === 0 ? "bg-default-50 px-1 rounded-sm" : "px-1");

  // "+" at the bottom of a day cell: a new event that day, for that person.
  const addHere = (date: string, personIds: string[]) => (
    <button
      type="button"
      onClick={() => newEvent(date, personIds)}
      className="self-start text-[11px] text-default-400 hover:text-primary flex items-center gap-1 px-1"
      aria-label="Add an event"
    >
      <FaPlus className="text-[9px]" /> event
    </button>
  );

  // Timed appointments during working hours (7am–6pm) on a weekday: the
  // reason a day might be a home day.
  const workHourEvents = (personId: string, date: string) => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() % 6 !== 0;
    return weekday ? eventsFor(date, (e) => !e.allDay && e.personIds.includes(personId) && (e.start ?? "") >= "07:00" && (e.start ?? "") < "18:00") : [];
  };
  const dayHint = (personId: string, day: Plan["people"][number]["days"][number]) => {
    const appts = workHourEvents(personId, day.date);
    if (!appts.length || (day.status && day.status !== "WORKING_OFFICE")) return null;
    const what = appts.map((e) => `${e.title} ${fmtTime(e.start)}`).join(", ");
    return day.status === "WORKING_OFFICE" ? (
      <span className="text-[11px] leading-tight text-warning-600">{what}: still the office?</span>
    ) : (
      <span className="text-[11px] leading-tight text-default-500">{what}: home?</span>
    );
  };

  const statusSelect = (personId: string, day: Plan["people"][number]["days"][number]) => (
    <select
      aria-label="Where"
      value={day.source === "set" ? day.status ?? "" : ""}
      onChange={(ev) => setStatus(personId, day.date, (ev.target.value || null) as DayStatus | null)}
      className="w-full rounded-md text-xs px-1 py-1 border border-default-200 bg-content1"
      style={day.status ? { borderColor: STATUS_COLORS[day.status], color: STATUS_COLORS[day.status], fontWeight: 600 } : undefined}
    >
      <option value="">{day.source === "trip" ? `Travel (${day.tripName})` : "—"}</option>
      {DAY_STATUSES.map((s) => (
        <option key={s} value={s}>
          {DAY_STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  );

  const petSelect = (petId: string, day: Plan["pets"][number]["days"][number]) => (
    <select
      aria-label="Where"
      value={day.status ?? ""}
      onChange={(ev) => setPet(petId, day.date, (ev.target.value || null) as PetDayStatus | null)}
      className={`w-full rounded-md text-xs px-1 py-1 border border-default-200 bg-content1 ${day.status ? "font-semibold text-primary" : ""}`}
    >
      <option value="">—</option>
      {PET_DAY_STATUSES.map((s) => (
        <option key={s} value={s}>
          {PET_DAY_LABELS[s]}
        </option>
      ))}
    </select>
  );

  const personLabel = (id: string, name: string) => {
    const l = lookOf(id);
    return (
      <Chip size="sm" variant="flat" style={l?.color ? { backgroundColor: `${l.color}33`, color: l.color } : undefined}>
        {l?.emoji ? `${l.emoji} ` : ""}
        {name}
      </Chip>
    );
  };

  return (
    <DefaultLayout>
      <div className="max-w-7xl mx-auto px-4 py-6 flex flex-col gap-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Week planner</h1>
            <p className="text-sm text-default-500">
              {dayNum(plan.weekStart)} – {dayNum(plan.weekEnd)}
              {plan.weekStart === thisMonday ? " · this week" : plan.weekStart === addDays(thisMonday, 7) ? " · next week" : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" isIconOnly variant="flat" aria-label="Previous week" onPress={() => go(addDays(plan.weekStart, -7))}>
              <FaChevronLeft />
            </Button>
            <Button size="sm" variant="flat" onPress={() => go(addDays(thisMonday, 7))}>
              Next week
            </Button>
            <Button size="sm" isIconOnly variant="flat" aria-label="Next week" onPress={() => go(addDays(plan.weekStart, 7))}>
              <FaChevronRight />
            </Button>
            <Button size="sm" isIconOnly variant="light" aria-label="Reload" isLoading={loading} onPress={load}>
              <FaSyncAlt />
            </Button>
            <Button size="sm" color="primary" variant="flat" startContent={<FaPlus />} onPress={() => newEvent(plan.weekStart >= thisMonday ? plan.weekStart : thisMonday)}>
              Event
            </Button>
            <Button size="sm" color="primary" variant="flat" startContent={<FaPlus />} onPress={() => newTask()}>
              Task
            </Button>
          </div>
        </div>

        {/* The review itself: notes for the week and "reviewed", first thing on the page */}
        <Card>
          <CardBody className="flex flex-col sm:flex-row sm:items-end gap-3">
            <Input
              label="Notes for the week"
              placeholder="Cris drives Thursday; book Dolce for Wednesday"
              value={notes}
              onValueChange={setNotes}
              className="flex-1"
            />
            <div className="flex items-center gap-2">
              {reviewed && (
                <span className="text-xs text-default-500">
                  Reviewed{plan.review?.reviewedBy ? ` by ${plan.review.reviewedBy}` : ""}{" "}
                  {new Date(plan.review!.reviewedAt!).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                </span>
              )}
              <Button
                color={reviewed ? "default" : "primary"}
                variant={reviewed ? "flat" : "solid"}
                startContent={<FaCheck />}
                onPress={() => run("mark_week_reviewed", { weekStart: plan.weekStart, notes, ...(me ? { personName: me } : {}) }, reviewed ? "Notes saved" : "Week reviewed")}
              >
                {reviewed ? "Save notes" : "Mark reviewed"}
              </Button>
            </div>
          </CardBody>
        </Card>

        {/* Needs attention */}
        <Card>
          <CardHeader className="font-semibold flex items-center gap-2">
            {plan.attention.length ? <FaExclamationTriangle className="text-warning" /> : <FaCheck className="text-success" />}
            {plan.attention.length ? `Needs attention (${plan.attention.length})` : "Nothing needs attention"}
          </CardHeader>
          {plan.attention.length > 0 && (
            <CardBody className="pt-0 gap-2 text-sm">
              {plan.attention.map((a, i) => {
                const e = a.kind === "unassigned" ? plan.events.find((x) => x.key === a.eventKeys?.[0]) : undefined;
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Chip size="sm" variant="flat" color={a.kind === "overlap" || a.kind === "overdue" ? "danger" : "warning"}>
                      {ATTENTION_LABELS[a.kind] ?? a.kind}
                    </Chip>
                    <span>{a.detail}</span>
                    {e && (
                      <span className="flex gap-1">
                        {plan.people.map((p) => (
                          <Button key={p.id} size="sm" variant="flat" className="h-6 min-w-0 px-2 text-xs" onPress={() => assign(e, [p.id])}>
                            {p.name}
                          </Button>
                        ))}
                        <Button size="sm" variant="flat" className="h-6 min-w-0 px-2 text-xs" onPress={() => assign(e, plan.people.map((p) => p.id))}>
                          Both
                        </Button>
                        <Button size="sm" variant="light" className="h-6 min-w-0 px-2 text-xs" onPress={() => assign(e, [])}>
                          Household
                        </Button>
                      </span>
                    )}
                  </div>
                );
              })}
            </CardBody>
          )}
        </Card>

        {/* Wide screens: the week as a grid */}
        <Card className="hidden md:block">
          <CardBody className="overflow-x-auto">
            <div className="grid grid-cols-[8rem_repeat(7,minmax(0,1fr))] gap-x-2 gap-y-1 min-w-4xl">
              <div />
              {plan.dates.map((d) => (
                <div key={d} className={`text-center text-sm pb-1 ${weekendBg(d)} ${d === todayLocal ? "text-primary font-semibold" : ""}`}>
                  <div className="font-medium">{dayName(d)}</div>
                  <div className="text-xs text-default-500">{dayNum(d)}</div>
                  {markers(d).map((m) => (
                    <div key={m} className="text-xs truncate" title={m}>
                      {m}
                    </div>
                  ))}
                </div>
              ))}

              {/* Each person / pet gets two grid rows: appointments (as tall as
                  their busiest day), then the status, so every status lines
                  up across the week. */}
              {plan.people.map((p) => (
                <React.Fragment key={p.id}>
                  <div className="col-span-8 border-t border-default-200" />
                  <div className="row-span-2 pt-1">{personLabel(p.id, p.name)}</div>
                  {p.days.map((day) => (
                    <div key={`e-${day.date}`} className={`flex flex-col gap-1 pt-1 min-w-0 ${weekendBg(day.date)}`}>
                      {/* Appointments first: they decide office vs home. */}
                      {eventsFor(day.date, (e) => e.personIds.includes(p.id)).map((e) => eventPill(e))}
                      {addHere(day.date, [p.id])}
                    </div>
                  ))}
                  {p.days.map((day) => (
                    <div key={`s-${day.date}`} className={`flex flex-col gap-1 pb-2 min-w-0 ${weekendBg(day.date)}`}>
                      {statusSelect(p.id, day)}
                      {dayHint(p.id, day)}
                    </div>
                  ))}
                </React.Fragment>
              ))}

              {plan.pets.map((pet) => (
                <React.Fragment key={pet.id}>
                  <div className="col-span-8 border-t border-default-200" />
                  <div className="row-span-2 pt-1 flex items-start gap-1 text-sm font-medium">
                    <FaPaw className="text-default-400 mt-0.5" /> {pet.name}
                  </div>
                  {pet.days.map((day) => (
                    <div key={`e-${day.date}`} className={`flex flex-col gap-1 pt-1 min-w-0 ${weekendBg(day.date)}`}>
                      {eventsFor(day.date, (e) => e.petIds.includes(pet.id)).map((e) => eventPill(e, true))}
                    </div>
                  ))}
                  {pet.days.map((day) => (
                    <div key={`s-${day.date}`} className={`pb-2 min-w-0 ${weekendBg(day.date)}`}>
                      {petSelect(pet.id, day)}
                    </div>
                  ))}
                </React.Fragment>
              ))}

              <div className="col-span-8 border-t border-default-200" />
              <div className="pt-1 text-sm font-medium text-default-500">Household</div>
              {plan.dates.map((d) => (
                <div key={d} className={`flex flex-col gap-1 pt-1 pb-2 min-w-0 ${weekendBg(d)}`}>
                  {householdEvents.filter((e) => e.date === d).map((e) => eventPill(e))}
                  {addHere(d, [])}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>

        {/* Phones: one card per day */}
        <div className="md:hidden flex flex-col gap-3">
          {plan.dates.map((d) => (
            <Card key={d}>
              <CardHeader className="pb-1 font-semibold">
                {dayName(d)} <span className="text-default-500 font-normal ml-1">{dayNum(d)}</span>
                {markers(d).length > 0 && <span className="ml-auto text-xs font-normal">{markers(d).join(" · ")}</span>}
              </CardHeader>
              <CardBody className="pt-0 gap-2">
                {plan.people.map((p) => {
                  const day = p.days.find((x) => x.date === d)!;
                  const mine = eventsFor(d, (e) => e.personIds.includes(p.id));
                  return (
                    <div key={p.id} className="flex flex-col gap-1">
                      {personLabel(p.id, p.name)}
                      <div className="flex flex-col gap-1 pl-2">
                        {mine.map((e) => eventPill(e))}
                        {addHere(d, [p.id])}
                      </div>
                      <div className="pl-2">
                        {statusSelect(p.id, day)}
                        {dayHint(p.id, day)}
                      </div>
                    </div>
                  );
                })}
                {plan.pets.map((pet) => {
                  const day = pet.days.find((x) => x.date === d)!;
                  const its = eventsFor(d, (e) => e.petIds.includes(pet.id));
                  return (
                    <div key={pet.id} className="flex flex-col gap-1">
                      <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
                        <span className="flex items-center gap-1 text-sm font-medium">
                          <FaPaw className="text-default-400" /> {pet.name}
                        </span>
                        {petSelect(pet.id, day)}
                      </div>
                      {its.length > 0 && <div className="flex flex-col gap-1 pl-2">{its.map((e) => eventPill(e, true))}</div>}
                    </div>
                  );
                })}
                <div className="flex flex-col gap-1">
                  <span className="text-xs uppercase text-default-500">Household</span>
                  {householdEvents.filter((e) => e.date === d).map((e) => eventPill(e))}
                  {addHere(d, [])}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>

        {/* Money, to-dos, travel, care, birthdays, errands */}
        <WeekSectionCards
          sections={plan.sections}
          nameOf={nameOfId}
          weekStart={plan.weekStart}
          onAddTask={(date) => newTask(date)}
          onCompleteTask={completeTask}
          onAddShoppingItem={addShoppingItem}
        />
        {plan.errors.length > 0 && <p className="text-xs text-default-400">Couldn&apos;t load: {plan.errors.join("; ")}</p>}
      </div>

      <EventModal
        isOpen={!!eventModal}
        onOpenChange={(open) => !open && setEventModal(null)}
        event={eventModal?.event ?? null}
        defaults={eventModal?.defaults}
        people={personRows}
        trips={trips}
        onSaved={() => {
          setEventModal(null);
          load();
        }}
      />
      <TaskModal
        isOpen={!!taskModal}
        onOpenChange={(open) => !open && setTaskModal(null)}
        task={null}
        defaults={taskModal?.defaults}
        people={personRows}
        onSaved={() => {
          setTaskModal(null);
          load();
        }}
      />
    </DefaultLayout>
  );
}
