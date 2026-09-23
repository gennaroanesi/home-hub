"use client";

// Home dashboard: the most important things across the app on one
// screen — tasks that need attention, this week's calendar, the baby
// timeline, upcoming travel, and open shopping lists. Navigation lives
// in the sidebar; this page is for "what's going on".
//
// Each section loads independently, so one failing query (or a model
// the current backend doesn't have yet) doesn't blank the whole page.

import React, { useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { getCurrentUser, fetchUserAttributes } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Spinner } from "@heroui/react";
import {
  FaTasks,
  FaCalendarAlt,
  FaPlane,
  FaShoppingCart,
  FaHeartbeat,
  FaExclamationTriangle,
} from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { listAllPages } from "@/lib/list-all";
import {
  addLocalDays,
  bucketTasks,
  eventOccurrences,
  localYmd,
  relativeDayLabel,
  startOfLocalDay,
  upcomingTrips,
  type DatedTask,
  type EventOccurrence,
  type TaskBuckets,
  type UpcomingTrip,
} from "@/lib/dashboard";
import { careUrgency, gestationalAge } from "@/lib/pregnancy";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Person = Schema["homePerson"]["type"];
type Task = Schema["homeTask"]["type"];
type CalEvent = Schema["homeCalendarEvent"]["type"];
type Trip = Schema["homeTrip"]["type"];
type ShoppingList = Schema["homeShoppingList"]["type"];
type ShoppingItem = Schema["homeShoppingItem"]["type"];
type Pregnancy = Schema["homePregnancy"]["type"];
type CareItem = Schema["homeCareItem"]["type"];
type Visit = Schema["homeMedicalVisit"]["type"];

const EVENT_DAYS = 7;
const TASK_DAYS = 7;
const TRIP_HORIZON_DAYS = 60;
const MAX_ROWS = 8;

// undefined = still loading, null = failed / unavailable.
type Loadable<T> = T | undefined | null;

interface BabyData {
  pregnancy: Pregnancy;
  person: string | null;
  careItems: CareItem[];
  nextVisit: Visit | null;
}

interface ShoppingSummary {
  list: ShoppingList;
  open: ShoppingItem[];
}

