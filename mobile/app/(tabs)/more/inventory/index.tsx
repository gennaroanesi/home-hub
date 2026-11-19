// Inventory home on the phone: a way in, not every item. What we own and
// what it cost, shortcuts to the wishlist / drafts / running low / past,
// then tiles by category, room or person (each opens list.tsx for that
// slice), and the most recently added. Searching asks the server across
// everything. get_inventory_overview / list_inventory.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Dimensions, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../../lib/ops";
import { resizedImageUrl } from "../../../../lib/image";
import { formatUsd } from "../../../../../lib/inventory";
import { Input } from "../../../../components/finance/form";
import { ACCENT, Chip, FinanceHeader, HeaderButton, WARN, fs, type OpResultOf } from "../../../../components/finance/ui";
import { ItemFormModal, type InventoryItem } from "../../../../components/inventory/ItemFormModal";
import { ItemRow } from "../../../../components/inventory/ItemRow";
import { loadAllInventoryItems, openInventoryItem, useInventoryRefs } from "../../../../components/inventory/refs";
import type { ListTab } from "./list";

type Overview = OpResultOf<"get_inventory_overview">;
type Bucket = Overview["rooms"][number];
type By = "category" | "room" | "person";
type Icon = keyof typeof Ionicons.glyphMap;

const TYPE_ICON: Record<string, Icon> = {
  CLOTHING: "shirt-outline",
  CONSUMABLE: "basket-outline",
  FIREARM: "lock-closed-outline",
  AMMO: "lock-closed-outline",
  FILAMENT: "color-palette-outline",
  INSTRUMENT: "musical-notes-outline",
  PHOTOGRAPHY: "camera-outline",
  ELECTRONIC: "hardware-chip-outline",
};

