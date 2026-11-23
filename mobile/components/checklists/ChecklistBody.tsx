// One checklist's items, editable, and its action menu. Shared by the
// Checklists screen (cards that open in place) and the checklist detail
// screen, so the two never drift.
//
//   • Items grouped by section. A list with sections is a board like the
//     web's: one card per section, swiped sideways. Items without one show
//     as General; the header is hidden when that's the only group.
//   • Tap the box to tick, the text to rename, the trash to delete; a
//     composer under each section adds to it. Section editing (add,
//     rename, reorder) is web-only.
//   • openChecklistMenu: rename, add to every trip (templates), edit its
//     template (a list made from one), archive, delete. Same actions as the
//     web's "⋯" menu.

import { useMemo, useState } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { getClient } from "../../lib/amplify";
import {
  AUTO_ATTACH_HINT,
  AUTO_ATTACH_LABEL,
  UNGROUPED,
  archivePatch,
  buildSectionGroups,
  progress,
  type Checklist,
  type ChecklistItem,
  type SectionGroup,
} from "../../lib/checklist";

const ACCENT = "#735f55";

// ── Menu ─────────────────────────────────────────────────────────────

export type ChecklistMenuHandlers = {
  /** The list changed (renamed, archived, auto-add flipped): patch or reload it. */
  onChanged: (patch: Partial<Checklist>) => void;
  onDeleted: () => void;
  /** "Edit its template": open that template. */
  onOpenTemplate?: (templateId: string) => void;
};

async function update(checklist: Checklist, patch: Partial<Checklist>, h: ChecklistMenuHandlers, failTitle: string) {
  h.onChanged(patch);
  const { errors } = await getClient().models.homeChecklist.update({ id: checklist.id, ...(patch as any) }); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (errors?.length) {
    Alert.alert(failTitle, errors[0].message);
    h.onChanged({ ...(Object.fromEntries(Object.keys(patch).map((k) => [k, (checklist as any)[k]])) as Partial<Checklist>) }); // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

function renameChecklist(checklist: Checklist, h: ChecklistMenuHandlers) {
  const save = (v?: string) => {
    const name = (v ?? "").trim();
    if (name && name !== checklist.name) void update(checklist, { name }, h, "Rename failed");
  };
  if (Platform.OS === "ios") Alert.prompt("Rename checklist", undefined, save, "plain-text", checklist.name);
  else Alert.alert("Rename", "Renaming is on iOS and the web.");
}

function deleteChecklist(checklist: Checklist, itemCount: number, h: ChecklistMenuHandlers) {
  Alert.alert(`Delete "${checklist.name}"?`, itemCount ? `This removes it and its ${itemCount} items.` : undefined, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: async () => {
        const client = getClient();
        // No cascade on hasMany: items first (best effort), then the list.
        const { data: items } = await client.models.homeChecklistItem.list({ filter: { checklistId: { eq: checklist.id } }, limit: 1000 });
        await Promise.all((items ?? []).map((i) => client.models.homeChecklistItem.delete({ id: i.id }).catch(() => null)));
        const { errors } = await client.models.homeChecklist.delete({ id: checklist.id });
        if (errors?.length) Alert.alert("Delete failed", errors[0].message);
        else h.onDeleted();
      },
    },
  ]);
}

