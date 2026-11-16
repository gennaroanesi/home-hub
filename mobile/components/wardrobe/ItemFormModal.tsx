// Add / edit one wardrobe item — the native twin of the web ItemModal.
// Photos upload as soon as they're picked (home/wardrobe/, prefix
// "wardrobe"); the first is the main one. Saves through the
// save_wardrobe_item op (validation, defaults and the duplicate check live
// there, shared with Janet and the web); delete goes straight to the model
// like the web does.

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { getClient } from "../../lib/amplify";
import { callOp } from "../../lib/ops";
import { resizedImageUrl } from "../../lib/image";
import { formStyles } from "../person-form-styles";
import {
  FORMALITIES,
  FORMALITY_LABELS,
  SEASONS,
  SEASON_LABELS,
  WARDROBE_STATUSES,
  WARDROBE_STATUS_LABELS,
  imagesOf,
  makeMain,
} from "../../../lib/wardrobe";
import { ACCENT, choosePhotoSource, type WardrobeItem } from "./shared";

const TEXT_FIELDS = ["name", "brand", "color", "size", "fabric", "fit", "styleCode", "url", "notes"] as const;

interface Props {
  visible: boolean;
  editing: WardrobeItem | null;
  ownerPersonId: string;
  categories: string[];
  defaultCategory?: string;
  defaultStatus?: string;
  onClose: () => void;
  onSaved: (msg: string) => void;
}

