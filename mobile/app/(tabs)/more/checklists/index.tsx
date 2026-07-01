// Checklists list — mirrors pages/checklists.tsx on web.
//
//   • Templates section at the top (TEMPLATE entity type, shared
//     entityId "templates"). Tap a template to open + check off.
//   • Below that, every non-template checklist grouped by its
//     entityType (Trips / Events / Tasks / Bills / Documents / Other).
//   • "+" header button opens the create modal: pick entity type →
//     pick a specific entity → enter name → land in the detail
//     screen so you can start adding items.
//
// Section editing is intentionally web-only on this surface (per the
// scope decision when this screen shipped). Sections render in the
// detail view but mobile can't add/rename/reorder them; head to web
// for that.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import {
  ENTITY_TYPE_LABELS,
  ENTITY_TYPE_ORDER,
  ENTITY_TYPE_SINGULAR,
  TEMPLATE_ENTITY_ID,
  type Checklist,
  type EntityType,
} from "../../../../lib/checklist";

// Modal picker — what entity types can a checklist be attached to in
// the create flow. Same set as web's ENTITY_TYPE_ORDER plus TEMPLATE.
const CREATABLE_TYPES: EntityType[] = [
  "TEMPLATE",
  "TRIP",
  "EVENT",
  "TASK",
  "BILL",
  "DOCUMENT",
  "OTHER",
];

// Per-type lookups for resolving an entity's display name from its id
// (used both for card rendering and the create-modal picker).
const ENTITY_LOOKUP: Record<
  Exclude<EntityType, "TEMPLATE" | "OTHER">,
  { model: string; field: string }
> = {
  TRIP: { model: "homeTrip", field: "name" },
  EVENT: { model: "homeCalendarEvent", field: "title" },
  TASK: { model: "homeTask", field: "title" },
  BILL: { model: "homeBill", field: "name" },
  DOCUMENT: { model: "homeDocument", field: "title" },
};

interface ChecklistRow extends Checklist {
  itemCount: number;
  doneCount: number;
}

interface EntityOption {
  id: string;
  label: string;
}

