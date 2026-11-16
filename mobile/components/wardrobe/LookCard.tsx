// One outfit card — the native twin of the web LookCard: occasion badge (or
// a warning when it uses wishlist pieces), palette dots, an optional try-on
// image behind a "Show try-on" toggle, the pieces, the note and the
// caller's actions. Used by saved looks, the suggester and trip looks.

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { resizedImageUrl } from "../../lib/image";
import { ItemThumb, type WardrobeItem } from "./shared";

export function LookCard({
  title,
  occasion,
  palette,
  note,
  itemIds,
  wishlistItemIds,
  previewImageKey,
  byId,
  onOpenItem,
  badge,
  actions,
}: {
  title: string;
  occasion?: string | null;
  palette?: string | null;
  note?: string | null;
  itemIds?: (string | null)[] | null;
  wishlistItemIds?: (string | null)[] | null;
  previewImageKey?: string | null;
  byId: Map<string, WardrobeItem>;
  onOpenItem?: (it: WardrobeItem) => void;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const pieces = (itemIds ?? []).map((id) => (id ? byId.get(id) : undefined)).filter((x): x is WardrobeItem => !!x);
  const wish = (wishlistItemIds ?? [])
    .filter((id) => id && !(itemIds ?? []).includes(id))
    .map((id) => (id ? byId.get(id) : undefined))
    .filter((x): x is WardrobeItem => !!x);
  const future = pieces.some((p) => p.status === "WISHLIST");
  const dots = pieces.map((p) => p.colorHex).filter((h): h is string => !!h).slice(0, 4);

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        <View style={[styles.occasion, future && styles.occasionWarn]}>
          <Text style={[styles.occasionText, future && styles.occasionWarnText]}>
            {future ? "⚠ Includes pieces you don't own" : occasion || "Any time"}
          </Text>
        </View>
      </View>
      {(dots.length > 0 || !!palette) && (
        <View style={styles.paletteRow}>
          <View style={{ flexDirection: "row" }}>
            {dots.map((h, n) => (
              <View key={n} style={[styles.dot, { backgroundColor: h, marginLeft: n ? -4 : 0 }]} />
            ))}
          </View>
          {!!palette && <Text style={styles.palette}>{palette}</Text>}
        </View>
      )}
      {badge}
      {!!previewImageKey && (
        <>
          <Pressable onPress={() => setShowPreview((v) => !v)} style={styles.previewToggle}>
            <Text style={styles.previewToggleText}>{showPreview ? "Hide try-on" : "Show try-on"}</Text>
            <Ionicons name={showPreview ? "chevron-up" : "chevron-down"} size={16} color="#666" />
          </Pressable>
          {showPreview && (
            <Image
              source={{ uri: resizedImageUrl(previewImageKey, 800) }}
              style={styles.preview}
              contentFit="contain"
              accessibilityLabel={`AI-generated preview of ${title}`}
            />
          )}
        </>
      )}
      <View style={styles.pieces}>
        {pieces.map((p) => (
          <Pressable key={p.id} onPress={() => onOpenItem?.(p)} style={styles.piece} disabled={!onOpenItem}>
            <View style={[styles.pieceImg, p.status === "WISHLIST" && styles.pieceWish]}>
              <ItemThumb item={p} style={StyleSheet.absoluteFillObject} />
              {p.status === "WISHLIST" && (
                <View style={styles.notOwned}>
                  <Text style={styles.notOwnedText}>Not owned</Text>
                </View>
              )}
            </View>
            <Text style={styles.pieceCat} numberOfLines={1}>
              {p.category}
            </Text>
            <Text style={styles.pieceName} numberOfLines={2}>
              {p.name}
            </Text>
          </Pressable>
        ))}
      </View>
      {!!note && <Text style={styles.note}>{note}</Text>}
      {wish.length > 0 && <Text style={styles.wish}>Would be even better with: {wish.map((w) => w.name).join(", ")}</Text>}
      {actions && <View style={styles.actions}>{actions}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    padding: 14,
    gap: 10,
    marginBottom: 12,
  },
  titleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6 },
  title: { fontSize: 17, fontWeight: "600", color: "#222", flexShrink: 1 },
  occasion: { backgroundColor: "#e8eef7", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  occasionText: { fontSize: 11, fontWeight: "600", color: "#2f5597" },
  occasionWarn: { backgroundColor: "#fbf0dc", borderWidth: 1, borderColor: "#e8c98a" },
  occasionWarnText: { color: "#9a6a12" },
  paletteRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: "#fff" },
  palette: { fontSize: 11, color: "#999", textTransform: "uppercase", letterSpacing: 0.5, flexShrink: 1 },
  previewToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#f1f1f1",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  previewToggleText: { fontSize: 14, color: "#555" },
  preview: { width: "100%", aspectRatio: 2 / 3, borderRadius: 8, backgroundColor: "#fafafa" },
  pieces: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  piece: { width: "31%" },
  pieceImg: {
    aspectRatio: 3 / 4,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: "#fff",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  pieceWish: { borderWidth: 2, borderStyle: "dashed", borderColor: "#e0b250" },
  notOwned: { position: "absolute", left: 3, top: 3, backgroundColor: "#fbf0dc", borderRadius: 999, paddingHorizontal: 5 },
  notOwnedText: { fontSize: 9, fontWeight: "600", color: "#9a6a12" },
  pieceCat: { fontSize: 9, color: "#999", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 },
  pieceName: { fontSize: 12, color: "#333", lineHeight: 15 },
  note: { fontSize: 14, color: "#555", lineHeight: 20 },
  wish: { fontSize: 12, color: "#2f5597" },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
});
