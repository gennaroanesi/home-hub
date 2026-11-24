// Categories — the finance category tree, like the web's Categories window
// (components/finance/category-manager.tsx): each category with how many
// transactions use it (sub-categories included). + adds a top-level one; tap
// a category to add a sub-category, rename or move it under another parent,
// or delete it (its transactions move to a category you pick, its parent, or
// Uncategorized; its sub-categories move up a level). The ops
// (save_finance_category / delete_finance_category) rewrite every place the
// category is stored; afterwards the pickers' cached names are dropped.

import { useCallback, useEffect, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, FlatList, Modal, Platform, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../lib/ops";
import { ACCENT, DANGER, FinanceHeader, HeaderButton, fs } from "../../../components/finance/ui";
import { Field, FormSheet, Input, ff, forgetFinanceCategories } from "../../../components/finance/form";
import {
  categoriesOutside,
  categoryDirectCount,
  categoryUseCount,
  deleteNeedsTarget,
  rewrittenNote,
  type CategoryManagerNode,
} from "../../../../lib/finance/category-manager";

type Node = CategoryManagerNode;
type Draft = { id: string | null; name: string; parentId: string };
/** moveTo: "" = its parent (the op's default), UNCATEGORIZE, or a category id. */
type Removing = { node: Node; moveTo: string };
const UNCATEGORIZE = "__none";

function showMenu(title: string, actions: Array<{ label: string; run: () => void; destructive?: boolean }>) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...actions.map((a) => a.label), "Cancel"], cancelButtonIndex: actions.length, destructiveButtonIndex: actions.findIndex((a) => a.destructive) },
      (i) => actions[i]?.run(),
    );
  } else {
    Alert.alert(title, undefined, [...actions.map((a) => ({ text: a.label, onPress: a.run, style: a.destructive ? ("destructive" as const) : undefined })), { text: "Cancel", style: "cancel" as const }]);
  }
}

export default function FinanceCategories() {
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await callOp("list_finance_categories", { withCounts: true });
    if ("error" in r) return setError(r.error);
    setError(null);
    setNodes(r.result.tree);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function changed() {
    forgetFinanceCategories();
    await load();
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    const r = await callOp("save_finance_category", {
      ...(draft.id ? { categoryId: draft.id } : {}),
      name: draft.name,
      parentId: draft.parentId || null,
    });
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't save", r.error);
    setDraft(null);
    if (r.result.renamedFrom) Alert.alert(`${r.result.renamedFrom} → ${r.result.category.path}`, rewrittenNote(r.result.rewritten));
    await changed();
  }

  async function remove(rm: Removing) {
    setBusy(true);
    const r = await callOp("delete_finance_category", {
      categoryId: rm.node.id,
      ...(rm.moveTo === UNCATEGORIZE ? { uncategorize: true } : rm.moveTo ? { moveToCategoryId: rm.moveTo } : {}),
    });
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't delete", r.error);
    setRemoving(null);
    Alert.alert(`Deleted ${r.result.deleted}`, rewrittenNote(r.result.rewritten));
    await changed();
  }

  function askDelete(n: Node) {
    if (!nodes) return;
    if (categoryDirectCount(n.id, nodes) > 0) return setRemoving({ node: n, moveTo: "" });
    Alert.alert(`Delete ${n.path}?`, nodes.some((x) => x.parentId === n.id) ? "Its sub-categories move up one level." : undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void remove({ node: n, moveTo: "" }) },
    ]);
  }

  function menu(n: Node) {
    showMenu(n.path, [
      { label: "Add a sub-category", run: () => setDraft({ id: null, name: "", parentId: n.id }) },
      { label: "Rename or move", run: () => setDraft({ id: n.id, name: n.name, parentId: n.parentId ?? "" }) },
      { label: "Delete", destructive: true, run: () => askDelete(n) },
    ]);
  }

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Categories" right={<HeaderButton icon="add" onPress={() => setDraft({ id: null, name: "", parentId: "" })} busy={busy} />} />
      {!nodes ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <FlatList
          data={nodes}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListHeaderComponent={<Text style={[fs.muted, { paddingHorizontal: 4, paddingVertical: 6 }]}>Renaming or moving one updates every transaction, rule and budget line that uses it.</Text>}
          ListEmptyComponent={<Text style={fs.empty}>No categories yet. Tap + to add one.</Text>}
          renderItem={({ item, index }) => {
            return (
              <Pressable
                onPress={() => menu(item)}
                style={({ pressed }) => [
                  { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#fff", paddingVertical: 12, paddingRight: 14, paddingLeft: 14 + item.depth * 18 },
                  item.depth === 0 ? { marginTop: index > 0 ? 8 : 0, borderTopLeftRadius: 10, borderTopRightRadius: 10 } : { borderTopWidth: 1, borderTopColor: "#f0f0f0" },
                  (index === nodes.length - 1 || nodes[index + 1].depth === 0) && { borderBottomLeftRadius: 10, borderBottomRightRadius: 10 },
                  pressed && fs.pressed,
                ]}
              >
                <Text style={[fs.textFlex, item.depth === 0 && { fontWeight: "600" }]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={fs.muted}>{categoryUseCount(item.id, nodes)}</Text>
                <Ionicons name="ellipsis-horizontal" size={16} color="#bbb" />
              </Pressable>
            );
          }}
        />
      )}

      <FormSheet
        visible={!!draft}
        title={draft?.id ? "Edit category" : "New category"}
        onClose={() => setDraft(null)}
        onSave={save}
        busy={busy}
        canSave={!!draft?.name.trim()}
      >
        {draft && nodes && (
          <>
            <Field label="Name">
              <Input value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} placeholder="Groceries" autoFocus autoCorrect={false} />
            </Field>
            <Field label="Inside" hint={draft.id ? "Moving it takes its sub-categories along." : undefined}>
              <OptionList
                value={draft.parentId}
                onPick={(parentId) => setDraft({ ...draft, parentId })}
                options={[{ key: "", label: "Top level" }, ...categoriesOutside(draft.id, nodes).map((n) => ({ key: n.id, label: n.path }))]}
              />
            </Field>
          </>
        )}
      </FormSheet>

      {removing && nodes && <DeleteSheet removing={removing} nodes={nodes} busy={busy} onChange={setRemoving} onClose={() => setRemoving(null)} onDelete={() => void remove(removing)} />}
    </SafeAreaView>
  );
}

