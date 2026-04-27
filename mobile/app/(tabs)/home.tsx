// Home — Home Assistant device control.
//
// Reads homeDevice rows from AppSync for the device list (so areas /
// friendly names / sensitivity tier are in sync with the web /devices
// page) and calls HA REST directly for state refresh + actions. The
// hass-sync Lambda still keeps homeDevice.lastState fresh; we use it
// as the initial paint, then re-fetch live state after a control
// action so the UI reflects HA's view of reality.
//
// HIGH-sensitivity devices (locks, garage door) are visible but their
// action buttons are disabled — Duo Push is wired up for the web /
// agent path and we haven't ported it to mobile yet. The user is
// nudged toward Janet for those actions.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../lib/amplify";
import {
  callService,
  fetchState,
  invalidateLocalProbe,
  loadActiveHaConfig,
  type ActiveHaConfig,
} from "../../lib/ha";
import type { Schema } from "../../../amplify/data/resource";

type Device = Schema["homeDevice"]["type"];
type HaState = { state: string; attributes?: Record<string, unknown> };

interface ActionDef {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  service: string;
}

// Domain → list of available actions in the current state. Returns []
// for read-only domains so the row renders state without buttons.
function actionsFor(domain: string, state: string): ActionDef[] {
  switch (domain) {
    case "light":
    case "switch":
      return [
        state === "on"
          ? { label: "Off", icon: "power", service: "turn_off" }
          : { label: "On", icon: "power-outline", service: "turn_on" },
      ];
    case "lock":
      return state === "locked"
        ? [{ label: "Unlock", icon: "lock-open-outline", service: "unlock" }]
        : [{ label: "Lock", icon: "lock-closed-outline", service: "lock" }];
    case "cover":
      return [
        { label: "Open", icon: "chevron-up-outline", service: "open_cover" },
        { label: "Close", icon: "chevron-down-outline", service: "close_cover" },
      ];
    default:
      return [];
  }
}

function stateLabel(domain: string, state: string, attrs?: Record<string, unknown>): string {
  if (state === "unavailable") return "Unavailable";
  switch (domain) {
    case "light":
    case "switch":
      return state === "on" ? "On" : state === "off" ? "Off" : state;
    case "lock":
      return state === "locked" ? "Locked" : state === "unlocked" ? "Unlocked" : state;
    case "cover":
      return state.charAt(0).toUpperCase() + state.slice(1);
    case "climate": {
      const target = attrs?.temperature;
      const current = attrs?.current_temperature;
      if (typeof current === "number" && typeof target === "number") {
        return `${current}° → ${target}°`;
      }
      return state;
    }
    case "sensor": {
      const unit = attrs?.unit_of_measurement;
      return unit ? `${state} ${unit}` : state;
    }
    default:
      return state;
  }
}

function readState(d: Device): HaState | null {
  const raw = d.lastState;
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.state === "string" ? (parsed as HaState) : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && raw !== null && "state" in raw) {
    return raw as HaState;
  }
  return null;
}

