// "More" tab. Today it's a settings / sign-out screen plus a pointer
// at features that don't have their own tab yet (trips, devices,
// photos, agent, …). Each non-shipped row is a stub for now.

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { signOut } from "../../lib/auth";
import { usePerson } from "../../lib/use-person";

interface Row {
  label: string;
  detail?: string;
  comingPhase?: string;
}

const FEATURE_ROWS: Row[] = [
  { label: "Agent", comingPhase: "Phase 2" },
  { label: "Reminders", comingPhase: "Phase 2" },
  { label: "Devices", comingPhase: "Phase 3" },
  { label: "Photos", comingPhase: "Phase 4" },
  { label: "Trips", comingPhase: "Phase 5" },
  { label: "Notes", comingPhase: "Phase 5" },
];

export default function More() {
  const personState = usePerson();
  const personLabel =
    personState.status === "found"
      ? personState.person.name
      : personState.status === "loading"
        ? "…"
        : "(not linked)";

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.heading}>More</Text>

        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Signed in as</Text>
            <Text style={styles.rowValue}>{personLabel}</Text>
          </View>
          <Pressable
            onPress={signOut}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <Text style={[styles.rowLabel, styles.danger]}>Sign out</Text>
          </Pressable>
        </View>

        <Text style={styles.sectionTitle}>Coming soon</Text>
        <View style={styles.card}>
          {FEATURE_ROWS.map((r, i) => (
            <View
              key={r.label}
              style={[styles.row, i < FEATURE_ROWS.length - 1 && styles.rowDivider]}
            >
              <Text style={styles.rowLabel}>{r.label}</Text>
              <Text style={styles.rowMuted}>{r.comingPhase}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 40 },
  heading: { fontSize: 28, fontWeight: "600", marginBottom: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 8,
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
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  rowPressed: { backgroundColor: "#f4f4f4" },
  rowLabel: { fontSize: 15 },
  rowValue: { color: "#666", fontSize: 14 },
  rowMuted: { color: "#aaa", fontSize: 13 },
  danger: { color: "#c44" },
});
