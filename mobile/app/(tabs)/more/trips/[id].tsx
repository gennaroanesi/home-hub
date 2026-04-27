// Trip detail — read-only.
//
// Shows the trip header (name, type, dates, destination), then two
// sections: Legs (transport, sorted by sortOrder then departAt) and
// Reservations (hotels / tickets / etc, sorted by sortOrder then
// startAt). Each row links to its `url` if one is set so the user can
// jump to airline / hotel / Ticketmaster confirmation pages from the
// row.
//
// Times are wall-clock — see lib/trip.ts for the parse / format
// helpers and why we don't route through `new Date()`.

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import {
  LEG_MODE_EMOJI,
  LEG_MODE_LABEL,
  RESERVATION_EMOJI,
  TRIP_TYPE_CONFIG,
  type LegMode,
  type ReservationType,
  type Trip,
  type TripLeg,
  type TripReservation,
  type TripType,
  formatLegDateShort,
  formatLegTime,
  formatTripRange,
  shortLocation,
} from "../../../../lib/trip";

interface TripData {
  trip: Trip;
  legs: TripLeg[];
  reservations: TripReservation[];
}

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<TripData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const client = getClient();
    const [tripRes, legsRes, resRes] = await Promise.all([
      client.models.homeTrip.get({ id }),
      client.models.homeTripLeg.list({ filter: { tripId: { eq: id } } }),
      client.models.homeTripReservation.list({
        filter: { tripId: { eq: id } },
      }),
    ]);
    if (!tripRes.data) {
      setData(null);
      setLoading(false);
      return;
    }
    const legs = (legsRes.data ?? []).sort((a, b) => {
      const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (so !== 0) return so;
      return (a.departAt ?? "").localeCompare(b.departAt ?? "");
    });
    const reservations = (resRes.data ?? []).sort((a, b) => {
      const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (so !== 0) return so;
      return (a.startAt ?? "").localeCompare(b.startAt ?? "");
    });
    setData({ trip: tripRes.data, legs, reservations });
    setLoading(false);
  }, [id]);

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

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color="#735f55" />
        </Pressable>
        <Text style={styles.heading} numberOfLines={1}>
          {data?.trip.name ?? "Trip"}
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : !data ? (
        <Text style={styles.empty}>Trip not found.</Text>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          <TripHeader trip={data.trip} />

          <Text style={styles.sectionLabel}>Legs</Text>
          {data.legs.length === 0 ? (
            <Text style={styles.empty}>No legs.</Text>
          ) : (
            <View style={styles.card}>
              {data.legs.map((l, i) => (
                <LegRow
                  key={l.id}
                  leg={l}
                  divider={i < data.legs.length - 1}
                />
              ))}
            </View>
          )}

          <Text style={styles.sectionLabel}>Reservations</Text>
          {data.reservations.length === 0 ? (
            <Text style={styles.empty}>No reservations.</Text>
          ) : (
            <View style={styles.card}>
              {data.reservations.map((r, i) => (
                <ReservationRow
                  key={r.id}
                  reservation={r}
                  divider={i < data.reservations.length - 1}
                />
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function TripHeader({ trip }: { trip: Trip }) {
  const type = (trip.type as TripType | null) ?? null;
  const typeConfig = type ? TRIP_TYPE_CONFIG[type] : null;
  const dest = shortLocation(trip.destination);
  return (
    <View style={styles.tripCard}>
      <Text style={styles.tripName}>{trip.name}</Text>
      <View style={styles.tripMetaRow}>
        <Text style={styles.tripMeta}>
          {formatTripRange(trip.startDate, trip.endDate)}
        </Text>
        {dest && (
          <>
            <Text style={styles.tripMetaSep}>•</Text>
            <Text style={styles.tripMeta}>{dest}</Text>
          </>
        )}
        {typeConfig && (
          <View style={[styles.typeChip, { backgroundColor: typeConfig.color }]}>
            <Text style={styles.typeChipText}>{typeConfig.label}</Text>
          </View>
        )}
      </View>
      {!!trip.notes && <Text style={styles.tripNotes}>{trip.notes}</Text>}
    </View>
  );
}

function LegRow({ leg, divider }: { leg: TripLeg; divider: boolean }) {
  const mode = (leg.mode as LegMode | null) ?? "OTHER";
  const fromLabel = shortLocation(leg.fromLocation) ?? "—";
  const toLabel = shortLocation(leg.toLocation) ?? "—";
  const departDate = formatLegDateShort(leg.departAt);
  const departTime = formatLegTime(leg.departAt);
  const arriveTime = formatLegTime(leg.arriveAt);

  // Headline depends on mode: flights pull airline + flight number,
  // personal flights pull aircraft, others fall back to the mode label.
  let headline = LEG_MODE_LABEL[mode];
  if (mode === "COMMERCIAL_FLIGHT") {
    const parts = [leg.airline, leg.flightNumber].filter(Boolean);
    if (parts.length > 0) headline = parts.join(" ");
  } else if (mode === "PERSONAL_FLIGHT" && leg.aircraft) {
    headline = leg.aircraft;
  }

  const onPress = leg.url ? () => Linking.openURL(leg.url!) : undefined;
  const Wrapper = onPress ? Pressable : View;

  return (
    <Wrapper
      onPress={onPress}
      style={[styles.row, divider && styles.rowDivider]}
    >
      <Text style={styles.legEmoji}>{LEG_MODE_EMOJI[mode]}</Text>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{headline}</Text>
        <Text style={styles.rowMeta}>
          {fromLabel} {departTime}
          {arriveTime ? ` → ${toLabel} ${arriveTime}` : toLabel ? ` → ${toLabel}` : ""}
        </Text>
        {departDate && <Text style={styles.rowMetaQuiet}>{departDate}</Text>}
        {!!leg.confirmationCode && (
          <Text style={styles.confirmationCode} selectable>
            Confirmation: {leg.confirmationCode}
          </Text>
        )}
      </View>
      {leg.url && <Ionicons name="open-outline" size={16} color="#888" />}
    </Wrapper>
  );
}

function ReservationRow({
  reservation,
  divider,
}: {
  reservation: TripReservation;
  divider: boolean;
}) {
  const type = (reservation.type as ReservationType | null) ?? "OTHER";
  const startDate = formatLegDateShort(reservation.startAt);
  const endDate = formatLegDateShort(reservation.endAt);
  const dateLabel =
    startDate && endDate && startDate !== endDate
      ? `${startDate} – ${endDate}`
      : startDate || endDate;
  const loc = shortLocation(reservation.location);
  const onPress = reservation.url ? () => Linking.openURL(reservation.url!) : undefined;
  const Wrapper = onPress ? Pressable : View;

  return (
    <Wrapper
      onPress={onPress}
      style={[styles.row, divider && styles.rowDivider]}
    >
      <Text style={styles.legEmoji}>{RESERVATION_EMOJI[type]}</Text>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{reservation.name}</Text>
        <Text style={styles.rowMeta}>
          {dateLabel}
          {loc ? `${dateLabel ? "  •  " : ""}${loc}` : ""}
        </Text>
        {!!reservation.confirmationCode && (
          <Text style={styles.confirmationCode} selectable>
            Confirmation: {reservation.confirmationCode}
          </Text>
        )}
      </View>
      {reservation.url && <Ionicons name="open-outline" size={16} color="#888" />}
    </Wrapper>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

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
  heading: { fontSize: 22, fontWeight: "600", flex: 1 },

  body: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 16, textAlign: "center" },

  tripCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  tripName: { fontSize: 18, fontWeight: "600", color: "#222" },
  tripMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  tripMeta: { color: "#666", fontSize: 13 },
  tripMetaSep: { color: "#ccc", fontSize: 13 },
  tripNotes: { color: "#666", marginTop: 8, fontSize: 13, lineHeight: 19 },

  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 6,
  },

  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    marginBottom: 8,
  },

  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 15, color: "#222", fontWeight: "500" },
  rowMeta: { fontSize: 13, color: "#666", marginTop: 2 },
  rowMetaQuiet: { fontSize: 12, color: "#999", marginTop: 1 },
  confirmationCode: {
    fontSize: 12,
    color: "#888",
    marginTop: 4,
    fontFamily: "Menlo",
  },
  legEmoji: { fontSize: 22, paddingTop: 2 },

  typeChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 4,
  },
  typeChipText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
});