function openList(params: { title: string; categoryId?: string; roomId?: string; owner?: string; status?: ListTab }) {
  router.push({ pathname: "/more/inventory/list", params } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
}

export default function InventoryHome() {
  const refs = useInventoryRefs();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [by, setBy] = useState<By>("category");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ items: InventoryItem[]; count: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [everything, setEverything] = useState<InventoryItem[]>([]);

  const load = useCallback(async () => {
    const r = await callOp("get_inventory_overview", {});
    if ("error" in r) setError(r.error);
    else {
      setError(null);
      setO(r.result);
    }
  }, []);
  // On focus too: back from a list or an item picks up its changes.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Search everything, on the server, once typing pauses.
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return setHits(null);
    let live = true;
    const t = setTimeout(async () => {
      const r = await callOp("list_inventory", { status: "ALL", query: q, limit: 100 });
      if (!live) return;
      if ("error" in r) Alert.alert("Couldn't search", r.error);
      else setHits({ items: r.result.items, count: r.result.count });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  async function adjust(i: InventoryItem, delta: number) {
    const r = await callOp("adjust_inventory_quantity", { itemId: i.id, delta });
    if ("error" in r) return Alert.alert("Couldn't update", r.error);
    setHits((h) => h && { ...h, items: h.items.map((x) => (x.id === i.id ? { ...x, quantity: r.result.after, lowStock: r.result.restock?.lowStock ?? x.lowStock } : x)) });
    if (r.result.restock?.addedToList) Alert.alert("Running low", `Added to ${r.result.restock.addedToList}.`);
  }

  async function openAdd() {
    setEverything(await loadAllInventoryItems());
    setAdding(true);
  }

  const header = <FinanceHeader title="Inventory" right={<HeaderButton icon="add" onPress={() => void openAdd()} />} />;

  if (!o) {
    return (
      <SafeAreaView style={fs.screen} edges={["top"]}>
        {header}
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      </SafeAreaView>
    );
  }

  const shortcuts: Array<{ status: ListTab; label: string; n: number; sub?: string; icon: Icon; color?: string }> = [
    { status: "DRAFT" as const, label: "Drafts to review", n: o.statusCounts.DRAFT, icon: "sparkles-outline" as Icon, color: WARN },
    { status: "LOW" as const, label: "Running low", n: o.lowStock, icon: "alert-circle-outline" as Icon, color: WARN },
    { status: "WISHLIST" as const, label: "Wishlist", n: o.statusCounts.WISHLIST, sub: o.wishlist.estimatedTotal ? `~${formatUsd(o.wishlist.estimatedTotal)}` : undefined, icon: "heart-outline" as Icon },
    { status: "PAST" as const, label: "Sold & given away", n: o.statusCounts.PAST, icon: "archive-outline" as Icon },
  ].filter((s) => s.n > 0);

  const tiles: Array<Bucket & { icon: Icon; locked?: boolean; open: () => void }> =
    by === "category"
      ? o.categories
          .filter((c) => c.depth === 0)
          .map((c) => ({ ...c, icon: (c.detailType && TYPE_ICON[c.detailType]) || "cube-outline", locked: c.private, open: () => openList({ title: c.label, categoryId: c.key }) }))
      : by === "room"
        ? o.rooms.map((r) => ({ ...r, icon: (r.key === "none" ? "help-circle-outline" : "home-outline") as Icon, open: () => openList({ title: r.label, roomId: r.key }) }))
        : o.owners.map((w) => ({
            ...w,
            icon: (w.key.startsWith("pet:") ? "paw-outline" : w.key === "household" ? "people-outline" : "person-outline") as Icon,
            open: () => openList({ title: w.label, owner: w.key }),
          }));

  const tileW = (Dimensions.get("window").width - 32 - 10) / 2;

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      {header}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Input value={query} onChangeText={setQuery} placeholder="Search everything: name, brand, caliber, color…" autoCapitalize="none" clearButtonMode="while-editing" />
      </View>
      {q.length >= 2 ? (
        <ScrollView contentContainerStyle={fs.body} keyboardShouldPersistTaps="handled">
          {!hits ? (
            <ActivityIndicator />
          ) : hits.items.length === 0 ? (
            <Text style={fs.empty}>Nothing matches “{q}”.</Text>
          ) : (
            <>
              <Text style={[fs.muted, { paddingHorizontal: 4 }]}>
                {hits.count} match{hits.count === 1 ? "" : "es"}
                {hits.count > hits.items.length ? `, showing ${hits.items.length}` : ""}
              </Text>
              <View style={[fs.card, { paddingVertical: 2, gap: 0 }]}>
                {hits.items.map((i, n) => (
                  <ItemRow key={i.id} item={i} first={n === 0} onAdjust={(d) => void adjust(i, d)} />
                ))}
              </View>
            </>
          )}
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={fs.body}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
        >
          <Text style={[fs.muted, { paddingHorizontal: 4 }]}>
            {o.owned.count} thing{o.owned.count === 1 ? "" : "s"} we own{o.owned.value > 0 ? ` · ${formatUsd(o.owned.value)} paid` : ""}
          </Text>

          {shortcuts.length > 0 && (
            <View style={[fs.card, { paddingVertical: 2, gap: 0 }]}>
              {shortcuts.map((s, n) => (
                <Pressable
                  key={s.status}
                  onPress={() => openList({ title: s.label, status: s.status })}
                  style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, borderTopWidth: n === 0 ? 0 : 1, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}
                >
                  <Ionicons name={s.icon} size={18} color={s.color ?? ACCENT} />
                  <Text style={fs.textFlex}>{s.label}</Text>
                  {s.sub ? <Text style={fs.muted}>{s.sub}</Text> : null}
                  <Text style={[fs.money, { fontWeight: "600", color: s.color ?? "#333" }]}>{s.n}</Text>
                  <Ionicons name="chevron-forward" size={16} color="#ccc" />
                </Pressable>
              ))}
            </View>
          )}

          <View style={{ flexDirection: "row", gap: 6 }}>
            <Chip label="Categories" on={by === "category"} onPress={() => setBy("category")} />
            <Chip label="Rooms" on={by === "room"} onPress={() => setBy("room")} />
            <Chip label="People" on={by === "person"} onPress={() => setBy("person")} />
          </View>

          {tiles.length === 0 ? (
            <Text style={fs.empty}>Nothing here yet. Tap + to add something, or tell Janet.</Text>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              {tiles.map((t) => (
                <Pressable key={t.key} onPress={t.open} style={({ pressed }) => [{ width: tileW, backgroundColor: "#fff", borderRadius: 12, overflow: "hidden" }, pressed && fs.pressed]}>
                  {t.imageKey ? (
                    <Image source={{ uri: resizedImageUrl(t.imageKey, 400) }} style={{ width: tileW, height: tileW * 0.6, backgroundColor: "#eee" }} contentFit="cover" />
                  ) : (
                    <View style={{ width: tileW, height: tileW * 0.6, backgroundColor: "#f3efec", alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name={t.icon} size={28} color="#b9aca4" />
                    </View>
                  )}
                  <View style={{ padding: 10, gap: 2 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <Text style={[fs.text, { fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
                        {t.label}
                      </Text>
                      {t.locked && <Ionicons name="lock-closed" size={11} color="#aaa" />}
                    </View>
                    <Text style={fs.muted} numberOfLines={1}>
                      {t.count} item{t.count === 1 ? "" : "s"}
                      {t.value > 0 ? ` · ${formatUsd(t.value)}` : ""}
                    </Text>
                    {t.wishlist > 0 && (
                      <Text style={[fs.muted, { color: ACCENT }]} numberOfLines={1}>
                        +{t.wishlist} on the wishlist
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {o.recent.length > 0 && (
            <View style={{ gap: 6 }}>
              <Text style={[fs.label, { paddingHorizontal: 4 }]}>Recently added</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
                {o.recent.map((i) => (
                  <Pressable key={i.id} onPress={() => openInventoryItem(i.id)} style={({ pressed }) => [{ width: 110 }, pressed && fs.pressed]}>
                    {i.imageKeys[0] ? (
                      <Image source={{ uri: resizedImageUrl(i.imageKeys[0], 240) }} style={{ width: 110, height: 110, borderRadius: 10, backgroundColor: "#eee" }} contentFit="cover" />
                    ) : (
                      <View style={{ width: 110, height: 110, borderRadius: 10, backgroundColor: "#f3efec", alignItems: "center", justifyContent: "center" }}>
                        <Ionicons name={(i.detailType && TYPE_ICON[i.detailType]) || "cube-outline"} size={24} color="#b9aca4" />
                      </View>
                    )}
                    <Text style={[fs.text, { fontSize: 13, marginTop: 4 }]} numberOfLines={2}>
                      {i.name}
                    </Text>
                    {i.status === "WISHLIST" && <Text style={[fs.muted, { color: ACCENT }]}>Wishlist</Text>}
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}
        </ScrollView>
      )}
      <ItemFormModal
        visible={adding}
        item={null}
        defaultStatus="OWNED"
        categories={refs.categories}
        items={everything}
        lists={refs.lists}
        rooms={refs.rooms}
        owners={refs.owners}
        onClose={() => setAdding(false)}
        onSaved={(saved) => {
          setAdding(false);
          void load();
          if (saved) openInventoryItem(saved.id);
        }}
      />
    </SafeAreaView>
  );
}
