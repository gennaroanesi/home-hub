// Create / edit a homePetVaccine row.

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
import { type PetVaccine } from "../lib/pets";

interface Props {
  visible: boolean;
  petId: string;
  vaccine: PetVaccine | null;
  onClose: () => void;
  onSaved: () => void;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function PetVaccineFormModal({
  visible,
  petId,
  vaccine,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState("");
  const [administeredAt, setAdministeredAt] = useState("");
  const [nextDueAt, setNextDueAt] = useState("");
  const [administeredBy, setAdministeredBy] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (vaccine) {
      setName(vaccine.name);
      setAdministeredAt(vaccine.administeredAt ?? "");
      setNextDueAt(vaccine.nextDueAt ?? "");
      setAdministeredBy(vaccine.administeredBy ?? "");
      setBatchNumber(vaccine.batchNumber ?? "");
      setNotes(vaccine.notes ?? "");
    } else {
      setName("");
      setAdministeredAt("");
      setNextDueAt("");
      setAdministeredBy("");
      setBatchNumber("");
      setNotes("");
    }
  }, [visible, vaccine]);

  async function save() {
    if (!name.trim()) {
      Alert.alert("Vaccine name required");
      return;
    }
    if (!administeredAt || !ISO_DATE_RE.test(administeredAt)) {
      Alert.alert("Administered date must be YYYY-MM-DD");
      return;
    }
    if (nextDueAt && !ISO_DATE_RE.test(nextDueAt)) {
      Alert.alert("Next due date must be YYYY-MM-DD");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        administeredAt,
        nextDueAt: nextDueAt || null,
        administeredBy: administeredBy.trim() || null,
        batchNumber: batchNumber.trim() || null,
        notes: notes.trim() || null,
      };
      const client = getClient();
      if (vaccine) {
        const { errors } = await client.models.homePetVaccine.update({
          id: vaccine.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else {
        const { errors } = await client.models.homePetVaccine.create({
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
    if (!vaccine) return;
    Alert.alert("Delete vaccine record?", `"${vaccine.name}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const client = getClient();
            const { errors } = await client.models.homePetVaccine.delete({
              id: vaccine.id,
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
            {vaccine ? "Edit vaccine" : "New vaccine"}
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
          <Text style={styles.label}>Vaccine</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Rabies / DHPP / Bordetella"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!vaccine}
          />

          <Text style={styles.label}>Administered (YYYY-MM-DD)</Text>
          <TextInput
            style={styles.input}
            value={administeredAt}
            onChangeText={setAdministeredAt}
            placeholder="2026-04-15"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={!busy}
          />

          <Text style={styles.label}>Next due (optional)</Text>
          <TextInput
            style={styles.input}
            value={nextDueAt}
            onChangeText={setNextDueAt}
            placeholder="2027-04-15"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={!busy}
          />

          <Text style={styles.label}>Administered by</Text>
          <TextInput
            style={styles.input}
            value={administeredBy}
            onChangeText={setAdministeredBy}
            placeholder="Dr. Smith / Banfield"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Batch number</Text>
          <TextInput
            style={styles.input}
            value={batchNumber}
            onChangeText={setBatchNumber}
            placeholder="Optional"
            placeholderTextColor="#888"
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

          {vaccine && (
            <Pressable
              onPress={confirmDelete}
              style={({ pressed }) => [styles.delete, pressed && { opacity: 0.5 }]}
              disabled={busy}
            >
              <Text style={styles.deleteText}>Delete vaccine</Text>
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

  delete: { marginTop: 24, paddingVertical: 14, alignItems: "center" },
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
