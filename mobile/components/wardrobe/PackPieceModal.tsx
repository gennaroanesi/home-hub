// Trip looks: pick a closet piece for the packing list, without the model —
// the native twin of the web PackPieceModal. "Replace" swaps one packed
// piece for it in the list and every look that wore it (swapTripPlanItem);
// "Add piece" puts it on the list only (addTripPlanItem). Starts on a
// category; a search looks across the whole closet.

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { formStyles } from "../person-form-styles";
import { matchesSearch } from "../../../lib/wardrobe";
import { ItemThumb, Swatch, type WardrobeItem } from "./shared";

export type PackPickerMode = { kind: "replace"; item: WardrobeItem } | { kind: "add" };

interface Props {
  mode: PackPickerMode | null; // open while set
  items: WardrobeItem[]; // the person's wearable closet
  packIds: string[];
  busy: boolean;
  onPick: (to: WardrobeItem) => void;
  onClose: () => void;
}

export function PackPieceModal({ mode, items, packIds, busy, onPick, onClose }: Props) {
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const categories = useMemo(() => Array.from(new Set(items.map((i) => i.category))).sort(), [items]);

  useEffect(() => {
    if (!mode) return;
    setCat(mode.kind === "replace" ? mode.item.category : (categories[0] ?? ""));
    setQ("");
  }, [mode, categories]);

  const replacing = mode?.kind === "replace" ? mode.item : null;
  const searching = !!q.trim();
  const choices = items.filter((i) => {
    if (replacing ? i.id === replacing.id : packIds.includes(i.id)) return false;
    if (searching) return matchesSearch(q, [i.brand, i.name, i.color, i.category]);
    return !cat || i.category === cat;
  });

  return (
    <Modal visible={!!mode} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.screen}>
        <View style={s.header}>
          <Pressable onPress={onClose}>
            <Text style={s.cancel}>Cancel</Text>
          </Pressable>
          <Text style={s.headerTitle} numberOfLines={1}>
            {replacing ? `Replace ${[replacing.brand, replacing.name].filter(Boolean).join(" ")}` : "Add to the packing list"}
          </Text>
          {busy ? <ActivityIndicator /> : <View style={{ width: 44 }} />}
        </View>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Text style={s.hint}>
            {replacing
              ? "Swapped in the packing list and in every look that wears it. Saved looks keep it; open them to change."
              : "Goes on the packing list only. To wear it, open a look or ask for a tweak."}
          </Text>
          <View style={local.searchWrap}>
            <Ionicons name="search" size={16} color="#999" />
            <TextInput
              style={local.search}
              value={q}
              onChangeText={setQ}
              placeholder="Search the whole closet…"
              placeholderTextColor="#999"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          </View>
          {!searching && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
              {categories.map((c) => (
                <Pressable key={c} onPress={() => setCat(c)} style={[s.chip, cat === c && s.chipOn]}>
                  <Text style={[s.chipText, cat === c && s.chipTextOn]}>{c}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          {!choices.length && <Text style={s.hint}>Nothing else here.</Text>}
          <View style={[local.grid, busy && { opacity: 0.5 }]} pointerEvents={busy ? "none" : "auto"}>
            {choices.map((it) => (
              <Pressable key={it.id} onPress={() => onPick(it)} style={local.choice}>
                <View>
                  <ItemThumb item={it} width={200} style={local.img} />
                  {packIds.includes(it.id) && (
                    <View style={local.packed}>
                      <Text style={local.packedText}>Packed</Text>
                    </View>
                  )}
                </View>
                <View style={local.nameRow}>
                  <Swatch hex={it.colorHex} size={9} />
                  <Text style={local.name} numberOfLines={2}>
                    {it.brand ? <Text style={{ color: "#888" }}>{it.brand} </Text> : null}
                    {it.name}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = formStyles;

const local = StyleSheet.create({
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    marginTop: 6,
  },
  search: { flex: 1, paddingVertical: 9, fontSize: 15, color: "#222" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  choice: { width: "31%" },
  img: { aspectRatio: 3 / 4, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ddd" },
  packed: { position: "absolute", left: 3, top: 3, backgroundColor: "#e3f3e6", borderRadius: 999, paddingHorizontal: 5 },
  packedText: { fontSize: 9, fontWeight: "600", color: "#2e7d43" },
  nameRow: { flexDirection: "row", alignItems: "flex-start", gap: 4, marginTop: 3 },
  name: { fontSize: 11, color: "#333", lineHeight: 14, flexShrink: 1 },
});
