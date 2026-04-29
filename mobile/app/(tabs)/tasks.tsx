// Tasks list. Three-state status filter (open / completed / all) and
// an optional person filter that scopes by assignee. Tap the checkbox
// to toggle complete (optimistic update); tap the row body to open
// the edit modal. The "+" header button creates a new task.

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
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../lib/amplify";
import { resolveCurrentPerson } from "../../lib/current-person";
import { formatRecurrence } from "../../lib/recurrence";
import { formatAssignees, usePeople, type Person } from "../../lib/use-people";
import { TaskFormModal } from "../../components/TaskFormModal";
import type { Schema } from "../../../amplify/data/resource";

type Task = Schema["homeTask"]["type"];
type StatusFilter = "open" | "completed" | "all";

export default function Tasks() {
  const { people } = usePeople();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homeTask.list();
    const sorted = [...(data ?? [])].sort((a, b) => {
      // Open: by dueDate asc (no-due last); Completed: by completedAt desc.
      if (a.isCompleted && b.isCompleted) {
        return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
      }
      if (a.isCompleted) return 1;
      if (b.isCompleted) return -1;
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return a.title.localeCompare(b.title);
    });
    setTasks(sorted);
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

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter === "open" && t.isCompleted) return false;
      if (statusFilter === "completed" && !t.isCompleted) return false;
      if (personFilter) {
        const ids = (t.assignedPersonIds ?? []).filter((x): x is string => !!x);
        if (!ids.includes(personFilter)) return false;
      }
      return true;
    });
  }, [tasks, statusFilter, personFilter]);

  async function toggleComplete(task: Task) {
    const client = getClient();
    // Recurring tasks go through the shared mutation so close-and-spawn
    // semantics match the web.
    if (task.recurrence && !task.isCompleted) {
      try {
        const { person } = await resolveCurrentPerson();
        const { data: result, errors } =
          await client.mutations.taskOccurrenceAction({
            action: "COMPLETE",
            taskId: task.id,
            byPersonId: person?.id ?? null,
          });
        if (errors?.length) throw new Error(errors[0].message);
        if (result && !result.ok) throw new Error(result.message ?? "rejected");
      } catch (err: any) {
        Alert.alert("Update failed", err?.message ?? String(err));
      }
      void load();
      return;
    }

    // One-time task (or uncompleting a previously-closed one).
    const next = !task.isCompleted;
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id
          ? {
              ...t,
              isCompleted: next,
              completedAt: next ? new Date().toISOString() : null,
            }
          : t
      )
    );
    try {
      const { errors } = await client.models.homeTask.update({
        id: task.id,
        isCompleted: next,
        completedAt: next ? new Date().toISOString() : null,
      });
      if (errors?.length) throw new Error(errors[0].message);
    } catch (err: any) {
      Alert.alert("Update failed", err?.message ?? String(err));
      void load();
    }
  }

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(task: Task) {
    setEditing(task);
    setModalOpen(true);
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.heading}>Tasks</Text>
        <Pressable onPress={openCreate} hitSlop={12} style={styles.addBtn}>
          <Ionicons name="add" size={28} color="#735f55" />
        </Pressable>
      </View>

      <View style={styles.filters}>
        <FilterPills
          options={[
            { id: "open", label: "Open" },
            { id: "completed", label: "Done" },
            { id: "all", label: "All" },
          ]}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
        />
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
          data={filtered}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.listBody}
          ItemSeparatorComponent={Separator}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {statusFilter === "open"
                ? "No open tasks. 🎉"
                : statusFilter === "completed"
                  ? "Nothing completed yet."
                  : "No tasks."}
            </Text>
          }
          renderItem={({ item }) => (
            <TaskRow
              task={item}
              people={people}
              onToggle={() => toggleComplete(item)}
              onEdit={() => openEdit(item)}
            />
          )}
        />
      )}

      <TaskFormModal
        visible={modalOpen}
        task={editing}
        people={people}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />
    </SafeAreaView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function FilterPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.pillRow}>
      {options.map((opt) => {
        const on = opt.id === value;
        return (
          <Pressable
            key={opt.id}
            onPress={() => onChange(opt.id)}
            style={[styles.pill, on && styles.pillOn]}
          >
            <Text style={[styles.pillText, on && styles.pillTextOn]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

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

function TaskRow({
  task,
  people,
  onToggle,
  onEdit,
}: {
  task: Task;
  people: Person[];
  onToggle: () => void;
  onEdit: () => void;
}) {
  const due = task.dueDate ? new Date(task.dueDate) : null;
  const overdue = due ? due < startOfToday() : false;
  const dueLabel = due ? formatDueDate(due) : null;
  const assignees = formatAssignees(task.assignedPersonIds ?? [], people);
  const recurrence = formatRecurrence(task.recurrence);

  return (
    <View style={styles.row}>
      <Pressable onPress={onToggle} hitSlop={8} style={styles.checkBtn}>
        <Ionicons
          name={task.isCompleted ? "checkmark-circle" : "ellipse-outline"}
          size={26}
          color={task.isCompleted ? "#4e5e53" : "#bbb"}
        />
      </Pressable>
      <Pressable onPress={onEdit} style={styles.rowBody}>
        <Text style={[styles.rowTitle, task.isCompleted && styles.rowTitleDone]}>
          {task.title}
        </Text>
        <View style={styles.rowMeta}>
          {dueLabel && (
            <Text style={[styles.rowMetaText, overdue && styles.overdue]}>
              {dueLabel}
            </Text>
          )}
          {dueLabel && <Text style={styles.rowMetaSep}>•</Text>}
          <Text style={styles.rowMetaText}>{assignees}</Text>
          {recurrence && (
            <>
              <Text style={styles.rowMetaSep}>•</Text>
              <Ionicons name="repeat" size={11} color="#888" />
              <Text style={styles.rowMetaText}>{recurrence}</Text>
            </>
          )}
        </View>
      </Pressable>
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDueDate(d: Date): string {
  // Compare calendar days, not absolute time — so 9pm today is "Today",
  // not "Tomorrow" (the absolute-diff approach rounds anything past noon
  // up to the next day).
  const today = startOfToday();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((dayStart.getTime() - today.getTime()) / (24 * 3600 * 1000));
  if (diffDays < -1) return `${-diffDays}d overdue`;
  if (diffDays === -1) return "Yesterday";
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

  filters: { paddingHorizontal: 20, marginBottom: 8 },
  personRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  pillRow: { flexDirection: "row", gap: 6 },
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
  separator: { height: 1, backgroundColor: "#eee" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    borderRadius: 10,
    marginVertical: 3,
  },
  checkBtn: { paddingRight: 12 },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, color: "#222" },
  rowTitleDone: {
    textDecorationLine: "line-through",
    color: "#999",
  },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  rowMetaText: { fontSize: 12, color: "#888" },
  rowMetaSep: { color: "#ccc", fontSize: 12 },
  overdue: { color: "#c44", fontWeight: "600" },
});
