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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../lib/amplify";
import {
  callService,
  fetchAllStates,
  fetchState,
  invalidateLocalProbe,
  loadActiveHaConfig,
  loadHaConfig,
  type ActiveHaConfig,
} from "../../lib/ha";
import type { Schema } from "../../../amplify/data/resource";

const POLL_INTERVAL_MS = 10_000;

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
  // The user-configured public URL (env var or secure-store), used
  // for HA Companion deep-link routing. Distinct from haConfig.baseUrl
  // which may swap in the local http://homeassistant.local URL when
  // we're on home WiFi — universal links won't route from there.
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [allDevices, setAllDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Per-device live HA state, keyed on entityId. Overrides the cached
  // lastState from the DB once we have a fresher read.
  const [liveState, setLiveState] = useState<Record<string, HaState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scope, setScope] = useState<"pinned" | "all">("pinned");
  const [search, setSearch] = useState("");
  // Track whether the screen is currently focused. We only poll
  // when focused so a backgrounded tab doesn't keep banging on HA.
  const focusedRef = useRef(false);

  const loadDevices = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homeDevice.list();
    setAllDevices(data ?? []);
    setLoading(false);
  }, []);

  // Re-check the active config + reload devices on every tab focus.
  // Probe runs once per focus (and on pull-to-refresh) so leaving and
  // returning to home re-checks "am I on home WiFi" without making
  // every action wait on a 1.5s probe.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      let cancelled = false;
      (async () => {
        invalidateLocalProbe();
        const [active, configured] = await Promise.all([
          loadActiveHaConfig(),
          loadHaConfig(),
        ]);
        if (cancelled) return;
        setHaConfig(active);
        setPublicBaseUrl(configured?.baseUrl ?? "");
      })();
      void loadDevices();
      return () => {
        focusedRef.current = false;
        cancelled = true;
      };
    }, [loadDevices])
  );

  // Poll HA for fresh state every POLL_INTERVAL_MS while the tab is
  // focused AND the app is foregrounded. One /api/states call per
  // tick — cheaper than per-entity round trips for ~dozens of pinned
  // devices and lets unfocused devices (when scope === "all") catch
  // up too.
  useEffect(() => {
    if (!haConfig || haConfig === "loading") return;
    const cfg = haConfig;
    let cancelled = false;
    let appActive = AppState.currentState === "active";
    const sub = AppState.addEventListener("change", (state) => {
      appActive = state === "active";
    });

    async function poll() {
      if (cancelled || !focusedRef.current || !appActive) return;
      try {
        const states = await fetchAllStates(cfg);
        if (cancelled) return;
        const next: Record<string, HaState> = {};
        for (const s of states) {
          next[s.entity_id] = { state: s.state, attributes: s.attributes };
        }
        setLiveState(next);
      } catch {
        /* swallow — next tick retries; UI keeps showing stale state */
      }
    }
    // First tick fires immediately so the user doesn't sit on stale
    // data for 10 seconds after the screen loads.
    void poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      sub.remove();
    };
  }, [haConfig]);

  // Devices for the current scope + search filter.
  const filteredDevices = useMemo(() => {
    let list = scope === "pinned" ? allDevices.filter((d) => d.isPinned) : allDevices;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((d) => {
        const name = (d.friendlyName ?? "").toLowerCase();
        const eid = (d.entityId ?? "").toLowerCase();
        const area = (d.area ?? "").toLowerCase();
        return name.includes(q) || eid.includes(q) || area.includes(q);
      });
    }
    return list;
  }, [allDevices, scope, search]);
  const devices = filteredDevices;

  async function refreshAll() {
    setRefreshing(true);
    try {
      // Re-probe in case we just walked through the front door.
      invalidateLocalProbe();
      const cfg = await loadActiveHaConfig();
      setHaConfig(cfg);
      if (!cfg) return;
      await loadDevices();
      // One bulk fetch beats N per-entity calls. The polling loop uses
      // the same approach.
      try {
        const states = await fetchAllStates(cfg);
        const next: Record<string, HaState> = {};
        for (const s of states) {
          next[s.entity_id] = { state: s.state, attributes: s.attributes };
        }
        setLiveState(next);
      } catch {
        /* leave previous value */
      }
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
      ) : (
        <>
          <View style={styles.controls}>
            <Text style={styles.hint}>Long-press to view device on HA</Text>
            <View style={styles.scopeRow}>
              {(["pinned", "all"] as const).map((s) => {
                const on = scope === s;
                return (
                  <Pressable
                    key={s}
                    onPress={() => setScope(s)}
                    style={[styles.scopePill, on && styles.scopePillOn]}
                  >
                    <Text style={[styles.scopeText, on && styles.scopeTextOn]}>
                      {s === "pinned" ? "Pinned" : "All"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.searchRow}>
              <Ionicons name="search" size={14} color="#888" />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder={
                  scope === "all" ? "Search all devices" : "Search pinned"
                }
                placeholderTextColor="#888"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
            </View>
          </View>

          {devices.length === 0 ? (
            <Text style={styles.empty}>
              {search.trim()
                ? "No devices match."
                : scope === "pinned"
                  ? "No pinned devices. Pin some on the web /devices page (or ask Janet)."
                  : "No devices synced yet."}
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
                        publicBaseUrl={publicBaseUrl}
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
        </>
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
  publicBaseUrl,
  state,
  busy,
  divider,
  isLocal,
  onAction,
}: {
  device: Device;
  publicBaseUrl: string;
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

  // Long-press → open the entity's parent device page in the HA
  // Companion app via `homeassistant://navigate/config/devices/
  // device/<haDeviceId>`. That URL is the only one we found that
  // reliably lands on a specific entity surface in the iOS app —
  // the various ?more-info-entity-id query-param tricks just open
  // the default Lovelace overview.
  //
  // haDeviceId is HA's device-registry id, populated by hass-sync
  // through a template-API render. It can be null for entities
  // with no parent device (template sensors, helpers); in that case
  // we fall back to the entity-config URL on the web frontend.
  async function openInHa() {
    if (device.haDeviceId) {
      const url = `homeassistant://navigate/config/devices/device/${device.haDeviceId}`;
      try {
        await Linking.openURL(url);
        return;
      } catch {
        /* HA app not installed — try the web fallback below */
      }
    }
    if (!publicBaseUrl) {
      Alert.alert("HA URL not configured");
      return;
    }
    const webUrl = device.haDeviceId
      ? `${publicBaseUrl}/config/devices/device/${device.haDeviceId}`
      : `${publicBaseUrl}/config/entities/${encodeURIComponent(device.entityId)}`;
    await Linking.openURL(webUrl).catch(() => {
      Alert.alert("Couldn't open Home Assistant", webUrl);
    });
  }

  return (
    <Pressable
      onLongPress={openInHa}
      delayLongPress={400}
      style={[styles.row, divider && styles.rowDivider]}
    >
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
    </Pressable>
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

  controls: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    gap: 8,
  },
  hint: { fontSize: 12, color: "#888", fontStyle: "italic" },
  scopeRow: { flexDirection: "row", gap: 6 },
  scopePill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  scopePillOn: { backgroundColor: "#735f55", borderColor: "#735f55" },
  scopeText: { color: "#444", fontSize: 13 },
  scopeTextOn: { color: "#fff" },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 4 },

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
