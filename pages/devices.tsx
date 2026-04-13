"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Switch } from "@heroui/switch";
import { addToast } from "@heroui/react";
import {
  FaArrowLeft,
  FaSync,
  FaThermometerHalf,
  FaLock,
  FaLockOpen,
  FaVideo,
  FaWarehouse,
  FaPlug,
  FaRobot,
  FaQuestion,
  FaStar,
  FaRegStar,
} from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Device = Schema["homeDevice"]["type"];

// ── State rendering helpers ────────────────────────────────────────────────
// The lastState JSON blob is HA's raw entity state. Each domain renders
// differently — climate shows current/target temp + mode, lock shows
// locked/unlocked, camera shows latest snapshot, etc. Anything unrecognized
// falls back to the raw state string.

interface HassState {
  state?: string;
  attributes?: Record<string, any>;
  lastUpdated?: string | null;
}

/**
 * homeDevice.lastState is stored as a JSON string (hass-sync writes
 * it that way to satisfy AppSync's AWSJSON scalar input validation).
 * Parse it here; also tolerate an already-parsed object for any legacy
 * rows that might still be around.
 */
function getState(device: Device): HassState | null {
  const raw = device.lastState;
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as HassState;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as HassState;
  return null;
}

function domainIcon(domain: string | null | undefined) {
  switch (domain) {
    case "climate":
      return <FaThermometerHalf />;
    case "lock":
      return <FaLock />;
    case "cover":
      return <FaWarehouse />;
    case "camera":
      return <FaVideo />;
    case "switch":
      return <FaPlug />;
    case "vacuum":
      return <FaRobot />;
    default:
      return <FaQuestion />;
  }
}

/**
 * Format a climate entity as "68°F · heat" etc. Falls back to the raw state
 * string if the expected attributes aren't there.
 */
function renderClimate(s: HassState): React.ReactNode {
  const attrs = s.attributes ?? {};
  const current = attrs.current_temperature;
  const target = attrs.temperature;
  const unit = attrs.temperature_unit ?? "°F";
  const mode = s.state;
  const parts: string[] = [];
  if (typeof current === "number") parts.push(`${Math.round(current)}${unit}`);
  if (typeof target === "number") parts.push(`→ ${Math.round(target)}${unit}`);
  if (mode && mode !== "off" && mode !== "unavailable") parts.push(mode);
  return parts.length > 0 ? parts.join(" · ") : (s.state ?? "—");
}

function renderLock(s: HassState): React.ReactNode {
  const locked = s.state === "locked";
  const unavailable = s.state === "unavailable";
  if (unavailable) return <span className="text-default-400">unavailable</span>;
  return (
    <span className={locked ? "text-success" : "text-warning"}>
      {locked ? (
        <>
          <FaLock className="inline mr-1" size={10} /> locked
        </>
      ) : (
        <>
          <FaLockOpen className="inline mr-1" size={10} /> unlocked
        </>
      )}
    </span>
  );
}

// Device control actions by domain
function getDeviceActions(device: Device): { label: string; service: string; icon: React.ReactNode; color: "primary" | "success" | "warning" | "danger" }[] {
  const s = getState(device);
  if (!s) return [];
  switch (device.domain) {
    case "lock":
      return s.state === "locked"
        ? [{ label: "Unlock", service: "unlock", icon: <FaLockOpen size={10} />, color: "warning" }]
        : [{ label: "Lock", service: "lock", icon: <FaLock size={10} />, color: "success" }];
    case "cover":
      return s.state === "closed"
        ? [{ label: "Open", service: "open_cover", icon: null, color: "warning" }]
        : [{ label: "Close", service: "close_cover", icon: null, color: "success" }];
    case "switch":
    case "light":
    case "fan":
      return s.state === "off"
        ? [{ label: "Turn on", service: "turn_on", icon: null, color: "primary" }]
        : [{ label: "Turn off", service: "turn_off", icon: null, color: "warning" }];
    default:
      return [];
  }
}

function renderCover(s: HassState): React.ReactNode {
  // Garage / door: "open" | "closed" | "opening" | "closing"
  const state = s.state ?? "—";
  const color =
    state === "closed" ? "text-success" : state === "open" ? "text-warning" : "";
  return <span className={color}>{state}</span>;
}

