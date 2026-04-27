// Shopping tab. The schema separates lists ("Supermarket", "Home
// Depot", …) and items inside each list. We render a horizontal list
// picker at the top + the selected list's items underneath, with an
// inline "Add item" row at the bottom — the most common action is
// "throw a thing on the supermarket list", and inline TextInput is
// faster than a modal.
//
// The modal (ShoppingItemModal) handles edit and delete; tap an
// item's body to open it. Tap the checkbox to toggle bought.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AlertButton,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../lib/amplify";
import { ShoppingItemModal } from "../../components/ShoppingItemModal";
import type { Schema } from "../../../amplify/data/resource";

type List = Schema["homeShoppingList"]["type"];
type Item = Schema["homeShoppingItem"]["type"];

export default function Shopping() {
  const [lists, setLists] = useState<List[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newItem, setNewItem] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const loadLists = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homeShoppingList.list();
    const active = (data ?? [])
      .filter((l) => !l.isArchived)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    setLists(active);
    // Preserve selection if still around; otherwise pick the first.
    setSelectedListId((prev) => {
      if (prev && active.some((l) => l.id === prev)) return prev;
      return active[0]?.id ?? null;
    });
  }, []);

  const loadItems = useCallback(async (listId: string | null) => {
    if (!listId) {
      setItems([]);
      return;
    }
    const client = getClient();
    const { data } = await client.models.homeShoppingItem.list({
      filter: { listId: { eq: listId } },
    });
    setItems(data ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await loadLists();
      } finally {
        setLoading(false);
      }
    })();
  }, [loadLists]);

  useEffect(() => {
    void loadItems(selectedListId);
  }, [selectedListId, loadItems]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await loadLists();
      await loadItems(selectedListId);
    } finally {
      setRefreshing(false);
    }
  }

  // Sort: unchecked first (most recently added at top), then checked.
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      if (a.isChecked !== b.isChecked) return a.isChecked ? 1 : -1;
      if (a.isChecked) {
        return (b.checkedAt ?? "").localeCompare(a.checkedAt ?? "");
      }
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });
  }, [items]);

  async function toggleChecked(item: Item) {
    const next = !item.isChecked;
    setItems((prev) =>
      prev.map((i) =>
        i.id === item.id
          ? {
              ...i,
              isChecked: next,
              checkedAt: next ? new Date().toISOString() : null,
            }
          : i
      )
    );
    try {
      const client = getClient();
      const { errors } = await client.models.homeShoppingItem.update({
        id: item.id,
        isChecked: next,
        checkedAt: next ? new Date().toISOString() : null,
      });
      if (errors?.length) throw new Error(errors[0].message);
    } catch (err: any) {
      Alert.alert("Update failed", err?.message ?? String(err));
      void loadItems(selectedListId);
    }
  }

  async function addItem() {
    const trimmed = newItem.trim();
    if (!trimmed || !selectedListId || adding) return;
    setAdding(true);
    try {
      const client = getClient();
      const { errors, data } = await client.models.homeShoppingItem.create({
        listId: selectedListId,
        name: trimmed,
        isChecked: false,
        addedBy: "mobile",
      });
      if (errors?.length) throw new Error(errors[0].message);
      if (data) setItems((prev) => [...prev, data]);
      setNewItem("");
    } catch (err: any) {
      Alert.alert("Add failed", err?.message ?? String(err));
    } finally {
      setAdding(false);
    }
  }

  const selectedList = useMemo(
    () => lists.find((l) => l.id === selectedListId) ?? null,
    [lists, selectedListId]
  );

  function manageList() {
    if (!selectedList) return;
    Alert.alert(
      selectedList.name,
      undefined,
      [
        { text: "Rename", onPress: () => renameList() },
        { text: "Archive", onPress: () => archiveList() },
        { text: "Delete", style: "destructive", onPress: () => deleteList() },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true }
    );
  }

  function renameList() {
    if (!selectedList) return;
    Alert.prompt(
      "Rename list",
      undefined,
      async (name) => {
        const trimmed = name?.trim();
        if (!trimmed || trimmed === selectedList.name) return;
        try {
          const client = getClient();
          const { errors } = await client.models.homeShoppingList.update({
            id: selectedList.id,
            name: trimmed,
          });
          if (errors?.length) throw new Error(errors[0].message);
          setLists((prev) =>
            prev.map((l) => (l.id === selectedList.id ? { ...l, name: trimmed } : l))
          );
        } catch (err: any) {
          Alert.alert("Rename failed", err?.message ?? String(err));
        }
      },
      "plain-text",
      selectedList.name
    );
  }

  async function archiveList() {
    if (!selectedList) return;
    try {
      const client = getClient();
      const { errors } = await client.models.homeShoppingList.update({
        id: selectedList.id,
        isArchived: true,
        archivedAt: new Date().toISOString(),
      });
      if (errors?.length) throw new Error(errors[0].message);
      // Drop the archived list from the picker; pick another if any.
      setLists((prev) => {
        const next = prev.filter((l) => l.id !== selectedList.id);
        setSelectedListId(next[0]?.id ?? null);
        return next;
      });
    } catch (err: any) {
      Alert.alert("Archive failed", err?.message ?? String(err));
    }
  }

  function deleteList() {
    if (!selectedList) return;
    const itemCount = items.length;
    Alert.alert(
      `Delete "${selectedList.name}"?`,
      itemCount > 0
        ? `${itemCount} item${itemCount === 1 ? "" : "s"} will also be deleted.`
        : "This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const client = getClient();
              // Delete items first — schema has no cascade.
              await Promise.all(
                items.map((i) =>
                  client.models.homeShoppingItem.delete({ id: i.id })
                )
              );
              const { errors } = await client.models.homeShoppingList.delete({
                id: selectedList.id,
              });
              if (errors?.length) throw new Error(errors[0].message);
              setLists((prev) => {
                const next = prev.filter((l) => l.id !== selectedList.id);
                setSelectedListId(next[0]?.id ?? null);
                return next;
              });
            } catch (err: any) {
              Alert.alert("Delete failed", err?.message ?? String(err));
              await loadLists();
            }
          },
        },
      ]
    );
  }

  // Alert.prompt is iOS-only; this is an iOS app so we lean on it for
  // the quick-add-list and quick-clear actions.
  function newList() {
    Alert.prompt(
      "New shopping list",
      "Name (e.g. Supermarket)",
      async (name) => {
        const trimmed = name?.trim();
        if (!trimmed) return;
        try {
          const client = getClient();
          const { data, errors } = await client.models.homeShoppingList.create({
            name: trimmed,
            sortOrder: lists.length,
            isArchived: false,
          });
          if (errors?.length) throw new Error(errors[0].message);
          if (data) {
            setLists((prev) => [...prev, data]);
            setSelectedListId(data.id);
          }
        } catch (err: any) {
          Alert.alert("Create failed", err?.message ?? String(err));
        }
      }
    );
  }

  async function clearChecked() {
    const checked = items.filter((i) => i.isChecked);
    if (checked.length === 0) return;
    Alert.alert(
      "Clear checked items?",
      `${checked.length} item${checked.length === 1 ? "" : "s"} will be removed.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            try {
              const client = getClient();
              await Promise.all(
                checked.map((i) => client.models.homeShoppingItem.delete({ id: i.id }))
              );
              setItems((prev) => prev.filter((i) => !i.isChecked));
            } catch (err: any) {
              Alert.alert("Clear failed", err?.message ?? String(err));
              void loadItems(selectedListId);
            }
          },
        },
      ] as AlertButton[]
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.heading}>Shopping</Text>
        <View style={styles.headerActions}>
          {selectedList && (
            <Pressable onPress={manageList} hitSlop={12} style={styles.addBtn}>
              <Ionicons name="ellipsis-horizontal" size={22} color="#735f55" />
            </Pressable>
          )}
          <Pressable onPress={newList} hitSlop={12} style={styles.addBtn}>
            <Ionicons name="add" size={28} color="#735f55" />
          </Pressable>
        </View>
      </View>

      {/* List picker. flexGrow:0 keeps the horizontal ScrollView from
          inheriting `flex:1` from the SafeAreaView and stretching its
          children vertically; alignItems on the inner row keeps pills
          sized to their text rather than the full strip height. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.listsScroll}
        contentContainerStyle={styles.listsRow}
      >
        {lists.length === 0 && !loading && (
          <Text style={styles.muted}>No lists yet — tap + to add one.</Text>
        )}
        {lists.map((l) => {
          const on = l.id === selectedListId;
          return (
            <Pressable
              key={l.id}
              onPress={() => setSelectedListId(l.id)}
              style={[styles.listPill, on && styles.listPillOn]}
            >
              <Text style={[styles.listPillText, on && styles.listPillTextOn]}>
                {l.emoji ? `${l.emoji} ` : ""}
                {l.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={120}
        >
          <FlatList
            data={sortedItems}
            keyExtractor={(i) => i.id}
            contentContainerStyle={styles.itemsBody}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListFooterComponent={
              items.some((i) => i.isChecked) ? (
                <Pressable onPress={clearChecked} style={styles.clearChecked}>
                  <Text style={styles.clearCheckedText}>Clear checked</Text>
                </Pressable>
              ) : null
            }
            ListEmptyComponent={
              selectedListId ? (
                <Text style={styles.empty}>List is empty. Add an item below.</Text>
              ) : null
            }
            renderItem={({ item }) => (
              <ItemRow
                item={item}
                onToggle={() => toggleChecked(item)}
                onEdit={() => {
                  setEditing(item);
                  setModalOpen(true);
                }}
              />
            )}
          />

          {/* Inline add. Disabled until a list is selected. */}
          <View style={styles.addRow}>
            <Ionicons name="add-circle-outline" size={22} color="#888" />
            <TextInput
              style={styles.addInput}
              value={newItem}
              onChangeText={setNewItem}
              placeholder={
                selectedListId ? "Add item…" : "Select a list to add items"
              }
              placeholderTextColor="#888"
              editable={!!selectedListId && !adding}
              returnKeyType="done"
              onSubmitEditing={addItem}
              blurOnSubmit={false}
            />
          </View>
        </KeyboardAvoidingView>
      )}

      <ShoppingItemModal
        visible={modalOpen}
        item={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => loadItems(selectedListId)}
      />
    </SafeAreaView>
  );
}

// ── ItemRow ────────────────────────────────────────────────────────────────

function ItemRow({
  item,
  onToggle,
  onEdit,
}: {
  item: Item;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const detail = [item.quantity, item.notes].filter(Boolean).join(" · ");
  return (
    <View style={styles.row}>
      <Pressable onPress={onToggle} hitSlop={8} style={styles.checkBtn}>
        <Ionicons
          name={item.isChecked ? "checkmark-circle" : "ellipse-outline"}
          size={26}
          color={item.isChecked ? "#4e5e53" : "#bbb"}
        />
      </Pressable>
      <Pressable onPress={onEdit} style={styles.rowBody}>
        <Text style={[styles.rowTitle, item.isChecked && styles.rowTitleDone]}>
          {item.name}
        </Text>
        {!!detail && <Text style={styles.rowMeta}>{detail}</Text>}
      </Pressable>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  heading: { fontSize: 28, fontWeight: "600" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  addBtn: { padding: 4 },

  listsScroll: { flexGrow: 0 },
  listsRow: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
    alignItems: "center",
  },
  listPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
    marginRight: 6,
  },
  listPillOn: { backgroundColor: "#735f55", borderColor: "#735f55" },
  listPillText: { color: "#444", fontSize: 14 },
  listPillTextOn: { color: "#fff", fontWeight: "600" },
  muted: { color: "#888", fontSize: 13, paddingVertical: 4 },

  itemsBody: { paddingHorizontal: 20, paddingBottom: 80 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    marginVertical: 3,
  },
  checkBtn: { paddingRight: 12 },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, color: "#222" },
  rowTitleDone: { textDecorationLine: "line-through", color: "#999" },
  rowMeta: { fontSize: 12, color: "#888", marginTop: 2 },

  clearChecked: { alignItems: "center", paddingVertical: 16 },
  clearCheckedText: { color: "#c44", fontSize: 14 },

  addRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#ddd",
    backgroundColor: "#fff",
  },
  addInput: { flex: 1, fontSize: 15, paddingVertical: 4 },
});
