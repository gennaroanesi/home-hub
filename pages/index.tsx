"use client";

// Home dashboard: the most important things across the app on one
// screen — tasks that need attention, this week's calendar, the baby
// timeline, upcoming travel, open shopping lists and checklists in
// progress. Navigation lives in the sidebar; this page is for "what's
// going on" plus the quick actions (tick off a task, add a task / event
// / list) that don't need the full page. The modals are the same
// components the Tasks, Calendar and Shopping pages use.
//
// Each section loads independently, so one failing query (or a model
// the current backend doesn't have yet) doesn't blank the whole page.

import React, { useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { getCurrentUser, fetchUserAttributes } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Button } from "@heroui/button";
import { Checkbox } from "@heroui/checkbox";
import { useDisclosure } from "@heroui/modal";
import { Spinner, addToast } from "@heroui/react";
import {
  FaTasks,
  FaCalendarAlt,
  FaPlane,
  FaShoppingCart,
  FaHeartbeat,
  FaExclamationTriangle,
  FaCheckSquare,
  FaPlus,
} from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { TaskModal } from "@/components/task-modal";
import { EventModal } from "@/components/event-modal";
import { ShoppingListModal } from "@/components/shopping-list-modal";
import { listAllPages } from "@/lib/list-all";
import {
  ENTITY_TYPE_SINGULAR,
  isArchived,
  progress,
  type Checklist,
  type ChecklistItem,
  type ChecklistProgress,
  type EntityType,
} from "@/lib/checklist";
import { toggleTaskCompleted } from "@/lib/task-actions";
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
import { householdMembers } from "@/lib/household";
import { formatUsd, wishlistSummary, type WishlistSummary } from "@/lib/inventory";
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
type InventoryItem = Schema["homeInventoryItem"]["type"];

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
  // Wishlist items linked to this pregnancy (the baby registry).
  registry: WishlistSummary | null;
}

interface ShoppingSummary {
  list: ShoppingList;
  open: ShoppingItem[];
}

interface ChecklistSummary {
  checklist: Checklist;
  progress: ChecklistProgress;
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
  const [shoppingListCount, setShoppingListCount] = useState(0);
  const [checklists, setChecklists] = useState<Loadable<ChecklistSummary[]>>(undefined);
  const [baby, setBaby] = useState<Loadable<BabyData[]>>(undefined);
  // Every trip, not just upcoming ones: the event modal's trip picker
  // and the checklist card's trip names both need them.
  const [allTrips, setAllTrips] = useState<Trip[]>([]);

  // Quick-action modals
  const taskModal = useDisclosure();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const eventModal = useDisclosure();
  const [selectedEvent, setSelectedEvent] = useState<CalEvent | null>(null);
  const listModal = useDisclosure();

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
    const peopleP = listAllPages<Person>(client.models.homePerson).then((rows) => {
      setPeople(householdMembers(rows));
      return rows;
    });

