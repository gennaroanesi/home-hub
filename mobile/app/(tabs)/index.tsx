// Today dashboard. Shows the signed-in person's name, today's
// calendar events, and any tasks that are overdue / due today / have
// no due date but aren't done. Pull-to-refresh re-fetches.
//
// Events go through the feed settings (eventsFor, use CALENDAR, like the
// web home page), recurring ones expanded, and a busy day (a work
// calendar full of blocks) condenses to its first event, "+N more" (tap
// to expand) and the one that ends last: lib/dashboard.ts condenseDay.
// "Later this week" is grouped by day, events and tasks interleaved.
//
// Phase 1A: bare-RN components, plain useState. We'll factor common
// list / card primitives out into components/ once a second tab needs
// the same shape.

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { RRule } from "rrule";

import { getClient } from "../../lib/amplify";
import { loadCalendarEvents } from "../../lib/calendar";
import { registerForPushNotifications } from "../../lib/push";
import { usePeople } from "../../lib/use-people";
import { usePerson } from "../../lib/use-person";
import { Monogram } from "../../components/Monogram";
import { TaskFormModal } from "../../components/TaskFormModal";
import { EventFormModal } from "../../components/EventFormModal";
import {
  addLocalDays,
  condenseDay,
  eventOccurrences,
  fmtTimeRange,
  localYmd,
  relativeDayLabel,
  startOfLocalDay,
  type DayLine,
  type EventOccurrence,
} from "../../../lib/dashboard";
import type { Schema } from "../../../amplify/data/resource";

type Task = Schema["homeTask"]["type"];
type Event = Schema["homeCalendarEvent"]["type"];
type Occ = EventOccurrence<Event>;

interface TodayData {
  todayTasks: Task[];
  laterTasks: Task[];
  /** Event occurrences from today through LATER_DAYS, keyed by local day (YYYY-MM-DD), in day order. */
  eventDays: Map<string, Occ[]>;
}

const LATER_DAYS = 7;

