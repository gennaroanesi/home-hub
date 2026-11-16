// Add one lab result row (bulk entry — a photo or PDF of the report — goes
// through Janet). Saves via createLabResult in lib/health.ts, shared with
// the web /health page.

import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import { getClient } from "../../lib/amplify";
import { LAB_FLAGS, LAB_FLAG_LABELS, createLabResult } from "../../../lib/health";
import { formStyles } from "../person-form-styles";
import { ChipSelect, DateField, SheetHeader } from "./fields";

const FLAG_OPTIONS = LAB_FLAGS.map((f) => ({ key: f as string, label: LAB_FLAG_LABELS[f] }));

interface Props {
  visible: boolean;
  personId: string;
  today: string;
  onClose: () => void;
  onSaved: () => void;
}

export function LabResultFormModal({ visible, personId, today, onClose, onSaved }: Props) {
  const [testName, setTestName] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [range, setRange] = useState("");
  const [flag, setFlag] = useState("");
  const [panel, setPanel] = useState("");
  const [collectedAt, setCollectedAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setTestName("");
    setValue("");
    setUnit("");
    setRange("");
    setFlag("");
    setPanel("");
    setCollectedAt(today);
  }, [visible, today]);

  async function save() {
    if (!testName.trim()) return;
    setBusy(true);
    try {
      await createLabResult(getClient(), {
        personId,
        testName,
        value,
        unit,
        referenceRange: range,
        flag,
        panel,
        collectedAt,
        createdBy: "mobile",
      });
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={formStyles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <SheetHeader title="New lab result" onCancel={onClose} onSave={save} busy={busy} canSave={!!testName.trim()} />
        <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
          <Text style={formStyles.label}>Test</Text>
          <TextInput
            style={formStyles.input}
            value={testName}
            onChangeText={setTestName}
            placeholder="Hemoglobin"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={formStyles.label}>Value</Text>
              <TextInput
                style={formStyles.input}
                value={value}
                onChangeText={setValue}
                placeholder="11.8"
                placeholderTextColor="#888"
                editable={!busy}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={formStyles.label}>Unit</Text>
              <TextInput
                style={formStyles.input}
                value={unit}
                onChangeText={setUnit}
                placeholder="g/dL"
                placeholderTextColor="#888"
                autoCapitalize="none"
                editable={!busy}
              />
            </View>
          </View>
          <Text style={formStyles.label}>Reference range</Text>
          <TextInput
            style={formStyles.input}
            value={range}
            onChangeText={setRange}
            placeholder="11.1–15.9"
            placeholderTextColor="#888"
            editable={!busy}
          />
          <Text style={formStyles.label}>Flag</Text>
          <ChipSelect options={FLAG_OPTIONS} value={flag} onChange={setFlag} allowNone disabled={busy} />
          <Text style={formStyles.label}>Panel</Text>
          <TextInput
            style={formStyles.input}
            value={panel}
            onChangeText={setPanel}
            placeholder="First-trimester labs"
            placeholderTextColor="#888"
            editable={!busy}
          />
          <Text style={formStyles.label}>Collected</Text>
          <DateField value={collectedAt} onChange={setCollectedAt} clearable disabled={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
