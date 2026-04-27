// Calendar tab — agenda view of upcoming events.
//
// We show the next 60 days expanded from the homeCalendarEvent table.
// Recurring events are expanded via lib/calendar.expandEvents so a
// weekly meeting whose base startAt is months back still shows up
// every Monday in the agenda. Days are grouped with sticky-style
// headers; tapping a row opens the edit modal (read-only when the
// event was imported from an ICS feed).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../lib/amplify";
import {
  expandEvents,
  formatDayLabel,
  formatEventTime,
  isoDate,
  type AgendaEvent,
} from "../../lib/calendar";
import { formatAssignees, usePeople, type Person } from "../../lib/use-people";
import { EventFormModal } from "../../components/EventFormModal";
import type { Schema } from "../../../amplify/data/resource";

type Event = Schema["homeCalendarEvent"]["type"];

const AGENDA_DAYS = 60;

interface DaySection {
  dateKey: string;
  occurrences: AgendaEvent[];
}

export default function Calendar() {
  const { people } = usePeople();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<Event | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homeCalendarEvent.list();
    setEvents(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const sections = useMemo<DaySection[]>(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + AGENDA_DAYS);

    const filteredEvents = personFilter
      ? events.filter((e) => {
          const ids = (e.assignedPersonIds ?? []).filter(
            (x): x is string => !!x
          );
          // No assignees = household event; show for all filters.
          return ids.length === 0 || ids.includes(personFilter);
        })
      : events;

    const expanded = expandEvents(filteredEvents, from, to);
    const groups = new Map<string, AgendaEvent[]>();
    for (const occ of expanded) {
      const key = isoDate(occ.start);
      const arr = groups.get(key) ?? [];
      arr.push(occ);
      groups.set(key, arr);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, occurrences]) => ({ dateKey, occurrences }));
  }, [events, personFilter]);

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(event: Event) {
    setEditing(event);
    setModalOpen(true);
  }

  // FlatList wants a flat array; we flatten section headers + rows
  // into discrete items. Keeping it flat (vs SectionList) matches the
  // shopping/tasks tabs.
  const flatItems = useMemo(() => {
    const out: (
      | { kind: "header"; dateKey: string }
      | { kind: "row"; occ: AgendaEvent }
    )[] = [];
    for (const section of sections) {
      out.push({ kind: "header", dateKey: section.dateKey });
      for (const occ of section.occurrences) {
        out.push({ kind: "row", occ });
      }
    }
    return out;
  }, [sections]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.heading}>Calendar</Text>
        <Pressable onPress={openCreate} hitSlop={12} style={styles.addBtn}>
          <Ionicons name="add" size={28} color="#735f55" />
        </Pressable>
      </View>

      <PersonFilter
        people={people}
        value={personFilter}
        onChange={setPersonFilter}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={flatItems}
          keyExtractor={(item, idx) =>
            item.kind === "header"
              ? `h-${item.dateKey}`
              : `o-${item.occ.event.id}-${item.occ.start.toISOString()}-${idx}`
          }
          contentContainerStyle={styles.listBody}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              Nothing on the calendar in the next {AGENDA_DAYS} days.
            </Text>
          }
          renderItem={({ item }) =>
            item.kind === "header" ? (
              <DayHeader dateKey={item.dateKey} />
            ) : (
              <EventRow
                occ={item.occ}
                people={people}
                onPress={() => openEdit(item.occ.event)}
              />
            )
          }
        />
      )}

      <EventFormModal
        visible={modalOpen}
        event={editing}
        people={people}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />
    </SafeAreaView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function PersonFilter({
  people,
  value,
  onChange,
}: {
  people: Person[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  if (people.length === 0) return null;
  return (
    <View style={styles.personRow}>
      <Pressable
        onPress={() => onChange(null)}
        style={[styles.pill, value === null && styles.pillOn]}
      >
        <Text style={[styles.pillText, value === null && styles.pillTextOn]}>
          Everyone
        </Text>
      </Pressable>
      {people.map((p) => {
        const on = value === p.id;
        return (
          <Pressable
            key={p.id}
            onPress={() => onChange(p.id)}
            style={[styles.pill, on && styles.pillOn]}
          >
            <Text style={[styles.pillText, on && styles.pillTextOn]}>{p.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function DayHeader({ dateKey }: { dateKey: string }) {
  const isToday = dateKey === isoDate(new Date());
  return (
    <View style={styles.dayHeader}>
      <Text style={[styles.dayLabel, isToday && styles.dayLabelToday]}>
        {formatDayLabel(dateKey)}
      </Text>
    </View>
  );
}

function EventRow({
  occ,
  people,
  onPress,
}: {
  occ: AgendaEvent;
  people: Person[];
  onPress: () => void;
}) {
  const assignees = formatAssignees(occ.event.assignedPersonIds ?? [], people);
  const time = formatEventTime(occ);
  const isImported = !!occ.event.feedId;
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Text style={styles.rowTime}>{time}</Text>
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {occ.event.title}
          </Text>
          {isImported && <Ionicons name="cloud-download-outline" size={12} color="#888" />}
          {occ.isRecurrenceInstance && (
            <Ionicons name="repeat" size={12} color="#888" />
          )}
        </View>
        <Text style={styles.rowMeta}>{assignees}</Text>
      </View>
    </Pressable>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  heading: { fontSize: 28, fontWeight: "600" },
  addBtn: { padding: 4 },

  personRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  pillOn: { backgroundColor: "#735f55", borderColor: "#735f55" },
  pillText: { color: "#444", fontSize: 13 },
  pillTextOn: { color: "#fff" },

  listBody: { paddingHorizontal: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  dayHeader: { paddingTop: 16, paddingBottom: 6 },
  dayLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  dayLabelToday: { color: "#735f55" },

  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    marginVertical: 3,
    gap: 12,
  },
  rowTime: { width: 70, color: "#666", fontSize: 13, paddingTop: 1 },
  rowBody: { flex: 1 },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rowTitle: { fontSize: 15, color: "#222", flexShrink: 1 },
  rowMeta: { fontSize: 12, color: "#888", marginTop: 2 },
});
