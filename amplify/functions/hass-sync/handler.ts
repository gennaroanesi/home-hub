import type { Handler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/hass-sync";
import type { Schema } from "../../data/resource";
import { HassClient, entityDomain, friendlyName, type HassEntity } from "./hass-client.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

// Domains we care about for the dashboard. Anything else is still synced
// into the cache (so the agent can read it) but not pinned.
const AUTO_PIN_DOMAINS = new Set(["climate", "lock", "cover", "camera"]);

// Domains we skip entirely. HA surfaces a LOT of internal entities
// (automations, scripts, sun, zones, sensors, config helpers, etc) —
// for v1 we only want actionable devices and what renders on the
// dashboard. Every entity synced is a DynamoDB write, so every one
// we skip saves latency on the refresh button.
//
// Notably skipped for v1:
//   - sensor / binary_sensor: Unifi alone can surface 200+ of these
//     (signal, throughput, client counts, poe, etc). Opt-in later.
//   - device_tracker: used by v2 home-wifi detection, but read live
//     from HA when needed — no reason to sync into the cache.
//   - update / button / number / select / text: config helpers, not
//     things you'd ever put on a dashboard.
//
// Allowed: climate, lock, cover, camera, vacuum, light, switch, fan,
// media_player, alarm_control_panel, humidifier, water_heater, plus
// anything new we haven't specifically skipped.
const SKIP_DOMAINS = new Set([
  // HA internals
  "automation",
  "script",
  "scene",
  "zone",
  "sun",
  "persistent_notification",
  "group",
  "conversation",
  "tts",
  "stt",
  "todo",
  "calendar",
  "weather",
  // Config helpers
  "input_boolean",
  "input_number",
  "input_select",
  "input_text",
  "input_datetime",
  "number",
  "select",
  "text",
  "button",
  "update",
  // Noisy at volume
  "sensor",
  "binary_sensor",
  "device_tracker",
  "event",
  "image",
]);

// Concurrency limit for parallel DynamoDB upserts. Each write goes
// Lambda → AppSync → DDB, which is ~100-200ms per request; 10 at a
// time keeps the refresh under AppSync's 30s timeout even with many
// entities, without hammering AppSync's per-connection limit.
const WRITE_CONCURRENCY = 10;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const results = await Promise.allSettled(chunk.map(fn));
    for (const r of results) {
      if (r.status === "fulfilled") ok++;
      else {
        failed++;
        console.warn("upsert failed:", r.reason);
      }
    }
  }
  return { ok, failed };
}

interface SyncResult {
  synced: number;
  hassAvailable: boolean;
  error: string | null;
}

// ── Core sync logic ─────────────────────────────────────────────────────────

async function runSync(): Promise<SyncResult> {
  const baseUrl = env.HASS_BASE_URL;
  const token = env.HASS_TOKEN;

  if (!baseUrl || !token) {
    return {
      synced: 0,
      hassAvailable: false,
      error: "HASS_BASE_URL or HASS_TOKEN not set",
    };
  }

  const hass = new HassClient(baseUrl, token);

  const healthy = await hass.healthcheck();
  if (!healthy) {
    return {
      synced: 0,
      hassAvailable: false,
      error: "Home Assistant healthcheck failed",
    };
  }

  let entities: HassEntity[];
  try {
    entities = await hass.getStates();
  } catch (err: any) {
    return {
      synced: 0,
      hassAvailable: false,
      error: err?.message ?? "getStates failed",
    };
  }

  // Pull the existing homeDevice cache once so we can diff (update if
  // present, create if new). Secondary-indexed on entityId for quick lookup.
  const { data: existing } = await client.models.homeDevice.list({ limit: 1000 });
  const existingByEntityId = new Map(
    (existing ?? []).map((d) => [d.entityId, d])
  );

  const now = new Date().toISOString();

  // Filter down to entities we actually want to sync before kicking off
  // any writes. Log the counts so we can see what's happening in CloudWatch.
  const wanted = entities.filter((e) => !SKIP_DOMAINS.has(entityDomain(e.entity_id)));
  console.log(
    `hass-sync: fetched ${entities.length} entities, syncing ${wanted.length} after skip filter`
  );

  const { ok, failed } = await runWithConcurrency(wanted, WRITE_CONCURRENCY, async (entity) => {
    const domain = entityDomain(entity.entity_id);
    const area = (entity.attributes as any).area ?? null;
    const lastState = {
      state: entity.state,
      attributes: entity.attributes,
      lastUpdated: entity.last_updated ?? null,
    };

    const existingDevice = existingByEntityId.get(entity.entity_id);

    if (existingDevice) {
      // Update: preserve user-set fields (sensitivity, isPinned), refresh
      // state and metadata.
      await client.models.homeDevice.update({
        id: existingDevice.id,
        friendlyName: friendlyName(entity),
        domain,
        area,
        lastState,
        lastSyncedAt: now,
      });
    } else {
      // New: auto-pin if the domain is in the whitelist, default sensitivity
      // to READ_ONLY so controls stay opt-in.
      await client.models.homeDevice.create({
        entityId: entity.entity_id,
        friendlyName: friendlyName(entity),
        domain,
        area,
        sensitivity: "READ_ONLY",
        isPinned: AUTO_PIN_DOMAINS.has(domain),
        lastState,
        lastSyncedAt: now,
      });
    }
  });

  console.log(`hass-sync: upserted ${ok} devices, ${failed} failed`);

  return {
    synced: ok,
    hassAvailable: true,
    error: failed > 0 ? `${failed} upserts failed (see logs)` : null,
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────
// Single entrypoint used by both the AppSync resolver (syncHomeDevices
// mutation) and the EventBridge schedule. The return shape matches the
// GraphQL custom type and also satisfies EventBridge (which doesn't care).

export const handler: Handler<unknown, SyncResult> = async (event) => {
  const result = await runSync();
  // Log for the scheduled path — AppSync invocations already return
  // via GraphQL so there's no reason to surface the same data twice,
  // but a single log line per run is useful either way.
  console.log("hass-sync:", JSON.stringify({ event: typeof event, result }));
  return result;
};
