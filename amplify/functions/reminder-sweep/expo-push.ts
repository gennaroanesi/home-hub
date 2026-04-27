// Tiny Expo push client for use inside the reminder-sweep lambda.
// Speaks the Expo Push API directly (no SDK) — one HTTPS POST, no
// auth required. Mirrors what scripts/send-test-push.mjs does for
// ad-hoc testing, just inside the Lambda runtime.
//
// We pass through high-level errors; Expo will return per-token
// statuses in the `data` array so callers can decide whether to
// retire dead tokens.

const ENDPOINT = "https://exp.host/--/api/v2/push/send";

export interface ExpoPushMessage {
  to: string; // ExponentPushToken[xxx]
  title: string;
  body: string;
  /** Free-form data delivered to the device handler. */
  data?: Record<string, unknown>;
  /** Defaults to "default" so the device plays the system sound. */
  sound?: "default" | null;
}

export interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Send a batch of push notifications. Returns one ticket per message;
 * the caller can correlate by index.
 */
export async function sendExpoPush(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
  if (messages.length === 0) return [];
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(
      messages.map((m) => ({
        sound: m.sound === undefined ? "default" : m.sound,
        ...m,
      }))
    ),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Expo push HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return Array.isArray(json?.data) ? (json.data as ExpoPushTicket[]) : [];
}
