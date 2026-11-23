// Checklist detail: one list full screen. The Checklists screen opens
// lists in place; this screen is for links straight to one (a new list,
// "Edit its template"). Items and the "⋯" menu are the shared
// ChecklistBody / openChecklistMenu.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import { AUTO_ATTACH_LABEL, progress, type Checklist, type ChecklistItem } from "../../../../lib/checklist";
import { ChecklistBody, openChecklistMenu } from "../../../../components/checklists/ChecklistBody";

export default function ChecklistDetail() {
  const params = useLocalSearchParams<{ id: string }>();
  const checklistId = String(params.id ?? "");
  const [loading, setLoading] = useState(true);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);

  const load = useCallback(async () => {
    if (!checklistId) return;
    const client = getClient();
    const [{ data: cl }, { data: its }] = await Promise.all([
      client.models.homeChecklist.get({ id: checklistId }),
      client.models.homeChecklistItem.list({ filter: { checklistId: { eq: checklistId } }, limit: 1000 }),
    ]);
    setChecklist(cl ?? null);
    setItems(its ?? []);
    setLoading(false);
  }, [checklistId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => progress(items), [items]);

  const back = (
    <Pressable onPress={() => router.back()} hitSlop={12} style={styles.headerBtn}>
      <Ionicons name="chevron-back" size={28} color="#735f55" />
    </Pressable>
  );

  if (loading || !checklist) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <View style={styles.header}>{back}</View>
        <View style={styles.center}>{loading ? <ActivityIndicator /> : <Text style={styles.empty}>Checklist not found.</Text>}</View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        {back}
        <Text style={styles.headerName} numberOfLines={1}>
          {checklist.name}
        </Text>
        <Pressable
          onPress={() =>
            openChecklistMenu(checklist, items.length, {
              onChanged: (patch) => {
                setChecklist((c) => (c ? { ...c, ...patch } : c));
                if (patch.isArchived === true) router.back();
              },
              onDeleted: () => router.back(),
              onOpenTemplate: (id) => router.push(`/more/checklists/${id}` as any), // eslint-disable-line @typescript-eslint/no-explicit-any
            })
          }
          hitSlop={12}
          style={styles.headerBtn}
          accessibilityLabel="Checklist actions"
        >
          <Ionicons name="ellipsis-horizontal-circle-outline" size={24} color="#735f55" />
        </Pressable>
      </View>

      {checklist.entityType === "TEMPLATE" && checklist.autoAttachTrips === true && (
        <View style={styles.banner}>
          <Ionicons name="airplane-outline" size={14} color="#735f55" />
          <Text style={styles.bannerText}>{AUTO_ATTACH_LABEL}</Text>
        </View>
      )}
      {checklist.isArchived && (
        <View style={styles.banner}>
          <Ionicons name="archive" size={14} color="#7a5c50" />
          <Text style={styles.bannerText}>
            Archived
            {checklist.archivedAt ? ` · ${new Date(checklist.archivedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
          </Text>
        </View>
      )}

      <View style={styles.progressBar}>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${stats.pct}%` }]} />
        </View>
        <Text style={styles.progressLabel}>
          {stats.done}/{stats.total} done
        </Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
          <ChecklistBody checklistId={checklist.id} items={items} setItems={setItems} reload={load} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f5f3" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, gap: 4 },
  headerBtn: { padding: 6 },
  headerName: { flex: 1, fontSize: 17, fontWeight: "600", color: "#3d3a37", paddingHorizontal: 4 },
  banner: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 6, backgroundColor: "#eee2d9" },
  bannerText: { fontSize: 12, color: "#7a5c50", fontWeight: "500" },
  progressBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  progressTrack: { flex: 1, height: 4, backgroundColor: "#e9e5e2", borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: "#735f55" },
  progressLabel: { fontSize: 12, color: "#888", minWidth: 60, textAlign: "right" },
  bodyContent: { padding: 16, paddingBottom: 60 },
  empty: { color: "#888", textAlign: "center", marginTop: 30 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
