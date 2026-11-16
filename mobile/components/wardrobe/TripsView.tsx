// Trip looks tab of the mobile Wardrobe: the person's trips (upcoming
// first, lib/wardrobe-trip-edits.ts), each with where its plan stands.
// Tap one for the trip-looks screen (/more/wardrobe/trip/<id>).

import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";

import { getClient } from "../../lib/amplify";
import { listAllPages } from "../../../lib/list-all";
import { formatTripRange, type Trip } from "../../../lib/trip";
import { parseJsonField, type TripLook } from "../../../lib/wardrobe-trip";
import { latestTripPlan, sortTripsForPlanning, tripsForPerson } from "../../../lib/wardrobe-trip-edits";
import type { Schema } from "../../../amplify/data/resource";
import { todayYmd, wardrobeStyles as ws } from "./shared";

type Plan = Schema["homeWardrobeTripPlan"]["type"];

export function TripsView({ personId, personName }: { personId: string; personName: string }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const client = getClient();
    try {
      const [all, p] = await Promise.all([
        listAllPages<Trip>(client.models.homeTrip),
        listAllPages<Plan>(client.models.homeWardrobeTripPlan, { filter: { personId: { eq: personId } } }),
      ]);
      setTrips(sortTripsForPlanning(tripsForPerson(all, personId), todayYmd()));
      setPlans(p);
    } finally {
      setLoading(false);
    }
  }, [personId]);

  // On mount, on a person change, and back from a trip screen (fresh plan status).
  useFocusEffect(
    useCallback(() => {
      void load().catch(() => {});
    }, [load]),
  );

  if (loading) return <ActivityIndicator style={{ marginTop: 24 }} />;
  if (!trips.length) {
    return (
      <View style={ws.emptyBox}>
        <Text style={{ color: "#888", textAlign: "center" }}>No trips for {personName} yet. Add one in Trips first, with its dates and destination.</Text>
      </View>
    );
  }

  const today = todayYmd();
  return (
    <View>
      <Text style={[ws.meta, { marginBottom: 8 }]}>
        A packing list and a look for each day, from the destination&apos;s weather, the trip&apos;s reservations and your activities.
      </Text>
      {trips.map((t) => {
        const plan = latestTripPlan(plans.filter((p) => p.tripId === t.id));
        const looks = parseJsonField<TripLook[]>(plan?.looks, []);
        const status = !plan
          ? "No plan yet"
          : plan.status === "GENERATING"
            ? "Planning…"
            : plan.status === "FAILED"
              ? "Planning failed"
              : `${looks.length} look${looks.length === 1 ? "" : "s"} · ${(plan.packItemIds ?? []).filter(Boolean).length} pieces`;
        return (
          <Pressable
            key={t.id}
            onPress={() => router.push(`/more/wardrobe/trip/${t.id}?personId=${personId}` as any)}
            style={({ pressed }) => [styles.row, t.endDate < today && { opacity: 0.6 }, pressed && { opacity: 0.7 }]}
          >
            <Ionicons name="airplane-outline" size={20} color="#735f55" />
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{t.name}</Text>
              <Text style={ws.meta}>
                {formatTripRange(t.startDate, t.endDate)}
                {t.destination?.city ? ` · ${t.destination.city}` : ""}
              </Text>
              <Text style={[styles.status, plan?.status === "READY" && { color: "#2e7d43" }, plan?.status === "FAILED" && { color: "#c44" }]}>
                {status}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#bbb" />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 6,
  },
  title: { fontSize: 15, fontWeight: "500", color: "#222" },
  status: { fontSize: 12, color: "#888", marginTop: 2 },
});
