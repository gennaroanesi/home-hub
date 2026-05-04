// Create / edit / delete a homeCalendarEvent.
//
// Imported events (event.feedId set, see homeCalendarFeed) are
// read-only — any edits would be overwritten on the next ICS sync —
// so we surface a banner and disable the save flow when feedId is
// truthy. Delete is also blocked since the next sync would just
// recreate the row.
//
// Start / end use the native iOS datetime picker (date+time) to
// match the web's <input type="datetime-local">. When "All day"
// is on, the picker switches to date-only mode and we normalize
// to midnight / 23:59 on save. Moving the start by N preserves
// duration by shifting end by the same delta.

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
  Switch,
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
import { AttachmentSection } from "./AttachmentSection";

type Event = Schema["homeCalendarEvent"]["type"];

interface Props {
  visible: boolean;
  event: Event | null;
  /** Default ISO date (YYYY-MM-DD) when creating from a non-today day. */
  defaultDate?: string;
  people: Person[];
  onClose: () => void;
  onSaved: () => void;
}

function defaultStartSeed(defaultDate?: string): Date {
  if (defaultDate) {
    const d = new Date(`${defaultDate}T09:00:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  return d;
}

function formatLabel(d: Date, allDay: boolean): string {
  if (allDay) {
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 0, 0);
  return out;
}

export function EventFormModal({
  visible,
  event,
  defaultDate,
  people,
  onClose,
  onSaved,
}: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startAt, setStartAt] = useState<Date>(() => defaultStartSeed(defaultDate));
  const [endAt, setEndAt] = useState<Date>(() => {
    const s = defaultStartSeed(defaultDate);
    return new Date(s.getTime() + 60 * 60 * 1000);
  });
  const [assignedIds, setAssignedIds] = useState<string[]>([]);
  const [recurrence, setRecurrence] = useState("");
  const [busy, setBusy] = useState(false);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  const isImported = !!event?.feedId;

  useEffect(() => {
    if (!visible) return;
    if (event) {
      setTitle(event.title);
      setDescription(event.description ?? "");
      setAllDay(event.isAllDay ?? false);
      const s = new Date(event.startAt);
      setStartAt(s);
      setEndAt(
        event.endAt ? new Date(event.endAt) : new Date(s.getTime() + 60 * 60 * 1000)
      );
      setAssignedIds(
        (event.assignedPersonIds ?? []).filter((id): id is string => !!id)
      );
      setRecurrence(event.recurrence ?? "");
    } else {
      setTitle("");
      setDescription("");
      setAllDay(false);
      const s = defaultStartSeed(defaultDate);
      setStartAt(s);
      setEndAt(new Date(s.getTime() + 60 * 60 * 1000));
      setAssignedIds([]);
      setRecurrence("");
    }
    setShowStartPicker(false);
    setShowEndPicker(false);
  }, [visible, event, defaultDate]);

  function toggleAssignee(id: string) {
    setAssignedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function onChangeStart(picked: Date) {
    const delta = picked.getTime() - startAt.getTime();
    setStartAt(picked);
    // Preserve duration when start shifts (web parity).
    setEndAt(new Date(endAt.getTime() + delta));
  }

  async function save() {
    if (!title.trim()) {
      Alert.alert("Title required");
      return;
    }
    if (endAt.getTime() <= startAt.getTime()) {
      Alert.alert("End must be after start");
      return;
    }
    setBusy(true);
    try {
      const startIso = (allDay ? startOfDay(startAt) : startAt).toISOString();
      const endIso = (allDay ? endOfDay(endAt) : endAt).toISOString();

      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        startAt: startIso,
        endAt: endIso,
        isAllDay: allDay,
        assignedPersonIds: assignedIds.length > 0 ? assignedIds : null,
        recurrence: recurrence || null,
      };
      const client = getClient();
      if (event) {
        const { errors } = await client.models.homeCalendarEvent.update({
          id: event.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else {
        const { errors } = await client.models.homeCalendarEvent.create(payload);
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

  function confirmDelete() {
    if (!event) return;
    Alert.alert("Delete event?", `"${event.title}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const client = getClient();
            const { errors } = await client.models.homeCalendarEvent.delete({
              id: event.id,
            });
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

  const formDisabled = busy || isImported;

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
          <Text style={styles.headerTitle}>
            {event ? (isImported ? "Imported event" : "Edit event") : "New event"}
          </Text>
          {isImported ? (
            <View style={{ width: 50 }} />
          ) : (
            <Pressable onPress={save} disabled={busy}>
              {busy ? (
                <ActivityIndicator />
              ) : (
                <Text style={[styles.save, !title.trim() && styles.disabled]}>
                  Save
                </Text>
              )}
            </Pressable>
          )}
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {isImported && (
            <View style={styles.importedBanner}>
              <Text style={styles.importedText}>
                This event was imported from an external calendar feed and is
                read-only here. Edit it in the source calendar.
              </Text>
            </View>
          )}

          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Dentist"
            placeholderTextColor="#888"
            editable={!formDisabled}
            autoFocus={!event}
          />

          <Text style={styles.label}>Description</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={description}
            onChangeText={setDescription}
            placeholder="Optional"
            placeholderTextColor="#888"
            multiline
            editable={!formDisabled}
          />

          <View style={styles.allDayRow}>
            <Text style={styles.label}>All day</Text>
            <Switch
              value={allDay}
              onValueChange={setAllDay}
              disabled={formDisabled}
            />
          </View>

          <Text style={styles.label}>Starts</Text>
          <Pressable
            onPress={() => {
              setShowStartPicker((v) => !v);
              setShowEndPicker(false);
            }}
            style={styles.dateBtn}
            disabled={formDisabled}
          >
            <Ionicons name="calendar-outline" size={16} color="#735f55" />
            <Text style={styles.dateBtnText}>{formatLabel(startAt, allDay)}</Text>
          </Pressable>
          {showStartPicker && (
            <View style={styles.spinnerCard}>
              <DateTimePicker
                value={startAt}
                mode={allDay ? "date" : "datetime"}
                display="spinner"
                themeVariant="light"
                onChange={(_, picked) => {
                  if (picked) onChangeStart(picked);
                }}
                disabled={formDisabled}
              />
            </View>
          )}

          <Text style={styles.label}>Ends</Text>
          <Pressable
            onPress={() => {
              setShowEndPicker((v) => !v);
              setShowStartPicker(false);
            }}
            style={styles.dateBtn}
            disabled={formDisabled}
          >
            <Ionicons name="calendar-outline" size={16} color="#735f55" />
            <Text style={styles.dateBtnText}>{formatLabel(endAt, allDay)}</Text>
          </Pressable>
          {showEndPicker && (
            <View style={styles.spinnerCard}>
              <DateTimePicker
                value={endAt}
                mode={allDay ? "date" : "datetime"}
                display="spinner"
                themeVariant="light"
                minimumDate={startAt}
                onChange={(_, picked) => {
                  if (picked) setEndAt(picked);
                }}
                disabled={formDisabled}
              />
            </View>
          )}

          <Text style={styles.label}>Assigned to</Text>
          <View style={styles.chipRow}>
            {people.map((p) => {
              const on = assignedIds.includes(p.id);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => toggleAssignee(p.id)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={formDisabled}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {p.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.muted}>None selected = household event</Text>

          <Text style={styles.label}>Recurrence</Text>
          <View style={styles.chipRow}>
            <Pressable
              onPress={() => setRecurrence("")}
              style={[styles.chip, !recurrence && styles.chipOn]}
              disabled={formDisabled}
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
                  disabled={formDisabled}
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

          {event && (
            <>
              <Text style={styles.label}>Attachments</Text>
              <AttachmentSection parentType="EVENT" parentId={event.id} />
            </>
          )}

          {event && !isImported && (
            <Pressable
              onPress={confirmDelete}
              style={({ pressed }) => [styles.delete, pressed && { opacity: 0.5 }]}
              disabled={busy}
            >
              <Text style={styles.deleteText}>Delete event</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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

  body: { padding: 20, gap: 8, paddingBottom: 120 },
  importedBanner: {
    backgroundColor: "#fff5e0",
    padding: 12,
    borderRadius: 10,
    marginBottom: 8,
  },
  importedText: { fontSize: 13, color: "#664400" },

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

  allDayRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },

  dateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  dateBtnText: { fontSize: 15, color: "#222" },
  spinnerCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    marginTop: 6,
    paddingVertical: 4,
  },

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
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
