// Build or edit a look — the native twin of the web LookModal: title,
// occasion, palette, note and the pieces, picked from the person's closet
// (wishlist allowed, retired hidden). Opened from a trip, the picker starts
// on what's packed for it, with a toggle to the whole closet.
//
// Try-on images aren't generated here (web only). A saved image is kept
// while the look still has exactly the pieces it was rendered from and
// dropped otherwise, the same rule as the web.

import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";

import { getClient } from "../../lib/amplify";
import { resizedImageUrl } from "../../lib/image";
import { formStyles } from "../person-form-styles";
import { sameIdSet } from "../../../lib/wardrobe";
import { ACCENT, ItemThumb, Swatch, type WardrobeItem, type WardrobeLook } from "./shared";

export interface LookDraft {
  title: string;
  previewImageKey?: string | null;
  tryOnJobId?: string | null;
  stylingInstructions?: string | null;
  generationBrief?: string | null;
  palette?: string | null;
  occasion?: string | null;
  note?: string | null;
  itemIds: string[];
  source?: "MANUAL" | "SUGGESTED" | "IMPORTED";
}

interface Props {
  visible: boolean;
  editing: WardrobeLook | null;
  draft?: LookDraft | null;
  ownerPersonId: string;
  items: WardrobeItem[];
  categories: string[];
  nextSortOrder: number;
  scope?: { label: string; itemIds: string[] } | null;
  onClose: () => void;
  /** The saved look (undefined when it was deleted). */
  onSaved: (saved?: WardrobeLook) => void;
}

const ids = (v: (string | null)[] | null | undefined) => (v ?? []).filter((x): x is string => !!x);

