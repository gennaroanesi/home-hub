// Create / edit / delete a homeTripLeg.
//
// departAt / arriveAt follow the wall-clock ISO convention: stored as
// "YYYY-MM-DDTHH:mm:00.000Z" where the Z is syntactic and the time is
// the actual clock reading at the airport. We never run these values
// through `new Date()` for storage — the local-date components are
// formatted into the ISO string by hand. See lib/trip.ts.
//
// Locations are split into city / airport / country text inputs; mobile
// doesn't have the city autocomplete the web has, so latitude /
// longitude / timezone come back null when entered here. Editing a leg
// created on the web preserves those fields untouched.

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
  LEG_MODE_EMOJI,
  LEG_MODE_LABEL,
  formatLegDateShort,
  formatLegTime,
  legIsoToLocalDate,
  type LegMode,
  type TripLeg,
} from "../../lib/trip";

const LEG_MODES: LegMode[] = [
  "COMMERCIAL_FLIGHT",
  "PERSONAL_FLIGHT",
  "CAR",
  "TRAIN",
  "BUS",
  "BOAT",
  "OTHER",
];

interface Props {
  visible: boolean;
  tripId: string;
  leg: TripLeg | null;
  onClose: () => void;
  onSaved: (info?: { toast?: string }) => void;
}

/** Format a Date's local components as "YYYY-MM-DDTHH:mm:00.000Z" —
 *  the wall-clock ISO convention. The Z is syntactic. */
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

