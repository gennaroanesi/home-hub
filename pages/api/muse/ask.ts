/**
 * POST /api/muse/ask
 *
 * Free-form request to the home agent, same brain as WhatsApp but
 * restricted to the API tool set (no Duo / WhatsApp-only tools).
 * Body: { message: string }
 * Response: { message, actionsTaken }
 *
 * Runs synchronously, so it's bounded by the SSR request timeout —
 * long multi-tool requests may be cut off; prefer /tools/{name}.
 */
import { invokeAgent, withMuseAuth } from "@/lib/muse-api";

export default withMuseAuth(async (req, res, { sender }) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const message = req.body?.message;
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const out = await invokeAgent<{ message: string; actionsTaken: unknown[] }>({
      arguments: {
        message,
        history: [],
        sender,
        chatContext: { channel: "API", chatJid: null },
      },
    });
    return res.status(200).json({ message: out.message, actionsTaken: out.actionsTaken });
  } catch (err) {
    console.error("[muse] ask:", err);
    return res.status(502).json({ error: "Agent invocation failed" });
  }
});
