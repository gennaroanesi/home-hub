// Reminders — browse + pause/resume/delete only. Creating reminders
// is a Janet flow ("remind us every morning at 8am to take vitamins")
// because the items blob is rich and the natural-language path is
// dramatically faster on mobile than a form. The web /reminders page
// keeps the full editor for power-user tweaks.
//
// Lives outside the (tabs) group so it stacks on top of the tabbar
// when the user navigates from More.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../lib/amplify";
import { usePeople } from "../../../lib/use-people";
import type { Schema } from "../../../../amplify/data/resource";

type Reminder = Schema["homeReminder"]["type"];
type StatusFilter = "active" | "all";

interface ReminderItem {
  id?: string;
  name?: string;
  notes?: string;
  firesAt?: string;
  rrule?: string;
}

// AWSJSON tolerant parser, same shape as lib/reminder-schedule on web.
function parseItems(raw: unknown): ReminderItem[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as ReminderItem[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "#4e5e53",
  PAUSED: "#a78a4f",
  EXPIRED: "#888",
  CANCELLED: "#c44",
};

export default function Reminders() {
  const { people } = usePeople();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");

  const load = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homeReminder.list();
    const sorted = [...(data ?? [])].sort(
      (a, b) =>
        new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
    );
    setReminders(sorted);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const visible = useMemo(() => {
    if (statusFilter === "all") return reminders;
    return reminders.filter(
      (r) => r.status === "PENDING" || r.status === "PAUSED"
    );
  }, [reminders, statusFilter]);

  function openActions(r: Reminder) {
    const isActive = r.status === "PENDING" || r.status === "PAUSED";
    const buttons: { text: string; onPress?: () => void; style?: "destructive" | "cancel" }[] = [];
    if (isActive) {
      buttons.push({
        text: r.status === "PAUSED" ? "Resume" : "Pause",
        onPress: () => toggleStatus(r),
      });
    }
    buttons.push({
      text: "Delete",
      style: "destructive",
      onPress: () => confirmDelete(r),
    });
    buttons.push({ text: "Cancel", style: "cancel" });
    Alert.alert(r.name, undefined, buttons, { cancelable: true });
  }

  async function toggleStatus(r: Reminder) {
    const next = r.status === "PAUSED" ? "PENDING" : "PAUSED";
    setReminders((prev) =>
      prev.map((x) => (x.id === r.id ? { ...x, status: next } : x))
    );
    try {
      const client = getClient();
      const { errors } = await client.models.homeReminder.update({
        id: r.id,
        status: next,
      });
      if (errors?.length) throw new Error(errors[0].message);
    } catch (err: any) {
      Alert.alert("Update failed", err?.message ?? String(err));
      void load();
    }
  }

  function confirmDelete(r: Reminder) {
    Alert.alert("Delete reminder?", `"${r.name}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            const client = getClient();
            const { errors } = await client.models.homeReminder.delete({
              id: r.id,
            });
            if (errors?.length) throw new Error(errors[0].message);
            setReminders((prev) => prev.filter((x) => x.id !== r.id));
          } catch (err: any) {
            Alert.alert("Delete failed", err?.message ?? String(err));
          }
        },
      },
    ]);
  }

  function personLabel(r: Reminder): string {
    if (!r.personId) return "Household";
    return people.find((p) => p.id === r.personId)?.name ?? "?";
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color="#735f55" />
        </Pressable>
        <Text style={styles.heading}>Reminders</Text>
      </View>

      <View style={styles.filters}>
        {(
          [
            { id: "active", label: "Active" },
            { id: "all", label: "All" },
          ] as { id: StatusFilter; label: string }[]
        ).map((opt) => {
          const on = opt.id === statusFilter;
          return (
            <Pressable
              key={opt.id}
              onPress={() => setStatusFilter(opt.id)}
              style={[styles.pill, on && styles.pillOn]}
            >
              <Text style={[styles.pillText, on && styles.pillTextOn]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.listBody}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {statusFilter === "active"
                ? 'No active reminders. Ask Janet: "remind us every morning at 8am to take vitamins".'
                : "No reminders yet."}
            </Text>
          }
          renderItem={({ item }) => (
            <ReminderRow
              reminder={item}
              targetLabel={personLabel(item)}
              onPress={() => openActions(item)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function ReminderRow({
  reminder,
  targetLabel,
  onPress,
}: {
  reminder: Reminder;
  targetLabel: string;
  onPress: () => void;
}) {
  const items = parseItems(reminder.items);
  const status = reminder.status ?? "PENDING";
  const next = new Date(reminder.scheduledAt);

  return (
    <Pressable onPress={onPress} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {reminder.name}
        </Text>
        <Text style={styles.rowMeta}>
          {items.length} item{items.length === 1 ? "" : "s"} · {targetLabel}
        </Text>
        <Text style={styles.rowMeta}>Next: {formatNext(next, status)}</Text>
      </View>
      <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[status] ?? "#888" }]}>
        <Text style={styles.statusText}>{status}</Text>
      </View>
    </Pressable>
  );
}

function formatNext(next: Date, status: string): string {
  if (status === "PAUSED") return "paused";
  if (status === "EXPIRED") return "—";
  if (status === "CANCELLED") return "—";
  const now = new Date();
  const diffMin = Math.round((next.getTime() - now.getTime()) / 60_000);
  if (diffMin < -60) return next.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (diffMin < 0) return `${-diffMin}m ago (overdue)`;
  if (diffMin < 60) return `in ${diffMin}m`;
  if (diffMin < 24 * 60) {
    return next.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return next.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 4,
  },
  backBtn: { padding: 4 },
  heading: { fontSize: 28, fontWeight: "600" },

  filters: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
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
  empty: { color: "#888", padding: 24, textAlign: "center", fontSize: 14, lineHeight: 20 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: "#fff",
    borderRadius: 10,
    marginVertical: 3,
    gap: 12,
  },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 15, color: "#222", marginBottom: 2 },
  rowMeta: { fontSize: 12, color: "#888", marginTop: 1 },

  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  statusText: { color: "#fff", fontSize: 10, fontWeight: "600", letterSpacing: 0.5 },
});
