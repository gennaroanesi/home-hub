// Create / edit / delete a homeCalendarEvent.
//
// Imported events (event.feedId set, see homeCalendarFeed) are
// read-only — any edits would be overwritten on the next ICS sync —
// so we surface a banner and disable the save flow when feedId is
// truthy. Delete is also blocked since the next sync would just
// recreate the row.
//
// Native date pickers are deliberately deferred (would force a
// dev-client rebuild). For Phase 1D the form uses quick-pick chips
// for the date plus a YYYY-MM-DD input for arbitrary dates, and a
// plain HH:MM TextInput for the start time.

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { getClient } from "../lib/amplify";
import { isoDate } from "../lib/calendar";
import { RECURRENCE_PRESETS } from "../lib/recurrence";
import { type Person } from "../lib/use-people";
import type { Schema } from "../../amplify/data/resource";

type Event = Schema["homeCalendarEvent"]["type"];

interface Props {
  visible: boolean;
  event: Event | null;
  /** Default date when creating from a non-today day. */
  defaultDate?: string;
  people: Person[];
  onClose: () => void;
  onSaved: () => void;
}

type DateQuick = "today" | "tomorrow" | "next-week" | "custom";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function todayDate(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateForQuick(q: DateQuick, custom: string): string {
  if (q === "custom" && ISO_DATE_RE.test(custom)) return custom;
  const d = todayDate();
  if (q === "tomorrow") d.setDate(d.getDate() + 1);
  if (q === "next-week") d.setDate(d.getDate() + 7);
  return isoDate(d);
}

function quickFromDate(dateStr: string): { quick: DateQuick; custom: string } {
  const today = isoDate(todayDate());
  if (dateStr === today) return { quick: "today", custom: "" };
  const tom = new Date(todayDate());
  tom.setDate(tom.getDate() + 1);
  if (dateStr === isoDate(tom)) return { quick: "tomorrow", custom: "" };
  const nw = new Date(todayDate());
  nw.setDate(nw.getDate() + 7);
  if (dateStr === isoDate(nw)) return { quick: "next-week", custom: "" };
  return { quick: "custom", custom: dateStr };
}

function buildStartIso(dateStr: string, time: string, allDay: boolean): string {
  if (allDay) return new Date(`${dateStr}T00:00:00`).toISOString();
  return new Date(`${dateStr}T${time}:00`).toISOString();
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
  const [quick, setQuick] = useState<DateQuick>("today");
  const [custom, setCustom] = useState("");
  const [time, setTime] = useState("09:00");
  const [durationMin, setDurationMin] = useState("60");
  const [assignedIds, setAssignedIds] = useState<string[]>([]);
  const [recurrence, setRecurrence] = useState("");
  const [busy, setBusy] = useState(false);

  const isImported = !!event?.feedId;

  useEffect(() => {
    if (!visible) return;
    if (event) {
      setTitle(event.title);
      setDescription(event.description ?? "");
      setAllDay(event.isAllDay ?? false);
      const { quick: q, custom: c } = quickFromDate(isoDate(new Date(event.startAt)));
      setQuick(q);
      setCustom(c);
      const start = new Date(event.startAt);
      setTime(
        `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`
      );
      const dur = event.endAt
        ? Math.max(
            5,
            Math.round(
              (new Date(event.endAt).getTime() - start.getTime()) / 60_000
            )
          )
        : 60;
      setDurationMin(String(dur));
      setAssignedIds(
        (event.assignedPersonIds ?? []).filter((id): id is string => !!id)
      );
      setRecurrence(event.recurrence ?? "");
    } else {
      setTitle("");
      setDescription("");
      setAllDay(false);
      const seed = defaultDate ?? isoDate(todayDate());
      const { quick: q, custom: c } = quickFromDate(seed);
      setQuick(q);
      setCustom(c);
      setTime("09:00");
      setDurationMin("60");
      setAssignedIds([]);
      setRecurrence("");
    }
  }, [visible, event, defaultDate]);

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
    if (quick === "custom" && !ISO_DATE_RE.test(custom)) {
      Alert.alert("Custom date must be YYYY-MM-DD");
      return;
    }
    if (!allDay && !TIME_RE.test(time)) {
      Alert.alert("Time must be HH:MM (24-hour)");
      return;
    }
    const dur = parseInt(durationMin, 10);
    if (!allDay && (Number.isNaN(dur) || dur <= 0)) {
      Alert.alert("Duration must be a positive number of minutes");
      return;
    }
    setBusy(true);
    try {
      const dateStr = dateForQuick(quick, custom);
      const startAt = buildStartIso(dateStr, time, allDay);
      const endAt = allDay
        ? new Date(`${dateStr}T23:59:00`).toISOString()
        : new Date(new Date(startAt).getTime() + dur * 60_000).toISOString();

      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        startAt,
        endAt,
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

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.screen}>
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

        <ScrollView contentContainerStyle={styles.body}>
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
            editable={!busy && !isImported}
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
            editable={!busy && !isImported}
          />

          <View style={styles.allDayRow}>
            <Text style={styles.label}>All day</Text>
            <Switch
              value={allDay}
              onValueChange={setAllDay}
              disabled={busy || isImported}
            />
          </View>

          <Text style={styles.label}>Date</Text>
          <View style={styles.chipRow}>
            {(["today", "tomorrow", "next-week", "custom"] as DateQuick[]).map((q) => {
              const on = quick === q;
              return (
                <Pressable
                  key={q}
                  onPress={() => setQuick(q)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy || isImported}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {q === "next-week"
                      ? "Next week"
                      : q.charAt(0).toUpperCase() + q.slice(1)}
                  </Text>
                </Pressable>
              );
            })}
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
              editable={!busy && !isImported}
            />
          )}

          {!allDay && (
            <>
              <Text style={styles.label}>Start time (24h)</Text>
              <TextInput
                style={styles.input}
                value={time}
                onChangeText={setTime}
                placeholder="HH:MM"
                placeholderTextColor="#888"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy && !isImported}
                keyboardType="numbers-and-punctuation"
              />

              <Text style={styles.label}>Duration (min)</Text>
              <TextInput
                style={styles.input}
                value={durationMin}
                onChangeText={setDurationMin}
                placeholder="60"
                placeholderTextColor="#888"
                keyboardType="number-pad"
                editable={!busy && !isImported}
              />
            </>
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
                  disabled={busy || isImported}
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
              disabled={busy || isImported}
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
                  disabled={busy || isImported}
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
