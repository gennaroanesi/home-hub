// Minimal Home Assistant REST client shared between hass-sync and
// daily-summary. Only implements the handful of endpoints we actually need
// — bringing in a full HA SDK would be overkill.
//
// Auth: long-lived access token (HA user profile → "Long-Lived Access Tokens")
// Base URL: the Nabu Casa remote URL (https://<token>.ui.nabu.casa)

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any> & {
    friendly_name?: string;
    device_class?: string;
    unit_of_measurement?: string;
  };
  last_changed?: string;
  last_updated?: string;
}

export class HassClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    // Strip trailing slash so concatenation is clean
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Ping HA's root API endpoint. Returns true if HA responds with its
   * expected "API running" payload within the timeout, false otherwise.
   * Used as a preflight before gathering state.
   */
  async healthcheck(timeoutMs = 5000): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${this.baseUrl}/api/`, {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch all entity states. HA returns an array of every entity's current
   * state plus attributes. Timeout-bounded so we don't hang when HA is
   * slow-but-responsive (which happens when the Nabu Casa tunnel is
   * degraded).
   */
  async getStates(timeoutMs = 15000): Promise<HassEntity[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/states`, {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HA getStates failed: ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as HassEntity[];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch a single entity by id. Throws if missing.
   */
  async getState(entityId: string): Promise<HassEntity> {
    const res = await fetch(
      `${this.baseUrl}/api/states/${encodeURIComponent(entityId)}`,
      { method: "GET", headers: this.headers() }
    );
    if (!res.ok) {
      throw new Error(`HA getState(${entityId}) failed: ${res.status}`);
    }
    return (await res.json()) as HassEntity;
  }

  /**
   * Map of entity_id → area_name for every entity that has an area
   * assigned. Areas live in HA's area_registry, which is only
   * exposed via the WebSocket API in REST-land. We work around it
   * by asking /api/template to render Jinja that walks every state
   * and emits a JSON object via `area_name(entity_id)` — one
   * REST call gets us the whole map.
   */
  async getAreaMap(timeoutMs = 15000): Promise<Record<string, string>> {
    const template = [
      "{% set ns = namespace(items={}) %}",
      "{% for s in states %}",
      "{% set a = area_name(s.entity_id) %}",
      "{% if a %}",
      "{% set ns.items = dict(ns.items, **{s.entity_id: a}) %}",
      "{% endif %}",
      "{% endfor %}",
      "{{ ns.items | tojson }}",
    ].join("");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/template`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ template }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HA getAreaMap failed: ${res.status} ${await res.text()}`);
      }
      const body = await res.text();
      try {
        return JSON.parse(body) as Record<string, string>;
      } catch {
        // Older HA might return non-JSON if the template errors. Treat
        // as "no areas known" — caller falls back to null and the UI
        // still groups under "Other".
        return {};
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Extract the HA domain from an entity id. `climate.living_room` → `climate`.
 */
export function entityDomain(entityId: string): string {
  return entityId.split(".")[0] ?? "";
}

/**
 * Pull a friendly name out of an entity. Falls back to the entity_id if HA
 * didn't set one.
 */
export function friendlyName(entity: HassEntity): string {
  return entity.attributes.friendly_name ?? entity.entity_id;
}
