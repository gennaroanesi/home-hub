// Home Assistant client. Reads the user's base URL + long-lived token
// from EXPO_PUBLIC_* env vars (preferred) or falling back to
// expo-secure-store, and calls HA's REST API directly. Used by the
// Home tab to render and control household devices.
//
// Env vars (set via mobile/.env.local for dev or EAS Secrets for
// builds): EXPO_PUBLIC_HA_BASE_URL, EXPO_PUBLIC_HA_TOKEN. They're
// embedded in the bundle at build time, so anyone with the .ipa can
// extract them — same threat model as the secure-store path on a
// stolen unlocked phone, so it's an acceptable trade for skipping
// the in-app input flow.
//
// On every fresh focus we probe http://homeassistant.local:8123 with
// the same token; if it answers we route subsequent calls there
// (faster, stays on LAN, lets us relax HIGH-sensitivity gating). The
// probe needs three Info.plist entries (NSAppTransportSecurity
// exception for HTTP to .local, NSLocalNetworkUsageDescription, and
// NSBonjourServices listing _home-assistant._tcp). Those live in
// app.json and require a dev-client rebuild to take effect.

import * as SecureStore from "expo-secure-store";

const KEY_BASE_URL = "ha_base_url";
const KEY_TOKEN = "ha_token";

const LOCAL_BASE = "http://homeassistant.local:8123";
const PROBE_TIMEOUT_MS = 1500;
const PROBE_CACHE_MS = 30_000;

const ENV_BASE_URL = process.env.EXPO_PUBLIC_HA_BASE_URL ?? "";
const ENV_TOKEN = process.env.EXPO_PUBLIC_HA_TOKEN ?? "";

export interface HaConfig {
  baseUrl: string;
  token: string;
}

/** Active config — same shape as HaConfig plus a flag the UI uses
 *  to badge "local" vs "remote" and decide whether HIGH-sensitivity
 *  actions are allowed without Duo. */
export interface ActiveHaConfig extends HaConfig {
  isLocal: boolean;
}

/** True when both pieces of credentials came from env vars; the
 *  settings screen uses this to show a read-only state instead of
 *  the input form. */
export function isEnvConfigured(): boolean {
  return !!ENV_BASE_URL && !!ENV_TOKEN;
}

/** Returns null if either piece of credentials is missing. Env vars
 *  win over secure-store so a build-time configured app doesn't get
 *  out of sync if the user typed something else once. */
export async function loadHaConfig(): Promise<HaConfig | null> {
  if (ENV_BASE_URL && ENV_TOKEN) {
    return { baseUrl: ENV_BASE_URL.replace(/\/+$/, ""), token: ENV_TOKEN };
  }
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(KEY_BASE_URL),
    SecureStore.getItemAsync(KEY_TOKEN),
  ]);
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export async function saveHaConfig(cfg: HaConfig): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEY_BASE_URL, cfg.baseUrl.trim().replace(/\/+$/, "")),
    SecureStore.setItemAsync(KEY_TOKEN, cfg.token.trim()),
  ]);
}

export async function clearHaConfig(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_BASE_URL),
    SecureStore.deleteItemAsync(KEY_TOKEN),
  ]);
}

/** GET /api/ — quick credential validation. */
export async function ping(cfg: HaConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${cfg.baseUrl}/api/`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status}` };
    }
    const json = await res.json().catch(() => ({}));
    return {
      ok: true,
      message: json?.message ?? "API running",
    };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? String(err) };
  }
}

// ── Local probe ─────────────────────────────────────────────────────────────

interface ProbeCacheEntry {
  isLocal: boolean;
  expiresAt: number;
}

let probeCache: ProbeCacheEntry | null = null;

/** Forget the cached probe result (e.g. after the user explicitly
 *  taps refresh, or when foregrounding the app from background). */
export function invalidateLocalProbe(): void {
  probeCache = null;
}

/**
 * Probe `http://homeassistant.local:8123/api/`. Returns true if HA
 * answered within PROBE_TIMEOUT_MS using the same token. Cached for
 * PROBE_CACHE_MS so we don't pay the latency on every call.
 */
async function probeLocal(token: string): Promise<boolean> {
  const now = Date.now();
  if (probeCache && probeCache.expiresAt > now) {
    return probeCache.isLocal;
  }
  let isLocal = false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${LOCAL_BASE}/api/`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    isLocal = res.ok;
  } catch {
    isLocal = false;
  } finally {
    clearTimeout(timer);
  }
  probeCache = { isLocal, expiresAt: now + PROBE_CACHE_MS };
  return isLocal;
}

/**
 * Resolve the active HA config. Probes the local URL first; falls
 * back to the configured public URL when the probe misses.
 */
export async function loadActiveHaConfig(): Promise<ActiveHaConfig | null> {
  const cfg = await loadHaConfig();
  if (!cfg) return null;
  const isLocal = await probeLocal(cfg.token);
  return isLocal
    ? { baseUrl: LOCAL_BASE, token: cfg.token, isLocal: true }
    : { ...cfg, isLocal: false };
}

// ── HA endpoints ────────────────────────────────────────────────────────────

/** Single entity state (raw HA shape: { entity_id, state, attributes, ... }). */
export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export async function fetchState(
  cfg: HaConfig,
  entityId: string
): Promise<HaEntityState> {
  const res = await fetch(
    `${cfg.baseUrl}/api/states/${encodeURIComponent(entityId)}`,
    { headers: { Authorization: `Bearer ${cfg.token}` } }
  );
  if (!res.ok) {
    throw new Error(`fetchState ${entityId}: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * One round-trip dump of every entity HA knows about. Cheaper for
 * polling than N individual /api/states/{id} calls when we want
 * fresh state for a dozen+ devices at once.
 */
export async function fetchAllStates(cfg: HaConfig): Promise<HaEntityState[]> {
  const res = await fetch(`${cfg.baseUrl}/api/states`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) throw new Error(`fetchAllStates: HTTP ${res.status}`);
  return res.json();
}

/**
 * Call a Home Assistant service. Mirrors pages/api/devices/control.ts
 * on the web side. HIGH-sensitivity gating is left to the caller —
 * Home tab allows HIGH only when the active config reports isLocal
 * (the user is plausibly on home WiFi).
 */
export async function callService(
  cfg: HaConfig,
  domain: string,
  service: string,
  data: Record<string, unknown> = {}
): Promise<unknown> {
  const url = `${cfg.baseUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${domain}.${service}: HTTP ${res.status} ${text}`);
  }
  return res.json();
}