export default function Today() {
  const personState = usePerson();
  const { people } = usePeople();
  const [data, setData] = useState<TodayData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Tap a row → open the matching edit modal. Reuses the same
  // TaskFormModal / EventFormModal from the dedicated tabs so the
  // edit experience is identical from any entry point.
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [eventModalOpen, setEventModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Busy days the user expanded past "+N more".
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    const client = getClient();
    const [tasksRes, events] = await Promise.all([
      client.models.homeTask.list({
        filter: { isCompleted: { eq: false } },
      }),
      loadCalendarEvents("CALENDAR"),
    ]);

    const startOfDay = startOfLocalDay(new Date());
    const endOfDay = addLocalDays(startOfDay, 1);
    const endOfWeek = addLocalDays(startOfDay, LATER_DAYS);

    // Occurrences (recurring expanded) by local day; one already in
    // progress shows under today, as on the web home page.
    const eventDays = new Map<string, Occ[]>();
    for (const occ of eventOccurrences(events, startOfDay, endOfWeek)) {
      const key = localYmd(occ.start < startOfDay ? startOfDay : occ.start);
      if (!eventDays.has(key)) eventDays.set(key, []);
      eventDays.get(key)!.push(occ);
    }

    // Bucket tasks by effective due date:
    //   - dueDate set: today bucket if overdue/today, later if within window.
    //   - recurring without dueDate: bucket by next-occurrence date.
    //   - neither: ambient — keeps showing up under TODAY until done.
    const allTasks = tasksRes.data ?? [];
    const todayTasks: Task[] = [];
    const laterTasks: Task[] = [];
    for (const t of allTasks) {
      if (t.dueDate) {
        const due = new Date(t.dueDate);
        if (due < endOfDay) todayTasks.push(t);
        else if (due < endOfWeek) laterTasks.push(t);
        continue;
      }
      if (t.recurrence) {
        const next = nextRecurrence(t.recurrence);
        if (!next) {
          todayTasks.push(t); // unparseable rule — surface it
        } else if (next < endOfDay) {
          todayTasks.push(t);
        } else if (next < endOfWeek) {
          laterTasks.push(t);
        }
        continue;
      }
      // Ambient — no due date, no recurrence.
      todayTasks.push(t);
    }

    const taskCmp = (a: Task, b: Task) => {
      const ad = effectiveTaskDate(a)?.getTime() ?? Number.POSITIVE_INFINITY;
      const bd = effectiveTaskDate(b)?.getTime() ?? Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return a.title.localeCompare(b.title);
    };
    todayTasks.sort(taskCmp);
    laterTasks.sort(taskCmp);

    setData({ todayTasks, laterTasks, eventDays });
  }, []);

  useEffect(() => {
    if (personState.status !== "found") return;
    void load();
    void registerForPushNotifications(personState.person.id);
  }, [personState, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  if (personState.status === "loading") {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (personState.status === "missing") {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.heading}>Home Hub</Text>
        <Text style={styles.warn}>
          No homePerson row is linked to your Cognito user.
        </Text>
        {personState.tried.map((c) => (
          <Text key={c} style={styles.mono} selectable>
            • {c}
          </Text>
        ))}
      </SafeAreaView>
    );
  }

  const now = new Date();
  const todayKey = localYmd(now);
  const lines = (key: string) => condenseDay(data?.eventDays.get(key) ?? [], expandedDays.has(key));
  const todayLines = data ? lines(todayKey) : [];
  const laterDays = data ? buildLaterDays(data, todayKey, now, lines) : [];

  // One condensed calendar line: an event, or "+N more" that expands its day.
  const renderLine = (line: DayLine<Event>, dayKey: string, i: number) =>
    line.kind === "more" ? (
      <Pressable
        key={`more-${dayKey}-${i}`}
        onPress={() => setExpandedDays((s) => new Set(s).add(dayKey))}
        style={styles.row}
      >
        <Text style={styles.rowTime} />
        <Ionicons name="ellipsis-horizontal" size={16} color="#aaa" style={styles.rowKindIcon} />
        <View style={styles.rowBody}>
          <Text style={styles.moreText}>+{line.count} more</Text>
        </View>
      </Pressable>
    ) : (
      <EventRow
        key={`e-${line.occ.event.id}-${line.occ.start.getTime()}`}
        occ={line.occ}
        onPress={() => {
          setEditingEvent(line.occ.event);
          setEventModalOpen(true);
        }}
      />
    );

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Ionicons name="checkmark-circle" size={16} color="#fff" />
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <View style={styles.brandRow}>
          <View style={styles.brandText}>
            <Text style={styles.heading}>Hi, {personState.person.name}</Text>
            <Text style={styles.dateLine}>{formatToday()}</Text>
          </View>
          <Monogram height={56} />
        </View>

        {data === null ? (
          <ActivityIndicator />
        ) : (
          <>
            <SuperSection title="Today">
              <Section title="Events">
                {todayLines.length === 0 ? (
                  <EmptyRow>Nothing on the calendar today.</EmptyRow>
                ) : (
                  todayLines.map((line, i) => renderLine(line, todayKey, i))
                )}
              </Section>
              <Section title="Tasks">
                {data.todayTasks.length === 0 ? (
                  <EmptyRow>No tasks for today. 🎉</EmptyRow>
                ) : (
                  data.todayTasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      now={new Date()}
                      showDay={false}
                      onPress={() => {
                        setEditingTask(t);
                        setTaskModalOpen(true);
                      }}
                    />
                  ))
                )}
              </Section>
            </SuperSection>

            {laterDays.length > 0 && (
              <SuperSection title="Later this week">
                <View style={styles.sectionBody}>
                  {laterDays.map(({ key, label, items }) => (
                    <View key={key}>
                      <Text style={styles.dayLabel}>{label}</Text>
                      {items.map((item, i) =>
                        item.kind === "task" ? (
                          <TaskRow
                            key={`t-${item.task.id}`}
                            task={item.task}
                            now={now}
                            showDay={false}
                            onPress={() => {
                              setEditingTask(item.task);
                              setTaskModalOpen(true);
                            }}
                          />
                        ) : (
                          renderLine(item.line, key, i)
                        )
                      )}
                    </View>
                  ))}
                </View>
              </SuperSection>
            )}
          </>
        )}
      </ScrollView>

      <TaskFormModal
        visible={taskModalOpen}
        task={editingTask}
        people={people}
        onClose={() => setTaskModalOpen(false)}
        onSaved={(info) => {
          void load();
          if (info?.toast) setToast(info.toast);
        }}
      />
      <EventFormModal
        visible={eventModalOpen}
        event={editingEvent}
        people={people}
        onClose={() => setEventModalOpen(false)}
        onSaved={load}
      />
    </SafeAreaView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function SuperSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.superSection}>
      <Text style={styles.superSectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <Text style={styles.empty}>{children}</Text>;
}