export function openChecklistMenu(checklist: Checklist, itemCount: number, h: ChecklistMenuHandlers) {
  const isTemplate = checklist.entityType === "TEMPLATE";
  const actions: { label: string; run: () => void; destructive?: boolean }[] = [{ label: "Rename", run: () => renameChecklist(checklist, h) }];
  if (isTemplate)
    actions.push({
      label: checklist.autoAttachTrips ? "Stop adding to every trip" : "Add to every trip",
      run: () =>
        void update(checklist, { autoAttachTrips: !checklist.autoAttachTrips }, h, "Couldn't change it").then(() => {
          if (!checklist.autoAttachTrips) Alert.alert(AUTO_ATTACH_LABEL, AUTO_ATTACH_HINT);
        }),
    });
  if (!isTemplate && checklist.sourceTemplateId && h.onOpenTemplate) {
    const tid = checklist.sourceTemplateId;
    actions.push({ label: "Edit its template", run: () => h.onOpenTemplate!(tid) });
  }
  const archived = checklist.isArchived === true;
  actions.push({ label: archived ? "Unarchive" : "Archive", run: () => void update(checklist, archivePatch(!archived), h, archived ? "Unarchive failed" : "Archive failed") });
  actions.push({ label: "Delete", run: () => deleteChecklist(checklist, itemCount, h), destructive: true });
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: checklist.name, options: [...actions.map((a) => a.label), "Cancel"], cancelButtonIndex: actions.length, destructiveButtonIndex: actions.findIndex((a) => a.destructive) },
      (i) => actions[i]?.run(),
    );
  } else {
    Alert.alert(checklist.name, undefined, [...actions.map((a) => ({ text: a.label, onPress: a.run, style: a.destructive ? ("destructive" as const) : undefined })), { text: "Cancel", style: "cancel" as const }]);
  }
}

// ── Body ─────────────────────────────────────────────────────────────

