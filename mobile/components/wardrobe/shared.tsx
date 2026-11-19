// Small pieces shared by the mobile Wardrobe screens and their sheets —
// the native twin of components/wardrobe/shared.tsx on the web. Logic
// (filters, labels, trip-plan edits) lives in the root lib/wardrobe*.ts.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";

import { getClient } from "../../lib/amplify";
import { uploadDocumentFile } from "../../lib/documents-upload";
import { resizedImageUrl } from "../../lib/image";
import { mainImage, WARDROBE_STATUS_LABELS, type WardrobeStatus } from "../../../lib/wardrobe";
import type { Schema } from "../../../amplify/data/resource";

export type WardrobeItem = Schema["homeWardrobeItem"]["type"];
export type WardrobeLook = Schema["homeWardrobeLook"]["type"];
export type WardrobeProfile = Schema["homeWardrobeProfile"]["type"];

export const ACCENT = "#735f55";

export function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Status / swatch ────────────────────────────────────────────────────────

const STATUS_COLORS: Record<WardrobeStatus, { bg: string; fg: string; dashed?: boolean }> = {
  KEEP: { bg: "#e8eef7", fg: "#2f5597" },
  NEW: { bg: "#e3f3e6", fg: "#2e7d43" },
  TAILOR: { bg: "#fbf0dc", fg: "#9a6a12" },
  RETIRE: { bg: "#f8e3e3", fg: "#b03a3a" },
  WISHLIST: { bg: "#fff", fg: "#2f5597", dashed: true },
};

export function StatusChip({ status }: { status?: string | null }) {
  const s = (status ?? "KEEP") as WardrobeStatus;
  const c = STATUS_COLORS[s] ?? STATUS_COLORS.KEEP;
  return (
    <View
      style={[
        styles.statusChip,
        { backgroundColor: c.bg },
        c.dashed && { borderWidth: 1, borderStyle: "dashed", borderColor: c.fg },
      ]}
    >
      <Text style={[styles.statusChipText, { color: c.fg }]}>{WARDROBE_STATUS_LABELS[s] ?? s}</Text>
    </View>
  );
}

export function Swatch({ hex, size = 12 }: { hex?: string | null; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: "#bbb",
        backgroundColor: hex || "#eee",
      }}
    />
  );
}

/** Main photo of an item, or its color as a block when there's none. */
export function ItemThumb({
  item,
  width = 240,
  style,
  fit = "contain",
}: {
  item: Pick<WardrobeItem, "imageKeys" | "colorHex">;
  width?: number;
  style?: StyleProp<ViewStyle>;
  fit?: "contain" | "cover";
}) {
  const k = mainImage(item);
  return (
    <View style={[styles.thumb, style]}>
      {k ? (
        <Image source={{ uri: resizedImageUrl(k, width) }} style={StyleSheet.absoluteFill} contentFit={fit} transition={120} />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: item.colorHex ? `${item.colorHex}55` : "#f1f1f1" }]} />
      )}
    </View>
  );
}

// ── Chips ──────────────────────────────────────────────────────────────────

export function Chip({ on, onPress, label, count }: { on: boolean; onPress: () => void; label: string; count?: number }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>
        {label}
        {count != null && <Text style={styles.chipCount}> {count}</Text>}
      </Text>
    </Pressable>
  );
}

// ── Toast ──────────────────────────────────────────────────────────────────

export interface ToastMsg {
  title: string;
  detail?: string;
  tone?: "ok" | "warn" | "error";
}

/** A transient pill under the header, like the trip screens use. */
export function useToast(): [ReactNode, (m: ToastMsg) => void] {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((m: ToastMsg) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), m.detail ? 3500 : 2200);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const node = msg ? (
    <View
      style={[styles.toast, msg.tone === "error" && { backgroundColor: "#a33" }, msg.tone === "warn" && { backgroundColor: "#9a6a12" }]}
      pointerEvents="none"
    >
      <Ionicons name={msg.tone === "error" ? "alert-circle" : msg.tone === "warn" ? "time-outline" : "checkmark-circle"} size={16} color="#fff" />
      <View style={{ flexShrink: 1 }}>
        <Text style={styles.toastText}>{msg.title}</Text>
        {!!msg.detail && <Text style={styles.toastDetail}>{msg.detail}</Text>}
      </View>
    </View>
  ) : null;
  return [node, show];
}

