/**
 * GET /api/v1/openapi.json
 *
 * OpenAPI 3.1 spec for the external API, generated from the agent's
 * tool definitions so it can't drift from what /tools/{name} accepts.
 * Auth: `Authorization: Bearer <MUSE_API_KEY>` (see lib/external-api.ts).
 */
import { baseUrlFor, buildOpenApiSpec, listTools, withApiKey } from "@/lib/external-api";

export default withApiKey(async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const tools = await listTools();
    return res.status(200).json(buildOpenApiSpec(tools, baseUrlFor(req)));
  } catch (err) {
    console.error("[api] openapi:", err);
    return res.status(502).json({ error: "Could not load tool definitions" });
  }
});
