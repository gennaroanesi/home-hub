// Closet tab of the mobile Wardrobe: search, category / status / in-a-look
// chips (lib/wardrobe.ts filterCloset, same as the web), and the items
// grouped by category as photo cards. Tap a card to edit it.

import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import {
  WARDROBE_STATUSES,
  WARDROBE_STATUS_LABELS,
  closetCounts,
  compareClosetItems,
  filterCloset,
  itemIdsInLooks,
  type ClosetFilter,
} from "../../../lib/wardrobe";
import { Chip, ItemThumb, StatusChip, Swatch, wardrobeStyles as ws, type WardrobeItem, type WardrobeLook } from "./shared";

export function ClosetView({
  items,
  looks,
  categories,
  filter,
  onFilter,
  onOpen,
}: {
  items: WardrobeItem[];
  looks: WardrobeLook[];
  categories: string[];
  filter: ClosetFilter;
  onFilter: (f: ClosetFilter) => void;
  onOpen: (it: WardrobeItem) => void;
}) {
  const inLooks = useMemo(() => itemIdsInLooks(looks), [looks]);
  const shown = filterCloset(items, filter, inLooks);
  const groups = categories.map((c) => [c, shown.filter((i) => i.category === c).sort(compareClosetItems)] as const).filter(([, l]) => l.length);
  const counts = closetCounts(items);
  const set = (patch: Partial<ClosetFilter>) => onFilter({ ...filter, ...patch });

  return (
    <View>
      <View style={ws.searchWrap}>
        <Ionicons name="search" size={16} color="#999" />
        <TextInput
          style={ws.search}
          value={filter.search}
          onChangeText={(v) => set({ search: v })}
          placeholder="Search name, brand, color, fabric…"
          placeholderTextColor="#999"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ws.chipRow}>
        <Chip on={!filter.category} onPress={() => set({ category: "" })} label="All" count={items.length} />
        {categories.map((c) => (
          <Chip key={c} on={filter.category === c} onPress={() => set({ category: c })} label={c} count={items.filter((i) => i.category === c).length} />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ws.chipRow}>
        <Chip on={filter.status === "OWNED"} onPress={() => set({ status: "OWNED" })} label="Wearing" />
        <Chip on={filter.status === ""} onPress={() => set({ status: "" })} label="Everything" />
        <View style={styles.divider} />
        <Chip
          on={filter.inLook === "YES"}
          onPress={() => set({ inLook: filter.inLook === "YES" ? "" : "YES" })}
          label="In a look"
          count={items.filter((i) => inLooks.has(i.id)).length}
        />
        <Chip
          on={filter.inLook === "NO"}
          onPress={() => set({ inLook: filter.inLook === "NO" ? "" : "NO" })}
          label="Not in a look"
          count={items.filter((i) => !inLooks.has(i.id)).length}
        />
        <View style={styles.divider} />
        {WARDROBE_STATUSES.map((s) => (
          <Chip
            key={s}
            on={filter.status === s}
            onPress={() => set({ status: s })}
            label={WARDROBE_STATUS_LABELS[s]}
            count={items.filter((i) => (i.status ?? "KEEP") === s).length}
          />
        ))}
      </ScrollView>
      <Text style={[ws.meta, { marginTop: 2, marginBottom: 4 }]}>
        {counts.owned} owned · {counts.wish} on the wishlist · {counts.photos} of {items.length} have photos
      </Text>

      {!groups.length ? (
        <View style={ws.emptyBox}>
          <Text style={{ color: "#888", textAlign: "center" }}>
            {items.length ? "Nothing matches these filters." : "Nothing here yet. Tap + to start this closet."}
          </Text>
        </View>
      ) : (
        groups.map(([c, list]) => (
          <View key={c} style={{ marginTop: 10 }}>
            <Text style={styles.groupTitle}>
              {c} <Text style={ws.meta}>{list.length}</Text>
            </Text>
            <View style={styles.grid}>
              {list.map((it) => (
                <ItemCard key={it.id} item={it} onPress={() => onOpen(it)} />
              ))}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function ItemCard({ item, onPress }: { item: WardrobeItem; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}>
      <ItemThumb item={item} width={480} fit="cover" style={styles.cardImg} />
      <View style={styles.cardBody}>
        <Text style={styles.brand} numberOfLines={1}>
          {item.brand ?? " "}
        </Text>
        <Text style={styles.name} numberOfLines={2}>
          {item.name}
        </Text>
        <View style={styles.metaRow}>
          <Swatch hex={item.colorHex} />
          <Text style={styles.meta} numberOfLines={1}>
            {[item.color, item.size].filter(Boolean).join(" · ") || "No color set"}
          </Text>
        </View>
        <View style={styles.badges}>
          {item.status && item.status !== "KEEP" && <StatusChip status={item.status} />}
          {(item.quantity ?? 1) > 1 && (
            <View style={styles.qty}>
              <Text style={styles.qtyText}>×{item.quantity}</Text>
            </View>
          )}
          {!!item.lastWornOn && <Text style={styles.worn}>worn {item.lastWornOn}</Text>}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  groupTitle: { fontSize: 17, fontWeight: "600", color: "#222", marginBottom: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: {
    width: "48.5%",
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e0e0e0",
    overflow: "hidden",
  },
  cardImg: { aspectRatio: 4 / 3 },
  cardBody: { padding: 10, gap: 2 },
  brand: { fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: 0.8 },
  name: { fontSize: 14, fontWeight: "500", color: "#222", lineHeight: 18 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  meta: { fontSize: 12, color: "#777", flexShrink: 1 },
  badges: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2, flexWrap: "wrap" },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", marginVertical: 4, marginHorizontal: 4, backgroundColor: "#ccc" },
  qty: { backgroundColor: "#f1f1f1", borderRadius: 4, paddingHorizontal: 5 },
  qtyText: { fontSize: 10, fontWeight: "600", color: "#555" },
  worn: { fontSize: 10, color: "#999" },
});
