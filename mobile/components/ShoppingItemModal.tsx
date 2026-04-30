// Edit / delete a single homeShoppingItem. New-item creation happens
// inline on the list (faster UX), so this modal is edit-only.

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

import { getClient } from "../lib/amplify";
import type { Schema } from "../../amplify/data/resource";

type Item = Schema["homeShoppingItem"]["type"];

interface Props {
  visible: boolean;
  item: Item | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ShoppingItemModal({ visible, item, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || !item) return;
    setName(item.name);
    setQuantity(item.quantity ?? "");
    setNotes(item.notes ?? "");
  }, [visible, item]);

  async function save() {
    if (!item) return;
    if (!name.trim()) {
      Alert.alert("Name required");
      return;
    }
    setBusy(true);
    try {
      const client = getClient();
      const { errors } = await client.models.homeShoppingItem.update({
        id: item.id,
        name: name.trim(),
        quantity: quantity.trim() || null,
        notes: notes.trim() || null,
      });
      if (errors?.length) throw new Error(errors[0].message);
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!item) return;
    Alert.alert("Delete item?", `"${item.name}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const client = getClient();
            const { errors } = await client.models.homeShoppingItem.delete({
              id: item.id,
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
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Pressable onPress={onClose} disabled={busy}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Edit item</Text>
          <Pressable onPress={save} disabled={busy}>
            {busy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.save, !name.trim() && styles.disabled]}>Save</Text>
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
            placeholder="Apples"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus
          />

          <Text style={styles.label}>Quantity</Text>
          <TextInput
            style={styles.input}
            value={quantity}
            onChangeText={setQuantity}
            placeholder="2 lbs / 6 / etc."
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

          <Pressable
            onPress={confirmDelete}
            style={({ pressed }) => [styles.delete, pressed && { opacity: 0.5 }]}
            disabled={busy}
          >
            <Text style={styles.deleteText}>Delete item</Text>
          </Pressable>
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

  delete: { marginTop: 32, paddingVertical: 14, alignItems: "center" },
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
