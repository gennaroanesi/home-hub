/**
 * POST /api/devices/control
 *
 * Calls a Home Assistant service on a device. For HIGH-sensitivity
 * devices, requires Duo Push approval first.
 *
 * Body: { entityId, domain, service, serviceData?, duoUsername? }
 * - entityId: e.g. "lock.back_door"
 * - domain: e.g. "lock"
 * - service: e.g. "lock" or "unlock"
 * - serviceData: optional extra data (e.g. { temperature: 72 })
 * - duoUsername: required for HIGH-sensitivity devices
 *
 * Env vars required on the Amplify compute role:
 *   HASS_BASE_URL — e.g. https://xxx.ui.nabu.casa
 *   HASS_TOKEN — long-lived access token
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { preauth, pushAndWait } from "@/lib/duo-server";

const HASS_BASE_URL = process.env.HASS_BASE_URL ?? "";
const HASS_TOKEN = process.env.HASS_TOKEN ?? "";

async function callHassService(
  domain: string,
  service: string,
  data: Record<string, any>,
): Promise<any> {
  const url = `${HASS_BASE_URL}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HASS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HA ${domain}.${service} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { entityId, domain, service, serviceData, duoUsername, sensitivity } = req.body ?? {};

  if (!entityId || !domain || !service) {
    return res.status(400).json({ error: "entityId, domain, and service are required" });
  }

  // HASS env vars not needed for Duo-only requests (sensitivity changes)
  if (entityId !== "__sensitivity_change__" && (!HASS_BASE_URL || !HASS_TOKEN)) {
    return res.status(500).json({ error: "HASS_BASE_URL or HASS_TOKEN not configured" });
  }

  try {
    // HIGH sensitivity requires Duo Push
    if (sensitivity === "HIGH") {
      if (!duoUsername) {
        return res.status(403).json({ error: "Duo authentication required for HIGH-sensitivity devices" });
      }
      const pre = await preauth(duoUsername);
      if (pre.result !== "auth" && pre.result !== "allow") {
        return res.status(403).json({ error: `Duo preauth: ${pre.status_msg ?? pre.result}` });
      }
      if (pre.result === "auth") {
        const pushResult = await pushAndWait({
          username: duoUsername,
          pushinfo: { Action: `${service} ${entityId}`, Source: "Home Hub web" },
        });
        if (pushResult.result !== "allow") {
          return res.status(403).json({ error: `Duo push ${pushResult.result}: ${pushResult.status_msg}` });
        }
      }
    }

    // Sensitivity change is Duo-only — no HA call needed
    if (entityId === "__sensitivity_change__") {
      return res.status(200).json({ success: true, duoApproved: true });
    }

    // Call HA
    const result = await callHassService(domain, service, {
      entity_id: entityId,
      ...(serviceData ?? {}),
    });

    return res.status(200).json({ success: true, entityId, service, result });
  } catch (err) {
    console.error("Device control error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Internal error",
    });
  }
}
