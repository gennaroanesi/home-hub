// Checklist detail — view + edit items.
//
//   • Header: back, editable name (tap to rename), trash → delete the
//     whole checklist.
//   • Body: progress bar, then items grouped by section. The
//     "Ungrouped" header is hidden when it's the only group, so
//     simple lists stay clean. Section editing is web-only — mobile
//     can add items into existing sections via the inline composer
//     under each header.
//   • Tap an item to toggle done. Tap the row text to rename it
//     inline. Swipe / trash icon to delete a single item.
//   • Per-section "+ Add item" composer at the bottom of each group.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import {
  UNGROUPED,
  buildSectionGroups,
  progress,
  type Checklist,
  type ChecklistItem,
  type SectionGroup,
} from "../../../../lib/checklist";

export default function ChecklistDetail() {
  const params = useLocalSearchParams<{ id: string }>();
  const checklistId = String(params.id ?? "");

  const [loading, setLoading] = useState(true);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);

  // Inline rename state for the checklist name itself.
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  // Per-item rename state. itemId -> draft text. Null = not renaming.
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState("");

  // Per-section "add item" composer drafts. Key is the sectionId from
  // buildSectionGroups (UNGROUPED sentinel for items without a section).
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!checklistId) return;
    const client = getClient();
    const [{ data: cl }, { data: its }] = await Promise.all([
      client.models.homeChecklist.get({ id: checklistId }),
      client.models.homeChecklistItem.list({
        filter: { checklistId: { eq: checklistId } },
        limit: 500,
      }),
    ]);
    setChecklist(cl ?? null);
    setItems(its ?? []);
    setLoading(false);
  }, [checklistId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Section grouping ─────────────────────────────────────────────
  const groups: SectionGroup[] = useMemo(
    () => buildSectionGroups(items),
    [items]
  );
  const stats = useMemo(() => progress(items), [items]);

  // Hide the "Ungrouped" header if it's the only group AND there are
  // no other sections — keeps simple lists from showing a useless
  // banner. If even one custom section exists, we keep the header so
  // the ungrouped items don't blur into the next section.
  const hideUngroupedHeader =
    groups.length === 1 && groups[0].sectionId === UNGROUPED;

  // ── Mutations ───────────────────────────────────────────────────

  async function toggleItem(item: ChecklistItem) {
    const next = !item.isDone;
    // Optimistic update.
    setItems((prev) =>
      prev.map((p) =>
        p.id === item.id
          ? { ...p, isDone: next, doneAt: next ? new Date().toISOString() : null }
          : p
      )
    );
    try {
      const client = getClient();
      const { errors } = await client.models.homeChecklistItem.update({
        id: item.id,
        isDone: next,
        doneAt: next ? new Date().toISOString() : null,
      });
      if (errors?.length) throw new Error(errors[0].message);
    } catch (err: any) {
      Alert.alert("Update failed", err?.message ?? String(err));
      await load();
    }
  }

  function startRename(item: ChecklistItem) {
    setEditingItemId(item.id);
    setItemDraft(item.text);
  }

  async function commitRename() {
    if (!editingItemId) return;
    const trimmed = itemDraft.trim();
    const id = editingItemId;
    setEditingItemId(null);
    if (!trimmed) return;
    const before = items.find((p) => p.id === id);
    if (!before || before.text === trimmed) return;
    setItems((prev) =>
      prev.map((p) => (p.id === id ? { ...p, text: trimmed } : p))
    );
    try {
      const client = getClient();
      const { errors } = await client.models.homeChecklistItem.update({
        id,
        text: trimmed,
      });
      if (errors?.length) throw new Error(errors[0].message);
    } catch (err: any) {
      Alert.alert("Rename failed", err?.message ?? String(err));
      await load();
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
          try {
            const client = getClient();
            const { errors } = await client.models.homeChecklistItem.delete({
              id: item.id,
            });
            if (errors?.length) throw new Error(errors[0].message);
          } catch (err: any) {
            Alert.alert("Delete failed", err?.message ?? String(err));
            await load();
          }
        },
      },
    ]);
  }

  async function addItem(group: SectionGroup) {
    const draft = (composerDrafts[group.sectionId] ?? "").trim();
    if (!draft || !checklist) return;
    const section = group.sectionId === UNGROUPED ? null : group.sectionName;
    const nextSort =
      group.items.length === 0
        ? 0
        : Math.max(...group.items.map((i) => i.sortOrder ?? 0)) + 1;
    setComposerDrafts((prev) => ({ ...prev, [group.sectionId]: "" }));
    try {
      const client = getClient();
      const { errors } = await client.models.homeChecklistItem.create({
        checklistId: checklist.id,
        text: draft,
        section,
        isDone: false,
        sortOrder: nextSort,
      });
      if (errors?.length) throw new Error(errors[0].message);
      await load();
    } catch (err: any) {
      Alert.alert("Add failed", err?.message ?? String(err));
      // Restore the draft so the user doesn't lose their text.
      setComposerDrafts((prev) => ({ ...prev, [group.sectionId]: draft }));
    }
  }

  // ── Checklist-level actions ─────────────────────────────────────

  function startNameEdit() {
    if (!checklist) return;
    setNameDraft(checklist.name);
    setNameEditing(true);
  }

  async function commitNameEdit() {
    if (!checklist) return;
    const trimmed = nameDraft.trim();
    setNameEditing(false);
    if (!trimmed || trimmed === checklist.name) return;
    setChecklist({ ...checklist, name: trimmed });
    try {
      const client = getClient();
      const { errors } = await client.models.homeChecklist.update({
        id: checklist.id,
        name: trimmed,
      });
      if (errors?.length) throw new Error(errors[0].message);
    } catch (err: any) {
      Alert.alert("Rename failed", err?.message ?? String(err));
      await load();
    }
  }

  async function toggleArchive() {
    if (!checklist) return;
    const nextArchived = !(checklist.isArchived === true);
    const nowIso = new Date().toISOString();
    setChecklist({
      ...checklist,
      isArchived: nextArchived,
      archivedAt: nextArchived ? nowIso : null,
    });
    try {
      const client = getClient();
      const { errors } = await client.models.homeChecklist.update({
        id: checklist.id,
        isArchived: nextArchived,
        archivedAt: nextArchived ? nowIso : null,
      });
      if (errors?.length) throw new Error(errors[0].message);
      // Archiving is the typical case — bounce back so the list
      // reflects the change immediately. Unarchive stays on the
      // screen so the user can keep working with the checklist.
      if (nextArchived) router.back();
    } catch (err: any) {
      Alert.alert(
        nextArchived ? "Archive failed" : "Unarchive failed",
        err?.message ?? String(err)
      );
      await load();
    }
  }

  function deleteChecklist() {
    if (!checklist) return;
    Alert.alert(
      `Delete "${checklist.name}"?`,
      "This removes the checklist and all its items.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const client = getClient();
              // Delete items in parallel; AppSync has no cascade on
              // hasMany. Errors per item get swallowed — the parent
              // delete still fires so we don't end up with a dangling
              // checklist if one item delete fails.
              await Promise.all(
                items.map((i) =>
                  client.models.homeChecklistItem
                    .delete({ id: i.id })
                    .catch(() => null)
                )
              );
              const { errors } = await client.models.homeChecklist.delete({
                id: checklist.id,
              });
              if (errors?.length) throw new Error(errors[0].message);
              router.back();
            } catch (err: any) {
              Alert.alert("Delete failed", err?.message ?? String(err));
            }
          },
        },
      ]
    );
  }

  // ── Render ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.headerBtn}
          >
            <Ionicons name="chevron-back" size={28} color="#735f55" />
          </Pressable>
        </View>
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      </SafeAreaView>
    );
  }

  if (!checklist) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.headerBtn}
          >
            <Ionicons name="chevron-back" size={28} color="#735f55" />
          </Pressable>
        </View>
        <View style={styles.center}>
          <Text style={styles.empty}>Checklist not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.headerBtn}
        >
          <Ionicons name="chevron-back" size={28} color="#735f55" />
        </Pressable>
        {nameEditing ? (
          <TextInput
            style={styles.headerNameInput}
            value={nameDraft}
            onChangeText={setNameDraft}
            onBlur={commitNameEdit}
            onSubmitEditing={commitNameEdit}
            returnKeyType="done"
            autoFocus
            selectTextOnFocus
          />
        ) : (
          <Pressable onPress={startNameEdit} style={styles.headerNameBtn}>
            <Text style={styles.headerName} numberOfLines={1}>
              {checklist.name}
            </Text>
            <Ionicons name="create-outline" size={16} color="#bbb" />
          </Pressable>
        )}
        <Pressable
          onPress={toggleArchive}
          hitSlop={12}
          style={styles.headerBtn}
        >
          <Ionicons
            name={
              checklist.isArchived
                ? "archive"
                : "archive-outline"
            }
            size={22}
            color="#735f55"
          />
        </Pressable>
        <Pressable
          onPress={deleteChecklist}
          hitSlop={12}
          style={styles.headerBtn}
        >
          <Ionicons name="trash-outline" size={22} color="#b96868" />
        </Pressable>
      </View>

      {checklist.isArchived && (
        <View style={styles.archivedBanner}>
          <Ionicons name="archive" size={14} color="#7a5c50" />
          <Text style={styles.archivedBannerText}>
            Archived
            {checklist.archivedAt
              ? ` · ${new Date(checklist.archivedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
              : ""}
          </Text>
        </View>
      )}

      <View style={styles.progressBar}>
        <View style={styles.progressTrack}>
          <View
            style={[styles.progressFill, { width: `${stats.pct}%` }]}
          />
        </View>
        <Text style={styles.progressLabel}>
          {stats.done}/{stats.total} done
        </Text>
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
        >
          {groups.length === 0 ? (
            <Text style={styles.empty}>
              No items yet. Add one below.
            </Text>
          ) : (
            groups.map((group) => (
              <View key={group.sectionId} style={styles.sectionCard}>
                {!(hideUngroupedHeader && group.sectionId === UNGROUPED) && (
                  <Text style={styles.sectionHeader}>{group.sectionName}</Text>
                )}
                {group.items.map((item) => (
                  <ChecklistRow
                    key={item.id}
                    item={item}
                    isEditing={editingItemId === item.id}
                    draft={editingItemId === item.id ? itemDraft : ""}
                    onToggle={() => toggleItem(item)}
                    onStartRename={() => startRename(item)}
                    onChangeDraft={setItemDraft}
                    onCommitRename={commitRename}
                    onDelete={() => deleteItem(item)}
                  />
                ))}
                <ItemComposer
                  draft={composerDrafts[group.sectionId] ?? ""}
                  onChange={(v) =>
                    setComposerDrafts((prev) => ({
                      ...prev,
                      [group.sectionId]: v,
                    }))
                  }
                  onSubmit={() => addItem(group)}
                  placeholder={
                    group.sectionId === UNGROUPED
                      ? "Add item"
                      : `Add to ${group.sectionName}`
                  }
                />
              </View>
            ))
          )}

          {/* Always-on composer for an empty checklist, since there
              are no section cards yet to host one. */}
          {groups.length === 0 && (
            <View style={styles.sectionCard}>
              <ItemComposer
                draft={composerDrafts[UNGROUPED] ?? ""}
                onChange={(v) =>
                  setComposerDrafts((prev) => ({ ...prev, [UNGROUPED]: v }))
                }
                onSubmit={() =>
                  addItem({
                    sectionId: UNGROUPED,
                    sectionName: "Ungrouped",
                    items: [],
                    sortOrder: -1,
                  })
                }
                placeholder="Add first item"
              />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Row ─────────────────────────────────────────────────────────────

function ChecklistRow({
  item,
  isEditing,
  draft,
  onToggle,
  onStartRename,
  onChangeDraft,
  onCommitRename,
  onDelete,
}: {
  item: ChecklistItem;
  isEditing: boolean;
  draft: string;
  onToggle: () => void;
  onStartRename: () => void;
  onChangeDraft: (v: string) => void;
  onCommitRename: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.itemRow}>
      <Pressable onPress={onToggle} hitSlop={8} style={styles.checkbox}>
        <Ionicons
          name={item.isDone ? "checkbox" : "square-outline"}
          size={22}
          color={item.isDone ? "#735f55" : "#bbb"}
        />
      </Pressable>
      {isEditing ? (
        <TextInput
          style={[styles.itemText, styles.itemInput]}
          value={draft}
          onChangeText={onChangeDraft}
          onBlur={onCommitRename}
          onSubmitEditing={onCommitRename}
          returnKeyType="done"
          autoFocus
          selectTextOnFocus
        />
      ) : (
        <Pressable
          onPress={onStartRename}
          style={styles.itemTextPress}
          hitSlop={4}
        >
          <Text
            style={[styles.itemText, item.isDone && styles.itemTextDone]}
            numberOfLines={3}
          >
            {item.text}
          </Text>
        </Pressable>
      )}
      <Pressable onPress={onDelete} hitSlop={8} style={styles.itemDeleteBtn}>
        <Ionicons name="trash-outline" size={18} color="#c99c9c" />
      </Pressable>
    </View>
  );
}

// ── Composer ────────────────────────────────────────────────────────

function ItemComposer({
  draft,
  placeholder,
  onChange,
  onSubmit,
}: {
  draft: string;
  placeholder: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const enabled = draft.trim().length > 0;
  return (
    <View style={styles.composerRow}>
      <Ionicons name="add" size={18} color="#bbb" />
      <TextInput
        style={styles.composerInput}
        value={draft}
        onChangeText={onChange}
        onSubmitEditing={onSubmit}
        placeholder={placeholder}
        placeholderTextColor="#bbb"
        returnKeyType="done"
        blurOnSubmit={false}
      />
      {enabled && (
        <Pressable onPress={onSubmit} hitSlop={6} style={styles.composerAddBtn}>
          <Text style={styles.composerAddText}>Add</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f5f3" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  headerBtn: { padding: 6 },
  headerNameBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
  },
  headerName: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
    color: "#3d3a37",
  },
  headerNameInput: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
    color: "#3d3a37",
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "#fff",
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },

  archivedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: "#eee2d9",
  },
  archivedBannerText: {
    fontSize: 12,
    color: "#7a5c50",
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  progressBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    backgroundColor: "#e9e5e2",
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: "#735f55" },
  progressLabel: { fontSize: 12, color: "#888", minWidth: 60, textAlign: "right" },

  body: { flex: 1 },
  bodyContent: { padding: 16, paddingBottom: 60 },

  empty: { color: "#888", textAlign: "center", marginTop: 30 },

  sectionCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 6,
    marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  sectionHeader: {
    fontSize: 12,
    color: "#888",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
  },

  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#f0eeec",
    gap: 10,
  },
  checkbox: { width: 24, alignItems: "center" },
  itemTextPress: { flex: 1 },
  itemText: { fontSize: 15, color: "#3d3a37" },
  itemInput: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    flex: 1,
  },
  itemTextDone: { color: "#aaa", textDecorationLine: "line-through" },
  itemDeleteBtn: { padding: 4 },

  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#f0eeec",
    gap: 8,
  },
  composerInput: {
    flex: 1,
    fontSize: 15,
    color: "#3d3a37",
    paddingVertical: 0,
  },
  composerAddBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "#735f55",
    borderRadius: 14,
  },
  composerAddText: { color: "#fff", fontSize: 13, fontWeight: "500" },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
