// Inventory on the phone: what we own, the wishlist, drafts from Janet's
// photo intake, and sold / given-away things, grouped by category. Search,
// category chips, ammo per caliber (owner-only), +/- for consumables; tap
// an item for its page. Reads and writes go through the inventory ops
// (lib/ops/inventory-items.ts), like the web and Janet.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../../lib/ops";
import { resizedImageUrl } from "../../../../lib/image";
import { categoryAndDescendants, formatUsd, sizeRank, wishlistSummary } from "../../../../../lib/inventory";
import { Input } from "../../../../components/finance/form";
import { ACCENT, Chip, FinanceHeader, HeaderButton, WARN, fs } from "../../../../components/finance/ui";
import { ItemFormModal, type InventoryItem } from "../../../../components/inventory/ItemFormModal";
import { AmmoCard } from "../../../../components/inventory/AmmoCard";
import { openInventoryItem, useInventoryRefs } from "../../../../components/inventory/refs";

type Tab = "OWNED" | "WISHLIST" | "DRAFT" | "PAST";
const TAB_LABELS: Record<Tab, string> = { OWNED: "Owned", WISHLIST: "Wishlist", DRAFT: "Drafts", PAST: "Past" };
const inTab = (i: InventoryItem, t: Tab) => (t === "PAST" ? i.status === "SOLD" || i.status === "GIVEN_AWAY" : i.status === t);