    loadTasks();
    loadEvents();
    loadTrips();
    loadShopping();
    loadChecklists();
    loadBaby(peopleP);
  }

  function loadTasks() {
    guard(setTasks, async () =>
      bucketTasks(
        await listAllPages<Task>(client.models.homeTask, {
          filter: { isCompleted: { eq: false } },
        }),
        now,
        TASK_DAYS,
      ),
    );
  }

  function loadEvents() {
    const todayStart = startOfLocalDay(now);
    guard(setEvents, async () =>
      eventOccurrences(
        await listAllPages<CalEvent>(client.models.homeCalendarEvent),
        todayStart,
        addLocalDays(todayStart, EVENT_DAYS),
      ),
    );
  }

  function loadTrips() {
    guard(setTrips, async () => {
      const rows = await listAllPages<Trip>(client.models.homeTrip);
      setAllTrips(rows);
      return upcomingTrips(rows, localYmd(now), TRIP_HORIZON_DAYS);
    });
  }

  function loadShopping() {
    guard(setShopping, async () => {
      const [lists, items] = await Promise.all([
        listAllPages<ShoppingList>(client.models.homeShoppingList),
        listAllPages<ShoppingItem>(client.models.homeShoppingItem, {
          filter: { isChecked: { eq: false } },
        }),
      ]);
      setShoppingListCount(lists.length);
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
  }

  // Checklists still in progress: not archived, not templates, and not
  // fully ticked off (an empty list counts as in progress).
  function loadChecklists() {
    guard(setChecklists, async () => {
      const [lists, items] = await Promise.all([
        listAllPages<Checklist>(client.models.homeChecklist),
        listAllPages<ChecklistItem>(client.models.homeChecklistItem),
      ]);
      const itemsByList = new Map<string, ChecklistItem[]>();
      for (const item of items) {
        const bucket = itemsByList.get(item.checklistId) ?? [];
        bucket.push(item);
        itemsByList.set(item.checklistId, bucket);
      }
      return lists
        .filter((c) => (c.entityType as string) !== "TEMPLATE" && !isArchived(c))
        .map((checklist) => ({
          checklist,
          progress: progress(itemsByList.get(checklist.id) ?? []),
        }))
        .filter((c) => c.progress.total === 0 || c.progress.done < c.progress.total)
        .sort(
          (a, b) =>
            b.progress.total - b.progress.done - (a.progress.total - a.progress.done) ||
            a.checklist.name.localeCompare(b.checklist.name),
        );
    });
  }

  function loadBaby(peopleP: Promise<Person[]>) {
    guard(setBaby, async () => {
      // The health models only exist once the backend is deployed with
      // them; an older amplify_outputs.json simply has no such model.
      const models = client.models as Partial<typeof client.models>;
      if (!models.homePregnancy || !models.homeCareItem || !models.homeMedicalVisit) return [];
      const pregnancies = (await listAllPages<Pregnancy>(models.homePregnancy, {
        filter: { status: { eq: "ACTIVE" } },
      }));
      if (pregnancies.length === 0) return [];
      const [allPeople, careItems, visits, wishlist] = await Promise.all([
        peopleP,
        listAllPages<CareItem>(models.homeCareItem),
        listAllPages<Visit>(models.homeMedicalVisit, {
          filter: { status: { eq: "PLANNED" } },
        }),
        models.homeInventoryItem
          ? listAllPages<InventoryItem>(models.homeInventoryItem, {
              filter: { status: { eq: "WISHLIST" } },
            })
          : Promise.resolve([] as InventoryItem[]),
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
        registry: (() => {
          const summary = wishlistSummary(wishlist.filter((w) => w.pregnancyId === pregnancy.id));
          return summary.count > 0 ? summary : null;
        })(),
      }));
    });
  }

  // ── Quick actions ──────────────────────────────────────────────────────────

  function openNewTask() {
    setSelectedTask(null);
    taskModal.onOpen();
  }

  function openTask(task: Task) {
    setSelectedTask(task);
    taskModal.onOpen();
  }

  async function completeTask(task: Task) {
    if (completingIds.has(task.id)) return;
    setCompletingIds((prev) => new Set(prev).add(task.id));
    try {
      const { title, description } = await toggleTaskCompleted(client, task);
      addToast({ title, description, color: "success" });
      loadTasks();
    } catch (err: any) {
      addToast({
        title: "Update failed",
        description: err?.message ?? String(err),
        color: "danger",
      });
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  }

  function openNewEvent() {
    setSelectedEvent(null);
    eventModal.onOpen();
  }

  function openEvent(event: CalEvent) {
    setSelectedEvent(event);
    eventModal.onOpen();
  }

  const peopleById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people],
  );

  const tripNames = useMemo(
    () => new Map(allTrips.map((t) => [t.id, t.name])),
    [allTrips],
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
            <TasksCard
              data={tasks}
              now={now}
              peopleById={peopleById}
              completingIds={completingIds}
              onComplete={completeTask}
              onOpen={openTask}
              onNew={openNewTask}
            />
            <EventsCard
              data={events}
              now={now}
              peopleById={peopleById}
              onOpen={openEvent}
              onNew={openNewEvent}
            />
            <ChecklistsCard data={checklists} tripNames={tripNames} />
          </div>
          <div className="flex flex-col gap-4">
            {baby && baby.length > 0 && baby.map((b) => (
              <BabyCard key={b.pregnancy.id} data={b} now={now} />
            ))}
            {baby === null && <FailedCard title="Baby" icon={<FaHeartbeat />} href="/health" />}
            <TripsCard data={trips} />
            <ShoppingCard data={shopping} onNew={listModal.onOpen} />
          </div>
        </div>

        <TaskModal
          isOpen={taskModal.isOpen}
          onOpenChange={taskModal.onOpenChange}
          task={selectedTask}
          people={people}
          onSaved={loadTasks}
        />
        <EventModal
          isOpen={eventModal.isOpen}
          onOpenChange={eventModal.onOpenChange}
          event={selectedEvent}
          people={people}
          trips={allTrips}
          onSaved={loadEvents}
        />
        <ShoppingListModal
          isOpen={listModal.isOpen}
          onOpenChange={listModal.onOpenChange}
          list={null}
          nextSortOrder={shoppingListCount}
          onSaved={loadShopping}
        />
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
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  href: string;
  hrefLabel?: string;
  badge?: React.ReactNode;
  // Quick action shown in the header next to the page link.
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card shadow="sm" radius="md">
      <CardHeader className="flex items-center gap-2 pb-1">
        <span className="text-default-500">{icon}</span>
        <h2 className="font-semibold text-foreground">{title}</h2>
        {badge}
        <span className="ml-auto flex items-center gap-2">
          {action}
          <NextLink href={href} className="text-xs text-primary hover:underline">
            {hrefLabel}
          </NextLink>
        </span>
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

function NewButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Button
      size="sm"
      variant="flat"
      className="h-6 min-w-0 px-2 text-xs"
      startContent={<FaPlus size={9} />}
      onPress={onPress}
    >
      {label}
    </Button>
  );
}

