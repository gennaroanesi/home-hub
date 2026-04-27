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
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../lib/amplify";
import { registerForPushNotifications } from "../../lib/push";
import { usePerson } from "../../lib/use-person";
import type { Schema } from "../../../amplify/data/resource";

type Task = Schema["homeTask"]["type"];
type Event = Schema["homeCalendarEvent"]["type"];

interface TodayData {
  tasks: Task[];
  events: Event[];
}

export default function Today() {
  const personState = usePerson();
  const [data, setData] = useState<TodayData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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

    const tasks = (tasksRes.data ?? [])
      .filter((t) => !t.dueDate || new Date(t.dueDate) < endOfDay)
      .sort((a, b) => {
        // Overdue/due first (oldest dueDate), then no-due-date, by title.
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return a.title.localeCompare(b.title);
      });

    const events = (eventsRes.data ?? [])
      .filter((e) => {
        const start = new Date(e.startAt);
        return start >= startOfDay && start < endOfDay;
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt));

    setData({ tasks, events });
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
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <Text style={styles.heading}>Hi, {personState.person.name}</Text>
        <Text style={styles.dateLine}>{formatToday()}</Text>

        <Section title="Events today">
          {data === null ? (
            <ActivityIndicator />
          ) : data.events.length === 0 ? (
            <EmptyRow>Nothing on the calendar today.</EmptyRow>
          ) : (
            data.events.map((e) => <EventRow key={e.id} event={e} />)
          )}
        </Section>

        <Section title="Tasks">
          {data === null ? (
            <ActivityIndicator />
          ) : data.tasks.length === 0 ? (
            <EmptyRow>No tasks due today. 🎉</EmptyRow>
          ) : (
            data.tasks.map((t) => <TaskRow key={t.id} task={t} now={new Date()} />)
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

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

function EventRow({ event }: { event: Event }) {
  const time = event.isAllDay ? "All day" : formatTime(event.startAt);
  return (
    <View style={styles.row}>
      <Text style={styles.rowTime}>{time}</Text>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {event.title}
        </Text>
      </View>
    </View>
  );
}

function TaskRow({ task, now }: { task: Task; now: Date }) {
  const due = task.dueDate ? new Date(task.dueDate) : null;
  const overdue = due ? due < startOf(now) : false;
  return (
    <View style={styles.row}>
      <Text style={[styles.rowTime, overdue && styles.overdue]}>
        {due ? (overdue ? "Overdue" : "Today") : "—"}
      </Text>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {task.title}
        </Text>
      </View>
    </View>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function startOf(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
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
  heading: { fontSize: 28, fontWeight: "600" },
  dateLine: { color: "#666", marginTop: 2, marginBottom: 16 },
  warn: { color: "#a44", marginTop: 12, marginBottom: 6 },
  mono: { fontFamily: "Menlo", fontSize: 12, color: "#444" },

  section: { marginTop: 8, marginBottom: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
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
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15 },
  overdue: { color: "#c44", fontWeight: "600" },
});