function EventRow({ occ, onPress }: { occ: Occ; onPress: () => void }) {
  const { event } = occ;
  // Start–end when the event has an end ("10:35–11:00 AM"), like the web home page.
  const label = occ.allDay
    ? "All day"
    : event.endAt
      ? fmtTimeRange(occ.start, occ.end)
      : formatTime(occ.start.toISOString());
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Text style={styles.rowTime} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
        {label}
      </Text>
      <Ionicons
        name="calendar-outline"
        size={16}
        color="#735f55"
        style={styles.rowKindIcon}
      />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {event.title}
        </Text>
      </View>
    </Pressable>
  );
}

function TaskRow({
  task,
  now,
  showDay,
  onPress,
}: {
  task: Task;
  now: Date;
  showDay: boolean;
  onPress: () => void;
}) {
  const due = task.dueDate ? new Date(task.dueDate) : null;
  const overdue = due ? due < startOf(now) : false;
  // For recurring tasks with no current dueDate (between cycles), show
  // when the rule next fires so the row isn't a useless "—". Tasks
  // with a dueDate keep the dueDate-based label even when recurring —
  // dueDate reflects the current cycle, and "Overdue" / "Today" is
  // more actionable than the post-completion next date.
  const nextRecur =
    !due && task.recurrence ? nextRecurrence(task.recurrence) : null;
  const effective = due ?? nextRecur;

  let label = "—";
  if (showDay && effective) {
    // "Later this week" rows show the actual day so the user can
    // distinguish Mon/Tue/Wed at a glance.
    label = shortWeekday(effective);
  } else if (due) {
    // In the TODAY bucket the date is implied — show the time so the
    // user knows when in the day the task is due. Overdue stays as a
    // hard flag.
    label = overdue ? "Overdue" : formatTime(task.dueDate!);
  } else if (nextRecur) {
    label = formatRelativeDate(nextRecur, now);
  }

  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Text style={[styles.rowTime, overdue && styles.overdue]}>{label}</Text>
      <Ionicons
        name="checkbox-outline"
        size={16}
        color="#4e5e53"
        style={styles.rowKindIcon}
      />
      <View style={styles.rowBody}>
        <View style={styles.rowTitleRow}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {task.title}
          </Text>
          {task.recurrence && (
            <Ionicons
              name="repeat"
              size={14}
              color="#888"
              style={styles.rowRecurIcon}
            />
          )}
        </View>
      </View>
    </Pressable>
  );
}

function nextRecurrence(rrule: string): Date | null {
  try {
    const parsed = RRule.fromString(rrule);
    // No dtstart on the task here (this code path runs only when
    // dueDate is null), so anchor the rule at "now" and ask for the
    // next occurrence after now. This gives "the next time it'd be
    // due if scheduled fresh today".
    const rule = new RRule({ ...parsed.origOptions, dtstart: new Date() });
    return rule.after(new Date());
  } catch {
    return null;
  }
}

