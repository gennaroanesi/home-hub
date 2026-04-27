// Used by tabs whose real implementation hasn't shipped yet. Keeps
// the routing graph complete so the tab bar shows the right entries
// even though tapping in lands on a "coming next" screen.

import { StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export function Placeholder({ label, phase }: { label: string; phase: string }) {
  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.phase}>{phase}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  label: { fontSize: 22, fontWeight: "600" },
  phase: { color: "#888", marginTop: 6 },
});
