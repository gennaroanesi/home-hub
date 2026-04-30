// Trips list — read-only browse on mobile. Grouped by Upcoming
// (end date today or later) and Past, each sorted by start date.
// Trip planning lives on web and through Janet; mobile is "look up
// confirmation code at the airport".

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import { usePeople } from "../../../../lib/use-people";
import { TripFormModal } from "../../../../components/TripFormModal";
import {
  TRIP_TYPE_CONFIG,
  type Trip,
  type TripType,
  formatTripRange,
  isUpcomingOrOngoing,
  shortLocation,
} from "../../../../lib/trip";

export default function TripsList() {
  const { people } = usePeople();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homeTrip.list();
    setTrips(data ?? []);
    setLoading(false);
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

  const sections = useMemo(() => {
    const upcoming = trips.filter(isUpcomingOrOngoing);
    const past = trips.filter((t) => !isUpcomingOrOngoing(t));
    upcoming.sort((a, b) => a.startDate.localeCompare(b.startDate));
    // Past is reverse chronological — most recent past first.
    past.sort((a, b) => b.startDate.localeCompare(a.startDate));
    return { upcoming, past };
  }, [trips]);

  // Flatten into a single FlatList feed with header rows so we don't
  // spawn two FlatLists (which would double scroll headaches).
  type Item =
    | { kind: "header"; key: string; label: string }
    | { kind: "trip"; trip: Trip };
  const items: Item[] = [];
  if (sections.upcoming.length > 0) {
    items.push({ kind: "header", key: "h-up", label: "Upcoming" });
    for (const t of sections.upcoming) items.push({ kind: "trip", trip: t });
  }
  if (sections.past.length > 0) {
    items.push({ kind: "header", key: "h-past", label: "Past" });
    for (const t of sections.past) items.push({ kind: "trip", trip: t });
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color="#735f55" />
        </Pressable>
        <Text style={styles.heading}>Trips</Text>
        <View style={styles.headerSpacer} />
        <Pressable
          onPress={() => setCreateOpen(true)}
          hitSlop={12}
          style={styles.addBtn}
        >
          <Ionicons name="add" size={28} color="#735f55" />
        </Pressable>
      </View>
      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Ionicons name="checkmark-circle" size={16} color="#fff" />
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) =>
            item.kind === "header" ? item.key : `t-${item.trip.id}`
          }
          contentContainerStyle={styles.listBody}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              No trips yet. Add one on the web or ask Janet.
            </Text>
          }
          renderItem={({ item }) =>
            item.kind === "header" ? (
              <Text style={styles.sectionLabel}>{item.label}</Text>
            ) : (
              <TripRow
                trip={item.trip}
                onPress={() => router.push(`/more/trips/${item.trip.id}`)}
              />
            )
          }
        />
      )}
      <TripFormModal
        visible={createOpen}
        trip={null}
        people={people}
        onClose={() => setCreateOpen(false)}
        onSaved={(info) => {
          void load();
          if (info?.toast) setToast(info.toast);
        }}
      />
    </SafeAreaView>
  );
}

function TripRow({ trip, onPress }: { trip: Trip; onPress: () => void }) {
  const type = (trip.type as TripType | null) ?? null;
  const typeConfig = type ? TRIP_TYPE_CONFIG[type] : null;
  const dest = shortLocation(trip.destination);
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {trip.name}
        </Text>
        <Text style={styles.rowMeta}>
          {formatTripRange(trip.startDate, trip.endDate)}
          {dest ? `  •  ${dest}` : ""}
        </Text>
      </View>
      {typeConfig && (
        <View style={[styles.typeChip, { backgroundColor: typeConfig.color }]}>
          <Text style={styles.typeChipText}>{typeConfig.label}</Text>
        </View>
      )}
      <Ionicons name="chevron-forward" size={18} color="#bbb" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 4,
  },
  backBtn: { padding: 4 },
  heading: { fontSize: 28, fontWeight: "600" },
  headerSpacer: { flex: 1 },
  addBtn: { padding: 4 },

  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#4e5e53",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    marginHorizontal: 20,
    marginBottom: 4,
    alignSelf: "flex-start",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  toastText: { color: "#fff", fontSize: 13, fontWeight: "500" },

  listBody: { paddingHorizontal: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 6,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: "#fff",
    borderRadius: 10,
    marginVertical: 3,
    gap: 10,
  },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 15, color: "#222", fontWeight: "500" },
  rowMeta: { fontSize: 12, color: "#888", marginTop: 2 },

  typeChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  typeChipText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
});
