// Create / edit / delete a homeTask. `task` prop in => edit mode;
// null => create mode. `onSaved` fires after a successful write so
// the parent list can refresh.
//
// Due date now uses the native iOS datetime picker (date+time) to
// match the web's <input type="datetime-local">. Tap the date row
// to expand the picker; the "x" pill clears the value.

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";

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

function formatDueLabel(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function TaskFormModal({ visible, task, people, onClose, onSaved }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedIds, setAssignedIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [showDuePicker, setShowDuePicker] = useState(false);
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
      setDueDate(task.dueDate ? new Date(task.dueDate) : null);
      setRecurrence(task.recurrence ?? "");
    } else {
      setTitle("");
      setDescription("");
      setAssignedIds([]);
      setDueDate(null);
      setRecurrence("");
    }
    setShowDuePicker(false);
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
    setBusy(true);
    try {
      const client = getClient();
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        assignedPersonIds: assignedIds.length > 0 ? assignedIds : null,
        dueDate: dueDate ? dueDate.toISOString() : null,
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
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
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

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
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
          <Pressable
            onPress={() => setShowDuePicker((v) => !v)}
            style={styles.dateBtn}
            disabled={busy}
          >
            <Text style={[styles.dateBtnText, !dueDate && styles.dateBtnPlaceholder]}>
              {dueDate ? formatDueLabel(dueDate) : "Pick a date and time"}
            </Text>
            {dueDate && (
              <Pressable
                onPress={() => {
                  setDueDate(null);
                  setShowDuePicker(false);
                }}
                hitSlop={8}
                disabled={busy}
              >
                <Ionicons name="close-circle" size={18} color="#bbb" />
              </Pressable>
            )}
          </Pressable>
          {showDuePicker && (
            <DateTimePicker
              value={dueDate ?? defaultDueSeed()}
              mode="datetime"
              display={Platform.OS === "ios" ? "inline" : "default"}
              onChange={(_, picked) => {
                if (Platform.OS !== "ios") setShowDuePicker(false);
                if (picked) setDueDate(picked);
              }}
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
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Default seed when opening the picker for the first time —
 *  today at 9am local time. Avoids the picker landing on midnight. */
function defaultDueSeed(): Date {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  return d;
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

  dateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  dateBtnText: { fontSize: 15, color: "#222" },
  dateBtnPlaceholder: { color: "#888" },

  delete: { marginTop: 32, paddingVertical: 14, alignItems: "center" },
  deletePressed: { opacity: 0.5 },
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