function renderSensor(s: HassState): React.ReactNode {
  const unit = s.attributes?.unit_of_measurement;
  if (!s.state) return "—";
  return unit ? `${s.state} ${unit}` : s.state;
}

function renderDeviceState(device: Device): React.ReactNode {
  const s = getState(device);
  if (!s) return <span className="text-default-400">no data</span>;

  switch (device.domain) {
    case "climate":
      return renderClimate(s);
    case "lock":
      return renderLock(s);
    case "cover":
      return renderCover(s);
    case "sensor":
    case "binary_sensor":
      return renderSensor(s);
    case "camera":
      return <span className="text-default-400">{s.state ?? "—"}</span>;
    default:
      return <span>{s.state ?? "—"}</span>;
  }
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function DevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  // When true, unpinned devices are shown too — use this to discover
  // things in the cache and pin them. Persists across renders only; not
  // saved to the user's profile because the expected flow is "flip it
  // on, pin the things you care about, flip it off".
  const [showUnpinned, setShowUnpinned] = useState(false);
  const [controlling, setControlling] = useState<string | null>(null); // entityId being controlled
  const [changingSensitivity, setChangingSensitivity] = useState<string | null>(null); // device.id
  const [myDuoUsername, setMyDuoUsername] = useState<string | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      await getCurrentUser();
      await loadDevices();
      // Load Duo username for HIGH-sensitivity device control
      try {
        const { data: auths } = await client.models.homePersonAuth.list({ limit: 10 });
        const first = (auths ?? [])[0];
        if (first) setMyDuoUsername((first as any).duoUsername ?? null);
      } catch { /* homePersonAuth may not exist yet */ }
    } catch {
      router.push("/login");
    }
  }

  const loadDevices = useCallback(async () => {
    setLoading(true);
    // Soft-fail if the model isn't deployed yet — lets the page render
    // something useful in the gap between schema bump and sandbox redeploy.
    try {
      const { data } = await client.models.homeDevice.list({ limit: 1000 });
      const all = data ?? [];
      setDevices(all);
      // Latest sync time across *all* devices — "last sync" is a global
      // concept, not per-pin.
      const latest = all
        .map((d) => d.lastSyncedAt)
        .filter((t): t is string => !!t)
        .sort()
        .pop();
      setLastSyncedAt(latest ?? null);
    } catch (err) {
      console.warn("homeDevice not available yet:", err);
      setDevices([]);
    }
    setLoading(false);
  }, []);

  async function togglePin(device: Device) {
    // Optimistic update — flip locally, then write. On failure we just
    // re-load from the source of truth.
    const next = !device.isPinned;
    setDevices((prev) =>
      prev.map((d) => (d.id === device.id ? { ...d, isPinned: next } : d))
    );
    try {
      await client.models.homeDevice.update({
        id: device.id,
        isPinned: next,
      });
    } catch (err) {
      console.error("Failed to toggle pin:", err);
      await loadDevices();
    }
  }

  async function controlDevice(device: Device, service: string) {
    setControlling(device.entityId ?? null);
    const isHigh = device.sensitivity === "HIGH";
    if (isHigh) {
      addToast({ title: "Duo push sent", description: "Approve on your phone…", color: "primary" });
    }
    try {
      const res = await fetch("/api/devices/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityId: device.entityId,
          domain: device.domain,
          service,
          sensitivity: device.sensitivity,
          duoUsername: isHigh ? myDuoUsername : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        addToast({ title: "Control failed", description: data.error ?? "Unknown error", color: "danger" });
        return;
      }
      addToast({ title: `${service} sent`, description: device.friendlyName ?? device.entityId });
      // Refresh device state after a short delay for HA to update
      setTimeout(() => handleSync(), 3000);
    } catch (err) {
      addToast({ title: "Control failed", description: err instanceof Error ? err.message : String(err), color: "danger" });
    } finally {
      setControlling(null);
    }
  }

  async function changeSensitivity(device: Device, newValue: string) {
    if (newValue === (device.sensitivity ?? "READ_ONLY")) return;

    // Require Duo approval to change sensitivity — this is a security-critical setting
    if (!myDuoUsername) {
      addToast({ title: "Duo required", description: "Link your Duo account at /security first", color: "warning" });
      return;
    }

    setChangingSensitivity(device.id);
    addToast({ title: "Duo push sent", description: "Approve to change sensitivity…", color: "primary" });
    try {
      const res = await fetch("/api/devices/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityId: "__sensitivity_change__",
          domain: "admin",
          service: "set_sensitivity",
          sensitivity: "HIGH", // always require Duo for sensitivity changes
          duoUsername: myDuoUsername,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        addToast({ title: "Denied", description: data.error ?? "Duo approval failed", color: "danger" });
        return;
      }

      // Duo approved — update the device
      await client.models.homeDevice.update({
        id: device.id,
        sensitivity: newValue as any,
      });
      setDevices((prev) =>
        prev.map((d) => (d.id === device.id ? { ...d, sensitivity: newValue } as any : d))
      );
      addToast({ title: "Sensitivity updated", description: `${device.friendlyName}: ${newValue}` });
    } catch (err) {
      addToast({ title: "Failed", description: err instanceof Error ? err.message : String(err), color: "danger" });
      await loadDevices(); // revert optimistic state
    } finally {
      setChangingSensitivity(null);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const { data, errors } = await client.mutations.syncHomeDevices({});
      if (errors?.length) throw new Error(errors[0].message);
      if (data && !data.hassAvailable) {
        setSyncError(data.error ?? "Home Assistant unreachable");
      }
      await loadDevices();
    } catch (err: any) {
      setSyncError(err?.message ?? "Sync failed");
    }
    setSyncing(false);
  }

  // Filter to visible devices (pinned only, or all if showUnpinned is on)
  const visibleDevices = useMemo(
    () => (showUnpinned ? devices : devices.filter((d) => d.isPinned)),
    [devices, showUnpinned]
  );

  const pinnedCount = useMemo(() => devices.filter((d) => d.isPinned).length, [devices]);

  // Group devices by area; devices without an area go in "Unassigned"
  const byArea = useMemo(() => {
    const groups = new Map<string, Device[]>();
    for (const d of visibleDevices) {
      const area = d.area ?? "Unassigned";
      if (!groups.has(area)) groups.set(area, []);
      groups.get(area)!.push(d);
    }
    // Sort within each area by domain then name
    const entries = Array.from(groups.entries());
    for (const [, list] of entries) {
      list.sort((a, b) => {
        if (a.domain !== b.domain) return (a.domain ?? "").localeCompare(b.domain ?? "");
        return (a.friendlyName ?? "").localeCompare(b.friendlyName ?? "");
      });
    }
    return entries.sort(([a], [b]) => {
      if (a === "Unassigned") return 1;
      if (b === "Unassigned") return -1;
      return a.localeCompare(b);
    });
  }, [visibleDevices]);

  function formatLastSync(iso: string | null): string {
    if (!iso) return "never";
    const d = new Date(iso);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return d.toLocaleDateString();
  }

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Devices</h1>
              <p className="text-xs text-default-400">
                {pinnedCount} pinned · {devices.length} in cache · synced {formatLastSync(lastSyncedAt)}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            color="primary"
            variant="flat"
            startContent={<FaSync size={12} className={syncing ? "animate-spin" : ""} />}
            isDisabled={syncing}
            onPress={handleSync}
          >
            {syncing ? "Syncing…" : "Refresh"}
          </Button>
        </div>

        {syncError && (
          <Card className="mb-4 bg-danger-50">
            <CardBody className="px-4 py-3">
              <p className="text-sm text-danger">⚠️ {syncError}</p>
            </CardBody>
          </Card>
        )}

        {/* Show-unpinned toggle — hidden until there's actually something in
            the cache, otherwise it's just clutter. */}
        {devices.length > 0 && (
          <div className="flex justify-end mb-3">
            <Switch
              size="sm"
              isSelected={showUnpinned}
              onValueChange={setShowUnpinned}
            >
              <span className="text-xs text-default-500">Show unpinned</span>
            </Switch>
          </div>
        )}

        {/* Empty states — three cases:
            - Nothing in cache: never synced, or sync failed
            - Things in cache but none pinned: show a helpful hint
            - Things pinned: rendered below this block */}
        {!loading && devices.length === 0 && (
          <Card>
            <CardBody className="px-4 py-10 text-center">
              <p className="text-sm text-default-500 mb-2">No devices synced yet.</p>
              <p className="text-xs text-default-400 mb-4">
                Hit Refresh to pull the current state from Home Assistant.
              </p>
            </CardBody>
          </Card>
        )}

        {!loading && devices.length > 0 && pinnedCount === 0 && !showUnpinned && (
          <Card>
            <CardBody className="px-4 py-8 text-center">
              <p className="text-sm text-default-500 mb-1">
                {devices.length} devices in the cache, but none are pinned.
              </p>
              <p className="text-xs text-default-400">
                Turn on <strong>Show unpinned</strong> above, then star the ones you want on the dashboard.
              </p>
            </CardBody>
          </Card>
        )}

        <div className="space-y-6">
          {byArea.map(([area, areaDevices]) => (
            <div key={area}>
              <h2 className="text-sm font-semibold text-default-600 uppercase tracking-wide mb-2">
                {area}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {areaDevices.map((device) => (
                  <Card key={device.id} className={device.isPinned ? "" : "opacity-70"}>
                    <CardHeader className="flex items-center gap-2 px-4 pt-3 pb-1">
                      <div className="text-default-500">{domainIcon(device.domain)}</div>
                      <p className="text-sm font-medium flex-1 min-w-0 truncate">
                        {device.friendlyName ?? device.entityId}
                      </p>
                      <Chip size="sm" variant="flat" className="capitalize">
                        {device.domain}
                      </Chip>
                      <button
                        onClick={() => togglePin(device)}
                        className="text-default-400 hover:text-warning transition-colors p-1"
                        title={device.isPinned ? "Unpin" : "Pin to dashboard"}
                        aria-label={device.isPinned ? "Unpin" : "Pin to dashboard"}
                      >
                        {device.isPinned ? (
                          <FaStar size={14} className="text-warning" />
                        ) : (
                          <FaRegStar size={14} />
                        )}
                      </button>
                    </CardHeader>
                    <CardBody className="px-4 pt-0 pb-3">
                      <p className="text-sm">{renderDeviceState(device)}</p>
                      {/* Control buttons */}
                      {device.sensitivity !== "READ_ONLY" && getDeviceActions(device).length > 0 && (
                        <div className="flex gap-2 mt-2">
                          {getDeviceActions(device).map((action) => (
                            <Button
                              key={action.service}
                              size="sm"
                              variant="flat"
                              color={action.color}
                              startContent={action.icon}
                              isLoading={controlling === device.entityId}
                              isDisabled={controlling !== null || (device.sensitivity === "HIGH" && !myDuoUsername)}
                              onPress={() => controlDevice(device, action.service)}
                            >
                              {action.label}
                            </Button>
                          ))}
                          {device.sensitivity === "HIGH" && !myDuoUsername && (
                            <span className="text-xs text-default-400 self-center">Duo required — link at /security</span>
                          )}
                        </div>
                      )}
                      {/* Sensitivity selector */}
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-xs text-default-400">Sensitivity:</span>
                        <select
                          className="text-xs border border-default-200 rounded px-1.5 py-0.5 bg-white"
                          value={device.sensitivity ?? "READ_ONLY"}
                          onChange={(e) => changeSensitivity(device, e.target.value)}
                          disabled={changingSensitivity === device.id}
                        >
                          <option value="READ_ONLY">Read-only</option>
                          <option value="LOW">Low</option>
                          <option value="MEDIUM">Medium</option>
                          <option value="HIGH">High</option>
                        </select>
                        {changingSensitivity === device.id && (
                          <span className="text-xs text-default-400">Verifying…</span>
                        )}
                      </div>
                      <p className="text-xs text-default-400 mt-1 truncate">
                        {device.entityId}
                      </p>
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Sensitivity note */}
        <p className="text-xs text-default-400 mt-8 text-center">
          Devices set to READ_ONLY have no controls. Change sensitivity in the device settings to enable.
        </p>
      </div>
    </DefaultLayout>
  );
}