export default function Home() {
  const [haConfig, setHaConfig] = useState<ActiveHaConfig | null | "loading">(
    "loading"
  );
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Per-device live HA state, keyed on entityId. Overrides the cached
  // lastState from the DB once we have a fresher read.
  const [liveState, setLiveState] = useState<Record<string, HaState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homeDevice.list();
    const pinned = (data ?? []).filter((d) => d.isPinned);
    setDevices(pinned);
    setLoading(false);
  }, []);

  // Re-check the active config + reload devices on every tab focus.
  // Probe runs once per focus (and on pull-to-refresh) so leaving and
  // returning to home re-checks "am I on home WiFi" without making
  // every action wait on a 1.5s probe.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        invalidateLocalProbe();
        const cfg = await loadActiveHaConfig();
        if (cancelled) return;
        setHaConfig(cfg);
      })();
      void loadDevices();
      return () => {
        cancelled = true;
      };
    }, [loadDevices])
  );

  async function refreshAll() {
    setRefreshing(true);
    try {
      // Re-probe in case we just walked through the front door.
      invalidateLocalProbe();
      const cfg = await loadActiveHaConfig();
      setHaConfig(cfg);
      if (!cfg) return;
      await loadDevices();
      const updates: Record<string, HaState> = {};
      // Sequential rather than parallel — small homes have a few
      // dozen pinned devices; HA REST handles bursts but a single
      // request stream is gentler on a residential router.
      for (const d of devices) {
        try {
          const live = await fetchState(cfg, d.entityId);
          updates[d.entityId] = {
            state: live.state,
            attributes: live.attributes,
          };
        } catch {
          /* leave previous value */
        }
      }
      setLiveState((prev) => ({ ...prev, ...updates }));
    } finally {
      setRefreshing(false);
    }
  }

  async function runAction(d: Device, service: string) {
    if (haConfig === "loading" || haConfig === null) return;
    const cfg = haConfig;

    // HIGH-sensitivity gating. When we're on home WiFi (probe says
    // local) we relax it to a confirm-prompt; when remote we still
    // refuse. Web/agent paths keep strict Duo as the formal channel.
    if (d.sensitivity === "HIGH") {
      if (!cfg.isLocal) {
        Alert.alert(
          "HIGH-sensitivity device",
          "Connect to your home WiFi to control this from mobile, or ask Janet from anywhere — HIGH-sensitivity actions skip Duo only when the app is on the home network."
        );
        return;
      }
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          `${service} ${d.friendlyName ?? d.entityId}?`,
          "Confirm — this is a HIGH-sensitivity device.",
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            {
              text: service,
              style: "destructive",
              onPress: () => resolve(true),
            },
          ],
          { cancelable: true, onDismiss: () => resolve(false) }
        );
      });
      if (!confirmed) return;
    }

    setBusyId(d.id);
    try {
      await callService(cfg, d.domain ?? "homeassistant", service, {
        entity_id: d.entityId,
      });
      // Re-read the actual state after a short delay so HA has time
      // to apply the change.
      setTimeout(async () => {
        try {
          const live = await fetchState(cfg, d.entityId);
          setLiveState((prev) => ({
            ...prev,
            [d.entityId]: { state: live.state, attributes: live.attributes },
          }));
        } catch {
          /* swallow — refresh button is still there */
        }
      }, 300);
    } catch (err: any) {
      Alert.alert("Action failed", err?.message ?? String(err));
    } finally {
      setBusyId(null);
    }
  }

  // Group by area; devices without an area go under "Other".
  const grouped = useMemo(() => {
    const m = new Map<string, Device[]>();
    for (const d of devices) {
      const key = d.area || "Other";
      const arr = m.get(key) ?? [];
      arr.push(d);
      m.set(key, arr);
    }
    // Sort areas alphabetically; "Other" last.
    return [...m.entries()].sort(([a], [b]) => {
      if (a === "Other") return 1;
      if (b === "Other") return -1;
      return a.localeCompare(b);
    });
  }, [devices]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.heading}>Home</Text>
        <View style={styles.headerRight}>
          {haConfig && haConfig !== "loading" && (
            <View
              style={[
                styles.connBadge,
                haConfig.isLocal ? styles.connBadgeLocal : styles.connBadgeRemote,
              ]}
            >
              <Ionicons
                name={haConfig.isLocal ? "wifi" : "cloud-outline"}
                size={11}
                color="#fff"
              />
              <Text style={styles.connBadgeText}>
                {haConfig.isLocal ? "LOCAL" : "REMOTE"}
              </Text>
            </View>
          )}
          {haConfig && haConfig !== "loading" && (
            <Pressable onPress={refreshAll} hitSlop={12} style={styles.headerBtn}>
              <Ionicons name="refresh" size={22} color="#735f55" />
            </Pressable>
          )}
        </View>
      </View>

      {haConfig === "loading" || loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : haConfig === null ? (
        <NotConfigured />
      ) : devices.length === 0 ? (
        <Text style={styles.empty}>
          No pinned devices. Pin some on the web /devices page (or ask Janet).
        </Text>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refreshAll} />
          }
        >
          {grouped.map(([area, areaDevices]) => (
            <View key={area} style={styles.areaBlock}>
              <Text style={styles.areaLabel}>{area}</Text>
              <View style={styles.card}>
                {areaDevices.map((d, i) => (
                  <DeviceRow
                    key={d.id}
                    device={d}
                    state={liveState[d.entityId] ?? readState(d)}
                    busy={busyId === d.id}
                    divider={i < areaDevices.length - 1}
                    isLocal={haConfig.isLocal}
                    onAction={(service) => runAction(d, service)}
                  />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function NotConfigured() {
  return (
    <View style={styles.center}>
      <Ionicons name="home-outline" size={36} color="#ccc" />
      <Text style={styles.notConfiguredText}>
        Connect Home Assistant to control your devices from here.
      </Text>
      <Pressable
        onPress={() => router.push("/more/ha-settings")}
        style={styles.connectBtn}
      >
        <Text style={styles.connectBtnText}>Set up Home Assistant</Text>
      </Pressable>
    </View>
  );
}

function DeviceRow({
  device,
  state,
  busy,
  divider,
  isLocal,
  onAction,
}: {
  device: Device;
  state: HaState | null;
  busy: boolean;
  divider: boolean;
  isLocal: boolean;
  onAction: (service: string) => void;
}) {
  const stateValue = state?.state ?? "unknown";
  const actions = actionsFor(device.domain ?? "", stateValue);
  const isHigh = device.sensitivity === "HIGH";
  // HIGH actions only enabled when we're on home WiFi. Off-network
  // taps still surface the explanatory alert via runAction.
  const highBlocked = isHigh && !isLocal;
  return (
    <View style={[styles.row, divider && styles.rowDivider]}>
      <View style={styles.rowLeft}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {device.friendlyName ?? device.entityId}
        </Text>
        <Text style={styles.rowMeta}>
          {stateLabel(device.domain ?? "", stateValue, state?.attributes)}
          {isHigh ? "  •  HIGH" : ""}
        </Text>
      </View>
      <View style={styles.rowActions}>
        {busy ? (
          <ActivityIndicator />
        ) : (
          actions.map((a) => (
            <Pressable
              key={a.service}
              onPress={() => onAction(a.service)}
              style={[styles.actionBtn, highBlocked && styles.actionBtnDisabled]}
            >
              <Ionicons
                name={a.icon}
                size={16}
                color={highBlocked ? "#aaa" : "#735f55"}
              />
              <Text
                style={[styles.actionText, highBlocked && styles.actionTextDisabled]}
              >
                {a.label}
              </Text>
            </Pressable>
          ))
        )}
      </View>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  heading: { fontSize: 28, fontWeight: "600" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerBtn: { padding: 4 },
  connBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  connBadgeLocal: { backgroundColor: "#4e5e53" },
  connBadgeRemote: { backgroundColor: "#a78a4f" },
  connBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.5,
  },

  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 12 },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  notConfiguredText: { color: "#666", fontSize: 14, textAlign: "center", lineHeight: 20 },
  connectBtn: {
    marginTop: 8,
    backgroundColor: "#735f55",
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
  },
  connectBtnText: { color: "#fff", fontWeight: "600" },

  body: { paddingHorizontal: 20, paddingBottom: 40 },
  areaBlock: { marginBottom: 16 },
  areaLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },

  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 8,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  rowLeft: { flex: 1 },
  rowTitle: { fontSize: 15, color: "#222" },
  rowMeta: { fontSize: 12, color: "#888", marginTop: 2 },

  rowActions: { flexDirection: "row", gap: 6 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    backgroundColor: "#fff",
  },
  actionBtnDisabled: { borderColor: "#eee", backgroundColor: "#f7f7f7" },
  actionText: { color: "#735f55", fontSize: 13, fontWeight: "500" },
  actionTextDisabled: { color: "#aaa" },
});
