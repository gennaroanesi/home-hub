// Create / edit a homeHealthProvider (typed phone numbers, address, portal,
// about). Saves through saveProvider / archiveProvider in lib/health.ts,
// shared with the web /health page. Archive is a soft delete: past visits
// keep pointing at the row.

import { useEffect, useState } from "react";
import {
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

import { getClient } from "../../lib/amplify";
import {
  PHONE_KINDS,
  PHONE_KIND_LABELS,
  archiveProvider,
  providerPhones,
  saveProvider,
  type PhoneKind,
  type ProviderPhone,
} from "../../../lib/health";
import { ACCENT, formStyles } from "../person-form-styles";
import { ChipSelect, SheetHeader } from "./fields";
import type { Schema } from "../../../amplify/data/resource";

type Provider = Schema["homeHealthProvider"]["type"];

const KIND_OPTIONS = PHONE_KINDS.map((k) => ({ key: k as PhoneKind, label: PHONE_KIND_LABELS[k] }));

interface Props {
  visible: boolean;
  provider: Provider | null;
  /** New providers belong to this person. */
  personId: string;
  onClose: () => void;
  onSaved: () => void;
}

export function ProviderFormModal({ visible, provider, personId, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [practice, setPractice] = useState("");
  const [phones, setPhones] = useState<ProviderPhone[]>([]);
  const [address, setAddress] = useState("");
  const [portalUrl, setPortalUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName(provider?.name ?? "");
    setSpecialty(provider?.specialty ?? "");
    setPractice(provider?.practice ?? "");
    // Folds a legacy single `phone` in as the first (clinic) number.
    const existing = provider ? providerPhones(provider as Parameters<typeof providerPhones>[0]) : [];
    setPhones(existing.length > 0 ? existing.map((p) => ({ ...p })) : [{ kind: "CLINIC", number: "", label: "" }]);
    setAddress(provider?.address ?? "");
    setPortalUrl(provider?.portalUrl ?? "");
    setNotes(provider?.notes ?? "");
  }, [visible, provider]);

  function updatePhone(i: number, patch: Partial<ProviderPhone>) {
    setPhones((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await saveProvider(getClient(), {
        providerId: provider?.id,
        personId,
        values: { name, specialty, practice, phones, address, portalUrl, notes },
      });
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmArchive() {
    if (!provider) return;
    Alert.alert(`Archive ${provider.name}?`, "Past visits keep the link.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await archiveProvider(getClient(), provider.id);
            onSaved();
            onClose();
          } catch (err: any) {
            Alert.alert("Archive failed", err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={formStyles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <SheetHeader
          title={provider ? "Edit provider" : "New provider"}
          onCancel={onClose}
          onSave={save}
          busy={busy}
          canSave={!!name.trim()}
        />
        <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
          <Text style={formStyles.label}>Name</Text>
          <TextInput
            style={formStyles.input}
            value={name}
            onChangeText={setName}
            placeholder="Dr. Smith"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!provider}
          />
          <Text style={formStyles.label}>Specialty</Text>
          <TextInput
            style={formStyles.input}
            value={specialty}
            onChangeText={setSpecialty}
            placeholder="OB/GYN, Pediatrician, Lab…"
            placeholderTextColor="#888"
            editable={!busy}
          />
          <Text style={formStyles.label}>Practice</Text>
          <TextInput style={formStyles.input} value={practice} onChangeText={setPractice} editable={!busy} />

          <View style={styles.phonesHeader}>
            <Text style={[formStyles.label, { marginTop: 0 }]}>Phone numbers</Text>
            <Pressable
              onPress={() => setPhones((prev) => [...prev, { kind: "OTHER", number: "", label: "" }])}
              hitSlop={10}
              disabled={busy}
              style={styles.addPhone}
            >
              <Ionicons name="add" size={18} color={ACCENT} />
              <Text style={styles.addPhoneText}>Number</Text>
            </Pressable>
          </View>
          {phones.map((ph, i) => (
            <View key={i} style={styles.phoneCard}>
              <ChipSelect
                options={KIND_OPTIONS}
                value={ph.kind ?? ""}
                onChange={(k) => k && updatePhone(i, { kind: k })}
                disabled={busy}
              />
              <View style={styles.phoneRow}>
                <TextInput
                  style={[formStyles.input, { flex: 1 }]}
                  value={ph.number}
                  onChangeText={(v) => updatePhone(i, { number: v })}
                  placeholder="(512) 555-0100"
                  placeholderTextColor="#888"
                  keyboardType="phone-pad"
                  editable={!busy}
                />
                <Pressable
                  onPress={() => setPhones((prev) => prev.filter((_, j) => j !== i))}
                  hitSlop={10}
                  disabled={busy}
                >
                  <Ionicons name="trash-outline" size={18} color="#c44" />
                </Pressable>
              </View>
              <TextInput
                style={formStyles.input}
                value={ph.label ?? ""}
                onChangeText={(v) => updatePhone(i, { label: v })}
                placeholder="Label (optional)"
                placeholderTextColor="#888"
                editable={!busy}
              />
            </View>
          ))}

          <Text style={formStyles.label}>Address</Text>
          <TextInput style={formStyles.input} value={address} onChangeText={setAddress} editable={!busy} />
          <Text style={formStyles.label}>Portal URL</Text>
          <TextInput
            style={formStyles.input}
            value={portalUrl}
            onChangeText={setPortalUrl}
            placeholder="https://"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
          />
          <Text style={formStyles.label}>About</Text>
          <TextInput
            style={[formStyles.input, formStyles.multiline]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Short summary — office hours, who to ask for…"
            placeholderTextColor="#888"
            multiline
            editable={!busy}
          />

          {provider && (
            <Pressable onPress={confirmArchive} style={formStyles.deleteBtn} disabled={busy}>
              <Text style={formStyles.deleteText}>Archive provider</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  phonesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  addPhone: { flexDirection: "row", alignItems: "center", gap: 2 },
  addPhoneText: { color: ACCENT, fontWeight: "500", fontSize: 13 },
  phoneCard: {
    gap: 6,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "#fafafa",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  phoneRow: { flexDirection: "row", alignItems: "center", gap: 10 },
});
