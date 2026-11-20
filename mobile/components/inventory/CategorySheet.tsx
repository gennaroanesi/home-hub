// Picking an inventory category on the phone: search as you type (any
// words of the path), alphabetical by path, and "Create …" when nothing
// matches ("Parent > Name" files it under an existing parent). Same rules
// as the web picker (lib/inventory.ts). save_inventory_category.

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { callOp } from "../../lib/ops";
import { detailSpec } from "../../../lib/inventory-details";
import { categoriesAlphabetical, categoryMatches, newCategoryFromText } from "../../../lib/inventory";
import { ACCENT } from "../finance/ui";
import type { InventoryCategory } from "./ItemFormModal";

export function CategorySheet({
  visible,
  categories,
  selected,
  onPick,
  onCreated,
  onClose,
}: {
  visible: boolean;
  categories: InventoryCategory[];
  selected?: string | null;
  onPick: (id: string) => void;
  onCreated: (category: InventoryCategory) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible) setQ("");
  }, [visible]);

  const nodes = useMemo(() => categoriesAlphabetical(categories), [categories]);
  const text = q.trim();
  const shown = nodes.filter((n) => !text || categoryMatches(n.path, text));
  const planned = text ? newCategoryFromText(categories, text) : null;

  function pick(id: string) {
    onPick(id);
    onClose();
  }

  async function create() {
    if (!planned) return;
    setBusy(true);
    try {
      const r = await callOp("save_inventory_category", { name: planned.name, parentId: planned.parentId });
      if ("error" in r) return Alert.alert("Couldn't create it", r.error);
      onCreated(r.result.category);
      pick(r.result.category.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <Pressable style={s.backdrop} onPress={onClose}>
          <Pressable style={s.sheet} onPress={() => {}}>
            <Text style={s.title}>Category</Text>
            <View style={s.searchRow}>
              <Ionicons name="search" size={16} color="#999" />
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder="Search, or type a new one (Parent > Name)"
                placeholderTextColor="#aaa"
                autoFocus
                autoCorrect={false}
                style={s.search}
                returnKeyType="done"
                onSubmitEditing={() => (shown.length === 1 ? pick(shown[0].category.id) : planned && shown.length === 0 ? void create() : undefined)}
              />
              {q ? (
                <Pressable onPress={() => setQ("")} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color="#bbb" />
                </Pressable>
              ) : null}
            </View>
            <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
              {planned && (
                <Pressable onPress={() => void create()} disabled={busy} style={({ pressed }) => [s.row, pressed && s.pressed]}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                    {busy ? <ActivityIndicator size="small" /> : <Ionicons name="add-circle-outline" size={18} color={ACCENT} />}
                    <Text style={[s.rowText, { color: ACCENT, fontWeight: "600" }]} numberOfLines={1}>
                      Create “{planned.path}”
                    </Text>
                  </View>
                </Pressable>
              )}
              {shown.map((n) => {
                const on = n.category.id === selected;
                const parts = n.path.split(" › ");
                return (
                  <Pressable key={n.category.id} onPress={() => pick(n.category.id)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
                    <Text style={[s.rowText, { flex: 1 }, on && { color: ACCENT, fontWeight: "600" }]} numberOfLines={1}>
                      {parts.length > 1 && <Text style={{ color: "#999" }}>{parts.slice(0, -1).join(" › ")} › </Text>}
                      {parts[parts.length - 1]}
                      {detailSpec(n.detailType)?.private ? " 🔒" : ""}
                    </Text>
                    {on && <Ionicons name="checkmark" size={18} color={ACCENT} />}
                  </Pressable>
                );
              })}
              {shown.length === 0 && !planned && <Text style={s.empty}>No match. To file a new one under a category, type “Parent &gt; Name”.</Text>}
            </ScrollView>
            <Pressable onPress={onClose} style={s.cancel}>
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 14, paddingBottom: 30 },
  title: { fontSize: 13, fontWeight: "600", color: "#888", textAlign: "center", marginBottom: 8 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: "#f3f1ef" },
  search: { flex: 1, fontSize: 16, color: "#222", padding: 0 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 13, paddingHorizontal: 20 },
  pressed: { backgroundColor: "#f3f3f3" },
  rowText: { fontSize: 16, color: "#222" },
  empty: { fontSize: 14, color: "#999", textAlign: "center", paddingVertical: 20, paddingHorizontal: 20 },
  cancel: { marginTop: 6, paddingVertical: 14, alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#eee" },
  cancelText: { fontSize: 16, color: "#888" },
});
