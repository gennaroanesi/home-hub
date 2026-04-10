"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
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

function getState(device: Device): HassState | null {
  return (device.lastState as HassState) ?? null;
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

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      await getCurrentUser();
      await loadDevices();
    } catch {
      router.push("/login");
    }
  }

  const loadDevices = useCallback(async () => {
    setLoading(true);
    // Soft-fail if the model isn't deployed yet — lets the page render
    // something useful in the gap between schema bump and sandbox redeploy.
    try {
      const { data } = await client.models.homeDevice.list({ limit: 500 });
      const pinned = (data ?? []).filter((d) => d.isPinned);
      setDevices(pinned);
      // Compute the most recent sync time so the header can show it
      const latest = pinned
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

  // Group devices by area; devices without an area go in "Unassigned"
  const byArea = useMemo(() => {
    const groups = new Map<string, Device[]>();
    for (const d of devices) {
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
  }, [devices]);

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
                Last sync: {formatLastSync(lastSyncedAt)}
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

        <div className="space-y-6">
          {byArea.map(([area, areaDevices]) => (
            <div key={area}>
              <h2 className="text-sm font-semibold text-default-600 uppercase tracking-wide mb-2">
                {area}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {areaDevices.map((device) => (
                  <Card key={device.id}>
                    <CardHeader className="flex items-center gap-2 px-4 pt-3 pb-1">
                      <div className="text-default-500">{domainIcon(device.domain)}</div>
                      <p className="text-sm font-medium flex-1 min-w-0 truncate">
                        {device.friendlyName ?? device.entityId}
                      </p>
                      <Chip size="sm" variant="flat" className="capitalize">
                        {device.domain}
                      </Chip>
                    </CardHeader>
                    <CardBody className="px-4 pt-0 pb-3">
                      <p className="text-sm">{renderDeviceState(device)}</p>
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

        {/* v1 disclaimer */}
        <p className="text-xs text-default-400 mt-8 text-center">
          Read-only. Device control coming in v2.
        </p>
      </div>
    </DefaultLayout>
  );
}
