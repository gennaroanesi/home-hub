// One item in an inventory list: photo, name, owner / summary / room,
// and its price, quantity, or +/- for consumables we own.

import { Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";

import { resizedImageUrl } from "../../lib/image";
import { formatUsd } from "../../../lib/inventory";
import { ACCENT, WARN, fs } from "../finance/ui";
import type { InventoryItem } from "./ItemFormModal";
import { openInventoryItem } from "./refs";

export function ItemRow({ item: i, first, onAdjust }: { item: InventoryItem; first: boolean; onAdjust: (delta: number) => void }) {
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
