// Create / edit a homePetMedication row.
//
// Schedule is free text in v1 ("twice daily with food"). Reminders
// that fire on a clock live in homeReminder; this row is the rx
// record itself. We can add a parentType: PET_MEDICATION linkage on
// homeReminder later if the user wants the cross-reference.

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
import { type PetMedication } from "../lib/pets";

interface Props {
  visible: boolean;
  petId: string;
  medication: PetMedication | null;
  onClose: () => void;
  onSaved: () => void;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function PetMedicationFormModal({
  visible,
  petId,
  medication,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState("");
  const [dosage, setDosage] = useState("");
  const [schedule, setSchedule] = useState("");
  const [purpose, setPurpose] = useState("");
  const [prescribedBy, setPrescribedBy] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [refillsRemaining, setRefillsRemaining] = useState("");
  const [lastRefillAt, setLastRefillAt] = useState("");
  const [notes, setNotes] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (medication) {
      setName(medication.name);
      setDosage(medication.dosage ?? "");
      setSchedule(medication.schedule ?? "");
      setPurpose(medication.purpose ?? "");
      setPrescribedBy(medication.prescribedBy ?? "");
      setStartDate(medication.startDate ?? "");
      setEndDate(medication.endDate ?? "");
      setRefillsRemaining(
        medication.refillsRemaining != null
          ? String(medication.refillsRemaining)
          : ""
      );
      setLastRefillAt(medication.lastRefillAt ?? "");
      setNotes(medication.notes ?? "");
      setIsActive(medication.isActive !== false);
    } else {
      setName("");
      setDosage("");
      setSchedule("");
      setPurpose("");
      setPrescribedBy("");
      setStartDate("");
      setEndDate("");
      setRefillsRemaining("");
      setLastRefillAt("");
      setNotes("");
      setIsActive(true);
    }
  }, [visible, medication]);

  async function save() {
    if (!name.trim()) {
      Alert.alert("Name required");
      return;
    }
    for (const [label, val] of [
      ["Start", startDate],
      ["End", endDate],
      ["Last refill", lastRefillAt],
    ] as const) {
      if (val && !ISO_DATE_RE.test(val)) {
        Alert.alert(`${label} date must be YYYY-MM-DD`);
        return;
      }
    }
    let refills: number | null = null;
    if (refillsRemaining.trim()) {
      const n = parseInt(refillsRemaining, 10);
      if (Number.isNaN(n) || n < 0) {
        Alert.alert("Refills must be a non-negative integer");
        return;
      }
      refills = n;
    }

    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        dosage: dosage.trim() || null,
        schedule: schedule.trim() || null,
        purpose: purpose.trim() || null,
        prescribedBy: prescribedBy.trim() || null,
        startDate: startDate || null,
        endDate: endDate || null,
        refillsRemaining: refills,
        lastRefillAt: lastRefillAt || null,
        notes: notes.trim() || null,
        isActive,
      };
      const client = getClient();
      if (medication) {
        const { errors } = await client.models.homePetMedication.update({
          id: medication.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else {
        const { errors } = await client.models.homePetMedication.create({
          petId,
          ...payload,
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

  function confirmDelete() {
    if (!medication) return;
    Alert.alert("Delete medication?", `"${medication.name}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const client = getClient();
            const { errors } = await client.models.homePetMedication.delete({
              id: medication.id,
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
            {medication ? "Edit medication" : "New medication"}
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

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.label}>Medication</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Apoquel"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!medication}
          />

          <Text style={styles.label}>Dosage</Text>
          <TextInput
            style={styles.input}
            value={dosage}
            onChangeText={setDosage}
            placeholder="1/2 pill"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Schedule</Text>
          <TextInput
            style={styles.input}
            value={schedule}
            onChangeText={setSchedule}
            placeholder="Once daily with food"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Purpose</Text>
          <TextInput
            style={styles.input}
            value={purpose}
            onChangeText={setPurpose}
            placeholder="Allergies"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Prescribed by</Text>
          <TextInput
            style={styles.input}
            value={prescribedBy}
            onChangeText={setPrescribedBy}
            placeholder="Dr. Smith"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Start date (YYYY-MM-DD)</Text>
          <TextInput
            style={styles.input}
            value={startDate}
            onChangeText={setStartDate}
            placeholder="2026-04-01"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={!busy}
          />

          <Text style={styles.label}>End date (optional)</Text>
          <TextInput
            style={styles.input}
            value={endDate}
            onChangeText={setEndDate}
            placeholder="leave blank if ongoing"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={!busy}
          />

          <Text style={styles.label}>Refills remaining</Text>
          <TextInput
            style={styles.input}
            value={refillsRemaining}
            onChangeText={setRefillsRemaining}
            placeholder="3"
            placeholderTextColor="#888"
            keyboardType="number-pad"
            editable={!busy}
          />

          <Text style={styles.label}>Last refill (YYYY-MM-DD)</Text>
          <TextInput
            style={styles.input}
            value={lastRefillAt}
            onChangeText={setLastRefillAt}
            placeholder="2026-04-15"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={!busy}
          />

          <Text style={styles.label}>Notes</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Watch for vomiting"
            placeholderTextColor="#888"
            multiline
            editable={!busy}
          />

          <View style={styles.activeRow}>
            <Text style={styles.label}>Active</Text>
            <Switch
              value={isActive}
              onValueChange={setIsActive}
              disabled={busy}
            />
          </View>

          {medication && (
            <Pressable
              onPress={confirmDelete}
              style={({ pressed }) => [styles.delete, pressed && { opacity: 0.5 }]}
              disabled={busy}
            >
              <Text style={styles.deleteText}>Delete medication</Text>
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

  activeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },

  delete: { marginTop: 24, paddingVertical: 14, alignItems: "center" },
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
