// Checklists — mirrors pages/checklists.tsx on web. Tabs Active,
// Archived (past trips' lists archive themselves, lib/trip-prep.ts) and
// Templates. Lists are grouped under what they belong to (a trip's name
// and dates, an event…), each a card that opens in place (chevron) to its
// items (ChecklistBody: sections swipe sideways) with a "⋯" menu
// (openChecklistMenu). "+" creates a list or template and opens it.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
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
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import { listAllPages } from "../../../../../lib/list-all";
import { ChecklistBody, openChecklistMenu } from "../../../../components/checklists/ChecklistBody";
import {
  AUTO_ATTACH_LABEL,
  checklistNameFromTemplate,
  copyChecklist,
  ENTITY_TYPE_LABELS,
  ENTITY_TYPE_ORDER,
  ENTITY_TYPE_SINGULAR,
  TEMPLATE_ENTITY_ID,
  matchesArchiveFilter,
  progress,
  type Checklist,
  type ChecklistItem,
  type EntityType,
} from "../../../../lib/checklist";

// Modal picker — what entity types can a checklist be attached to in
// the create flow. Same set as web's ENTITY_TYPE_ORDER plus TEMPLATE.
const CREATABLE_TYPES: EntityType[] = [
  "TEMPLATE",
  "TRIP",
  "EVENT",
  "TASK",
  "DOCUMENT",
  "PREGNANCY",
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
  DOCUMENT: { model: "homeDocument", field: "title" },
  PREGNANCY: { model: "homePregnancy", field: "dueDate" },
};

type ChecklistRow = Checklist;

interface EntityOption {
  id: string;
  label: string;
}

type Tab = "ACTIVE" | "ARCHIVED" | "TEMPLATES";
const TABS: { id: Tab; label: string }[] = [
  { id: "ACTIVE", label: "Active" },
  { id: "ARCHIVED", label: "Archived" },
  { id: "TEMPLATES", label: "Templates" },
];