export function ChecklistBody({
  checklistId,
  items,
  setItems,
  reload,
  inset = 16,
}: {
  checklistId: string;
  items: ChecklistItem[];
  setItems: (update: (prev: ChecklistItem[]) => ChecklistItem[]) => void;
  /** Re-read the items (after an add, or a failed write). */
  reload: () => Promise<void> | void;
  /** Horizontal padding of the container, so the board can scroll edge to edge. */
  inset?: number;
}) {
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const groups: SectionGroup[] = useMemo(() => buildSectionGroups(items), [items]);
  const { width } = useWindowDimensions();
  const board = groups.length > 1 && groups.some((g) => g.sectionId !== UNGROUPED);
  const columnWidth = Math.min(340, width - inset * 2 - 40);
  const hideHeader = groups.length <= 1 && (groups[0]?.sectionId ?? UNGROUPED) === UNGROUPED;

  async function toggleItem(item: ChecklistItem) {
    const next = !item.isDone;
    const doneAt = next ? new Date().toISOString() : null;
    setItems((prev) => prev.map((p) => (p.id === item.id ? { ...p, isDone: next, doneAt } : p)));
    const { errors } = await getClient().models.homeChecklistItem.update({ id: item.id, isDone: next, doneAt });
    if (errors?.length) {
      Alert.alert("Update failed", errors[0].message);
      await reload();
    }
  }

  async function commitRename() {
    const id = editingItemId;
    const text = itemDraft.trim();
    setEditingItemId(null);
    const before = items.find((p) => p.id === id);
    if (!id || !text || !before || before.text === text) return;
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, text } : p)));
    const { errors } = await getClient().models.homeChecklistItem.update({ id, text });
    if (errors?.length) {
      Alert.alert("Rename failed", errors[0].message);
      await reload();
    }
  }

  function deleteItem(item: ChecklistItem) {
    Alert.alert(`Delete "${item.text}"?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setItems((prev) => prev.filter((p) => p.id !== item.id));
          const { errors } = await getClient().models.homeChecklistItem.delete({ id: item.id });
          if (errors?.length) {
            Alert.alert("Delete failed", errors[0].message);
            await reload();
          }
        },
      },
    ]);
  }

  async function addItem(group: SectionGroup) {
    const text = (drafts[group.sectionId] ?? "").trim();
    if (!text) return;
    const section = group.sectionId === UNGROUPED ? null : group.sectionName;
    const sortOrder = group.items.length ? Math.max(...group.items.map((i) => i.sortOrder ?? 0)) + 1 : items.length;
    setDrafts((prev) => ({ ...prev, [group.sectionId]: "" }));
    const { errors } = await getClient().models.homeChecklistItem.create({ checklistId, text, section, isDone: false, sortOrder });
    if (errors?.length) {
      Alert.alert("Add failed", errors[0].message);
      setDrafts((prev) => ({ ...prev, [group.sectionId]: text }));
      return;
    }
    await reload();
  }

  const shown: SectionGroup[] = groups.length ? groups : [{ sectionId: UNGROUPED, sectionName: "General", items: [], sortOrder: -1 }];

  return (
    <ScrollView
      horizontal={board}
      scrollEnabled={board}
      showsHorizontalScrollIndicator={false}
      snapToInterval={board ? columnWidth + 12 : undefined}
      decelerationRate={board ? "fast" : undefined}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={board ? { gap: 12, alignItems: "flex-start", paddingHorizontal: inset } : undefined}
      style={board ? { marginHorizontal: -inset } : undefined}
    >
      {shown.map((group) => {
        const p = progress(group.items);
        return (
          <View key={group.sectionId} style={[s.sectionCard, board && { width: columnWidth }]}>
            {!hideHeader && (
              <View style={s.sectionHeaderRow}>
                <Text style={s.sectionHeader}>{group.sectionId === UNGROUPED ? "General" : group.sectionName}</Text>
                <Text style={s.sectionCount}>
                  {p.done}/{p.total}
                </Text>
              </View>
            )}
            {group.items.map((item) => (
              <View key={item.id} style={s.itemRow}>
                <Pressable onPress={() => void toggleItem(item)} hitSlop={8} style={s.checkbox}>
                  <Ionicons name={item.isDone ? "checkbox" : "square-outline"} size={22} color={item.isDone ? ACCENT : "#bbb"} />
                </Pressable>
                {editingItemId === item.id ? (
                  <TextInput
                    style={[s.itemText, s.itemInput]}
                    value={itemDraft}
                    onChangeText={setItemDraft}
                    onBlur={commitRename}
                    onSubmitEditing={commitRename}
                    returnKeyType="done"
                    autoFocus
                    selectTextOnFocus
                  />
                ) : (
                  <Pressable
                    onPress={() => {
                      setEditingItemId(item.id);
                      setItemDraft(item.text);
                    }}
                    style={s.itemTextPress}
                    hitSlop={4}
                  >
                    <Text style={[s.itemText, item.isDone && s.itemTextDone]} numberOfLines={3}>
                      {item.text}
                    </Text>
                  </Pressable>
                )}
                <Pressable onPress={() => deleteItem(item)} hitSlop={8} style={s.itemDeleteBtn}>
                  <Ionicons name="trash-outline" size={17} color="#c99c9c" />
                </Pressable>
              </View>
            ))}
            <View style={s.composerRow}>
              <Ionicons name="add" size={18} color="#bbb" />
              <TextInput
                style={s.composerInput}
                value={drafts[group.sectionId] ?? ""}
                onChangeText={(v) => setDrafts((prev) => ({ ...prev, [group.sectionId]: v }))}
                onSubmitEditing={() => void addItem(group)}
                placeholder={group.sectionId === UNGROUPED ? "Add item" : `Add to ${group.sectionName}`}
                placeholderTextColor="#bbb"
                returnKeyType="done"
                blurOnSubmit={false}
              />
              {(drafts[group.sectionId] ?? "").trim() ? (
                <Pressable onPress={() => void addItem(group)} hitSlop={6} style={s.composerAddBtn}>
                  <Text style={s.composerAddText}>Add</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  sectionCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 4,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  sectionHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: 14 },
  sectionHeader: { fontSize: 12, color: "#888", fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
  sectionCount: { fontSize: 12, color: "#aaa", paddingTop: 4 },
  itemRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#f0eeec", gap: 10 },
  checkbox: { width: 24, alignItems: "center" },
  itemTextPress: { flex: 1 },
  itemText: { fontSize: 15, color: "#3d3a37" },
  itemInput: { paddingVertical: 0, paddingHorizontal: 0, flex: 1 },
  itemTextDone: { color: "#aaa", textDecorationLine: "line-through" },
  itemDeleteBtn: { padding: 4 },
  composerRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#f0eeec", gap: 8 },
  composerInput: { flex: 1, fontSize: 15, color: "#3d3a37", paddingVertical: 0 },
  composerAddBtn: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: ACCENT, borderRadius: 14 },
  composerAddText: { color: "#fff", fontSize: 13, fontWeight: "500" },
});
