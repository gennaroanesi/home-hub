// One slice of the inventory, opened from the Inventory home: a category
// (with its subcategories as chips), a room, a person, or a status across
// everything (wishlist, drafts, running low, sold / given away). Within a
// category / room / person the status tabs and search work on the loaded
// items; a status-only slice asks the server for just that status, so it
// stays small however big the inventory gets. list_inventory.

import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../../lib/ops";
import { categoryAndDescendants, formatUsd, sizeRank, wishlistSummary } from "../../../../../lib/inventory";
import { Input } from "../../../../components/finance/form";
import { ACCENT, Chip, FinanceHeader, HeaderButton, WARN, fs } from "../../../../components/finance/ui";
import { ItemFormModal, type InventoryItem } from "../../../../components/inventory/ItemFormModal";
import { ItemRow } from "../../../../components/inventory/ItemRow";
import { AmmoCard } from "../../../../components/inventory/AmmoCard";
import { loadAllInventoryItems, openInventoryItem, useInventoryRefs } from "../../../../components/inventory/refs";

export type ListTab = "OWNED" | "WISHLIST" | "DRAFT" | "PAST" | "LOW";
const TAB_LABELS: Record<ListTab, string> = { OWNED: "Owned", WISHLIST: "Wishlist", DRAFT: "Drafts", PAST: "Past", LOW: "Running low" };
const inTab = (i: InventoryItem, t: ListTab) =>
  t === "PAST" ? i.status === "SOLD" || i.status === "GIVEN_AWAY" : t === "LOW" ? i.status === "OWNED" && !!i.lowStock : i.status === t;

type Params = { title?: string; categoryId?: string; roomId?: string; owner?: string; status?: ListTab };

