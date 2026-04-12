// Minimal Home Assistant REST client — agent-local copy.
//
// This is a copy of amplify/functions/hass-sync/hass-client.ts with the
// addition of callService() for v2 device control. Each Lambda function
// in Amplify Gen 2 has its own build pipeline, so sharing a source file
// across sibling functions isn't supported cleanly. Keeping a separate
// copy is the same pattern used for duo.ts vs lib/duo-server.ts.
//
// Auth: long-lived access token (HA user profile -> "Long-Lived Access Tokens")
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
   * Call a Home Assistant service. Returns the response entities (HA
   * returns the entities that changed state as a result of the call).
   */
  async callService(
    domain: string,
    service: string,
    data: Record<string, any>,
    timeoutMs = 10000
  ): Promise<HassEntity[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(
        `${this.baseUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(data),
          signal: controller.signal,
        }
      );
      if (!res.ok) {
        throw new Error(
          `HA callService(${domain}.${service}) failed: ${res.status} ${await res.text()}`
        );
      }
      return (await res.json()) as HassEntity[];
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Extract the HA domain from an entity id. `climate.living_room` -> `climate`.
 */
export function entityDomain(entityId: string): string {
  return entityId.split(".")[0] ?? "";
}