export default function ChecklistsList() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [checklists, setChecklists] = useState<ChecklistRow[]>([]);
  const [entityNames, setEntityNames] = useState<Record<string, string>>({});

  // Create modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<EntityType>("TEMPLATE");
  const [createEntityId, setCreateEntityId] = useState<string>("");
  const [createEntityName, setCreateEntityName] = useState<string>("");
  const [createName, setCreateName] = useState("");
  const [entityOptions, setEntityOptions] = useState<EntityOption[]>([]);
  const [loadingEntities, setLoadingEntities] = useState(false);
  const [entityPickerOpen, setEntityPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const client = getClient();
    const [{ data: cls }, { data: items }] = await Promise.all([
      client.models.homeChecklist.list({ limit: 500 }),
      client.models.homeChecklistItem.list({ limit: 1000 }),
    ]);
    const itemsByChecklist = new Map<string, { total: number; done: number }>();
    for (const item of items ?? []) {
      const acc = itemsByChecklist.get(item.checklistId) ?? { total: 0, done: 0 };
      acc.total += 1;
      if (item.isDone) acc.done += 1;
      itemsByChecklist.set(item.checklistId, acc);
    }
    const rows: ChecklistRow[] = (cls ?? []).map((c) => {
      const counts = itemsByChecklist.get(c.id) ?? { total: 0, done: 0 };
      return { ...c, itemCount: counts.total, doneCount: counts.done };
    });
    setChecklists(rows);

    // Resolve entity names — same per-type batched .get() approach
    // the web list uses. Skips TEMPLATE / OTHER (no real entity).
    const idsByType: Partial<Record<EntityType, Set<string>>> = {};
    for (const r of rows) {
      const t = (r.entityType ?? "OTHER") as EntityType;
      if (t === "TEMPLATE" || t === "OTHER") continue;
      if (!idsByType[t]) idsByType[t] = new Set();
      idsByType[t]!.add(r.entityId);
    }
    const names: Record<string, string> = {};
    await Promise.all(
      (Object.entries(idsByType) as [
        Exclude<EntityType, "TEMPLATE" | "OTHER">,
        Set<string>,
      ][]).map(async ([type, ids]) => {
        const cfg = ENTITY_LOOKUP[type];
        if (!cfg) return;
        await Promise.all(
          Array.from(ids).map(async (id) => {
            try {
              const { data } = await (client.models as any)[cfg.model].get({
                id,
              });
              if (data) names[id] = (data as any)[cfg.field] ?? id;
            } catch {
              names[id] = id;
            }
          })
        );
      })
    );
    setEntityNames(names);
    setLoading(false);
  }, []);

  // Refetch on focus so the count badges stay accurate when you bounce
  // back from the detail screen after ticking items.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

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

  // ── Create flow ───────────────────────────────────────────────────
  // For TEMPLATE/OTHER the entityId is fixed (no entity picker needed).
  // For everything else we list the available entities of the chosen
  // type so the user picks one.

  function openCreate() {
    setCreateType("TEMPLATE");
    setCreateEntityId(TEMPLATE_ENTITY_ID);
    setCreateEntityName("");
    setCreateName("");
    setEntityOptions([]);
    setCreateOpen(true);
  }

  function pickCreateType(type: EntityType) {
    setCreateType(type);
    setCreateEntityId(type === "TEMPLATE" || type === "OTHER" ? defaultEntityId(type) : "");
    setCreateEntityName("");
    setEntityOptions([]);
    if (type !== "TEMPLATE" && type !== "OTHER") {
      void loadEntities(type);
    }
  }

  function defaultEntityId(type: EntityType): string {
    if (type === "TEMPLATE") return TEMPLATE_ENTITY_ID;
    if (type === "OTHER") return "other";
    return "";
  }

  async function loadEntities(type: EntityType) {
    setLoadingEntities(true);
    try {
      const cfg = ENTITY_LOOKUP[type as Exclude<EntityType, "TEMPLATE" | "OTHER">];
      if (!cfg) return;
      const client = getClient();
      const { data } = await (client.models as any)[cfg.model].list({ limit: 500 });
      const opts: EntityOption[] = (data ?? [])
        .map((d: any) => ({ id: d.id, label: (d[cfg.field] ?? d.id) as string }))
        .sort((a: EntityOption, b: EntityOption) => a.label.localeCompare(b.label));
      setEntityOptions(opts);
    } catch (err) {
      console.warn("Failed to load entities:", err);
    } finally {
      setLoadingEntities(false);
    }
  }

  async function submitCreate() {
    const name = createName.trim();
    if (!name || !createEntityId) return;
    setCreating(true);
    try {
      const client = getClient();
      const { data: created, errors } = await client.models.homeChecklist.create({
        entityType: createType,
        entityId: createEntityId,
        name,
        sortOrder: 0,
      });
      if (errors?.length) throw new Error(errors[0].message);
      setCreateOpen(false);
      await load();
      if (created?.id) {
        router.push(`/more/checklists/${created.id}` as any);
      }
    } catch (err: any) {
      Alert.alert("Create failed", err?.message ?? String(err));
    } finally {
      setCreating(false);
    }
  }

  // ── Grouped render data ───────────────────────────────────────────

  const templates = useMemo(
    () =>
      checklists
        .filter((c) => c.entityType === "TEMPLATE")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [checklists]
  );

  const grouped = useMemo(() => {
    return ENTITY_TYPE_ORDER.map((type) => ({
      type,
      label: ENTITY_TYPE_LABELS[type],
      items: checklists
        .filter((c) => (c.entityType ?? "OTHER") === type)
        .sort((a, b) => {
          const ae = entityNames[a.entityId] ?? a.entityId;
          const be = entityNames[b.entityId] ?? b.entityId;
          if (ae !== be) return ae.localeCompare(be);
          return a.name.localeCompare(b.name);
        }),
    })).filter((g) => g.items.length > 0);
  }, [checklists, entityNames]);

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
        <Text style={styles.heading}>Checklists</Text>
        <Pressable onPress={openCreate} hitSlop={12} style={styles.headerBtn}>
          <Ionicons name="add" size={28} color="#735f55" />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={grouped}
          keyExtractor={(g) => g.type}
          contentContainerStyle={styles.listBody}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListHeaderComponent={
            <TemplatesSection
              templates={templates}
              onOpen={(id) => router.push(`/more/checklists/${id}` as any)}
            />
          }
          ListEmptyComponent={
            templates.length === 0 ? (
              <Text style={styles.empty}>
                No checklists yet. Tap + to create one.
              </Text>
            ) : null
          }
          renderItem={({ item: group }) => (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{group.label}</Text>
              {group.items.map((cl) => (
                <ChecklistCard
                  key={cl.id}
                  checklist={cl}
                  subtitle={entityNames[cl.entityId] ?? cl.entityId}
                  onPress={() => router.push(`/more/checklists/${cl.id}` as any)}
                />
              ))}
            </View>
          )}
        />
      )}

      {/* ── Create modal ───────────────────────────────────────── */}
      <Modal
        visible={createOpen}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={() => setCreateOpen(false)}
      >
        <SafeAreaView style={styles.modalScreen} edges={["top"]}>
          <View style={styles.modalHeader}>
            <Pressable onPress={() => setCreateOpen(false)} hitSlop={12}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </Pressable>
            <Text style={styles.modalTitle}>New checklist</Text>
            <Pressable
              onPress={submitCreate}
              hitSlop={12}
              disabled={
                creating || !createName.trim() || !createEntityId
              }
            >
              <Text
                style={[
                  styles.modalSave,
                  (creating || !createName.trim() || !createEntityId) &&
                    styles.modalSaveDisabled,
                ]}
              >
                {creating ? "…" : "Create"}
              </Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <Text style={styles.fieldLabel}>Type</Text>
            <View style={styles.typePillRow}>
              {CREATABLE_TYPES.map((t) => {
                const on = createType === t;
                return (
                  <Pressable
                    key={t}
                    onPress={() => pickCreateType(t)}
                    style={[styles.pill, on && styles.pillOn]}
                  >
                    <Text style={[styles.pillText, on && styles.pillTextOn]}>
                      {ENTITY_TYPE_SINGULAR[t]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {createType !== "TEMPLATE" && createType !== "OTHER" && (
              <>
                <Text style={styles.fieldLabel}>
                  {ENTITY_TYPE_SINGULAR[createType]}
                </Text>
                <Pressable
                  onPress={() => setEntityPickerOpen(true)}
                  style={styles.pickerBtn}
                >
                  <Text
                    style={
                      createEntityName
                        ? styles.pickerValue
                        : styles.pickerPlaceholder
                    }
                  >
                    {loadingEntities
                      ? "Loading…"
                      : createEntityName ||
                        `Choose a ${ENTITY_TYPE_SINGULAR[createType].toLowerCase()}`}
                  </Text>
                  <Ionicons name="chevron-down" size={18} color="#888" />
                </Pressable>
              </>
            )}

            <Text style={styles.fieldLabel}>Name</Text>
            <TextInput
              style={styles.input}
              value={createName}
              onChangeText={setCreateName}
              placeholder="Packing list, weekly groceries, …"
              placeholderTextColor="#aaa"
              autoCapitalize="sentences"
              returnKeyType="done"
            />
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* ── Entity sub-picker modal ───────────────────────────── */}
      <Modal
        visible={entityPickerOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setEntityPickerOpen(false)}
      >
        <SafeAreaView style={styles.modalScreen} edges={["top"]}>
          <View style={styles.modalHeader}>
            <Pressable
              onPress={() => setEntityPickerOpen(false)}
              hitSlop={12}
            >
              <Text style={styles.modalCancel}>Cancel</Text>
            </Pressable>
            <Text style={styles.modalTitle}>
              Choose {ENTITY_TYPE_SINGULAR[createType].toLowerCase()}
            </Text>
            <View style={{ width: 60 }} />
          </View>
          {loadingEntities ? (
            <View style={styles.center}>
              <ActivityIndicator />
            </View>
          ) : (
            <FlatList
              data={entityOptions}
              keyExtractor={(o) => o.id}
              ListEmptyComponent={
                <Text style={styles.empty}>
                  No {ENTITY_TYPE_LABELS[createType].toLowerCase()} yet.
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => {
                    setCreateEntityId(item.id);
                    setCreateEntityName(item.label);
                    setEntityPickerOpen(false);
                  }}
                  style={({ pressed }) => [
                    styles.entityRow,
                    pressed && styles.entityRowPressed,
                  ]}
                >
                  <Text style={styles.entityRowLabel}>{item.label}</Text>
                  {createEntityId === item.id && (
                    <Ionicons name="checkmark" size={20} color="#735f55" />
                  )}
                </Pressable>
              )}
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// ── Templates section ──────────────────────────────────────────────

function TemplatesSection({
  templates,
  onOpen,
}: {
  templates: ChecklistRow[];
  onOpen: (id: string) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Templates</Text>
      {templates.length === 0 ? (
        <Text style={styles.sectionEmpty}>
          No templates yet. Create one above to spin up reusable lists.
        </Text>
      ) : (
        templates.map((t) => (
          <ChecklistCard
            key={t.id}
            checklist={t}
            subtitle={null}
            onPress={() => onOpen(t.id)}
          />
        ))
      )}
    </View>
  );
}

// ── Card ────────────────────────────────────────────────────────────

function ChecklistCard({
  checklist,
  subtitle,
  onPress,
}: {
  checklist: ChecklistRow;
  subtitle: string | null;
  onPress: () => void;
}) {
  const pct =
    checklist.itemCount === 0
      ? 0
      : Math.round((checklist.doneCount / checklist.itemCount) * 100);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {checklist.name}
        </Text>
        {subtitle && (
          <Text style={styles.cardSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
        <View style={styles.cardProgressRow}>
          <View style={styles.cardProgressTrack}>
            <View style={[styles.cardProgressFill, { width: `${pct}%` }]} />
          </View>
          <Text style={styles.cardProgressLabel}>
            {checklist.doneCount}/{checklist.itemCount}
          </Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#bbb" />
    </Pressable>
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
  heading: { fontSize: 18, fontWeight: "600", color: "#3d3a37" },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  listBody: { padding: 16, paddingBottom: 40 },
  empty: { color: "#888", textAlign: "center", marginTop: 40 },

  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  sectionEmpty: { color: "#aaa", fontSize: 14 },

  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  cardPressed: { backgroundColor: "#f0ece8" },
  cardBody: { flex: 1, gap: 4 },
  cardTitle: { fontSize: 15, fontWeight: "500", color: "#3d3a37" },
  cardSubtitle: { fontSize: 13, color: "#888" },
  cardProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  cardProgressTrack: {
    flex: 1,
    height: 4,
    backgroundColor: "#eee",
    borderRadius: 2,
    overflow: "hidden",
  },
  cardProgressFill: {
    height: "100%",
    backgroundColor: "#735f55",
  },
  cardProgressLabel: { fontSize: 12, color: "#888", minWidth: 40, textAlign: "right" },

  // Modal styling
  modalScreen: { flex: 1, backgroundColor: "#fff" },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  modalTitle: { fontSize: 17, fontWeight: "600", color: "#3d3a37" },
  modalCancel: { fontSize: 15, color: "#735f55" },
  modalSave: { fontSize: 15, fontWeight: "600", color: "#735f55" },
  modalSaveDisabled: { color: "#bbb" },
  modalBody: { padding: 16, gap: 8 },

  fieldLabel: {
    fontSize: 12,
    color: "#888",
    textTransform: "uppercase",
    marginTop: 12,
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  typePillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: "#eee",
  },
  pillOn: { backgroundColor: "#735f55" },
  pillText: { color: "#444", fontSize: 13 },
  pillTextOn: { color: "#fff", fontWeight: "500" },

  pickerBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    backgroundColor: "#fafafa",
  },
  pickerValue: { color: "#3d3a37", fontSize: 15 },
  pickerPlaceholder: { color: "#aaa", fontSize: 15 },

  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    backgroundColor: "#fafafa",
    color: "#3d3a37",
  },

  entityRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  entityRowPressed: { backgroundColor: "#f4f4f4" },
  entityRowLabel: { fontSize: 15, color: "#3d3a37" },
});