// A row either links to a page (`href`) or runs an action (`onPress`,
// e.g. open the edit modal). `leading` sits outside the clickable area
// — the task checkbox lives there.
function Row({
  href,
  onPress,
  leading,
  left,
  title,
  right,
}: {
  href?: string;
  onPress?: () => void;
  leading?: React.ReactNode;
  left?: React.ReactNode;
  title: React.ReactNode;
  right?: React.ReactNode;
}) {
  const content = (
    <>
      {left && <span className="w-16 shrink-0 text-xs text-default-500">{left}</span>}
      <span className="flex-1 min-w-0 truncate text-sm text-foreground">{title}</span>
      {right}
    </>
  );
  const cls = "flex flex-1 min-w-0 items-center gap-3 text-left";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 -mx-2 py-1.5 hover:bg-default-100">
      {leading}
      {onPress ? (
        <button type="button" onClick={onPress} className={cls}>
          {content}
        </button>
      ) : (
        <NextLink href={href ?? "#"} className={cls}>
          {content}
        </NextLink>
      )}
    </div>
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
  completingIds,
  onComplete,
  onOpen,
  onNew,
}: {
  data: Loadable<TaskBuckets<Task>>;
  now: Date;
  peopleById: Map<string, Person>;
  completingIds: Set<string>;
  onComplete: (task: Task) => void;
  onOpen: (task: Task) => void;
  onNew: () => void;
}) {
  const overdueCount = data?.overdue.length ?? 0;
  return (
    <Section
      title="Tasks"
      icon={<FaTasks />}
      href="/tasks"
      action={<NewButton label="Task" onPress={onNew} />}
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
                    onPress={() => onOpen(task)}
                    leading={
                      completingIds.has(task.id) ? (
                        <span className="w-5 flex justify-center">
                          <Spinner size="sm" />
                        </span>
                      ) : (
                        <Checkbox
                          size="sm"
                          isSelected={false}
                          onValueChange={() => onComplete(task)}
                          aria-label={`Mark "${task.title}" done`}
                        />
                      )
                    }
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
  onOpen,
  onNew,
}: {
  data: Loadable<EventOccurrence<CalEvent>[]>;
  now: Date;
  peopleById: Map<string, Person>;
  onOpen: (event: CalEvent) => void;
  onNew: () => void;
}) {
  return (
    <Section
      title="This week"
      icon={<FaCalendarAlt />}
      href="/calendar"
      hrefLabel="Calendar"
      action={<NewButton label="Event" onPress={onNew} />}
    >
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
                  onPress={() => onOpen(occ.event)}
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
      urgency: careUrgency({ status: c.status, windowStart: c.windowStart, windowEnd: c.windowEnd, scheduledAt: c.scheduledAt }, today),
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

      {data.registry && (
        <>
          <GroupLabel>Wishlist</GroupLabel>
          <Row
            href="/inventory"
            left={`${data.registry.count} item${data.registry.count === 1 ? "" : "s"}`}
            title={`~${formatUsd(data.registry.estimatedTotal)} to go`}
            right={
              data.registry.unpriced > 0 ? (
                <span className="text-xs text-default-400 shrink-0">{data.registry.unpriced} unpriced</span>
              ) : undefined
            }
          />
        </>
      )}

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
    <Section
      title="Travel"
      icon={<FaPlane />}
      href="/trips"
      action={
        <Button
          as={NextLink}
          href="/trips/new"
          size="sm"
          variant="flat"
          className="h-6 min-w-0 px-2 text-xs"
          startContent={<FaPlus size={9} />}
        >
          Trip
        </Button>
      }
    >
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

function ShoppingCard({ data, onNew }: { data: Loadable<ShoppingSummary[]>; onNew: () => void }) {
  return (
    <Section
      title="Shopping"
      icon={<FaShoppingCart />}
      href="/shopping"
      action={<NewButton label="List" onPress={onNew} />}
    >
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

// ── Checklists ───────────────────────────────────────────────────────────────

function checklistHref(entityType: EntityType, entityId: string): string {
  if (entityType === "TRIP") return `/trips/${entityId}`;
  return "/checklists";
}

function ChecklistsCard({
  data,
  tripNames,
}: {
  data: Loadable<ChecklistSummary[]>;
  tripNames: Map<string, string>;
}) {
  return (
    <Section title="Checklists" icon={<FaCheckSquare />} href="/checklists">
      <SectionBody data={data} empty={(d) => (d.length === 0 ? "No checklists in progress." : null)}>
        {(d) => (
          <>
            {d.slice(0, MAX_ROWS).map(({ checklist, progress: p }) => {
              const type = (checklist.entityType ?? "OTHER") as EntityType;
              const tripName = type === "TRIP" ? tripNames.get(checklist.entityId) : undefined;
              return (
                <Row
                  key={checklist.id}
                  href={checklistHref(type, checklist.entityId)}
                  left={ENTITY_TYPE_SINGULAR[type]}
                  title={
                    tripName ? (
                      <>
                        {checklist.name}
                        <span className="text-default-400"> · {tripName}</span>
                      </>
                    ) : (
                      checklist.name
                    )
                  }
                  right={
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="w-12 h-1.5 rounded-full bg-default-200 overflow-hidden">
                        <span className="block h-full bg-primary" style={{ width: `${p.pct}%` }} />
                      </span>
                      <span className="text-xs text-default-400 w-10 text-right">
                        {p.done}/{p.total}
                      </span>
                    </span>
                  }
                />
              );
            })}
            {d.length > MAX_ROWS && (
              <p className="text-xs text-default-400 px-2">+{d.length - MAX_ROWS} more</p>
            )}
          </>
        )}
      </SectionBody>
    </Section>
  );
}
