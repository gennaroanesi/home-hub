// "Add to checklist" from the trip-looks packing list — the native twin of
// the web PackChecklistModal: pick the pieces and one of the trip's
// checklists (or a new one); the add_trip_pack_to_checklist op writes the
// lines (one per piece, ×N copies, by category; lines already there skipped).

import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { getClient } from "../../lib/amplify";
import { callOp } from "../../lib/ops";
import { formStyles } from "../person-form-styles";
import { listAllPages } from "../../../lib/list-all";
import type { Checklist } from "../../../lib/checklist";
import { ACCENT, type WardrobeItem } from "./shared";

const NEW = "__new__";

interface Props {
  visible: boolean;
  tripId: string;
  tripName: string;
  personId: string;
  personName: string;
  groups: [string, WardrobeItem[]][];
  copies: (it: WardrobeItem) => number;
  onClose: () => void;
  onDone: (title: string, detail?: string) => void;
}

export function PackChecklistModal({ visible, tripId, tripName, personId, personName, groups, copies, onClose, onDone }: Props) {
  const [lists, setLists] = useState<Checklist[]>([]);
  const [target, setTarget] = useState(NEW);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setPicked(new Set(groups.flatMap(([, l]) => l.map((i) => i.id))));
    setName(`Packing · ${personName}`);
    (async () => {
      const rows = await listAllPages<Checklist>(getClient().models.homeChecklist, {
        filter: { entityType: { eq: "TRIP" }, entityId: { eq: tripId } },
      }).catch(() => [] as Checklist[]);
      const active = rows.filter((c) => c.isArchived !== true).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      setLists(active);
      // Default to an existing packing list when there is one.
      setTarget(active.find((c) => /pack/i.test(c.name))?.id ?? active[0]?.id ?? NEW);
    })();
  }, [visible, tripId]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = groups.flatMap(([, l]) => l);
  const toggle = (id: string) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function save() {
    setSaving(true);
    const r = await callOp("add_trip_pack_to_checklist", {
      personId,
      tripId,
      itemIds: all.filter((i) => picked.has(i.id)).map((i) => i.id),
      ...(target === NEW ? { checklistName: name.trim() || undefined } : { checklistId: target }),
    });
    setSaving(false);
    if ("error" in r) {
      Alert.alert("Couldn't add to checklist", r.error);
      return;
    }
    const { added, skipped, checklistName } = r.result;
    onDone(`${added.length} added to ${checklistName}`, skipped.length ? `${skipped.length} already on it` : undefined);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.screen}>
        <View style={s.header}>
          <Pressable onPress={onClose} disabled={saving}>
            <Text style={s.cancel}>Cancel</Text>
          </Pressable>
          <Text style={s.headerTitle} numberOfLines={1}>
            Add to a {tripName} checklist
          </Text>
          <Pressable onPress={save} disabled={saving || !picked.size}>
            {saving ? <ActivityIndicator /> : <Text style={[s.save, !picked.size && s.disabled]}>Add {picked.size}</Text>}
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={s.body}>
          <Text style={s.label}>Checklist</Text>
          <View style={s.chipRow}>
            {[...lists.map((c) => ({ id: c.id, name: c.name })), { id: NEW, name: "New checklist…" }].map((c) => (
              <Pressable key={c.id} onPress={() => setTarget(c.id)} style={[s.chip, target === c.id && s.chipOn]}>
                <Text style={[s.chipText, target === c.id && s.chipTextOn]}>{c.name}</Text>
              </Pressable>
            ))}
          </View>
          {target === NEW && (
            <>
              <Text style={s.label}>Name</Text>
              <TextInput style={s.input} value={name} onChangeText={setName} placeholderTextColor="#888" />
            </>
          )}
          <View style={local.countRow}>
            <Text style={s.hint}>
              {picked.size} of {all.length} pieces
            </Text>
            <Pressable onPress={() => setPicked(picked.size === all.length ? new Set() : new Set(all.map((i) => i.id)))}>
              <Text style={{ color: ACCENT, fontSize: 13 }}>{picked.size === all.length ? "Select none" : "Select all"}</Text>
            </Pressable>
          </View>
          {groups.map(([cat, list]) => (
            <View key={cat}>
              <Text style={s.label}>{cat}</Text>
              {list.map((it) => {
                const on = picked.has(it.id);
                return (
                  <Pressable key={it.id} onPress={() => toggle(it.id)} style={local.row}>
                    <Ionicons name={on ? "checkbox" : "square-outline"} size={20} color={on ? ACCENT : "#aaa"} />
                    <Text style={local.rowText}>
                      {it.name}
                      {copies(it) > 1 && <Text style={{ color: "#888" }}> ×{copies(it)}</Text>}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
          <Text style={[s.hint, { marginTop: 12 }]}>Lines already on the checklist are skipped, so you can add again after re-planning.</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = formStyles;

const local = StyleSheet.create({
  countRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  rowText: { fontSize: 15, color: "#222", flexShrink: 1 },
});