export default function HomeDashboard() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [now] = useState(() => new Date());

  const [people, setPeople] = useState<Person[]>([]);
  const [tasks, setTasks] = useState<Loadable<TaskBuckets<Task>>>(undefined);
  const [events, setEvents] = useState<Loadable<EventOccurrence<CalEvent>[]>>(undefined);
  const [trips, setTrips] = useState<Loadable<UpcomingTrip<Trip>[]>>(undefined);
  const [shopping, setShopping] = useState<Loadable<ShoppingSummary[]>>(undefined);
  const [baby, setBaby] = useState<Loadable<BabyData[]>>(undefined);

  useEffect(() => {
    (async () => {
      try {
        const { username } = await getCurrentUser();
        const attrs = await fetchUserAttributes();
        setFullName(attrs["custom:full_name"] ?? username);
      } catch {
        router.push("/login");
        return;
      }
      void loadAll();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadAll() {
    const todayStart = startOfLocalDay(now);
    const todayYmd = localYmd(now);

    const peopleP = listAllPages<Person>(client.models.homePerson).then((rows) => {
      // Household members only — face-tagging people have no login.
      const household = rows.filter((p) => p.cognitoUsername);
      setPeople(household);
      return rows;
    });

    guard(setTasks, async () =>
      bucketTasks(
        await listAllPages<Task>(client.models.homeTask, {
          filter: { isCompleted: { eq: false } },
        }),
        now,
        TASK_DAYS,
      ),
    );

    guard(setEvents, async () =>
      eventOccurrences(
        await listAllPages<CalEvent>(client.models.homeCalendarEvent),
        todayStart,
        addLocalDays(todayStart, EVENT_DAYS),
      ),
    );

    guard(setTrips, async () =>
      upcomingTrips(
        await listAllPages<Trip>(client.models.homeTrip),
        todayYmd,
        TRIP_HORIZON_DAYS,
      ),
    );

    guard(setShopping, async () => {
      const [lists, items] = await Promise.all([
        listAllPages<ShoppingList>(client.models.homeShoppingList),
        listAllPages<ShoppingItem>(client.models.homeShoppingItem, {
          filter: { isChecked: { eq: false } },
        }),
      ]);
      return lists
        .filter((l) => !l.isArchived)
        .map((list) => ({
          list,
          open: items
            .filter((i) => i.listId === list.id)
            .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
        }))
        .filter((s) => s.open.length > 0)
        .sort((a, b) => (a.list.sortOrder ?? 0) - (b.list.sortOrder ?? 0));
    });

    guard(setBaby, async () => {
      // The health models only exist once the backend is deployed with
      // them; an older amplify_outputs.json simply has no such model.
      const models = client.models as Partial<typeof client.models>;
      if (!models.homePregnancy || !models.homeCareItem || !models.homeMedicalVisit) return [];
      const pregnancies = (await listAllPages<Pregnancy>(models.homePregnancy, {
        filter: { status: { eq: "ACTIVE" } },
      }));
      if (pregnancies.length === 0) return [];
      const [allPeople, careItems, visits] = await Promise.all([
        peopleP,
        listAllPages<CareItem>(models.homeCareItem),
        listAllPages<Visit>(models.homeMedicalVisit, {
          filter: { status: { eq: "PLANNED" } },
        }),
      ]);
      const nowIso = new Date().toISOString();
      return pregnancies.map((pregnancy) => ({
        pregnancy,
        person: allPeople.find((p) => p.id === pregnancy.personId)?.name ?? null,
        careItems: careItems.filter((c) => c.pregnancyId === pregnancy.id),
        nextVisit:
          visits
            .filter((v) => v.personId === pregnancy.personId && v.visitAt >= nowIso)
            .sort((a, b) => a.visitAt.localeCompare(b.visitAt))[0] ?? null,
      }));
    });
  }

  const peopleById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people],
  );

  const dateLine = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <DefaultLayout>
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-foreground">
          {fullName ? `Hi ${fullName}!` : "Home"}
        </h1>
        {/* Client-only: the page is prerendered, so a date rendered at
            build time would mismatch on hydration. */}
        <p className="text-default-400 mt-1 mb-6">{fullName ? dateLine : " "}</p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <div className="flex flex-col gap-4">
            <TasksCard data={tasks} now={now} peopleById={peopleById} />
            <EventsCard data={events} now={now} peopleById={peopleById} />
          </div>
          <div className="flex flex-col gap-4">
            {baby && baby.length > 0 && baby.map((b) => (
              <BabyCard key={b.pregnancy.id} data={b} now={now} />
            ))}
            {baby === null && <FailedCard title="Baby" icon={<FaHeartbeat />} href="/health" />}
            <TripsCard data={trips} />
            <ShoppingCard data={shopping} />
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
}

// Runs a loader and routes its result (or failure → null) into state.
function guard<T>(set: (v: T | null) => void, load: () => Promise<T>) {
  load().then(set, (err) => {
    console.error("[dashboard]", err);
    set(null);
  });
}

// ── Shared pieces ────────────────────────────────────────────────────────────

function Section({
  title,
  icon,
  href,
  hrefLabel = "View all",
  badge,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  href: string;
  hrefLabel?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card shadow="sm" radius="md">
      <CardHeader className="flex items-center gap-2 pb-1">
        <span className="text-default-500">{icon}</span>
        <h2 className="font-semibold text-foreground">{title}</h2>
        {badge}
        <NextLink href={href} className="ml-auto text-xs text-primary hover:underline">
          {hrefLabel}
        </NextLink>
      </CardHeader>
      <CardBody className="pt-1">{children}</CardBody>
    </Card>
  );
}

function SectionBody<T>({
  data,
  empty,
  children,
}: {
  data: Loadable<T>;
  empty: (d: T) => string | null;
  children: (d: T) => React.ReactNode;
}) {
  if (data === undefined) {
    return (
      <div className="py-4 flex justify-center">
        <Spinner size="sm" />
      </div>
    );
  }
  if (data === null) {
    return <p className="text-sm text-danger py-2">Couldn&apos;t load this section.</p>;
  }
  const emptyMsg = empty(data);
  if (emptyMsg) return <p className="text-sm text-default-400 py-2">{emptyMsg}</p>;
  return <>{children(data)}</>;
}

function FailedCard({ title, icon, href }: { title: string; icon: React.ReactNode; href: string }) {
  return (
    <Section title={title} icon={icon} href={href}>
      <SectionBody data={null} empty={() => null}>{() => null}</SectionBody>
    </Section>
  );
}

function GroupLabel({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "danger" }) {
  return (
    <p
      className={`text-[11px] font-medium uppercase tracking-wider mt-3 first:mt-0 mb-1 ${
        tone === "danger" ? "text-danger" : "text-default-400"
      }`}
    >
      {children}
    </p>
  );
}

function PersonDots({ ids, peopleById }: { ids: (string | null)[] | null | undefined; peopleById: Map<string, Person> }) {
  const people = (ids ?? [])
    .map((id) => (id ? peopleById.get(id) : undefined))
    .filter((p): p is Person => !!p);
  if (people.length === 0) return null;
  return (
    <span className="flex -space-x-1 shrink-0">
      {people.map((p) => (
        <span
          key={p.id}
          title={p.name}
          className="w-5 h-5 rounded-full text-[10px] font-semibold text-white flex items-center justify-center ring-2 ring-content1"
          style={{ backgroundColor: p.color ?? "#888" }}
        >
          {p.emoji ?? p.name.charAt(0)}
        </span>
      ))}
    </span>
  );
}

function Row({
  href,
  left,
  title,
  right,
}: {
  href: string;
  left?: React.ReactNode;
  title: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <NextLink
      href={href}
      className="flex items-center gap-3 rounded-md px-2 -mx-2 py-1.5 hover:bg-default-100"
    >
      {left && <span className="w-16 shrink-0 text-xs text-default-500">{left}</span>}
      <span className="flex-1 min-w-0 truncate text-sm text-foreground">{title}</span>
      {right}
    </NextLink>
  );
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Tasks ────────────────────────────────────────────────────────────────────

function TasksCard({
  data,
  now,
  peopleById,
}: {
  data: Loadable<TaskBuckets<Task>>;
  now: Date;
  peopleById: Map<string, Person>;
}) {
  const overdueCount = data?.overdue.length ?? 0;
  return (
    <Section
      title="Tasks"
      icon={<FaTasks />}
      href="/tasks"
      badge={
        overdueCount > 0 ? (
          <span className="text-xs font-medium text-danger">{overdueCount} overdue</span>
        ) : undefined
      }
    >
      <SectionBody
        data={data}
        empty={(d) =>
          d.overdue.length + d.today.length + d.upcoming.length + d.anytime.length === 0
            ? "Nothing on the list. 🎉"
            : null
        }
      >
        {(d) => {
          // Budget rows so the card stays short: overdue and today first.
          let budget = MAX_ROWS;
          const take = (rows: DatedTask<Task>[]) => {
            const shown = rows.slice(0, Math.max(0, budget));
            budget -= shown.length;
            return shown;
          };
          const groups: { label: string; tone?: "danger"; rows: DatedTask<Task>[]; total: number }[] = [
            { label: "Overdue", tone: "danger", rows: take(d.overdue), total: d.overdue.length },
            { label: "Today", rows: take(d.today), total: d.today.length },
            { label: `Next ${TASK_DAYS} days`, rows: take(d.upcoming), total: d.upcoming.length },
            { label: "Anytime", rows: take(d.anytime), total: d.anytime.length },
          ];
          return groups
            .filter((g) => g.total > 0)
            .map((g) => (
              <div key={g.label}>
                <GroupLabel tone={g.tone}>
                  {g.label} · {g.total}
                </GroupLabel>
                {g.rows.map(({ task, date }) => (
                  <Row
                    key={task.id}
                    href="/tasks"
                    left={date ? relativeDayLabel(date, now) : task.recurrence ? "Repeats" : "—"}
                    title={task.title}
                    right={<PersonDots ids={task.assignedPersonIds} peopleById={peopleById} />}
                  />
                ))}
                {g.rows.length < g.total && (
                  <p className="text-xs text-default-400 px-2">+{g.total - g.rows.length} more</p>
                )}
              </div>
            ));
        }}
      </SectionBody>
    </Section>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────────

function EventsCard({
  data,
  now,
  peopleById,
}: {
  data: Loadable<EventOccurrence<CalEvent>[]>;
  now: Date;
  peopleById: Map<string, Person>;
}) {
  return (
    <Section title="This week" icon={<FaCalendarAlt />} href="/calendar" hrefLabel="Calendar">
      <SectionBody data={data} empty={(d) => (d.length === 0 ? "Nothing on the calendar this week." : null)}>
        {(d) => {
          // Group by local day; an occurrence already in progress shows under today.
          const todayStart = startOfLocalDay(now);
          const days = new Map<string, { label: string; rows: EventOccurrence<CalEvent>[] }>();
          for (const occ of d) {
            const day = occ.start < todayStart ? todayStart : occ.start;
            const key = localYmd(day);
            if (!days.has(key)) days.set(key, { label: relativeDayLabel(day, now), rows: [] });
            days.get(key)!.rows.push(occ);
          }
          return Array.from(days.entries()).map(([key, { label, rows }]) => (
            <div key={key}>
              <GroupLabel>{label}</GroupLabel>
              {rows.map((occ) => (
                <Row
                  key={`${occ.event.id}-${occ.start.getTime()}`}
                  href="/calendar"
                  left={occ.allDay ? "All day" : fmtTime(occ.start)}
                  title={occ.event.title}
                  right={<PersonDots ids={occ.event.assignedPersonIds} peopleById={peopleById} />}
                />
              ))}
            </div>
          ));
        }}
      </SectionBody>
    </Section>
  );
}

// ── Baby ─────────────────────────────────────────────────────────────────────

function BabyCard({ data, now }: { data: BabyData; now: Date }) {
  const today = localYmd(now);
  const ga = gestationalAge(data.pregnancy.dueDate, today);
  const pct = Math.min(100, Math.max(0, (ga.days / 280) * 100));

  const urgent = data.careItems
    .map((c) => ({
      item: c,
      urgency: careUrgency({ status: c.status, windowStart: c.windowStart, windowEnd: c.windowEnd }, today),
    }))
    .filter((c) => c.urgency === "OVERDUE" || c.urgency === "DUE_NOW" || c.urgency === "SOON")
    .sort((a, b) => a.item.windowStart.localeCompare(b.item.windowStart));

  const questionCount = (data.nextVisit?.questions ?? "")
    .split("\n")
    .filter((l) => l.trim()).length;

  return (
    <Section title={data.person ? `Baby · ${data.person}` : "Baby"} icon={<FaHeartbeat />} href="/health" hrefLabel="Health">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-foreground">{ga.label}</span>
        <span className="text-sm text-default-500">
          trimester {ga.trimester} · {ga.daysToGo} days to go
        </span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-default-200 overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>

      {data.nextVisit && (
        <>
          <GroupLabel>Next visit</GroupLabel>
          <Row
            href="/health"
            left={relativeDayLabel(new Date(data.nextVisit.visitAt), now)}
            title={data.nextVisit.title ?? "Appointment"}
            right={
              <span className="text-xs text-default-400 shrink-0">
                {fmtTime(new Date(data.nextVisit.visitAt))}
                {questionCount > 0 && ` · ${questionCount} question${questionCount === 1 ? "" : "s"}`}
              </span>
            }
          />
        </>
      )}

      {urgent.length > 0 && (
        <>
          <GroupLabel>Care timeline</GroupLabel>
          {urgent.slice(0, MAX_ROWS).map(({ item, urgency }) => (
            <Row
              key={item.id}
              href="/health"
              left={
                urgency === "OVERDUE" ? (
                  <span className="text-danger flex items-center gap-1">
                    <FaExclamationTriangle size={10} /> Overdue
                  </span>
                ) : urgency === "DUE_NOW" ? (
                  <span className="text-warning">Due now</span>
                ) : (
                  "Soon"
                )
              }
              title={item.title}
              right={
                <span className="text-xs text-default-400 shrink-0">
                  {urgency === "SOON" ? `opens ${fmtYmd(item.windowStart)}` : `by ${fmtYmd(item.windowEnd)}`}
                </span>
              }
            />
          ))}
        </>
      )}
    </Section>
  );
}

// ── Trips ────────────────────────────────────────────────────────────────────

function TripsCard({ data }: { data: Loadable<UpcomingTrip<Trip>[]> }) {
  return (
    <Section title="Travel" icon={<FaPlane />} href="/trips">
      <SectionBody
        data={data}
        empty={(d) => (d.length === 0 ? `No trips in the next ${TRIP_HORIZON_DAYS} days.` : null)}
      >
        {(d) =>
          d.slice(0, MAX_ROWS).map(({ trip, ongoing, daysAway }) => (
            <Row
              key={trip.id}
              href={`/trips/${trip.id}`}
              left={
                ongoing ? (
                  <span className="text-success font-medium">Now</span>
                ) : daysAway === 1 ? (
                  "Tomorrow"
                ) : (
                  `in ${daysAway}d`
                )
              }
              title={trip.name}
              right={
                <span className="text-xs text-default-400 shrink-0">
                  {fmtYmd(trip.startDate)} – {fmtYmd(trip.endDate)}
                </span>
              }
            />
          ))
        }
      </SectionBody>
    </Section>
  );
}

// ── Shopping ─────────────────────────────────────────────────────────────────

function ShoppingCard({ data }: { data: Loadable<ShoppingSummary[]> }) {
  return (
    <Section title="Shopping" icon={<FaShoppingCart />} href="/shopping">
      <SectionBody data={data} empty={(d) => (d.length === 0 ? "All lists are clear." : null)}>
        {(d) =>
          d.map(({ list, open }) => (
            <NextLink
              key={list.id}
              href="/shopping"
              className="block rounded-md px-2 -mx-2 py-1.5 hover:bg-default-100"
            >
              <div className="flex items-center gap-2 text-sm">
                <span>{list.emoji ?? "🛒"}</span>
                <span className="font-medium text-foreground">{list.name}</span>
                <span className="ml-auto text-xs text-default-400">{open.length} open</span>
              </div>
              <p className="text-xs text-default-500 truncate mt-0.5">
                {open.slice(0, 6).map((i) => i.name).join(", ")}
                {open.length > 6 && "…"}
              </p>
            </NextLink>
          ))
        }
      </SectionBody>
    </Section>
  );
}