/** Where a deleted category's transactions go. */
function DeleteSheet({
  removing,
  nodes,
  busy,
  onChange,
  onClose,
  onDelete,
}: {
  removing: Removing;
  nodes: Node[];
  busy: boolean;
  onChange: (r: Removing) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const n = removing.node;
  const count = categoryDirectCount(n.id, nodes);
  const needsTarget = deleteNeedsTarget(n.id, nodes);
  const parent = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined;
  const canDelete = !busy && !(needsTarget && !removing.moveTo);
  const options = [
    ...(parent ? [{ key: "", label: `Its parent (${parent.path})` }] : []),
    ...categoriesOutside(n.id, nodes)
      .filter((x) => x.id !== parent?.id)
      .map((x) => ({ key: x.id, label: x.path })),
    { key: UNCATEGORIZE, label: "Uncategorized" },
  ];
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ff.screen}>
        <View style={ff.header}>
          <Pressable onPress={onClose} disabled={busy} hitSlop={8}>
            <Text style={ff.cancel}>Cancel</Text>
          </Pressable>
          <Text style={ff.headerTitle} numberOfLines={1}>
            Delete category
          </Text>
          <Pressable onPress={onDelete} disabled={!canDelete} hitSlop={8}>
            {busy ? <ActivityIndicator /> : <Text style={[ff.save, { color: DANGER }, !canDelete && ff.disabled]}>Delete</Text>}
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={ff.body}>
          <Text style={fs.text}>
            Delete <Text style={{ fontWeight: "600" }}>{n.path}</Text>? Its sub-categories move up one level. Its {count} transaction{count === 1 ? "" : "s"} (and any rules or budget lines) move to:
          </Text>
          <OptionList value={removing.moveTo} onPick={(moveTo) => onChange({ ...removing, moveTo })} options={options} none={needsTarget ? "Choose a category" : undefined} />
        </ScrollView>
      </View>
    </Modal>
  );
}

/** A list of choices with a checkmark on the picked one. */
function OptionList({ value, onPick, options, none }: { value: string; onPick: (key: string) => void; options: Array<{ key: string; label: string }>; none?: string }) {
  return (
    <View style={[ff.box, { padding: 0, gap: 0, overflow: "hidden" }]}>
      {none && !value ? <Text style={[ff.hint, { paddingHorizontal: 12, paddingVertical: 8 }]}>{none}</Text> : null}
      {options.map((o) => (
        <Pressable key={o.key || "default"} onPress={() => onPick(o.key)} style={({ pressed }) => [ff.option, { paddingVertical: 11, paddingRight: 12, paddingLeft: 12 }, pressed && fs.pressed]}>
          <Text style={ff.optionText} numberOfLines={1}>
            {o.label}
          </Text>
          {value === o.key && <Ionicons name="checkmark" size={18} color={ACCENT} />}
        </Pressable>
      ))}
    </View>
  );
}