export function ItemFormModal({ visible, editing, ownerPersonId, categories, defaultCategory, defaultStatus, onClose, onSaved }: Props) {
  const [f, setF] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const e = editing;
    const next: Record<string, string> = {
      category: e?.category ?? defaultCategory ?? categories[0] ?? "Tops",
      status: e?.status ?? defaultStatus ?? "KEEP",
      season: e?.season ?? "ALL",
      formality: e?.formality ?? "",
      colorHex: e?.colorHex ?? "",
      price: e?.price != null ? String(e.price) : "",
      quantity: String(e?.quantity ?? 1),
    };
    for (const k of TEXT_FIELDS) next[k] = (e?.[k] as string | null | undefined) ?? "";
    setF(next);
    setPhotos(e ? imagesOf(e) : []);
    setSel(0);
  }, [visible, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const busy = saving || uploading;

  async function save() {
    if (!f.name?.trim()) {
      Alert.alert("Give it a name");
      return;
    }
    const hex = f.colorHex?.trim();
    if (hex && !/^#[0-9a-fA-F]{6}$/.test(hex)) {
      Alert.alert("Swatch color", "Use a hex color like #1f2a44, or leave it empty.");
      return;
    }
    setSaving(true);
    try {
      const str = (k: string) => (f[k]?.trim() ? f[k].trim() : null);
      const price = f.price?.trim() ? Number(f.price) : null;
      const quantity = Math.floor(Number(f.quantity));
      const r = await callOp("save_wardrobe_item", {
        personId: ownerPersonId,
        ...(editing ? { itemId: editing.id } : {}),
        category: f.category || categories[0] || "Tops",
        name: f.name.trim(),
        brand: str("brand"),
        color: str("color"),
        colorHex: hex || null,
        size: str("size"),
        fabric: str("fabric"),
        fit: str("fit"),
        styleCode: str("styleCode"),
        url: str("url"),
        notes: str("notes"),
        price: price != null && !Number.isNaN(price) ? price : null,
        quantity: quantity >= 1 ? quantity : 1,
        status: (f.status || "KEEP") as (typeof WARDROBE_STATUSES)[number],
        season: (f.season || "ALL") as (typeof SEASONS)[number],
        formality: (f.formality || null) as (typeof FORMALITIES)[number] | null,
        imageKeys: photos,
      });
      if ("error" in r) throw new Error(r.error);
      onSaved(editing ? "Saved" : "Added");
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  function remove() {
    if (!editing) return;
    Alert.alert(`Delete "${editing.name}"?`, "Looks that use it keep the others.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setSaving(true);
          try {
            const { errors } = await getClient().models.homeWardrobeItem.delete({ id: editing.id });
            if (errors?.length) throw new Error(errors[0].message);
            onSaved("Deleted");
            onClose();
          } catch (err: any) {
            Alert.alert("Delete failed", err?.message ?? String(err));
          } finally {
            setSaving(false);
          }
        },
      },
    ]);
  }

  const current = photos[Math.min(sel, photos.length - 1)];
  const cats = categories.includes(f.category) || !f.category ? categories : [...categories, f.category];
  const url = f.url?.trim() ?? "";

  const chips = (key: string, values: readonly string[], label: (v: string) => string, allowNone = false) => (
    <View style={s.chipRow}>
      {values.map((v) => {
        const on = f[key] === v;
        return (
          <Pressable key={v} onPress={() => set(key)(on && allowNone ? "" : v)} style={[s.chip, on && s.chipOn]} disabled={busy}>
            <Text style={[s.chipText, on && s.chipTextOn]}>{label(v)}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={s.header}>
          <Pressable onPress={onClose} disabled={saving}>
            <Text style={s.cancel}>Cancel</Text>
          </Pressable>
          <Text style={s.headerTitle}>{editing ? "Edit item" : "Add item"}</Text>
          <Pressable onPress={save} disabled={busy}>
            {saving ? <ActivityIndicator /> : <Text style={[s.save, (busy || !f.name?.trim()) && s.disabled]}>Save</Text>}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <View style={local.mainPhoto}>
            {current ? (
              <Image source={{ uri: resizedImageUrl(current, 900) }} style={StyleSheet.absoluteFill} contentFit="contain" />
            ) : (
              <Text style={local.noPhoto}>No photo yet</Text>
            )}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={local.thumbRow}>
            {photos.map((k, n) => (
              <Pressable key={k} onPress={() => setSel(n)} style={[local.thumb, n === sel && local.thumbOn]}>
                <Image source={{ uri: resizedImageUrl(k, 160) }} style={StyleSheet.absoluteFill} contentFit="cover" />
                {n === 0 && (
                  <View style={local.mainBadge}>
                    <Text style={local.mainBadgeText}>Main</Text>
                  </View>
                )}
              </Pressable>
            ))}
            <Pressable
              onPress={() => choosePhotoSource((keys) => { setSel(photos.length); setPhotos((p) => [...p, ...keys]); }, setUploading)}
              style={[local.thumb, local.addThumb]}
              disabled={busy}
            >
              {uploading ? <ActivityIndicator /> : <Ionicons name="camera-outline" size={22} color={ACCENT} />}
            </Pressable>
          </ScrollView>
          {!!current && (
            <View style={local.photoActions}>
              {sel > 0 && (
                <Pressable onPress={() => { setPhotos((p) => makeMain(p, sel)); setSel(0); }} hitSlop={8}>
                  <Text style={local.photoAction}>Make main</Text>
                </Pressable>
              )}
              <Pressable onPress={() => { setPhotos((p) => p.filter((_, n) => n !== sel)); setSel((x) => Math.max(0, x - 1)); }} hitSlop={8}>
                <Text style={[local.photoAction, { color: "#c44" }]}>Remove photo</Text>
              </Pressable>
            </View>
          )}

          <Text style={s.label}>Name</Text>
          <TextInput style={s.input} value={f.name ?? ""} onChangeText={set("name")} placeholder="Cotton piqué polo" placeholderTextColor="#888" editable={!saving} />

          <Text style={s.label}>Category</Text>
          {chips("category", cats, (v) => v)}

          <Text style={s.label}>Status</Text>
          {chips("status", WARDROBE_STATUSES, (v) => WARDROBE_STATUS_LABELS[v as keyof typeof WARDROBE_STATUS_LABELS])}

          <Text style={s.label}>Brand</Text>
          <TextInput style={s.input} value={f.brand ?? ""} onChangeText={set("brand")} placeholderTextColor="#888" editable={!saving} />

          <Text style={s.label}>Color</Text>
          <TextInput style={s.input} value={f.color ?? ""} onChangeText={set("color")} placeholder="Navy, sage suede…" placeholderTextColor="#888" editable={!saving} />

          <Text style={s.label}>Swatch</Text>
          <View style={local.swatchRow}>
            <View style={[local.swatch, { backgroundColor: /^#[0-9a-fA-F]{6}$/.test(f.colorHex ?? "") ? f.colorHex : "#eee" }]} />
            <TextInput
              style={[s.input, { flex: 1 }]}
              value={f.colorHex ?? ""}
              onChangeText={set("colorHex")}
              placeholder="#1f2a44"
              placeholderTextColor="#888"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!saving}
            />
          </View>

          <View style={local.twoCol}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Size</Text>
              <TextInput style={s.input} value={f.size ?? ""} onChangeText={set("size")} editable={!saving} />
            </View>
            <View style={{ width: 110 }}>
              <Text style={s.label}>Copies owned</Text>
              <TextInput style={s.input} value={f.quantity ?? "1"} onChangeText={set("quantity")} keyboardType="number-pad" editable={!saving} />
            </View>
          </View>

          <Text style={s.label}>Fabric</Text>
          <TextInput style={s.input} value={f.fabric ?? ""} onChangeText={set("fabric")} editable={!saving} />

          <Text style={s.label}>Fit</Text>
          <TextInput style={s.input} value={f.fit ?? ""} onChangeText={set("fit")} placeholder="Slim, regular…" placeholderTextColor="#888" editable={!saving} />

          <Text style={s.label}>Season</Text>
          {chips("season", SEASONS, (v) => SEASON_LABELS[v as keyof typeof SEASON_LABELS])}

          <Text style={s.label}>Formality</Text>
          {chips("formality", FORMALITIES, (v) => FORMALITY_LABELS[v as keyof typeof FORMALITY_LABELS], true)}

          <Text style={s.label}>{f.status === "WISHLIST" ? "Price (expected)" : "Price paid"}</Text>
          <TextInput style={s.input} value={f.price ?? ""} onChangeText={set("price")} keyboardType="decimal-pad" placeholder="$" placeholderTextColor="#888" editable={!saving} />

          <Text style={s.label}>Style code</Text>
          <TextInput style={s.input} value={f.styleCode ?? ""} onChangeText={set("styleCode")} autoCapitalize="characters" editable={!saving} />

          <Text style={s.label}>Link</Text>
          <View style={local.swatchRow}>
            <TextInput
              style={[s.input, { flex: 1 }]}
              value={f.url ?? ""}
              onChangeText={set("url")}
              placeholder="https://…"
              placeholderTextColor="#888"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!saving}
            />
            {/^https?:\/\/\S+$/i.test(url) && (
              <Pressable onPress={() => Linking.openURL(url)} hitSlop={8} style={{ padding: 6 }}>
                <Ionicons name="open-outline" size={20} color={ACCENT} />
              </Pressable>
            )}
          </View>

          <Text style={s.label}>Notes</Text>
          <TextInput style={[s.input, s.multiline]} value={f.notes ?? ""} onChangeText={set("notes")} multiline editable={!saving} />

          {editing && (
            <Pressable onPress={remove} style={s.deleteBtn} disabled={busy}>
              <Text style={s.deleteText}>Delete item</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = formStyles;

const local = StyleSheet.create({
  mainPhoto: {
    aspectRatio: 4 / 3,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#fff",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    alignItems: "center",
    justifyContent: "center",
  },
  noPhoto: { fontSize: 11, color: "#999", textTransform: "uppercase", letterSpacing: 1 },
  thumbRow: { gap: 8, paddingVertical: 8 },
  thumb: { width: 60, height: 60, borderRadius: 8, overflow: "hidden", borderWidth: 2, borderColor: "transparent", backgroundColor: "#fff" },
  thumbOn: { borderColor: ACCENT },
  addThumb: { alignItems: "center", justifyContent: "center", borderStyle: "dashed", borderColor: "#ccc", borderWidth: 1 },
  mainBadge: { position: "absolute", left: 2, top: 2, backgroundColor: ACCENT, borderRadius: 4, paddingHorizontal: 4 },
  mainBadgeText: { color: "#fff", fontSize: 9, fontWeight: "600" },
  photoActions: { flexDirection: "row", gap: 18 },
  photoAction: { color: ACCENT, fontSize: 13, fontWeight: "500" },
  swatchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  swatch: { width: 36, height: 36, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: "#bbb" },
  twoCol: { flexDirection: "row", gap: 10 },
});
