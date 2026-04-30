// Create / edit / delete a homeTrip.
//
// Trip start/end dates are pure-date (a.date()) — stored as
// YYYY-MM-DD, displayed via formatTripRange. We use the native date
// picker in mode="date" and slice the local components (the picker
// returns a Date in the device's local TZ; we just want the calendar
// day, no time-of-day).
//
// Destination is exposed as free-text city / country / airport. Mobile
// doesn't have the city autocomplete the web has, so lat/lon/timezone
// stay null when entered here. Editing a trip that was created on the
// web preserves those fields; we just don't mutate them.
//
// Delete cascades into legs + reservations so the user doesn't leave
// orphans.

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
import { type Person } from "../lib/use-people";
import {
  TRIP_TYPE_CONFIG,
  type Trip,
  type TripType,
} from "../../lib/trip";

const TRIP_TYPES: TripType[] = ["LEISURE", "WORK", "FLYING", "FAMILY"];

interface Props {
  visible: boolean;
  trip: Trip | null; // null = create
  people: Person[];
  onClose: () => void;
  onSaved: (info?: { toast?: string }) => void;
}

function isoDateOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDateOnly(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function formatDateLabel(s: string): string {
  const d = parseDateOnly(s);
  if (!d) return s;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function TripFormModal({ visible, trip, people, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState<TripType>("LEISURE");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [destCity, setDestCity] = useState("");
  const [destCountry, setDestCountry] = useState("");
  const [destAirport, setDestAirport] = useState("");
  const [notes, setNotes] = useState("");
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (trip) {
      setName(trip.name);
      setType((trip.type as TripType | null) ?? "LEISURE");
      setStartDate(trip.startDate);
      setEndDate(trip.endDate);
      const dest = (trip.destination ?? {}) as Record<string, unknown>;
      setDestCity((dest.city as string) ?? "");
      setDestCountry((dest.country as string) ?? "");
      setDestAirport((dest.airportCode as string) ?? "");
      setNotes(trip.notes ?? "");
      setParticipantIds(
        (trip.participantIds ?? []).filter((id): id is string => !!id)
      );
    } else {
      const today = isoDateOf(new Date());
      setName("");
      setType("LEISURE");
      setStartDate(today);
      setEndDate(today);
      setDestCity("");
      setDestCountry("");
      setDestAirport("");
      setNotes("");
      setParticipantIds([]);
    }
    setShowStartPicker(false);
    setShowEndPicker(false);
  }, [visible, trip]);

  function toggleParticipant(id: string) {
    setParticipantIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function save() {
    if (!name.trim()) {
      Alert.alert("Name required");
      return;
    }
    if (!startDate || !endDate) {
      Alert.alert("Start and end dates required");
      return;
    }
    if (endDate < startDate) {
      Alert.alert("End must be on or after start");
      return;
    }
    setBusy(true);
    try {
      const client = getClient();
      // Preserve any lat/lon/timezone the web autocomplete left on the
      // existing destination — we don't have those signals on mobile.
      const existingDest = (trip?.destination ?? {}) as Record<string, unknown>;
      const destination = {
        city: destCity.trim() || null,
        country: destCountry.trim() || null,
        airportCode: destAirport.trim() || null,
        latitude: (existingDest.latitude as number | null | undefined) ?? null,
        longitude: (existingDest.longitude as number | null | undefined) ?? null,
        timezone: (existingDest.timezone as string | null | undefined) ?? null,
      };
      const payload = {
        name: name.trim(),
        type,
        startDate,
        endDate,
        destination,
        notes: notes.trim() || null,
        participantIds: participantIds.length > 0 ? participantIds : null,
      };
      if (trip) {
        const { errors } = await client.models.homeTrip.update({
          id: trip.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
        onSaved({ toast: "Trip updated" });
      } else {
        const { errors } = await client.models.homeTrip.create(payload);
        if (errors?.length) throw new Error(errors[0].message);
        onSaved({ toast: "Trip created" });
      }
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!trip) return;
    Alert.alert(
      "Delete trip?",
      `"${trip.name}" and all its legs / reservations will be removed.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              const client = getClient();
              // Cascade — Amplify doesn't auto-cascade hasMany.
              const [legsRes, resRes] = await Promise.all([
                client.models.homeTripLeg.list({
                  filter: { tripId: { eq: trip.id } },
                }),
                client.models.homeTripReservation.list({
                  filter: { tripId: { eq: trip.id } },
                }),
              ]);
              await Promise.all([
                ...(legsRes.data ?? []).map((l) =>
                  client.models.homeTripLeg.delete({ id: l.id })
                ),
                ...(resRes.data ?? []).map((r) =>
                  client.models.homeTripReservation.delete({ id: r.id })
                ),
              ]);
              const { errors } = await client.models.homeTrip.delete({
                id: trip.id,
              });
              if (errors?.length) throw new Error(errors[0].message);
              onSaved({ toast: "Trip deleted" });
              onClose();
            } catch (err: any) {
              Alert.alert("Delete failed", err?.message ?? String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
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
          <Text style={styles.headerTitle}>{trip ? "Edit trip" : "New trip"}</Text>
          <Pressable onPress={save} disabled={busy}>
            {busy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.save, !name.trim() && styles.disabled]}>
                Save
              </Text>
            )}
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Italy, June '26"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!trip}
          />

          <Text style={styles.label}>Type</Text>
          <View style={styles.chipRow}>
            {TRIP_TYPES.map((t) => {
              const on = type === t;
              const cfg = TRIP_TYPE_CONFIG[t];
              return (
                <Pressable
                  key={t}
                  onPress={() => setType(t)}
                  style={[
                    styles.chip,
                    on && { backgroundColor: cfg.color, borderColor: cfg.color },
                  ]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {cfg.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.label}>Starts</Text>
          <Pressable
            onPress={() => {
              setShowStartPicker((v) => !v);
              setShowEndPicker(false);
            }}
            style={styles.dateBtn}
            disabled={busy}
          >
            <Ionicons name="calendar-outline" size={16} color="#735f55" />
            <Text style={styles.dateBtnText}>
              {startDate ? formatDateLabel(startDate) : "Pick a date"}
            </Text>
          </Pressable>
          {showStartPicker && (
            <View style={styles.spinnerCard}>
              <DateTimePicker
                value={parseDateOnly(startDate) ?? new Date()}
                mode="date"
                display="spinner"
                themeVariant="light"
                onChange={(_, picked) => {
                  if (!picked) return;
                  const iso = isoDateOf(picked);
                  setStartDate(iso);
                  // If end was before new start, snap end to start.
                  if (endDate && endDate < iso) setEndDate(iso);
                }}
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
            disabled={busy}
          >
            <Ionicons name="calendar-outline" size={16} color="#735f55" />
            <Text style={styles.dateBtnText}>
              {endDate ? formatDateLabel(endDate) : "Pick a date"}
            </Text>
          </Pressable>
          {showEndPicker && (
            <View style={styles.spinnerCard}>
              <DateTimePicker
                value={parseDateOnly(endDate) ?? new Date()}
                mode="date"
                display="spinner"
                themeVariant="light"
                minimumDate={parseDateOnly(startDate) ?? undefined}
                onChange={(_, picked) => {
                  if (picked) setEndDate(isoDateOf(picked));
                }}
              />
            </View>
          )}

          <Text style={styles.label}>Destination — city</Text>
          <TextInput
            style={styles.input}
            value={destCity}
            onChangeText={setDestCity}
            placeholder="Rome"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Destination — country</Text>
          <TextInput
            style={styles.input}
            value={destCountry}
            onChangeText={setDestCountry}
            placeholder="Italy"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Destination — airport (optional)</Text>
          <TextInput
            style={styles.input}
            value={destAirport}
            onChangeText={setDestAirport}
            placeholder="FCO"
            placeholderTextColor="#888"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
          />

          <Text style={styles.label}>Participants</Text>
          <View style={styles.chipRow}>
            {people.map((p) => {
              const on = participantIds.includes(p.id);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => toggleParticipant(p.id)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {p.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.muted}>None selected = household trip</Text>

          <Text style={styles.label}>Notes</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional"
            placeholderTextColor="#888"
            multiline
            editable={!busy}
          />

          {trip && (
            <Pressable
              onPress={confirmDelete}
              style={({ pressed }) => [styles.delete, pressed && { opacity: 0.5 }]}
              disabled={busy}
            >
              <Text style={styles.deleteText}>Delete trip</Text>
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

  body: { padding: 20, gap: 8, paddingBottom: 60 },
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

  delete: { marginTop: 32, paddingVertical: 14, alignItems: "center" },
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
