// One inventory item on the phone: photos, its detail fields (from
// lib/inventory-details.ts), where it is, what it cost, the parts
// installed on it, and for ammo the uses logged against it. Edit,
// "Got it" for wishlist items, approve / discard for drafts.
// get_inventory_item / manage_inventory_item / review_inventory_drafts.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Dimensions, Linking, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../../lib/ops";
import { resizedImageUrl } from "../../../../lib/image";
import { DETAIL_SPECS, formatDetailValue, type DetailType } from "../../../../../lib/inventory-details";
import { ACQUIRED_VIA_LABELS, formatUsd } from "../../../../../lib/inventory";
import { ACCENT, Card, FinanceHeader, HeaderButton, WARN, fs, type OpResultOf } from "../../../../components/finance/ui";
import { ItemFormModal } from "../../../../components/inventory/ItemFormModal";
import { openInventoryItem, useInventoryRefs } from "../../../../components/inventory/refs";

type Detail = OpResultOf<"get_inventory_item">;

const STATUS: Record<string, string> = { OWNED: "Owned", WISHLIST: "Wishlist", SOLD: "Sold", GIVEN_AWAY: "Given away", DRAFT: "Draft" };

export default function InventoryItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const refs = useInventoryRefs();
  const [d, setD] = useState<Detail | null>(null);
  const [all, setAll] = useState<Detail["item"][]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await callOp("get_inventory_item", { itemId: id });
    if ("error" in r) setError(r.error);
    else {
      setError(null);
      setD(r.result);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  // The edit form's "installed on" picker needs the other items.
  async function openEdit() {
    if (all.length === 0) {
      const r = await callOp("list_inventory", { status: "ALL", limit: 1000 });
      if (!("error" in r)) setAll(r.result.items);
    }
    setEditing(true);
  }

  async function act(fn: () => Promise<{ error?: string } | object>, after?: () => void) {
    setBusy(true);
    try {
      const r = (await fn()) as { error?: string };
      if (r.error) Alert.alert("Couldn't do that", r.error);
      else after ? after() : await load();
    } finally {
      setBusy(false);
    }
  }

  const header = <FinanceHeader title={d?.item.name ?? "Item"} right={d ? <HeaderButton icon="create-outline" onPress={() => void openEdit()} /> : undefined} />;

  if (!d) {
    return (
      <SafeAreaView style={fs.screen} edges={["top"]}>
        {header}
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      </SafeAreaView>
    );
  }

  const i = d.item;
  const type = i.detailType as DetailType | null;
  const fields = type
    ? DETAIL_SPECS[type].fields
        .filter((f) => f.kind !== "shoppingList")
        .map((f) => ({ label: f.label, value: formatDetailValue(f, i.details?.[f.key]) }))
        .filter((x) => x.value != null)
    : [];
  const width = Dimensions.get("window").width - 32;
  const partsValue = d.parts.reduce((n, p) => n + (p.pricePaid ?? 0) * Math.max(1, p.quantity ?? 1), 0);
  const facts: Array<[string, string | null]> = [
    ["Category", i.category],
    ["Belongs to", i.private ? "You (only you see this)" : i.owner],
    ["Brand", i.brand],
    ["Quantity", i.quantity != null && i.quantity !== 1 ? String(i.quantity) : null],
    ["Room", i.room],
    ["Where", i.location],
    ["Installed on", i.parentName],
    i.status === "WISHLIST"
      ? ["Estimate", i.estimatedPrice != null ? `${formatUsd(i.estimatedPrice)} each` : null]
      : ["Paid", i.pricePaid != null ? `${formatUsd(i.pricePaid)}${(i.quantity ?? 1) > 1 ? " each" : ""}` : null],
    ["Got it", [i.acquiredVia && i.acquiredVia !== "PURCHASED" ? `${ACQUIRED_VIA_LABELS[i.acquiredVia as keyof typeof ACQUIRED_VIA_LABELS]}${i.giftFrom ? ` from ${i.giftFrom}` : ""}` : null, i.vendor, i.acquiredAt].filter(Boolean).join(" · ") || null],
    ["Needed by", i.status === "WISHLIST" ? i.neededBy : null],
    ["Sold for", i.priceSold != null ? formatUsd(i.priceSold) : null],
    ["Tags", i.tags.length ? i.tags.map((t) => `#${t}`).join(" ") : null],
  ];

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      {header}
      <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        {i.imageKeys.length > 0 && (
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={{ borderRadius: 12 }}>
            {i.imageKeys.map((k) => (
              <Image key={k} source={{ uri: resizedImageUrl(k, 900) }} style={{ width, height: width * 0.75, backgroundColor: "#eee" }} contentFit="cover" />
            ))}
          </ScrollView>
        )}

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <Text style={[fs.muted, { fontWeight: "600" }]}>{STATUS[i.status ?? ""] ?? i.status}</Text>
          {i.private && <Ionicons name="lock-closed" size={12} color="#999" />}
          {i.lowStock && <Text style={{ color: WARN, fontWeight: "600", fontSize: 12 }}>Running low</Text>}
          {i.summary ? <Text style={fs.muted}>· {i.summary}</Text> : null}
        </View>

        {i.status === "WISHLIST" && (
          <Action label="Got it" icon="checkmark-circle-outline" busy={busy} onPress={() => void act(() => callOp("manage_inventory_item", { action: "mark_owned", itemId: i.id }))} />
        )}
        {i.status === "DRAFT" && (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Action label="Approve" icon="checkmark-circle-outline" busy={busy} onPress={() => void act(() => callOp("review_inventory_drafts", { action: "approve", itemIds: [i.id] }))} />
            <Action label="Discard" icon="trash-outline" busy={busy} danger onPress={() => void act(() => callOp("review_inventory_drafts", { action: "discard", itemIds: [i.id] }), () => router.back())} />
          </View>
        )}

        {fields.length > 0 && (
          <Card title={DETAIL_SPECS[type!].label}>
            {fields.map((x) => (
              <Row key={x.label} label={x.label} value={x.value!} />
            ))}
          </Card>
        )}

        <Card>
          {facts
            .filter(([, v]) => !!v)
            .map(([label, value]) => (
              <Row key={label} label={label} value={value!} onPress={label === "Installed on" && i.parentItemId ? () => openInventoryItem(i.parentItemId!) : undefined} />
            ))}
          {i.url ? (
            <Pressable onPress={() => void Linking.openURL(i.url!)}>
              <Text style={[fs.text, { color: ACCENT }]} numberOfLines={1}>
                {i.url}
              </Text>
            </Pressable>
          ) : null}
          {i.notes ? <Text style={[fs.text, { marginTop: 4 }]}>{i.notes}</Text> : null}
        </Card>

        {d.parts.length > 0 && (
          <Card title={`Parts · ${d.parts.length}`}>
            {d.parts.map((p) => (
              <Pressable key={p.id} onPress={() => openInventoryItem(p.id)} style={({ pressed }) => [fs.rowBetween, pressed && fs.pressed]}>
                <Text style={fs.textFlex} numberOfLines={1}>
                  {p.name}
                  {p.summary ? <Text style={fs.muted}> · {p.summary}</Text> : null}
                </Text>
                {p.pricePaid != null && <Text style={fs.muted}>{formatUsd(p.pricePaid)}</Text>}
              </Pressable>
            ))}
            {partsValue > 0 && (
              <Text style={fs.muted}>
                With parts: {formatUsd((i.pricePaid ?? 0) * Math.max(1, i.quantity ?? 1) + partsValue)}
              </Text>
            )}
          </Card>
        )}

        {d.ammoUses && d.ammoUses.length > 0 && (
          <Card title="Used from this box">
            {d.ammoUses.map((u) => (
              <View key={u.id} style={fs.rowBetween}>
                <Text style={fs.textFlex} numberOfLines={1}>
                  {u.date}
                  {u.note ? <Text style={fs.muted}> · {u.note}</Text> : null}
                </Text>
                <Text style={fs.money}>{u.rounds} rds</Text>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
      <ItemFormModal
        visible={editing}
        item={i}
        defaultStatus="OWNED"
        categories={refs.categories}
        items={all}
        lists={refs.lists}
        rooms={refs.rooms}
        owners={refs.owners}
        onClose={() => setEditing(false)}
        onSaved={(saved) => {
          setEditing(false);
          if (!saved) router.back();
          else if (saved.id !== i.id) router.replace({ pathname: "/more/inventory/[id]", params: { id: saved.id } } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
          else void load();
        }}
      />
    </SafeAreaView>
  );
}

function Row({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [fs.rowBetween, { alignItems: "flex-start" }, pressed && fs.pressed]}>
      <Text style={[fs.muted, { width: 110 }]}>{label}</Text>
      <Text style={[fs.textFlex, { textAlign: "right" }, onPress && { color: ACCENT }]}>{value}</Text>
    </Pressable>
  );
}

function Action({ label, icon, onPress, busy, danger }: { label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void; busy?: boolean; danger?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={({ pressed }) => [{ flex: 1, flexDirection: "row", gap: 6, justifyContent: "center", alignItems: "center", paddingVertical: 10, borderRadius: 10, backgroundColor: danger ? "#f8e5e3" : "#efe8e4" }, pressed && fs.pressed]}
    >
      <Ionicons name={icon} size={18} color={danger ? "#c0392b" : ACCENT} />
      <Text style={{ color: danger ? "#c0392b" : ACCENT, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