export function TripLegFormModal({
  visible,
  tripId,
  leg,
  onClose,
  onSaved,
}: Props) {
  const [mode, setMode] = useState<LegMode>("COMMERCIAL_FLIGHT");
  const [departAt, setDepartAt] = useState("");
  const [arriveAt, setArriveAt] = useState("");
  const [showDepartPicker, setShowDepartPicker] = useState(false);
  const [showArrivePicker, setShowArrivePicker] = useState(false);
  const [fromCity, setFromCity] = useState("");
  const [fromAirport, setFromAirport] = useState("");
  const [fromCountry, setFromCountry] = useState("");
  const [toCity, setToCity] = useState("");
  const [toAirport, setToAirport] = useState("");
  const [toCountry, setToCountry] = useState("");
  const [airline, setAirline] = useState("");
  const [flightNumber, setFlightNumber] = useState("");
  const [aircraft, setAircraft] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (leg) {
      setMode((leg.mode as LegMode | null) ?? "COMMERCIAL_FLIGHT");
      setDepartAt(leg.departAt ?? "");
      setArriveAt(leg.arriveAt ?? "");
      const from = (leg.fromLocation ?? {}) as Record<string, unknown>;
      const to = (leg.toLocation ?? {}) as Record<string, unknown>;
      setFromCity((from.city as string) ?? "");
      setFromAirport((from.airportCode as string) ?? "");
      setFromCountry((from.country as string) ?? "");
      setToCity((to.city as string) ?? "");
      setToAirport((to.airportCode as string) ?? "");
      setToCountry((to.country as string) ?? "");
      setAirline(leg.airline ?? "");
      setFlightNumber(leg.flightNumber ?? "");
      setAircraft(leg.aircraft ?? "");
      setConfirmationCode(leg.confirmationCode ?? "");
      setUrl(leg.url ?? "");
      setNotes(leg.notes ?? "");
    } else {
      setMode("COMMERCIAL_FLIGHT");
      setDepartAt("");
      setArriveAt("");
      setFromCity("");
      setFromAirport("");
      setFromCountry("");
      setToCity("");
      setToAirport("");
      setToCountry("");
      setAirline("");
      setFlightNumber("");
      setAircraft("");
      setConfirmationCode("");
      setUrl("");
      setNotes("");
    }
    setShowDepartPicker(false);
    setShowArrivePicker(false);
  }, [visible, leg]);

  function locPayload(
    city: string,
    airport: string,
    country: string,
    existing: Record<string, unknown> | undefined
  ) {
    const cityV = city.trim() || null;
    const airportV = airport.trim() || null;
    const countryV = country.trim() || null;
    if (!cityV && !airportV && !countryV) return null;
    return {
      city: cityV,
      airportCode: airportV,
      country: countryV,
      latitude: (existing?.latitude as number | null | undefined) ?? null,
      longitude: (existing?.longitude as number | null | undefined) ?? null,
      timezone: (existing?.timezone as string | null | undefined) ?? null,
    };
  }

  async function save() {
    setBusy(true);
    try {
      const client = getClient();
      const fromExisting = leg?.fromLocation as Record<string, unknown> | undefined;
      const toExisting = leg?.toLocation as Record<string, unknown> | undefined;
      const payload = {
        mode,
        departAt: departAt || null,
        arriveAt: arriveAt || null,
        fromLocation: locPayload(fromCity, fromAirport, fromCountry, fromExisting),
        toLocation: locPayload(toCity, toAirport, toCountry, toExisting),
        airline: airline.trim() || null,
        flightNumber: flightNumber.trim() || null,
        aircraft: aircraft.trim() || null,
        confirmationCode: confirmationCode.trim() || null,
        url: url.trim() || null,
        notes: notes.trim() || null,
      };
      if (leg) {
        const { errors } = await client.models.homeTripLeg.update({
          id: leg.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
        onSaved({ toast: "Leg updated" });
      } else {
        const { errors } = await client.models.homeTripLeg.create({
          tripId,
          sortOrder: 0,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
        onSaved({ toast: "Leg added" });
      }
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!leg) return;
    Alert.alert("Delete leg?", `${LEG_MODE_LABEL[mode]} will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const client = getClient();
            const { errors } = await client.models.homeTripLeg.delete({
              id: leg.id,
            });
            if (errors?.length) throw new Error(errors[0].message);
            onSaved({ toast: "Leg deleted" });
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

  const isFlight = mode === "COMMERCIAL_FLIGHT" || mode === "PERSONAL_FLIGHT";

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
          <Text style={styles.headerTitle}>{leg ? "Edit leg" : "New leg"}</Text>
          <Pressable onPress={save} disabled={busy}>
            {busy ? <ActivityIndicator /> : <Text style={styles.save}>Save</Text>}
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.label}>Mode</Text>
          <View style={styles.chipRow}>
            {LEG_MODES.map((m) => {
              const on = mode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => setMode(m)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {LEG_MODE_EMOJI[m]} {LEG_MODE_LABEL[m]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.label}>Departs</Text>
          <Pressable
            onPress={() => {
              setShowDepartPicker((v) => !v);
              setShowArrivePicker(false);
            }}
            style={styles.dateBtn}
            disabled={busy}
          >
            <Ionicons name="calendar-outline" size={16} color="#735f55" />
            <Text style={styles.dateBtnText}>{formatWallClockLabel(departAt)}</Text>
            {departAt ? (
              <Pressable
                onPress={() => setDepartAt("")}
                hitSlop={8}
                style={styles.clearBtn}
                disabled={busy}
              >
                <Ionicons name="close-circle" size={18} color="#bbb" />
              </Pressable>
            ) : null}
          </Pressable>
          {showDepartPicker && (
            <View style={styles.spinnerCard}>
              <DateTimePicker
                value={legIsoToLocalDate(departAt) ?? new Date()}
                mode="datetime"
                display="spinner"
                themeVariant="light"
                onChange={(_, picked) => {
                  if (picked) setDepartAt(toWallClockIso(picked));
                }}
              />
            </View>
          )}

          <Text style={styles.label}>Arrives</Text>
          <Pressable
            onPress={() => {
              setShowArrivePicker((v) => !v);
              setShowDepartPicker(false);
            }}
            style={styles.dateBtn}
            disabled={busy}
          >
            <Ionicons name="calendar-outline" size={16} color="#735f55" />
            <Text style={styles.dateBtnText}>{formatWallClockLabel(arriveAt)}</Text>
            {arriveAt ? (
              <Pressable
                onPress={() => setArriveAt("")}
                hitSlop={8}
                style={styles.clearBtn}
                disabled={busy}
              >
                <Ionicons name="close-circle" size={18} color="#bbb" />
              </Pressable>
            ) : null}
          </Pressable>
          {showArrivePicker && (
            <View style={styles.spinnerCard}>
              <DateTimePicker
                value={legIsoToLocalDate(arriveAt) ?? new Date()}
                mode="datetime"
                display="spinner"
                themeVariant="light"
                onChange={(_, picked) => {
                  if (picked) setArriveAt(toWallClockIso(picked));
                }}
              />
            </View>
          )}

          <Text style={styles.label}>From — city</Text>
          <TextInput
            style={styles.input}
            value={fromCity}
            onChangeText={setFromCity}
            placeholder="Austin"
            placeholderTextColor="#888"
            editable={!busy}
          />
          {isFlight && (
            <>
              <Text style={styles.label}>From — airport</Text>
              <TextInput
                style={styles.input}
                value={fromAirport}
                onChangeText={setFromAirport}
                placeholder="AUS"
                placeholderTextColor="#888"
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
              />
            </>
          )}
          <Text style={styles.label}>From — country</Text>
          <TextInput
            style={styles.input}
            value={fromCountry}
            onChangeText={setFromCountry}
            placeholder="US"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>To — city</Text>
          <TextInput
            style={styles.input}
            value={toCity}
            onChangeText={setToCity}
            placeholder="Rome"
            placeholderTextColor="#888"
            editable={!busy}
          />
          {isFlight && (
            <>
              <Text style={styles.label}>To — airport</Text>
              <TextInput
                style={styles.input}
                value={toAirport}
                onChangeText={setToAirport}
                placeholder="FCO"
                placeholderTextColor="#888"
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
              />
            </>
          )}
          <Text style={styles.label}>To — country</Text>
          <TextInput
            style={styles.input}
            value={toCountry}
            onChangeText={setToCountry}
            placeholder="Italy"
            placeholderTextColor="#888"
            editable={!busy}
          />

          {mode === "COMMERCIAL_FLIGHT" && (
            <>
              <Text style={styles.label}>Airline</Text>
              <TextInput
                style={styles.input}
                value={airline}
                onChangeText={setAirline}
                placeholder="United"
                placeholderTextColor="#888"
                editable={!busy}
              />
              <Text style={styles.label}>Flight number</Text>
              <TextInput
                style={styles.input}
                value={flightNumber}
                onChangeText={setFlightNumber}
                placeholder="UA5028"
                placeholderTextColor="#888"
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
              />
            </>
          )}
          {mode === "PERSONAL_FLIGHT" && (
            <>
              <Text style={styles.label}>Aircraft</Text>
              <TextInput
                style={styles.input}
                value={aircraft}
                onChangeText={setAircraft}
                placeholder="N12345"
                placeholderTextColor="#888"
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
              />
            </>
          )}

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

          {leg && (
            <Pressable
              onPress={confirmDelete}
              style={({ pressed }) => [styles.delete, pressed && { opacity: 0.5 }]}
              disabled={busy}
            >
              <Text style={styles.deleteText}>Delete leg</Text>
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

  delete: { marginTop: 32, paddingVertical: 14, alignItems: "center" },
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