export default function InventoryScreen() {
  const refs = useInventoryRefs();
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("OWNED");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const r = await callOp("list_inventory", { status: "ALL", limit: 1000 });
    if ("error" in r) setError(r.error);
    else {
      setError(null);
      setItems(r.result.items);
      setVersion((v) => v + 1);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const all = items ?? [];
  const counts = useMemo(() => Object.fromEntries((Object.keys(TAB_LABELS) as Tab[]).map((t) => [t, all.filter((i) => inTab(i, t)).length])) as Record<Tab, number>, [all]);
  const topCategories = refs.categories.filter((c) => c.depth === 0 && c.itemCount > 0);
  const catIds = useMemo(() => (category ? categoryAndDescendants(category, refs.categories) : null), [category, refs.categories]);

  const visible = useMemo(() => {
    const q = query.toLowerCase().trim();
    return all
      .filter((i) => inTab(i, tab))
      .filter((i) => !catIds || (!!i.categoryId && catIds.has(i.categoryId)))
      .filter((i) => {
        if (!q) return true;
        return [i.name, i.brand, i.notes, i.room, i.location, i.summary, i.category, ...i.tags].filter(Boolean).join(" ").toLowerCase().includes(q);
      });
  }, [all, tab, catIds, query]);

  const groups = useMemo(() => {
    const by = new Map<string, InventoryItem[]>();
    for (const i of visible) {
      const k = i.category ?? "Uncategorized";
      by.set(k, [...(by.get(k) ?? []), i]);
    }
    const order = (path: string) => {
      const n = refs.categories.findIndex((c) => c.path === path);
      return n === -1 ? Number.MAX_SAFE_INTEGER : n;
    };
    return [...by.entries()]
      .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
      .map(([label, rows]) => ({
        label,
        rows: rows.sort(
          (a, b) =>
            (tab === "WISHLIST" ? Number(a.priority !== "MUST_HAVE") - Number(b.priority !== "MUST_HAVE") : 0) ||
            sizeRank(a.details?.size as string | undefined) - sizeRank(b.details?.size as string | undefined) ||
            a.name.localeCompare(b.name),
        ),
      }));
  }, [visible, refs.categories, tab]);

  const wish = useMemo(() => (tab === "WISHLIST" ? wishlistSummary(visible) : null), [tab, visible]);
  const hasAmmo = all.some((i) => i.detailType === "AMMO");

  async function adjust(i: InventoryItem, delta: number) {
    const r = await callOp("adjust_inventory_quantity", { itemId: i.id, delta });
    if ("error" in r) return Alert.alert("Couldn't update", r.error);
    setItems((prev) => (prev ?? []).map((x) => (x.id === i.id ? { ...x, quantity: r.result.after, lowStock: r.result.restock?.lowStock ?? x.lowStock } : x)));
    if (r.result.restock?.addedToList) Alert.alert("Running low", `Added to ${r.result.restock.addedToList}.`);
  }

  async function approveAll() {
    const ids = visible.map((i) => i.id);
    const r = await callOp("review_inventory_drafts", { action: "approve", itemIds: ids });
    if ("error" in r) return Alert.alert("Couldn't approve", r.error);
    await load();
  }

  const header = <FinanceHeader title="Inventory" right={<HeaderButton icon="add" onPress={() => setAdding(true)} />} />;

  if (!items) {
    return (
      <SafeAreaView style={fs.screen} edges={["top"]}>
        {header}
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      {header}
      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 8 }}>
        <Input value={query} onChangeText={setQuery} placeholder="Search name, brand, caliber, color…" autoCapitalize="none" clearButtonMode="while-editing" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {(Object.keys(TAB_LABELS) as Tab[])
            .filter((t) => t !== "DRAFT" || counts.DRAFT > 0)
            .map((t) => (
              <Chip key={t} label={`${TAB_LABELS[t]} ${counts[t]}`} on={tab === t} onPress={() => setTab(t)} color={t === "DRAFT" ? WARN : undefined} />
            ))}
        </ScrollView>
        {topCategories.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            <Chip label="All" on={!category} onPress={() => setCategory("")} />
            {topCategories.map((c) => (
              <Chip key={c.id} label={c.name} on={category === c.id} onPress={() => setCategory(category === c.id ? "" : c.id)} />
            ))}
          </ScrollView>
        )}
      </View>
      <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} keyboardShouldPersistTaps="handled">
        {tab === "OWNED" && hasAmmo && !category && !query && <AmmoCard version={version} onChanged={() => void load()} />}
        {tab === "DRAFT" && visible.length > 0 && (
          <View style={[fs.card, { backgroundColor: "#fdf6e9" }]}>
            <Text style={fs.text}>Janet identified these from a photo. Open one to fix it, or approve them all.</Text>
            <Pressable onPress={() => void approveAll()} style={({ pressed }) => [{ alignSelf: "flex-start", paddingVertical: 6 }, pressed && fs.pressed]}>
              <Text style={{ color: ACCENT, fontWeight: "600" }}>Approve all {visible.length}</Text>
            </Pressable>
          </View>
        )}
        {wish && wish.count > 0 && (
          <Text style={[fs.muted, { paddingHorizontal: 4 }]}>
            {wish.count} item{wish.count === 1 ? "" : "s"} · ~{formatUsd(wish.estimatedTotal)}
            {wish.unpriced ? ` · ${wish.unpriced} without a price` : ""}
          </Text>
        )}
        {groups.length === 0 && <Text style={fs.empty}>{all.some((i) => inTab(i, tab)) ? "Nothing matches." : "Nothing here yet. Tap + to add something, or tell Janet."}</Text>}
        {groups.map((g) => (
          <View key={g.label} style={{ gap: 6 }}>
            <Text style={[fs.label, { paddingHorizontal: 4 }]}>
              {g.label} · {g.rows.length}
            </Text>
            <View style={[fs.card, { paddingVertical: 2, gap: 0 }]}>
              {g.rows.map((i, n) => (
                <ItemRow key={i.id} item={i} first={n === 0} onAdjust={(d) => void adjust(i, d)} />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
      <ItemFormModal
        visible={adding}
        item={null}
        defaultStatus={tab === "WISHLIST" ? "WISHLIST" : "OWNED"}
        categories={refs.categories}
        items={all}
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

function ItemRow({ item: i, first, onAdjust }: { item: InventoryItem; first: boolean; onAdjust: (delta: number) => void }) {
  const consumable = i.detailType === "CONSUMABLE" && i.status === "OWNED";
  const price = i.status === "WISHLIST" ? i.estimatedPrice : i.pricePaid;
  const line = [i.owner !== "household" ? i.owner : null, !consumable ? i.summary : null, i.parentName ? `on ${i.parentName}` : null, i.room].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={() => openInventoryItem(i.id)}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderTopWidth: first ? 0 : 1, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}
    >
      {i.imageKeys[0] ? (
        <Image source={{ uri: resizedImageUrl(i.imageKeys[0], 120) }} style={{ width: 40, height: 40, borderRadius: 6, backgroundColor: "#eee" }} contentFit="cover" />
      ) : (
        <View style={{ width: 40, height: 40, borderRadius: 6, backgroundColor: "#f3efec", alignItems: "center", justifyContent: "center" }}>
          <Ionicons name={i.private ? "lock-closed-outline" : "cube-outline"} size={18} color="#b9aca4" />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={[fs.text, { fontWeight: "500", flexShrink: 1 }]} numberOfLines={1}>
            {i.name}
          </Text>
          {i.private && <Ionicons name="lock-closed" size={11} color="#aaa" />}
          {i.lowStock && <Text style={{ fontSize: 11, color: WARN, fontWeight: "600" }}>LOW</Text>}
          {i.status === "WISHLIST" && i.priority === "MUST_HAVE" && <Text style={{ fontSize: 11, color: ACCENT, fontWeight: "600" }}>MUST</Text>}
        </View>
        {line ? (
          <Text style={fs.muted} numberOfLines={1}>
            {line}
          </Text>
        ) : null}
      </View>
      {consumable ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
          <Pressable onPress={() => onAdjust(-1)} hitSlop={6} style={{ padding: 4 }}>
            <Ionicons name="remove-circle-outline" size={22} color={ACCENT} />
          </Pressable>
          <Text style={[fs.money, { minWidth: 22, textAlign: "center" }]}>{i.quantity ?? 0}</Text>
          <Pressable onPress={() => onAdjust(1)} hitSlop={6} style={{ padding: 4 }}>
            <Ionicons name="add-circle-outline" size={22} color={ACCENT} />
          </Pressable>
        </View>
      ) : price != null ? (
        <Text style={fs.muted}>
          {i.status === "WISHLIST" ? "~" : ""}
          {formatUsd(price * Math.max(1, i.quantity ?? 1))}
        </Text>
      ) : (i.quantity ?? 1) > 1 ? (
        <Text style={fs.muted}>×{i.quantity}</Text>
      ) : null}
    </Pressable>
  );
}
