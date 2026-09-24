/**
 * GET /api/muse/openapi.json
 *
 * OpenAPI 3.1 spec for the Muse gateway, generated from the agent's
 * tool definitions so it can't drift from what /tools/{name} accepts.
 * Auth: `Authorization: Bearer <MUSE_API_KEY>` (see lib/muse-api.ts).
 */
import { baseUrlFor, buildOpenApiSpec, listTools, withMuseAuth } from "@/lib/muse-api";

export default withMuseAuth(async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const tools = await listTools();
    return res.status(200).json(buildOpenApiSpec(tools, baseUrlFor(req)));
  } catch (err) {
    console.error("[muse] openapi:", err);
    return res.status(502).json({ error: "Could not load tool definitions" });
  }
});