export default function ChecklistsList() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [checklists, setChecklists] = useState<ChecklistRow[]>([]);
  const [entityNames, setEntityNames] = useState<Record<string, string>>({});
  const [itemsByList, setItemsByList] = useState<Record<string, ChecklistItem[]>>({});
  const [tripDates, setTripDates] = useState<Record<string, { start: string; end: string }>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggleOpen = (id: string, force?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (force ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  const [tab, setTab] = useState<Tab>(() => (params.tab?.toUpperCase() === "TEMPLATES" ? "TEMPLATES" : params.tab?.toUpperCase() === "ARCHIVED" ? "ARCHIVED" : "ACTIVE"));
  const archiveFilter = tab === "ARCHIVED" ? "ARCHIVED" : "ACTIVE";

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
  // "Start from" a template (not for a new template): its items are copied in.
  const [createFrom, setCreateFrom] = useState<string>("");

  const load = useCallback(async () => {
    const client = getClient();
    const [cls, items] = await Promise.all([
      listAllPages<Checklist>(client.models.homeChecklist),
      listAllPages<ChecklistItem>(client.models.homeChecklistItem, { limit: 1000 }),
    ]);
    const byList: Record<string, ChecklistItem[]> = {};
    for (const item of items) (byList[item.checklistId] ??= []).push(item);
    setItemsByList(byList);
    const rows: ChecklistRow[] = cls;
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
    // Trip dates: trips are listed by date and show when they are.
    const dates: Record<string, { start: string; end: string }> = {};
    await Promise.all(
      Array.from(idsByType.TRIP ?? []).map(async (id) => {
        const { data } = await client.models.homeTrip.get({ id });
        if (data?.startDate) dates[id] = { start: data.startDate, end: data.endDate ?? data.startDate };
      })
    );
    setTripDates(dates);
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
    const type: EntityType = tab === "TEMPLATES" ? "TEMPLATE" : "TRIP";
    setCreateType(type);
    setCreateEntityId(defaultEntityId(type));
    if (type !== "TEMPLATE") void loadEntities(type);
    setCreateEntityName("");
    setCreateName("");
    setCreateFrom("");
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
    const template = createType !== "TEMPLATE" ? templates.find((t) => t.id === createFrom) : undefined;
    const name = createName.trim() || (template ? checklistNameFromTemplate(template.name) : "");
    if (!name || !createEntityId) return;
    setCreating(true);
    try {
      const client = getClient();
      let created: { id: string } | null = null;
      if (template) {
        // Same copy as the web's "From template" (lib/checklist.ts).
        created = await copyChecklist(client, template, { entityType: createType, entityId: createEntityId, name });
      } else {
        const res = await client.models.homeChecklist.create({ entityType: createType, entityId: createEntityId, name, sortOrder: 0 });
        if (res.errors?.length) throw new Error(res.errors[0].message);
        created = res.data;
      }
      setCreateOpen(false);
      await load();
      // Opens in place, on the tab it belongs to.
      if (created?.id) {
        setTab(createType === "TEMPLATE" ? "TEMPLATES" : "ACTIVE");
        toggleOpen(created.id, true);
      }
    } catch (err: any) {
      Alert.alert("Create failed", err?.message ?? String(err));
    } finally {
      setCreating(false);
    }
  }

  // ── Grouped render data ───────────────────────────────────────────

  const filtered = useMemo(
    () => checklists.filter((c) => matchesArchiveFilter(c, archiveFilter)),
    [checklists, archiveFilter]
  );

  const templates = useMemo(
    () =>
      checklists
        .filter((c) => c.entityType === "TEMPLATE")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [checklists]
  );

  // Type → entity (a trip, an event…) → its lists. Trips by date, the
  // next one first (archived: the latest first); others by name.
  const grouped = useMemo(() => {
    return ENTITY_TYPE_ORDER.map((type) => {
      const lists = filtered.filter((c) => (c.entityType ?? "OTHER") === type);
      const byEntity = new Map<string, ChecklistRow[]>();
      for (const l of lists) byEntity.set(l.entityId, [...(byEntity.get(l.entityId) ?? []), l]);
      const entities = Array.from(byEntity.entries()).map(([entityId, ls]) => ({
        entityId,
        name: entityNames[entityId] ?? (type === "OTHER" ? "Other" : "…"),
        dates: tripDates[entityId] ?? null,
        lists: ls.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)),
      }));
      entities.sort((a, b) => {
        if (type === "TRIP") {
          const da = a.dates?.start ?? "9999";
          const db = b.dates?.start ?? "9999";
          return archiveFilter === "ARCHIVED" ? db.localeCompare(da) : da.localeCompare(db);
        }
        return a.name.localeCompare(b.name);
      });
      return { type, label: ENTITY_TYPE_LABELS[type], entities };
    }).filter((g) => g.entities.length > 0);
  }, [filtered, entityNames, tripDates, archiveFilter]);

  const setListItems = (id: string) => (update: (prev: ChecklistItem[]) => ChecklistItem[]) =>
    setItemsByList((prev) => ({ ...prev, [id]: update(prev[id] ?? []) }));

  async function reloadList(id: string) {
    const { data } = await getClient().models.homeChecklistItem.list({ filter: { checklistId: { eq: id } }, limit: 1000 });
    setItemsByList((prev) => ({ ...prev, [id]: data ?? [] }));
  }

  const renderCard = (cl: ChecklistRow) => (
    <ListCard
      key={cl.id}
      checklist={cl}
      items={itemsByList[cl.id] ?? []}
      open={open.has(cl.id)}
      onToggle={() => toggleOpen(cl.id)}
      onMenu={() =>
        openChecklistMenu(cl, (itemsByList[cl.id] ?? []).length, {
          onChanged: (patch) => setChecklists((prev) => prev.map((c) => (c.id === cl.id ? { ...c, ...patch } : c))),
          onDeleted: () => setChecklists((prev) => prev.filter((c) => c.id !== cl.id)),
          onOpenTemplate: (tid) => {
            setTab("TEMPLATES");
            toggleOpen(tid, true);
          },
        })
      }
      setItems={setListItems(cl.id)}
      reload={() => reloadList(cl.id)}
    />
  );

  const fmtDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

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

      <View style={styles.filterRow}>
        {TABS.map((f) => {
          const on = tab === f.id;
          return (
            <Pressable
              key={f.id}
              onPress={() => setTab(f.id)}
              style={[styles.pill, on && styles.pillOn]}
            >
              <Text style={[styles.pillText, on && styles.pillTextOn]}>
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView
            contentContainerStyle={styles.listBody}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          >
            {tab === "TEMPLATES" ? (
              <View style={styles.section}>
                <Text style={styles.sectionEmpty}>
                  Reusable lists. One {AUTO_ATTACH_LABEL.toLowerCase()} is copied onto each new and upcoming trip; copies drop the word &quot;template&quot; from the name.
                </Text>
                <View style={{ height: 12 }} />
                {templates.length === 0 ? <Text style={styles.sectionEmpty}>No templates yet. Tap + to make one.</Text> : templates.map(renderCard)}
              </View>
            ) : grouped.length === 0 ? (
              <Text style={styles.empty}>
                {archiveFilter === "ARCHIVED"
                  ? "No archived checklists."
                  : checklists.some((c) => c.entityType !== "TEMPLATE")
                    ? "Nothing active. Past trips' checklists are under Archived."
                    : "No checklists yet. Tap + to create one."}
              </Text>
            ) : (
              grouped.map((group) => (
                <View key={group.type} style={styles.section}>
                  <Text style={styles.sectionTitle}>{group.label}</Text>
                  {group.entities.map((e) => (
                    <View key={e.entityId} style={styles.entityBlock}>
                      {group.type !== "OTHER" && (
                        <View style={styles.entityHeader}>
                          <Text style={styles.entityTitle} numberOfLines={1}>
                            {e.name}
                          </Text>
                          {e.dates && (
                            <Text style={styles.entityDates}>
                              {e.dates.start === e.dates.end ? fmtDay(e.dates.start) : `${fmtDay(e.dates.start)} – ${fmtDay(e.dates.end)}`}
                            </Text>
                          )}
                        </View>
                      )}
                      {e.lists.map(renderCard)}
                    </View>
                  ))}
                </View>
              ))
            )}
          </ScrollView>
        </KeyboardAvoidingView>
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
                creating || !(createName.trim() || (createType !== "TEMPLATE" && createFrom)) || !createEntityId
              }
            >
              <Text
                style={[
                  styles.modalSave,
                  (creating || !(createName.trim() || (createType !== "TEMPLATE" && createFrom)) || !createEntityId) &&
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

            {createType !== "TEMPLATE" && templates.length > 0 && (
              <>
                <Text style={styles.fieldLabel}>Start from</Text>
                <View style={styles.typePillRow}>
                  {[{ id: "", name: "Blank" }, ...templates].map((t) => {
                    const on = createFrom === t.id;
                    return (
                      <Pressable key={t.id || "blank"} onPress={() => setCreateFrom(t.id)} style={[styles.pill, on && styles.pillOn]}>
                        <Text style={[styles.pillText, on && styles.pillTextOn]}>{t.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}

            <Text style={styles.fieldLabel}>Name</Text>
            <TextInput
              style={styles.input}
              value={createName}
              onChangeText={setCreateName}
              placeholder={createFrom && createType !== "TEMPLATE" ? checklistNameFromTemplate(templates.find((t) => t.id === createFrom)?.name ?? "") : "Packing list, weekly groceries, …"}
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

// ── Card ────────────────────────────────────────────────────────────
// Header: chevron, name, progress, "⋯". Opens in place to its items.

function ListCard({
  checklist,
  items,
  open,
  onToggle,
  onMenu,
  setItems,
  reload,
}: {
  checklist: ChecklistRow;
  items: ChecklistItem[];
  open: boolean;
  onToggle: () => void;
  onMenu: () => void;
  setItems: (update: (prev: ChecklistItem[]) => ChecklistItem[]) => void;
  reload: () => Promise<void>;
}) {
  const p = progress(items);
  const archived = checklist.isArchived === true;
  return (
    <View style={[styles.card, archived && styles.cardArchived]}>
      <View style={styles.cardHeader}>
        <Pressable onPress={onToggle} style={({ pressed }) => [styles.cardHeaderMain, pressed && styles.cardPressed]} accessibilityState={{ expanded: open }}>
          <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={16} color="#999" />
          <View style={styles.cardBody}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {checklist.name}
              </Text>
              {archived && (
                <View style={styles.archivedBadge}>
                  <Text style={styles.archivedBadgeText}>Archived</Text>
                </View>
              )}
            </View>
            {checklist.entityType === "TEMPLATE" && checklist.autoAttachTrips === true && <Text style={styles.cardSubtitle}>{AUTO_ATTACH_LABEL}</Text>}
            <View style={styles.cardProgressRow}>
              <View style={styles.cardProgressTrack}>
                <View style={[styles.cardProgressFill, { width: `${p.pct}%` }]} />
              </View>
              <Text style={styles.cardProgressLabel}>
                {p.done}/{p.total}
              </Text>
            </View>
          </View>
        </Pressable>
        <Pressable onPress={onMenu} hitSlop={10} style={styles.cardMenuBtn} accessibilityLabel={`${checklist.name} actions`}>
          <Ionicons name="ellipsis-horizontal" size={20} color="#735f55" />
        </Pressable>
      </View>
      {open && (
        <View style={styles.cardOpen}>
          <ChecklistBody checklistId={checklist.id} items={items} setItems={setItems} reload={reload} inset={10} />
        </View>
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
    backgroundColor: "#fff",
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    overflow: "hidden",
  },
  cardHeader: { flexDirection: "row", alignItems: "center" },
  cardHeaderMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 12, paddingVertical: 12 },
  cardMenuBtn: { paddingHorizontal: 14, paddingVertical: 12 },
  cardOpen: { backgroundColor: "#f7f5f3", paddingHorizontal: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#eee" },
  entityBlock: { marginBottom: 14 },
  entityHeader: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 6 },
  entityTitle: { flexShrink: 1, fontSize: 17, fontWeight: "600", color: "#3d3a37" },
  entityDates: { fontSize: 13, color: "#888" },
  cardPressed: { backgroundColor: "#f0ece8" },
  cardArchived: { opacity: 0.6 },
  cardBody: { flex: 1, gap: 4 },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: "500", color: "#3d3a37" },
  archivedBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: "#eee",
  },
  archivedBadgeText: {
    fontSize: 10,
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
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
  filterRow: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
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
