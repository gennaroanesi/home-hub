// Create / edit / delete a homeTask. `task` prop in => edit mode;
// null => create mode. `onSaved` fires after a successful write so
// the parent list can refresh.
//
// Native date pickers were skipped for Phase 1B to avoid a dev-client
// rebuild cycle — instead we expose four quick-pick buttons (None /
// Today / Tomorrow / Next week) and a YYYY-MM-DD text input for
// custom dates. We can drop in @react-native-community/datetimepicker
// later when we rebuild the dev client for another reason.

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { getClient } from "../lib/amplify";
import { RECURRENCE_PRESETS } from "../lib/recurrence";
import { type Person } from "../lib/use-people";
import type { Schema } from "../../amplify/data/resource";

type Task = Schema["homeTask"]["type"];

interface Props {
  visible: boolean;
  task: Task | null; // null = create
  people: Person[];
  onClose: () => void;
  onSaved: () => void;
}

type DueQuick = "none" | "today" | "tomorrow" | "next-week" | "custom";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dueDateForQuick(quick: DueQuick, custom: string): string | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  switch (quick) {
    case "none":
      return null;
    case "today":
      return today.toISOString();
    case "tomorrow": {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
    case "next-week": {
      const d = new Date(today);
      d.setDate(d.getDate() + 7);
      return d.toISOString();
    }
    case "custom":
      if (!ISO_DATE_RE.test(custom)) return null;
      return new Date(`${custom}T00:00:00`).toISOString();
  }
}

function quickFromTask(task: Task | null): { quick: DueQuick; custom: string } {
  if (!task?.dueDate) return { quick: "none", custom: "" };
  const due = new Date(task.dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDay = isoDate(due);
  if (dueDay === isoDate(today)) return { quick: "today", custom: "" };
  const t = new Date(today);
  t.setDate(t.getDate() + 1);
  if (dueDay === isoDate(t)) return { quick: "tomorrow", custom: "" };
  const w = new Date(today);
  w.setDate(w.getDate() + 7);
  if (dueDay === isoDate(w)) return { quick: "next-week", custom: "" };
  return { quick: "custom", custom: dueDay };
}

export function TaskFormModal({ visible, task, people, onClose, onSaved }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedIds, setAssignedIds] = useState<string[]>([]);
  const [quick, setQuick] = useState<DueQuick>("none");
  const [custom, setCustom] = useState("");
  const [recurrence, setRecurrence] = useState<string>(""); // empty = none
  const [busy, setBusy] = useState(false);

  // Reset form when the modal opens. Avoids stale state leaking across
  // create-then-edit cycles.
  useEffect(() => {
    if (!visible) return;
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? "");
      setAssignedIds(
        (task.assignedPersonIds ?? []).filter((id): id is string => !!id)
      );
      const { quick: q, custom: c } = quickFromTask(task);
      setQuick(q);
      setCustom(c);
      setRecurrence(task.recurrence ?? "");
    } else {
      setTitle("");
      setDescription("");
      setAssignedIds([]);
      setQuick("none");
      setCustom("");
      setRecurrence("");
    }
  }, [visible, task]);

  function toggleAssignee(id: string) {
    setAssignedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function save() {
    if (!title.trim()) {
      Alert.alert("Title required");
      return;
    }
    if (quick === "custom" && custom && !ISO_DATE_RE.test(custom)) {
      Alert.alert("Custom date must be YYYY-MM-DD");
      return;
    }
    setBusy(true);
    try {
      const client = getClient();
      const dueDate = dueDateForQuick(quick, custom);
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        assignedPersonIds: assignedIds.length > 0 ? assignedIds : null,
        dueDate,
        recurrence: recurrence || null,
      };
      if (task) {
        const { errors } = await client.models.homeTask.update({
          id: task.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else {
        const { errors } = await client.models.homeTask.create({
          ...payload,
          isCompleted: false,
          createdBy: "mobile",
        });
        if (errors?.length) throw new Error(errors[0].message);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!task) return;
    Alert.alert("Delete task?", `"${task.title}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const client = getClient();
            const { errors } = await client.models.homeTask.delete({ id: task.id });
            if (errors?.length) throw new Error(errors[0].message);
            onSaved();
            onClose();
          } catch (err: any) {
            Alert.alert("Delete failed", err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={onClose} disabled={busy}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle}>{task ? "Edit task" : "New task"}</Text>
          <Pressable onPress={save} disabled={busy}>
            {busy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.save, !title.trim() && styles.disabled]}>Save</Text>
            )}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Water plants"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!task}
          />

          <Text style={styles.label}>Description</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={description}
            onChangeText={setDescription}
            placeholder="Optional"
            placeholderTextColor="#888"
            multiline
            editable={!busy}
          />

          <Text style={styles.label}>Assigned to</Text>
          <View style={styles.chipRow}>
            {people.map((p) => {
              const on = assignedIds.includes(p.id);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => toggleAssignee(p.id)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{p.name}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.muted}>None selected = household task</Text>

          <Text style={styles.label}>Due date</Text>
          <View style={styles.chipRow}>
            {(["none", "today", "tomorrow", "next-week", "custom"] as DueQuick[]).map(
              (q) => {
                const on = quick === q;
                return (
                  <Pressable
                    key={q}
                    onPress={() => setQuick(q)}
                    style={[styles.chip, on && styles.chipOn]}
                    disabled={busy}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>
                      {q === "next-week"
                        ? "Next week"
                        : q.charAt(0).toUpperCase() + q.slice(1)}
                    </Text>
                  </Pressable>
                );
              }
            )}
          </View>
          {quick === "custom" && (
            <TextInput
              style={styles.input}
              value={custom}
              onChangeText={setCustom}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#888"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
            />
          )}

          <Text style={styles.label}>Recurrence</Text>
          <View style={styles.chipRow}>
            <Pressable
              onPress={() => setRecurrence("")}
              style={[styles.chip, !recurrence && styles.chipOn]}
              disabled={busy}
            >
              <Text style={[styles.chipText, !recurrence && styles.chipTextOn]}>
                None
              </Text>
            </Pressable>
            {RECURRENCE_PRESETS.map((p) => {
              const on = recurrence === p.value;
              return (
                <Pressable
                  key={p.value}
                  onPress={() => setRecurrence(p.value)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {p.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {recurrence &&
            !RECURRENCE_PRESETS.some((p) => p.value === recurrence) && (
              <Text style={styles.muted}>
                Custom rule (edit on web): {recurrence}
              </Text>
            )}

          {task && (
            <Pressable
              onPress={confirmDelete}
              style={({ pressed }) => [styles.delete, pressed && styles.deletePressed]}
              disabled={busy}
            >
              <Text style={styles.deleteText}>Delete task</Text>
            </Pressable>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
    backgroundColor: "#fff",
  },
  headerTitle: { fontSize: 16, fontWeight: "600" },
  cancel: { color: "#888", fontSize: 15 },
  save: { color: "#735f55", fontWeight: "600", fontSize: 15 },
  disabled: { opacity: 0.4 },

  body: { padding: 20, gap: 8, paddingBottom: 40 },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
  },
  input: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  muted: { color: "#888", fontSize: 12, marginTop: 4 },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  chipOn: { backgroundColor: "#735f55", borderColor: "#735f55" },
  chipText: { color: "#444", fontSize: 13 },
  chipTextOn: { color: "#fff" },

  delete: { marginTop: 32, paddingVertical: 14, alignItems: "center" },
  deletePressed: { opacity: 0.5 },
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
