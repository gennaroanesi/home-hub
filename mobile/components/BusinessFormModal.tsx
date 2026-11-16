// Create / edit a business or service person (homeBusiness) — the native
// twin of the dialog in components/businesses-tab.tsx. Saves through the
// save_business op (Janet's too); delete is a plain model delete, as on
// the web. Health providers are listed alongside but edited in Health.

import { useEffect, useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";

import { getClient } from "../lib/amplify";
import { callOp } from "../lib/ops";
import { formStyles as styles } from "./person-form-styles";
import {
  BUSINESS_CATEGORIES,
  BUSINESS_CATEGORY_LABELS,
  type BusinessCategory,
  type BusinessRow,
} from "../../lib/businesses";

interface Props {
  visible: boolean;
  business: BusinessRow | null;
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY = {
  name: "",
  service: "",
  contactName: "",
  phone: "",
  email: "",
  website: "",
  address: "",
  notes: "",
};

function isoDateOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseIso(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function BusinessFormModal({ visible, business, onClose, onSaved }: Props) {
  const [text, setText] = useState(EMPTY);
  const [category, setCategory] = useState<BusinessCategory | "">("");
  const [lastUsedOn, setLastUsedOn] = useState("");
  const [showDate, setShowDate] = useState(false);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setText({
      name: business?.name ?? "",
      service: business?.service ?? "",
      contactName: business?.contactName ?? "",
      phone: business?.phone ?? "",
      email: business?.email ?? "",
      website: business?.website ?? "",
      address: business?.address ?? "",
      notes: business?.notes ?? "",
    });
    setCategory((business?.category as BusinessCategory | null) ?? "");
    setLastUsedOn(business?.lastUsedOn ?? "");
    setActive(business?.active ?? true);
    setShowDate(false);
  }, [visible, business]);

  const set = (k: keyof typeof EMPTY) => (v: string) => setText((t) => ({ ...t, [k]: v }));

  async function save() {
    if (!text.name.trim()) {
      Alert.alert("Name required");
      return;
    }
    setBusy(true);
    const trimmed = Object.fromEntries(
      Object.entries(text).map(([k, v]) => [k, v.trim() || null]),
    ) as Record<keyof typeof EMPTY, string | null>;
    const r = await callOp("save_business", {
      ...(business ? { businessId: business.id } : {}),
      ...trimmed,
      name: text.name.trim(),
      category: category || null,
      lastUsedOn: lastUsedOn || null,
      active,
    });
    setBusy(false);
    if ("error" in r) {
      Alert.alert("Couldn't save", r.error);
      return;
    }
    onSaved();
    onClose();
  }

  function remove() {
    if (!business) return;
    Alert.alert(`Delete ${business.name}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const { errors } = await getClient().models.homeBusiness.delete({ id: business.id });
          setBusy(false);
          if (errors?.length) {
            Alert.alert("Couldn't delete", errors[0].message);
            return;
          }
          onSaved();
          onClose();
        },
      },
    ]);
  }

  const field = (
    k: keyof typeof EMPTY,
    label: string,
    placeholder: string,
    extra: Partial<ComponentProps<typeof TextInput>> = {},
  ) => (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, extra.multiline && styles.multiline]}
        value={text[k]}
        onChangeText={set(k)}
        placeholder={placeholder}
        placeholderTextColor="#888"
        editable={!busy}
        {...extra}
      />
    </>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Pressable onPress={onClose} disabled={busy}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {business ? `Edit ${business.name}` : "New business"}
          </Text>
          <Pressable onPress={save} disabled={busy}>
            {busy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.save, !text.name.trim() && styles.disabled]}>{business ? "Save" : "Create"}</Text>
            )}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {field("name", "Name", "Austin Appliance Repair", { autoFocus: !business })}

          <Text style={styles.label}>Category</Text>
          <View style={styles.chipRow}>
            {BUSINESS_CATEGORIES.map((c) => {
              const on = category === c;
              return (
                <Pressable
                  key={c}
                  onPress={() => setCategory(on ? "" : c)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{BUSINESS_CATEGORY_LABELS[c]}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>Doctors and labs go in Health, where visits can point at them.</Text>

          {field("service", "What they do for us", "Fixed the dishwasher pump")}
          {field("contactName", "Contact person", "Mike")}
          {field("phone", "Phone", "+15125551234", { keyboardType: "phone-pad" })}
          {field("email", "Email", "hello@example.com", {
            keyboardType: "email-address",
            autoCapitalize: "none",
            autoCorrect: false,
          })}
          {field("website", "Website", "example.com", {
            keyboardType: "url",
            autoCapitalize: "none",
            autoCorrect: false,
          })}
          {field("address", "Address", "123 Main St, Austin")}

          <Text style={styles.label}>Last used</Text>
          <Pressable onPress={() => setShowDate((v) => !v)} style={[styles.input, styles.switchRow]} disabled={busy}>
            <Text style={{ fontSize: 15, color: lastUsedOn ? "#222" : "#888" }}>
              {lastUsedOn
                ? parseIso(lastUsedOn)!.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                : "Pick a date"}
            </Text>
            {!!lastUsedOn && (
              <Pressable onPress={() => setLastUsedOn("")} hitSlop={8} disabled={busy}>
                <Ionicons name="close-circle" size={18} color="#bbb" />
              </Pressable>
            )}
          </Pressable>
          {showDate && (
            <DateTimePicker
              value={parseIso(lastUsedOn) ?? new Date()}
              mode="date"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              themeVariant="light"
              maximumDate={new Date()}
              onChange={(_, picked) => {
                if (Platform.OS !== "ios") setShowDate(false);
                if (picked) setLastUsedOn(isoDateOf(picked));
              }}
            />
          )}

          {field("notes", "Notes", "Ask for Mike; cash discount", { multiline: true })}

          <View style={[styles.switchRow, { marginTop: 12 }]}>
            <Text style={styles.switchLabel}>Active</Text>
            <Switch value={active} onValueChange={setActive} disabled={busy} />
          </View>

          {business && (
            <Pressable onPress={remove} style={styles.deleteBtn} disabled={busy}>
              <Text style={styles.deleteText}>Delete business</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