export default function InventoryListScreen() {
  const p = useLocalSearchParams<Params>();
  const refs = useInventoryRefs();
  const scoped = !!(p.categoryId || p.roomId || p.owner);
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<ListTab>(p.status ?? "OWNED");
  const [sub, setSub] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [everything, setEverything] = useState<InventoryItem[]>([]);

  const load = useCallback(async () => {
    const scope = { categoryId: p.categoryId, roomId: p.roomId, ownerName: p.owner, limit: 1000 };
    // A status across everything: just that status from the server.
    const calls = scoped
      ? [callOp("list_inventory", { ...scope, status: "ALL" })]
      : tab === "PAST"
        ? [callOp("list_inventory", { ...scope, status: "SOLD" }), callOp("list_inventory", { ...scope, status: "GIVEN_AWAY" })]
        : [callOp("list_inventory", { ...scope, status: tab === "LOW" ? "OWNED" : tab, lowStockOnly: tab === "LOW" || undefined })];
    const rs = await Promise.all(calls);
    const bad = rs.find((r) => "error" in r);
    if (bad && "error" in bad) return setError(bad.error);
    const ok = rs.flatMap((r) => ("error" in r ? [] : [r.result]));
    setError(null);
    setItems(ok.flatMap((r) => r.items));
    setTotal(ok.reduce((n, r) => n + r.count, 0));
    setVersion((v) => v + 1);
  }, [p.categoryId, p.roomId, p.owner, scoped, tab]);
  // On focus too: back from an item page picks up its edits.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const all = items ?? [];
  const tabs = (Object.keys(TAB_LABELS) as ListTab[]).filter((t) => t !== "LOW");
  const counts = useMemo(() => Object.fromEntries(tabs.map((t) => [t, all.filter((i) => inTab(i, t)).length])) as Record<ListTab, number>, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const children = useMemo(() => {
    if (!p.categoryId) return [];
    return refs.categories
      .filter((c) => c.parentId === p.categoryId)
      .map((c) => ({ ...c, n: all.filter((i) => inTab(i, tab) && !!i.categoryId && categoryAndDescendants(c.id, refs.categories).has(i.categoryId)).length }))
      .filter((c) => c.n > 0);
  }, [p.categoryId, refs.categories, all, tab]);
  const subIds = useMemo(() => (sub ? categoryAndDescendants(sub, refs.categories) : null), [sub, refs.categories]);

  const visible = useMemo(() => {
    const q = query.toLowerCase().trim();
    return all
      .filter((i) => inTab(i, tab))
      .filter((i) => !subIds || (!!i.categoryId && subIds.has(i.categoryId)))
      .filter((i) => !q || [i.name, i.brand, i.notes, i.room, i.location, i.summary, i.category, ...i.tags].filter(Boolean).join(" ").toLowerCase().includes(q));
  }, [all, tab, subIds, query]);

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

  const value = useMemo(() => visible.reduce((n, i) => n + (tab === "WISHLIST" ? (i.estimatedPrice ?? 0) : (i.pricePaid ?? 0)) * Math.max(1, i.quantity ?? 1), 0), [visible, tab]);
  const wish = useMemo(() => (tab === "WISHLIST" ? wishlistSummary(visible) : null), [tab, visible]);
  const showAmmo = tab === "OWNED" && !query && all.some((i) => i.detailType === "AMMO" && i.status === "OWNED");
  // A single heading is the page title already.
  const oneGroup = groups.length === 1;

  async function adjust(i: InventoryItem, delta: number) {
    const r = await callOp("adjust_inventory_quantity", { itemId: i.id, delta });
    if ("error" in r) return Alert.alert("Couldn't update", r.error);
    setItems((prev) => (prev ?? []).map((x) => (x.id === i.id ? { ...x, quantity: r.result.after, lowStock: r.result.restock?.lowStock ?? x.lowStock } : x)));
    if (r.result.restock?.addedToList) Alert.alert("Running low", `Added to ${r.result.restock.addedToList}.`);
  }

  async function approveAll() {
    const r = await callOp("review_inventory_drafts", { action: "approve", itemIds: visible.map((i) => i.id) });
    if ("error" in r) return Alert.alert("Couldn't approve", r.error);
    await load();
  }

  const title = p.title ?? TAB_LABELS[tab];
  const header = <FinanceHeader title={title} right={<HeaderButton icon="add" onPress={() => void loadAllInventoryItems().then((x) => { setEverything(x); setAdding(true); })} />} />;

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
        <Input value={query} onChangeText={setQuery} placeholder={`Search ${title.toLowerCase()}…`} autoCapitalize="none" clearButtonMode="while-editing" />
        {scoped && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {tabs
              .filter((t) => t === "OWNED" || t === tab || counts[t] > 0)
              .map((t) => (
                <Chip key={t} label={`${TAB_LABELS[t]} ${counts[t]}`} on={tab === t} onPress={() => setTab(t)} color={t === "DRAFT" ? WARN : undefined} />
              ))}
          </ScrollView>
        )}
        {children.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            <Chip label="All" on={!sub} onPress={() => setSub("")} />
            {children.map((c) => (
              <Chip key={c.id} label={`${c.name} ${c.n}`} on={sub === c.id} onPress={() => setSub(sub === c.id ? "" : c.id)} />
            ))}
          </ScrollView>
        )}
      </View>
      <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} keyboardShouldPersistTaps="handled">
        {showAmmo && <AmmoCard version={version} onChanged={() => void load()} />}
        {tab === "DRAFT" && visible.length > 0 && (
          <View style={[fs.card, { backgroundColor: "#fdf6e9" }]}>
            <Text style={fs.text}>Janet identified these from a photo. Open one to fix it, or approve them all.</Text>
            <Pressable onPress={() => void approveAll()} style={({ pressed }) => [{ alignSelf: "flex-start", paddingVertical: 6 }, pressed && fs.pressed]}>
              <Text style={{ color: ACCENT, fontWeight: "600" }}>Approve all {visible.length}</Text>
            </Pressable>
          </View>
        )}
        {visible.length > 0 && (
          <Text style={[fs.muted, { paddingHorizontal: 4 }]}>
            {wish
              ? `${wish.count} item${wish.count === 1 ? "" : "s"} · ~${formatUsd(wish.estimatedTotal)}${wish.unpriced ? ` · ${wish.unpriced} without a price` : ""}`
              : `${visible.length} item${visible.length === 1 ? "" : "s"}${value > 0 ? ` · ${formatUsd(value)}` : ""}`}
            {total > all.length ? ` · showing the first ${all.length} of ${total}` : ""}
          </Text>
        )}
        {groups.length === 0 && <Text style={fs.empty}>{all.some((i) => inTab(i, tab)) ? "Nothing matches." : "Nothing here yet."}</Text>}
        {groups.map((g) => (
          <View key={g.label} style={{ gap: 6 }}>
            {!oneGroup && (
              <Text style={[fs.label, { paddingHorizontal: 4 }]}>
                {g.label} · {g.rows.length}
              </Text>
            )}
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
        defaultCategoryId={sub || (p.categoryId !== "none" ? p.categoryId : undefined)}
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
