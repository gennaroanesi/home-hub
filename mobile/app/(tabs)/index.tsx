// Today dashboard. Shows the signed-in person's name, today's
// calendar events, and any tasks that are overdue / due today / have
// no due date but aren't done. Pull-to-refresh re-fetches.
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
import { registerForPushNotifications } from "../../lib/push";
import { usePeople } from "../../lib/use-people";
import { usePerson } from "../../lib/use-person";
import { Monogram } from "../../components/Monogram";
import { TaskFormModal } from "../../components/TaskFormModal";
import { EventFormModal } from "../../components/EventFormModal";
import type { Schema } from "../../../amplify/data/resource";

type Task = Schema["homeTask"]["type"];
type Event = Schema["homeCalendarEvent"]["type"];

interface TodayData {
  todayTasks: Task[];
  laterTasks: Task[];
  todayEvents: Event[];
  laterEvents: Event[];
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

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    const client = getClient();
    const [tasksRes, eventsRes] = await Promise.all([
      client.models.homeTask.list({
        filter: { isCompleted: { eq: false } },
      }),
      client.models.homeCalendarEvent.list(),
    ]);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    const endOfWeek = new Date(startOfDay);
    endOfWeek.setDate(endOfWeek.getDate() + LATER_DAYS);

    // Bucket events by start time. Recurring events are skipped here
    // (we don't expand on Today — they live in the Calendar agenda).
    const allEvents = eventsRes.data ?? [];
    const todayEvents = allEvents
      .filter((e) => {
        const start = new Date(e.startAt);
        return start >= startOfDay && start < endOfDay;
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    const laterEvents = allEvents
      .filter((e) => {
        const start = new Date(e.startAt);
        return start >= endOfDay && start < endOfWeek;
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt));

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

    setData({ todayTasks, laterTasks, todayEvents, laterEvents });
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
                {data.todayEvents.length === 0 ? (
                  <EmptyRow>Nothing on the calendar today.</EmptyRow>
                ) : (
                  data.todayEvents.map((e) => (
                    <EventRow
                      key={e.id}
                      event={e}
                      showDay={false}
                      onPress={() => {
                        setEditingEvent(e);
                        setEventModalOpen(true);
                      }}
                    />
                  ))
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

            {(data.laterEvents.length > 0 || data.laterTasks.length > 0) && (
              <SuperSection title="Later this week">
                <View style={styles.sectionBody}>
                  {mergeLaterItems(data.laterEvents, data.laterTasks).map(
                    (item) =>
                      item.kind === "event" ? (
                        <EventRow
                          key={`e-${item.event.id}`}
                          event={item.event}
                          showDay
                          onPress={() => {
                            setEditingEvent(item.event);
                            setEventModalOpen(true);
                          }}
                        />
                      ) : (
                        <TaskRow
                          key={`t-${item.task.id}`}
                          task={item.task}
                          now={new Date()}
                          showDay
                          onPress={() => {
                            setEditingTask(item.task);
                            setTaskModalOpen(true);
                          }}
                        />
                      )
                  )}
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

function EventRow({
  event,
  showDay,
  onPress,
}: {
  event: Event;
  showDay: boolean;
  onPress: () => void;
}) {
  const start = new Date(event.startAt);
  const time = event.isAllDay ? "All day" : formatTime(event.startAt);
  const label = showDay ? `${shortWeekday(start)} ${time}` : time;
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Text style={styles.rowTime}>{label}</Text>
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
  | { kind: "event"; sortKey: number; event: Event }
  | { kind: "task"; sortKey: number; task: Task };

/** Interleave events + tasks under "Later this week" by their effective
 *  date. Mirrors how the user thinks about the next 7 days — "what's
 *  next" wins over "what kind of thing it is". Tasks without any date
 *  signal sink to the bottom. */
function mergeLaterItems(events: Event[], tasks: Task[]): LaterItem[] {
  const items: LaterItem[] = [
    ...events.map(
      (e): LaterItem => ({
        kind: "event",
        sortKey: new Date(e.startAt).getTime(),
        event: e,
      })
    ),
    ...tasks.map(
      (t): LaterItem => ({
        kind: "task",
        sortKey: effectiveTaskDate(t)?.getTime() ?? Number.POSITIVE_INFINITY,
        task: t,
      })
    ),
  ];
  items.sort((a, b) => a.sortKey - b.sortKey);
  return items;
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
  rowTime: { width: 70, color: "#666", fontSize: 13 },
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
