// Create / edit / delete a homeTripReservation.
//
// startAt / endAt follow the wall-clock ISO convention — same as
// homeTripLeg.departAt / arriveAt. See lib/trip.ts for why we never
// route those values through `new Date()`.

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
import {
  RESERVATION_EMOJI,
  formatLegDateShort,
  formatLegTime,
  legIsoToLocalDate,
  type ReservationType,
  type TripReservation,
} from "../../lib/trip";

const RESERVATION_TYPES: ReservationType[] = [
  "HOTEL",
  "CAR_RENTAL",
  "TICKET",
  "TOUR",
  "RESTAURANT",
  "ACTIVITY",
  "OTHER",
];

const RESERVATION_TYPE_LABEL: Record<ReservationType, string> = {
  HOTEL: "Hotel",
  CAR_RENTAL: "Car rental",
  TICKET: "Ticket",
  TOUR: "Tour",
  RESTAURANT: "Restaurant",
  ACTIVITY: "Activity",
  OTHER: "Other",
};

interface Props {
  visible: boolean;
  tripId: string;
  reservation: TripReservation | null;
  onClose: () => void;
  onSaved: (info?: { toast?: string }) => void;
}

function toWallClockIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}:00.000Z`;
}

function formatWallClockLabel(iso: string | null | undefined): string {
  if (!iso) return "Pick a date and time";
  const date = formatLegDateShort(iso);
  const time = formatLegTime(iso);
  return [date, time].filter(Boolean).join(" · ") || "Pick a date and time";
}

export function TripReservationFormModal({
  visible,
  tripId,
  reservation,
  onClose,
  onSaved,
}: Props) {
  const [type, setType] = useState<ReservationType>("HOTEL");
  const [name, setName] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [url, setUrl] = useState("");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (reservation) {
      setType((reservation.type as ReservationType | null) ?? "HOTEL");
      setName(reservation.name);
      setStartAt(reservation.startAt ?? "");
      setEndAt(reservation.endAt ?? "");
      const loc = (reservation.location ?? {}) as Record<string, unknown>;
      setCity((loc.city as string) ?? "");
      setCountry((loc.country as string) ?? "");
      setConfirmationCode(reservation.confirmationCode ?? "");
      setUrl(reservation.url ?? "");
      setCost(reservation.cost != null ? String(reservation.cost) : "");
      setCurrency(reservation.currency ?? "");
      setNotes(reservation.notes ?? "");
    } else {
      setType("HOTEL");
      setName("");
      setStartAt("");
      setEndAt("");
      setCity("");
      setCountry("");
      setConfirmationCode("");
      setUrl("");
      setCost("");
      setCurrency("");
      setNotes("");
    }
    setShowStartPicker(false);
    setShowEndPicker(false);
  }, [visible, reservation]);

  function locPayload() {
    const cityV = city.trim() || null;
    const countryV = country.trim() || null;
    if (!cityV && !countryV) return null;
    const existing = (reservation?.location ?? {}) as Record<string, unknown>;
    return {
      city: cityV,
      country: countryV,
      airportCode: (existing.airportCode as string | null | undefined) ?? null,
      latitude: (existing.latitude as number | null | undefined) ?? null,
      longitude: (existing.longitude as number | null | undefined) ?? null,
      timezone: (existing.timezone as string | null | undefined) ?? null,
    };
  }

  async function save() {
    if (!name.trim()) {
      Alert.alert("Name required");
      return;
    }
    let costNum: number | null = null;
    if (cost.trim()) {
      const n = parseFloat(cost);
      if (Number.isNaN(n) || n < 0) {
        Alert.alert("Cost must be a non-negative number");
        return;
      }
      costNum = n;
    }
    setBusy(true);
    try {
      const client = getClient();
      const payload = {
        type,
        name: name.trim(),
        startAt: startAt || null,
        endAt: endAt || null,
        location: locPayload(),
        confirmationCode: confirmationCode.trim() || null,
        url: url.trim() || null,
        cost: costNum,
        currency: currency.trim() || null,
        notes: notes.trim() || null,
      };
      if (reservation) {
        const { errors } = await client.models.homeTripReservation.update({
          id: reservation.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
        onSaved({ toast: "Reservation updated" });
      } else {
        const { errors } = await client.models.homeTripReservation.create({
          tripId,
          sortOrder: 0,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
        onSaved({ toast: "Reservation added" });
      }
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!reservation) return;
    Alert.alert(
      "Delete reservation?",
      `"${reservation.name}" will be removed.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              const client = getClient();
              const { errors } = await client.models.homeTripReservation.delete(
                { id: reservation.id }
              );
              if (errors?.length) throw new Error(errors[0].message);
              onSaved({ toast: "Reservation deleted" });
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
          <Text style={styles.headerTitle}>
            {reservation ? "Edit reservation" : "New reservation"}
          </Text>
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
          <Text style={styles.label}>Type</Text>
          <View style={styles.chipRow}>
            {RESERVATION_TYPES.map((t) => {
              const on = type === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => setType(t)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {RESERVATION_EMOJI[t]} {RESERVATION_TYPE_LABEL[t]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Hotel Astoria"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!reservation}
          />

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
            <Text style={styles.dateBtnText}>{formatWallClockLabel(startAt)}</Text>
            {startAt ? (
              <Pressable
                onPress={() => setStartAt("")}
                hitSlop={8}
                style={styles.clearBtn}
                disabled={busy}
              >
                <Ionicons name="close-circle" size={18} color="#bbb" />
              </Pressable>
            ) : null}
          </Pressable>
          {showStartPicker && (
            <View style={styles.spinnerCard}>
              <DateTimePicker
                value={legIsoToLocalDate(startAt) ?? new Date()}
                mode="datetime"
                display="spinner"
                themeVariant="light"
                onChange={(_, picked) => {
                  if (picked) setStartAt(toWallClockIso(picked));
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
            <Text style={styles.dateBtnText}>{formatWallClockLabel(endAt)}</Text>
            {endAt ? (
              <Pressable
                onPress={() => setEndAt("")}
                hitSlop={8}
                style={styles.clearBtn}
                disabled={busy}
              >
                <Ionicons name="close-circle" size={18} color="#bbb" />
              </Pressable>
            ) : null}
          </Pressable>
          {showEndPicker && (
            <View style={styles.spinnerCard}>
              <DateTimePicker
                value={legIsoToLocalDate(endAt) ?? new Date()}
                mode="datetime"
                display="spinner"
                themeVariant="light"
                onChange={(_, picked) => {
                  if (picked) setEndAt(toWallClockIso(picked));
                }}
              />
            </View>
          )}

          <Text style={styles.label}>City</Text>
          <TextInput
            style={styles.input}
            value={city}
            onChangeText={setCity}
            placeholder="Rome"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Country</Text>
          <TextInput
            style={styles.input}
            value={country}
            onChangeText={setCountry}
            placeholder="Italy"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Confirmation code</Text>
          <TextInput
            style={styles.input}
            value={confirmationCode}
            onChangeText={setConfirmationCode}
            placeholder="Optional"
            placeholderTextColor="#888"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
          />

          <Text style={styles.label}>URL (booking page)</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="https://…"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
          />

          <View style={styles.row2}>
            <View style={styles.flex}>
              <Text style={styles.label}>Cost</Text>
              <TextInput
                style={styles.input}
                value={cost}
                onChangeText={setCost}
                placeholder="0.00"
                placeholderTextColor="#888"
                keyboardType="decimal-pad"
                editable={!busy}
              />
            </View>
            <View style={{ width: 110 }}>
              <Text style={styles.label}>Currency</Text>
              <TextInput
                style={styles.input}
                value={currency}
                onChangeText={setCurrency}
                placeholder="USD"
                placeholderTextColor="#888"
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
              />
            </View>
          </View>

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

          {reservation && (
            <Pressable
              onPress={confirmDelete}
              style={({ pressed }) => [styles.delete, pressed && { opacity: 0.5 }]}
              disabled={busy}
            >
              <Text style={styles.deleteText}>Delete reservation</Text>
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
  multiline: { minHeight: 60, textAlignVertical: "top" },

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
  dateBtnText: { fontSize: 15, color: "#222", flex: 1 },
  clearBtn: { marginLeft: 4 },
  spinnerCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    marginTop: 6,
    paddingVertical: 4,
  },

  row2: { flexDirection: "row", gap: 8, alignItems: "flex-end" },
  flex: { flex: 1 },

  delete: { marginTop: 32, paddingVertical: 14, alignItems: "center" },
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
