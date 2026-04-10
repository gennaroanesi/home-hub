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

// Domains we skip entirely. HA surfaces a lot of internal entities
// (automations, scripts, sun, zones, persistent notifications, etc) that
// aren't useful to us and would bloat the table.
const SKIP_DOMAINS = new Set([
  "automation",
  "script",
  "scene",
  "zone",
  "sun",
  "persistent_notification",
  "input_boolean",
  "input_number",
  "input_select",
  "input_text",
  "input_datetime",
  "group",
  "conversation",
  "tts",
  "stt",
  "todo",
]);

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

  const ok = await hass.healthcheck();
  if (!ok) {
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
  let synced = 0;

  for (const entity of entities) {
    const domain = entityDomain(entity.entity_id);
    if (SKIP_DOMAINS.has(domain)) continue;

    // Area comes from the entity's area_id attribute when populated via
    // HA's area registry. Not every install sets this — fall back to null.
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
    synced++;
  }

  return { synced, hassAvailable: true, error: null };
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
