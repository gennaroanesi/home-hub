// "I'll pick" for Trip looks on the phone, the twin of the web's
// components/wardrobe/trip-picker.tsx: tap pieces in the closet to pack them,
// +/- copies for items owned more than once, and a running count by type
// ("4 T-Shirts · 3 Jeans"). The planner builds looks only from these and
// reviews them (lib/wardrobe-trip.ts, PICKED mode).

import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { quantityOf } from "../../../lib/wardrobe";
import { categoryCounts, categoryCountsLabel, pickedCopies, type TripPicks } from "../../../lib/wardrobe-trip";
import { groupByCategory } from "../../../lib/wardrobe-trip-edits";
import { ACCENT, ItemThumb, wardrobeStyles as ws, type WardrobeItem } from "./shared";

export function TripPicker({ closet, picks, onChange }: { closet: WardrobeItem[]; picks: TripPicks; onChange: (next: TripPicks) => void }) {
  const [query, setQuery] = useState("");
  const picked = useMemo(() => new Set(picks.itemIds), [picks.itemIds]);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return closet.filter((i) => {
      const hay = [i.name, i.brand, i.color, i.category].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [closet, query]);
  const groups = groupByCategory(shown);
  const chosen = closet.filter((i) => picked.has(i.id));
  const copies = (i: WardrobeItem) => pickedCopies(i, picks);
  const total = chosen.reduce((n, i) => n + copies(i), 0);

  function toggle(it: WardrobeItem) {
    const itemIds = picked.has(it.id) ? picks.itemIds.filter((x) => x !== it.id) : [...picks.itemIds, it.id];
    const rest = { ...(picks.copies ?? {}) };
    delete rest[it.id];
    onChange({ itemIds, copies: rest });
  }

  function setCopies(it: WardrobeItem, n: number) {
    const v = Math.max(1, Math.min(quantityOf(it), n));
    const rest = { ...(picks.copies ?? {}) };
    delete rest[it.id];
    onChange({ itemIds: picks.itemIds, copies: v > 1 ? { ...rest, [it.id]: v } : rest });
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={ws.body}>
        <Text style={{ fontWeight: "700" }}>{total}</Text> piece{total === 1 ? "" : "s"}
        {chosen.length > 0 ? <Text style={{ color: "#666" }}> · {categoryCountsLabel(categoryCounts(chosen, copies))}</Text> : null}
      </Text>
      <TextInput style={ws.input} value={query} onChangeText={setQuery} placeholder="Search the closet" placeholderTextColor="#999" clearButtonMode="while-editing" />
      {groups.map(([cat, list]) => {
        const n = list.filter((i) => picked.has(i.id)).reduce((s, i) => s + copies(i), 0);
        return (
          <View key={cat}>
            <Text style={[ws.sectionLabel, { marginTop: 4, marginBottom: 6 }]}>
              {cat}
              {n > 0 ? <Text style={{ color: ACCENT }}> · {n} picked</Text> : null}
            </Text>
            <View style={styles.grid}>
              {list.map((it) => {
                const on = picked.has(it.id);
                const max = quantityOf(it);
                return (
                  <View key={it.id} style={styles.cell}>
                    <Pressable onPress={() => toggle(it)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                      <ItemThumb item={it} width={160} style={[styles.img, on ? styles.imgOn : styles.imgOff]} />
                      {on && (
                        <View style={styles.check}>
                          <Ionicons name="checkmark" size={12} color="#fff" />
                        </View>
                      )}
                    </Pressable>
                    <Text style={styles.name} numberOfLines={2}>
                      {it.name}
                    </Text>
                    {on && max > 1 && (
                      <View style={styles.copies}>
                        <Pressable onPress={() => setCopies(it, copies(it) - 1)} disabled={copies(it) <= 1} hitSlop={8}>
                          <Ionicons name="remove-circle-outline" size={18} color={copies(it) <= 1 ? "#ccc" : ACCENT} />
                        </Pressable>
                        <Text style={styles.copiesText}>
                          {copies(it)} of {max}
                        </Text>
                        <Pressable onPress={() => setCopies(it, copies(it) + 1)} disabled={copies(it) >= max} hitSlop={8}>
                          <Ionicons name="add-circle-outline" size={18} color={copies(it) >= max ? "#ccc" : ACCENT} />
                        </Pressable>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}
      {!groups.length && <Text style={ws.meta}>Nothing in the closet matches.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cell: { width: "22%" },
  img: { width: "100%", aspectRatio: 3 / 4, borderRadius: 6, borderWidth: 2, backgroundColor: "#fff" },
  imgOn: { borderColor: ACCENT },
  imgOff: { borderColor: "#e5e5e5", opacity: 0.85 },
  check: { position: "absolute", top: 4, right: 4, backgroundColor: ACCENT, borderRadius: 10, padding: 2 },
  name: { fontSize: 11, marginTop: 3, color: "#333" },
  copies: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  copiesText: { fontSize: 11, color: "#555" },
});