function formatRelativeDate(d: Date, now: Date): string {
  const start = startOf(now);
  const diffDays = Math.round((d.getTime() - start.getTime()) / (24 * 3600 * 1000));
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function startOf(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function shortWeekday(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

/** Best-effort "when is this task due" for sorting. */
function effectiveTaskDate(t: Task): Date | null {
  if (t.dueDate) return new Date(t.dueDate);
  if (t.recurrence) return nextRecurrence(t.recurrence);
  return null;
}

type LaterItem =
  | { kind: "line"; line: DayLine<Event> }
  | { kind: "task"; task: Task };

interface LaterDay {
  key: string;
  label: string;
  items: LaterItem[];
}

/** "Later this week", one group per day after today: that day's
 *  condensed calendar lines with its tasks interleaved by time ("what's
 *  next" wins over "what kind of thing it is"). All-day events lead;
 *  "+N more" sits right after the day's first event. */
function buildLaterDays(
  data: TodayData,
  todayKey: string,
  now: Date,
  lines: (key: string) => DayLine<Event>[]
): LaterDay[] {
  const tasksByDay = new Map<string, { at: number; task: Task }[]>();
  for (const task of data.laterTasks) {
    const date = effectiveTaskDate(task);
    if (!date) continue; // the later bucket only holds dated tasks
    const key = localYmd(date);
    if (!tasksByDay.has(key)) tasksByDay.set(key, []);
    tasksByDay.get(key)!.push({ at: date.getTime(), task });
  }

  const keys = [...new Set([...data.eventDays.keys(), ...tasksByDay.keys()])]
    .filter((k) => k > todayKey)
    .sort();

  return keys.map((key) => {
    let prev = Number.NEGATIVE_INFINITY;
    const events = lines(key).map((line) => {
      const at =
        line.kind === "more"
          ? prev
          : line.occ.allDay
            ? Number.NEGATIVE_INFINITY
            : line.occ.start.getTime();
      prev = at;
      return { at, item: { kind: "line", line } as LaterItem };
    });
    const tasks = tasksByDay.get(key) ?? []; // already in time order (laterTasks is sorted)
    const items: LaterItem[] = [];
    let t = 0;
    for (const e of events) {
      while (t < tasks.length && tasks[t].at < e.at) items.push({ kind: "task", task: tasks[t++].task });
      items.push(e.item);
    }
    while (t < tasks.length) items.push({ kind: "task", task: tasks[t++].task });

    const [y, m, d] = key.split("-").map(Number);
    return { key, label: relativeDayLabel(new Date(y, m - 1, d), now), items };
  });
}

function formatToday(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  brandRow: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 16,
  },
  // Stretch + justifyContent centers the heading/date pair against
  // the taller monogram. alignItems:center alone leaves the text
  // anchored to its own (shorter) bounding box, which reads as
  // top-aligned next to a 56pt logo.
  brandText: { flex: 1, justifyContent: "center" },
  heading: { fontSize: 28, fontWeight: "600" },
  dateLine: { color: "#666", marginTop: 2 },
  warn: { color: "#a44", marginTop: 12, marginBottom: 6 },
  mono: { fontFamily: "Menlo", fontSize: 12, color: "#444" },

  superSection: { marginTop: 4, marginBottom: 12 },
  superSectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#222",
    marginBottom: 6,
  },
  section: { marginTop: 4, marginBottom: 12 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  sectionBody: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  empty: { color: "#888", padding: 12, fontSize: 14 },

  row: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    gap: 12,
  },
  // Wide enough for an event's "11:30 AM–1:00 PM".
  rowTime: { width: 104, color: "#666", fontSize: 13 },
  moreText: { fontSize: 14, color: "#999" },
  dayLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 2,
  },
  rowKindIcon: { opacity: 0.85 },
  rowBody: { flex: 1 },
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { fontSize: 15, flexShrink: 1 },
  rowRecurIcon: { opacity: 0.7 },
  overdue: { color: "#c44", fontWeight: "600" },

  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#4e5e53",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    marginHorizontal: 20,
    marginTop: 8,
    alignSelf: "flex-start",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  toastText: { color: "#fff", fontSize: 13, fontWeight: "500" },
});
