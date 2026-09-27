/**
 * POST /api/muse/tools/{name}
 *
 * Runs one home-agent tool directly (no LLM in the loop). Body is the
 * tool's input object as described by /api/muse/openapi.json.
 * Response: { result } on success, { error } otherwise.
 */
import { invokeAgent, listTools, missingRequired, withMuseAuth } from "@/lib/muse-api";

// Room for base64 images (add_inventory_photo). The request is forwarded
// to the agent Lambda, whose synchronous invoke payload caps out at 6 MB,
// so ~4 MB of image data is the practical limit — use imageUrl beyond that.
export const config = { api: { bodyParser: { sizeLimit: "6mb" } } };

export default withMuseAuth(async (req, res, { sender }) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const name = String(req.query.name ?? "");
  const input = req.body ?? {};
  if (typeof input !== "object" || Array.isArray(input)) {
    return res.status(400).json({ error: "Body must be a JSON object" });
  }

  try {
    const tool = (await listTools()).find((t) => t.name === name);
    if (!tool) {
      return res.status(404).json({ error: `Unknown tool: ${name}` });
    }
    const missing = missingRequired(tool, input);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required field(s): ${missing.join(", ")}` });
    }

    const out = await invokeAgent<{ result?: unknown; error?: string }>({
      apiTool: { name, input, sender },
    });
    if (out.error) return res.status(400).json({ error: out.error });
    return res.status(200).json({ result: out.result });
  } catch (err) {
    console.error(`[muse] tool ${name}:`, err);
    return res.status(502).json({ error: "Tool invocation failed" });
  }
});