// ── Option sheet ───────────────────────────────────────────────────────────

/** A bottom sheet with a list of options (days, checklists…). */
export function OptionSheet({
  visible,
  title,
  options,
  selected,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: { value: string; label: string }[];
  selected?: string | null;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <ScrollView style={{ maxHeight: 420 }}>
            {options.map((o) => {
              const on = o.value === selected;
              return (
                <Pressable
                  key={o.value}
                  onPress={() => {
                    onPick(o.value);
                    onClose();
                  }}
                  style={({ pressed }) => [styles.sheetRow, pressed && { backgroundColor: "#f3f3f3" }]}
                >
                  <Text style={[styles.sheetRowText, on && { color: ACCENT, fontWeight: "600" }]}>{o.label}</Text>
                  {on && <Ionicons name="checkmark" size={18} color={ACCENT} />}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable onPress={onClose} style={styles.sheetCancel}>
            <Text style={styles.sheetCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Photos ─────────────────────────────────────────────────────────────────

const WEB_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * Pick photos with the camera or library and upload them under
 * home/wardrobe/ or home/inventory/ (presigned /api/documents/upload-url,
 * like the web's uploadWardrobePhotos). Returns the new keys. `max` caps
 * a library pick. `webTypesOnly` (try-on reference photos) skips anything
 * but JPEG / PNG / WebP, which is all the renderer takes.
 */
export async function pickWardrobePhotos(source: "camera" | "library", max = 6, webTypesOnly = false, prefix: "wardrobe" | "inventory" = "wardrobe"): Promise<string[]> {
  const perm =
    source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert(source === "camera" ? "Camera permission needed" : "Photo library permission needed");
    return [];
  }
  const opts: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    quality: 0.85,
    ...(source === "library" && max > 1 ? { allowsMultipleSelection: true, selectionLimit: max } : {}),
  };
  const res = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled) return [];
  const keys: string[] = [];
  for (const a of res.assets.slice(0, max)) {
    const contentType = a.mimeType ?? "image/jpeg";
    if (webTypesOnly && !WEB_IMAGE_TYPES.includes(contentType)) {
      Alert.alert("Use a JPEG, PNG or WebP photo", "Try-on reference photos can't be HEIC.");
      continue;
    }
    try {
      const up = await uploadDocumentFile({ uri: a.uri, contentType, filename: a.fileName ?? `${prefix}.jpg`, prefix });
      keys.push(up.s3Key);
    } catch (err: any) {
      Alert.alert("Couldn't upload a photo", err?.message ?? String(err));
    }
  }
  return keys;
}

/** Ask camera or library, then pick + upload. */
export function choosePhotoSource(onKeys: (keys: string[]) => void, setBusy: (b: boolean) => void, max = 6, webTypesOnly = false, prefix: "wardrobe" | "inventory" = "wardrobe") {
  const run = async (src: "camera" | "library") => {
    setBusy(true);
    try {
      const keys = await pickWardrobePhotos(src, max, webTypesOnly, prefix);
      if (keys.length) onKeys(keys);
    } finally {
      setBusy(false);
    }
  };
  // Let the alert finish dismissing before iOS presents the picker.
  const later = (src: "camera" | "library") => setTimeout(() => void run(src), 350);
  Alert.alert("Add photo", undefined, [
    { text: "Camera", onPress: () => later("camera") },
    { text: "Photo library", onPress: () => later("library") },
    { text: "Cancel", style: "cancel" },
  ]);
}

// ── Wears ──────────────────────────────────────────────────────────────────

/** "Wore it today": a homeWardrobeWear row and lastWornOn on each piece, as the web does. */
export async function logWornToday(personId: string, itemIds: string[], lookId?: string | null): Promise<void> {
  const client = getClient();
  const date = todayYmd();
  const r = await client.models.homeWardrobeWear.create({ personId, date, itemIds, lookId: lookId ?? null });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  await Promise.all(itemIds.map((id) => client.models.homeWardrobeItem.update({ id, lastWornOn: date })));
}

// ── Styles ─────────────────────────────────────────────────────────────────

export const wardrobeStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, gap: 4 },
  backBtn: { padding: 4 },
  heading: { fontSize: 28, fontWeight: "600", flex: 1 },
  headingSmall: { fontSize: 20, fontWeight: "600" },
  subheading: { fontSize: 13, color: "#777" },
  iconBtn: { padding: 6 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  empty: { color: "#888", padding: 24, textAlign: "center" },
  emptyBox: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#ccc",
    borderRadius: 12,
    padding: 24,
    marginTop: 8,
  },

  tabs: { flexDirection: "row", marginHorizontal: 20, backgroundColor: "#ececec", borderRadius: 10, padding: 3, marginBottom: 8 },
  tab: { flex: 1, paddingVertical: 7, alignItems: "center", borderRadius: 8 },
  tabOn: { backgroundColor: "#fff" },
  tabText: { fontSize: 13, color: "#666", fontWeight: "500" },
  tabTextOn: { color: "#222" },

  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  search: { flex: 1, paddingVertical: 9, fontSize: 15, color: "#222" },
  chipRow: { flexDirection: "row", gap: 6, paddingVertical: 6 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingVertical: 4 },

  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    padding: 14,
    gap: 10,
    marginBottom: 12,
  },
  sectionLabel: { fontSize: 12, fontWeight: "600", color: "#888", textTransform: "uppercase", letterSpacing: 0.5 },
  sectionTitle: { fontSize: 18, fontWeight: "600", color: "#222" },
  meta: { fontSize: 12, color: "#888" },
  body: { fontSize: 14, color: "#444", lineHeight: 20 },
  input: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    color: "#222",
  },
  multiline: { minHeight: 64, textAlignVertical: "top" },

  btn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  btnPrimary: { backgroundColor: ACCENT },
  btnPrimaryText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  btnFlat: { backgroundColor: "#efeae7" },
  btnFlatText: { color: ACCENT, fontWeight: "500", fontSize: 14 },
  btnSmall: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  btnSmallText: { fontSize: 13 },
  btnDanger: { color: "#c44" },
  disabled: { opacity: 0.45 },
  link: { color: ACCENT, fontWeight: "500" },
});

const styles = StyleSheet.create({
  statusChip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, alignSelf: "flex-start" },
  statusChipText: { fontSize: 10, fontWeight: "600" },
  thumb: { backgroundColor: "#fff", overflow: "hidden" },

  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  chipOn: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipText: { color: "#444", fontSize: 13 },
  chipTextOn: { color: "#fff" },
  chipCount: { fontSize: 11, opacity: 0.7 },

  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#4e5e53",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    marginHorizontal: 20,
    marginBottom: 6,
    alignSelf: "flex-start",
    maxWidth: "90%",
  },
  toastText: { color: "#fff", fontSize: 13, fontWeight: "500" },
  toastDetail: { color: "#eee", fontSize: 12, marginTop: 1 },

  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 14, paddingBottom: 30 },
  sheetTitle: { fontSize: 13, fontWeight: "600", color: "#888", textAlign: "center", marginBottom: 6 },
  sheetRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, paddingHorizontal: 20 },
  sheetRowText: { fontSize: 16, color: "#222" },
  sheetCancel: { marginTop: 6, paddingVertical: 14, alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#eee" },
  sheetCancelText: { fontSize: 16, color: "#888" },
});
