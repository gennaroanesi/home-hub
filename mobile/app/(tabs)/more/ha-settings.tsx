// Home Assistant credentials. Stored device-locally in
// expo-secure-store so we never have to round-trip them through
// AppSync. The Home tab reads the same store on focus and uses the
// values for direct REST calls to HA.
//
// Long-lived tokens live in HA: User profile → Long-Lived Access
// Tokens → Create Token. We surface the help text so the user can
// follow the path without leaving the app.

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  clearHaConfig,
  isEnvConfigured,
  loadHaConfig,
  ping,
  saveHaConfig,
} from "../../../lib/ha";

export default function HaSettings() {
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pingResult, setPingResult] = useState<string | null>(null);
  const [pingOk, setPingOk] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const cfg = await loadHaConfig();
      if (cfg) {
        setBaseUrl(cfg.baseUrl);
        setToken(cfg.token);
      }
      setLoading(false);
    })();
  }, []);

  async function save() {
    if (!baseUrl.trim() || !token.trim()) {
      Alert.alert("Both fields are required");
      return;
    }
    setBusy(true);
    try {
      await saveHaConfig({ baseUrl: baseUrl.trim(), token: token.trim() });
      Alert.alert("Saved");
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!baseUrl.trim() || !token.trim()) {
      Alert.alert("Enter both fields first");
      return;
    }
    setBusy(true);
    setPingResult(null);
    setPingOk(null);
    try {
      const res = await ping({ baseUrl: baseUrl.trim(), token: token.trim() });
      setPingOk(res.ok);
      setPingResult(res.message);
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    Alert.alert(
      "Disconnect Home Assistant?",
      "URL + token will be removed from this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            await clearHaConfig();
            setBaseUrl("");
            setToken("");
            setPingResult(null);
            setPingOk(null);
          },
        },
      ]
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  const envManaged = isEnvConfigured();

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color="#735f55" />
        </Pressable>
        <Text style={styles.heading}>Home Assistant</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {envManaged ? (
          <Text style={styles.helpText}>
            Configured via build-time env vars (EXPO_PUBLIC_HA_BASE_URL +
            EXPO_PUBLIC_HA_TOKEN). To change them, update mobile/.env.local or
            EAS Secrets and rebuild.
          </Text>
        ) : (
          <Text style={styles.helpText}>
            The Home tab calls Home Assistant directly with a long-lived access
            token. Create one in HA: User profile → Long-Lived Access Tokens →
            Create Token. Both fields are stored device-locally; nothing leaves
            your phone.
          </Text>
        )}

        <Text style={styles.label}>Base URL</Text>
        <TextInput
          style={styles.input}
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="https://abc123.ui.nabu.casa"
          placeholderTextColor="#888"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!busy && !envManaged}
        />

        <Text style={styles.label}>Long-lived token</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={token}
          onChangeText={setToken}
          placeholder="eyJ0eXAiOiJK…"
          placeholderTextColor="#888"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          editable={!busy && !envManaged}
        />

        <View style={styles.btnRow}>
          <Pressable
            onPress={test}
            disabled={busy}
            style={[styles.secondaryBtn, busy && styles.disabled]}
          >
            <Text style={styles.secondaryBtnText}>Test</Text>
          </Pressable>
          {!envManaged && (
            <Pressable
              onPress={save}
              disabled={busy}
              style={[styles.primaryBtn, busy && styles.disabled]}
            >
              <Text style={styles.primaryBtnText}>Save</Text>
            </Pressable>
          )}
        </View>

        {pingResult !== null && (
          <View
            style={[
              styles.pingResult,
              pingOk ? styles.pingOk : styles.pingErr,
            ]}
          >
            <Ionicons
              name={pingOk ? "checkmark-circle" : "alert-circle"}
              size={16}
              color={pingOk ? "#3a6f3a" : "#a44"}
            />
            <Text style={[styles.pingText, pingOk ? styles.pingTextOk : styles.pingTextErr]}>
              {pingOk ? "Connected: " : "Failed: "}
              {pingResult}
            </Text>
          </View>
        )}

        {!envManaged && (baseUrl || token) && (
          <Pressable onPress={disconnect} style={styles.disconnect}>
            <Text style={styles.disconnectText}>Disconnect</Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },

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

  body: { padding: 20, paddingBottom: 40 },
  helpText: {
    fontSize: 13,
    color: "#666",
    lineHeight: 19,
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  input: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  multiline: { minHeight: 80, textAlignVertical: "top", fontFamily: "Menlo", fontSize: 11 },

  btnRow: { flexDirection: "row", gap: 10, marginTop: 20 },
  primaryBtn: {
    flex: 1,
    backgroundColor: "#735f55",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  secondaryBtn: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
  },
  secondaryBtnText: { color: "#735f55", fontSize: 15, fontWeight: "500" },
  disabled: { opacity: 0.5 },

  pingResult: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
  },
  pingOk: { backgroundColor: "#e6f1e0" },
  pingErr: { backgroundColor: "#fbe6e6" },
  pingText: { flex: 1, fontSize: 13, lineHeight: 18 },
  pingTextOk: { color: "#3a6f3a" },
  pingTextErr: { color: "#a44" },

  disconnect: { marginTop: 32, paddingVertical: 12, alignItems: "center" },
  disconnectText: { color: "#c44", fontSize: 14 },
});
