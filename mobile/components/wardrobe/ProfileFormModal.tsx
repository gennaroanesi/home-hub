// Per-person closet settings — the native twin of the web ProfileModal:
// category list (order, presets, custom), the style brief the suggester and
// trip planner follow, and the try-on fit preferences + reference photos
// (up to 3; the first is the default).

import { useEffect, useState } from "react";
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
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { getClient } from "../../lib/amplify";
import { resizedImageUrl } from "../../lib/image";
import { formStyles } from "../person-form-styles";
import { CATEGORY_PRESETS } from "../../../lib/wardrobe";
import { ACCENT, choosePhotoSource, type WardrobeProfile } from "./shared";

interface Props {
  visible: boolean;
  personId: string;
  personName: string;
  profile: WardrobeProfile | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}

export function ProfileFormModal({ visible, personId, personName, profile, categories, onClose, onSaved }: Props) {
  const [cats, setCats] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [fitNotes, setFitNotes] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setCats(categories);
    setNotes(profile?.styleNotes ?? "");
    setFitNotes(profile?.fitNotes ?? "");
    setPhotos((profile?.referenceImageKeys ?? []).filter((k): k is string => !!k));
    setCustom("");
  }, [visible, profile, categories]);

  const add = (c: string) => {
    const v = c.trim();
    if (v && !cats.some((x) => x.toLowerCase() === v.toLowerCase())) setCats((p) => [...p, v]);
  };
  const move = (i: number, d: number) =>
    setCats((p) => {
      const j = i + d;
      if (j < 0 || j >= p.length) return p;
      const n = p.slice();
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  async function save() {
    setSaving(true);
    try {
      const client = getClient();
      const body = {
        personId,
        categories: cats,
        styleNotes: notes.trim() || null,
        referenceImageKeys: photos,
        fitNotes: fitNotes.trim() || null,
      };
      const r = profile
        ? await client.models.homeWardrobeProfile.update({ id: profile.id, ...body })
        : await client.models.homeWardrobeProfile.create(body);
      if (r.errors?.length) throw new Error(r.errors[0].message);
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || uploading;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={s.header}>
          <Pressable onPress={onClose} disabled={saving}>
            <Text style={s.cancel}>Cancel</Text>
          </Pressable>
          <Text style={s.headerTitle}>{personName}&apos;s closet settings</Text>
          <Pressable onPress={save} disabled={busy}>
            {saving ? <ActivityIndicator /> : <Text style={[s.save, busy && s.disabled]}>Save</Text>}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>Style brief</Text>
          <TextInput
            style={[s.input, s.multiline, { minHeight: 110 }]}
            value={notes}
            onChangeText={setNotes}
            multiline
            placeholder="Old-money British leaning. Earth tones, navy, grey, olive. No black on top."
            placeholderTextColor="#888"
            editable={!saving}
          />
          <Text style={s.hint}>
            What the outfit suggester and trip planner follow when picking clothes: palettes you like, rules, things to avoid. How things should fit in
            try-on previews goes in Fit preferences.
          </Text>

          <Text style={s.label}>Categories</Text>
          <View style={local.catList}>
            {cats.map((c, i) => (
              <View key={c} style={local.catRow}>
                <Text style={local.catName}>{c}</Text>
                <Pressable onPress={() => move(i, -1)} hitSlop={6} style={local.catBtn}>
                  <Ionicons name="arrow-up" size={16} color="#777" />
                </Pressable>
                <Pressable onPress={() => move(i, 1)} hitSlop={6} style={local.catBtn}>
                  <Ionicons name="arrow-down" size={16} color="#777" />
                </Pressable>
                <Pressable onPress={() => setCats((p) => p.filter((x) => x !== c))} hitSlop={6} style={local.catBtn}>
                  <Ionicons name="close" size={16} color="#c44" />
                </Pressable>
              </View>
            ))}
          </View>
          <View style={s.chipRow}>
            {CATEGORY_PRESETS.filter((p) => !cats.some((c) => c.toLowerCase() === p.toLowerCase())).map((p) => (
              <Pressable key={p} onPress={() => add(p)} style={s.chip}>
                <Text style={s.chipText}>+ {p}</Text>
              </Pressable>
            ))}
          </View>
          <View style={local.customRow}>
            <TextInput
              style={[s.input, { flex: 1 }]}
              value={custom}
              onChangeText={setCustom}
              placeholder="Custom category"
              placeholderTextColor="#888"
              returnKeyType="done"
              onSubmitEditing={() => {
                add(custom);
                setCustom("");
              }}
            />
            <Pressable
              onPress={() => {
                add(custom);
                setCustom("");
              }}
              style={local.addBtn}
            >
              <Text style={{ color: ACCENT, fontWeight: "600" }}>Add</Text>
            </Pressable>
          </View>
          <Text style={s.hint}>Removing a category doesn&apos;t delete its items; they still show under their old category.</Text>

          <Text style={s.label}>Try-on reference photos</Text>
          <Text style={s.hint}>
            A well-lit full-body photo in a neutral pose; a side or face reference can follow. The first is the default. Photos are sent to OpenAI
            when a new preview is requested (on the web).
          </Text>
          <View style={local.refRow}>
            {photos.map((key, index) => (
              <View key={key} style={local.ref}>
                <Image source={{ uri: resizedImageUrl(key, 240) }} style={local.refImg} contentFit="cover" />
                {index === 0 ? (
                  <Text style={local.refDefault}>Default</Text>
                ) : (
                  <Pressable onPress={() => setPhotos((p) => [key, ...p.filter((k) => k !== key)])} hitSlop={4}>
                    <Text style={local.refAction}>Use as default</Text>
                  </Pressable>
                )}
                <Pressable onPress={() => setPhotos((p) => p.filter((k) => k !== key))} hitSlop={4}>
                  <Text style={[local.refAction, { color: "#c44" }]}>Remove</Text>
                </Pressable>
              </View>
            ))}
            {photos.length < 3 && (
              <Pressable
                onPress={() => choosePhotoSource((keys) => setPhotos((p) => [...p, ...keys].slice(0, 3)), setUploading, 3 - photos.length, true)}
                style={[local.refImg, local.refAdd]}
                disabled={busy}
              >
                {uploading ? <ActivityIndicator /> : <Ionicons name="camera-outline" size={24} color={ACCENT} />}
              </Pressable>
            )}
          </View>

          <Text style={s.label}>Fit preferences</Text>
          <TextInput
            style={[s.input, s.multiline]}
            value={fitNotes}
            onChangeText={setFitNotes}
            multiline
            maxLength={2000}
            placeholder="Relaxed trousers; shirts usually tucked in…"
            placeholderTextColor="#888"
            editable={!saving}
          />
          <Text style={s.hint}>
            Only for try-on previews: how clothes should sit on you in the generated image. The suggester doesn&apos;t read this; put what to pick or
            avoid in the style brief.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = formStyles;

const local = StyleSheet.create({
  catList: { gap: 4 },
  catRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, gap: 6 },
  catName: { flex: 1, fontSize: 15, color: "#222" },
  catBtn: { padding: 4 },
  customRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  addBtn: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#fff", borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ccc" },
  refRow: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 6 },
  ref: { width: 96, gap: 2 },
  refImg: { width: 96, height: 128, borderRadius: 8, backgroundColor: "#eee" },
  refAdd: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderStyle: "dashed", borderColor: "#ccc", backgroundColor: "#fff" },
  refDefault: { fontSize: 12, color: ACCENT, fontWeight: "600" },
  refAction: { fontSize: 12, color: ACCENT },
});