export function LookFormModal({ visible, editing, draft, ownerPersonId, items, categories, nextSortOrder, scope, onClose, onSaved }: Props) {
  const [f, setF] = useState({ title: "", occasion: "", palette: "", note: "" });
  const [picked, setPicked] = useState<string[]>([]);
  const [cat, setCat] = useState("");
  const [scoped, setScoped] = useState(true);
  const [saving, setSaving] = useState(false);

  const src = editing ?? draft ?? null;

  useEffect(() => {
    if (!visible) return;
    setF({ title: src?.title ?? "", occasion: src?.occasion ?? "", palette: src?.palette ?? "", note: src?.note ?? "" });
    setPicked(ids(src?.itemIds as (string | null)[] | null | undefined));
    const start = scope ? items.filter((i) => scope.itemIds.includes(i.id)) : items;
    setCat(categories.find((c) => start.some((i) => i.category === c)) ?? categories[0] ?? "");
    setScoped(true);
  }, [visible, editing, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const scopeItems = scope ? items.filter((i) => scope.itemIds.includes(i.id)) : items;
  const pool = scope && scoped ? scopeItems : items;
  const shownCategories = scope && scoped ? categories.filter((c) => pool.some((i) => i.category === c)) : categories;
  const choices = pool.filter((i) => i.status !== "RETIRE" && (!cat || i.category === cat));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const previewKey = src?.previewImageKey ?? null;
  const previewIds = ids(src?.itemIds as (string | null)[] | null | undefined);
  const keepPreview = !!previewKey && sameIdSet(previewIds, picked);

  async function save() {
    if (!f.title.trim() || picked.length < 2) {
      Alert.alert("Add a title and at least two pieces");
      return;
    }
    setSaving(true);
    try {
      const client = getClient();
      const body = {
        ownerPersonId,
        title: f.title.trim(),
        palette: f.palette.trim() || null,
        occasion: f.occasion.trim() || null,
        note: f.note.trim() || null,
        itemIds: picked,
        // Never save an image of a different set of pieces.
        previewImageKey: keepPreview ? previewKey : null,
        tryOnJobId: keepPreview ? (src?.tryOnJobId ?? null) : null,
        stylingInstructions: src?.stylingInstructions ?? null,
        generationBrief: src?.generationBrief ?? null,
      };
      const r = editing
        ? await client.models.homeWardrobeLook.update({ id: editing.id, ...body })
        : await client.models.homeWardrobeLook.create({ ...body, source: draft?.source ?? "MANUAL", sortOrder: nextSortOrder });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      onSaved(r.data ?? undefined);
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  function remove() {
    if (!editing) return;
    Alert.alert(`Delete the look "${editing.title}"?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const { errors } = await getClient().models.homeWardrobeLook.delete({ id: editing.id });
          if (errors?.length) {
            Alert.alert("Delete failed", errors[0].message);
            return;
          }
          onSaved();
          onClose();
        },
      },
    ]);
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={s.header}>
          <Pressable onPress={onClose} disabled={saving}>
            <Text style={s.cancel}>Cancel</Text>
          </Pressable>
          <Text style={s.headerTitle}>{editing ? "Edit look" : "New look"}</Text>
          <Pressable onPress={save} disabled={saving}>
            {saving ? <ActivityIndicator /> : <Text style={[s.save, (!f.title.trim() || picked.length < 2) && s.disabled]}>Save</Text>}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {!!previewKey && (
            <View>
              <Image
                source={{ uri: resizedImageUrl(previewKey, 640) }}
                style={[local.preview, !keepPreview && { opacity: 0.35 }]}
                contentFit="contain"
              />
              <Text style={[s.hint, !keepPreview && { color: "#9a6a12" }]}>
                {keepPreview ? "AI-generated try-on · fit and details may vary" : "Pieces changed — this try-on is dropped on save."}
              </Text>
            </View>
          )}

          <Text style={s.label}>Title</Text>
          <TextInput style={s.input} value={f.title} onChangeText={set("title")} placeholderTextColor="#888" editable={!saving} />
          <Text style={s.label}>Occasion</Text>
          <TextInput style={s.input} value={f.occasion} onChangeText={set("occasion")} placeholder="Office, weekend, golf…" placeholderTextColor="#888" editable={!saving} />
          <Text style={s.label}>Palette</Text>
          <TextInput style={s.input} value={f.palette} onChangeText={set("palette")} placeholder="Navy + grey" placeholderTextColor="#888" editable={!saving} />
          <Text style={s.label}>Why it works</Text>
          <TextInput style={[s.input, s.multiline]} value={f.note} onChangeText={set("note")} multiline editable={!saving} />

          <Text style={s.label}>Pieces ({picked.length}) · tap to remove</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={local.pickedRow}>
            {picked.map((id) => {
              const it = byId.get(id);
              if (!it) return null;
              return (
                <Pressable key={id} onPress={() => toggle(id)} style={local.pickedItem}>
                  <ItemThumb item={it} width={160} style={local.pickedImg} />
                  <Text style={local.pieceName} numberOfLines={2}>
                    {it.name}
                  </Text>
                </Pressable>
              );
            })}
            {!picked.length && <Text style={s.hint}>Pick pieces below.</Text>}
          </ScrollView>

          {scope && (
            <View style={s.chipRow}>
              {([
                [true, scope.label],
                [false, "Whole closet"],
              ] as const).map(([v, label]) => (
                <Pressable
                  key={String(v)}
                  onPress={() => {
                    setScoped(v);
                    if (v && !scopeItems.some((i) => i.category === cat)) {
                      const first = categories.find((c) => scopeItems.some((i) => i.category === c));
                      if (first) setCat(first);
                    }
                  }}
                  style={[local.scopeChip, scoped === v && local.scopeChipOn]}
                >
                  <Text style={[local.scopeText, scoped === v && { color: ACCENT }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
            {shownCategories.map((c) => (
              <Pressable key={c} onPress={() => setCat(c)} style={[s.chip, cat === c && s.chipOn]}>
                <Text style={[s.chipText, cat === c && s.chipTextOn]}>{c}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={local.grid}>
            {choices.map((it) => {
              const on = picked.includes(it.id);
              return (
                <Pressable key={it.id} onPress={() => toggle(it.id)} style={[local.choice, on && local.choiceOn]}>
                  <ItemThumb item={it} width={200} style={local.choiceImg} />
                  <View style={local.choiceName}>
                    <Swatch hex={it.colorHex} size={9} />
                    <Text style={local.pieceName} numberOfLines={2}>
                      {it.name}
                    </Text>
                  </View>
                  {it.status === "WISHLIST" && <Text style={local.wish}>Wishlist</Text>}
                </Pressable>
              );
            })}
            {!choices.length && <Text style={s.hint}>Nothing in this category.</Text>}
          </View>

          {editing && (
            <Pressable onPress={remove} style={s.deleteBtn} disabled={saving}>
              <Text style={s.deleteText}>Delete look</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = formStyles;

const local = StyleSheet.create({
  preview: { width: "100%", height: 320, borderRadius: 10, backgroundColor: "#fafafa" },
  pickedRow: { gap: 8, paddingVertical: 4, minHeight: 72 },
  pickedItem: { width: 64 },
  pickedImg: { width: 64, height: 80, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ddd" },
  pieceName: { fontSize: 11, color: "#333", lineHeight: 14, marginTop: 3, flexShrink: 1 },
  scopeChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: "#ddd" },
  scopeChipOn: { borderColor: ACCENT },
  scopeText: { fontSize: 12, color: "#777" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { width: "31%", borderRadius: 8, borderWidth: 2, borderColor: "transparent", padding: 2 },
  choiceOn: { borderColor: ACCENT },
  choiceImg: { aspectRatio: 3 / 4, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ddd" },
  choiceName: { flexDirection: "row", alignItems: "flex-start", gap: 4, marginTop: 3 },
  wish: { fontSize: 10, color: "#2f5597" },
});
