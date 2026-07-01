// "More" tab. Settings, sign-out, and a launcher for features that
// don't earn their own bottom-tab slot (yet). Reminders is the first
// real entry; others stay as "coming soon" until their phase lands.

import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { signOut } from "../../../lib/auth";
import { usePerson } from "../../../lib/use-person";

interface ComingRow {
  label: string;
  comingPhase: string;
}

const COMING_ROWS: ComingRow[] = [
  { label: "Notes", comingPhase: "Coming soon" },
  { label: "Photos", comingPhase: "Coming soon" },
];

interface FeatureRow {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: string;
}

const FEATURE_ROWS: FeatureRow[] = [
  { label: "Shopping", icon: "cart-outline", route: "/more/shopping" },
  { label: "Reminders", icon: "alarm-outline", route: "/more/reminders" },
  { label: "Checklists", icon: "checkbox-outline", route: "/more/checklists" },
  { label: "Trips", icon: "airplane-outline", route: "/more/trips" },
  { label: "Documents", icon: "document-text-outline", route: "/more/documents" },
  { label: "Pets", icon: "paw-outline", route: "/more/pets" },
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

        <Text style={styles.sectionTitle}>Features</Text>
        <View style={styles.card}>
          {FEATURE_ROWS.map((r, i) => (
            <Pressable
              key={r.route}
              onPress={() => router.push(r.route as any)}
              style={({ pressed }) => [
                styles.row,
                i < FEATURE_ROWS.length - 1 && styles.rowDivider,
                pressed && styles.rowPressed,
              ]}
            >
              <View style={styles.rowLeft}>
                <Ionicons name={r.icon} size={20} color="#735f55" />
                <Text style={styles.rowLabel}>{r.label}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#bbb" />
            </Pressable>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={[styles.row, styles.rowDivider]}>
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
          {COMING_ROWS.map((r, i) => (
            <View
              key={r.label}
              style={[styles.row, i < COMING_ROWS.length - 1 && styles.rowDivider]}
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
  rowLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
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
