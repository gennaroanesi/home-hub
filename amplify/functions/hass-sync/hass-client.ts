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
   * state plus attributes. This is a single REST call and scales to
   * hundreds of entities without trouble.
   */
  async getStates(): Promise<HassEntity[]> {
    const res = await fetch(`${this.baseUrl}/api/states`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`HA getStates failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as HassEntity[];
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
