import makeWASocket, { DisconnectReason, fetchLatestWaWebVersion, jidNormalizedUser, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import { useS3AuthState } from "./s3-auth-state.js";
import {
  invokeHomeAgent,
  listPendingOutboundMessages,
  markOutboundMessageSent,
  markOutboundMessageFailed,
  getPerson,
  type OutboundMessage,
  type HistoryMessage,
} from "./appsync.js";
import { startServer, updateQR, updateStatus } from "./qr-server.js";

const logger = pino({ level: "info" });
const GROUP_JID = process.env.WHATSAPP_GROUP_JID;
const OUTBOUND_POLL_MS = 30_000;

if (GROUP_JID) {
  logger.info({ group: GROUP_JID }, "Bot will only respond to @-mentions in the configured group");
} else {
  logger.info("Bot will only respond to @-mentions in any group");
}

// Simple cooldown to avoid flooding the agent
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 3000;

// Per-chat short-term memory. We keep the last N user/assistant turns per
// group JID so the agent has context for follow-up questions ("did I do
// well?", "what did I just ask you to do?"). Memory is in-process only —
// it resets on every container restart, which is fine for the household
// use case (a fresh deploy starts a fresh conversation).
//
// Scoped per chat (not per sender) so the whole household participates
// in the same conversation: Cristine can follow up on something Gennaro
// just said.
const HISTORY_TURNS = 5; // = 10 messages (5 user + 5 assistant)
const chatHistories = new Map<string, HistoryMessage[]>();

function getHistory(chatJid: string): HistoryMessage[] {
  return chatHistories.get(chatJid) ?? [];
}

function appendHistory(chatJid: string, role: "user" | "assistant", content: string): void {
  const buf = chatHistories.get(chatJid) ?? [];
  buf.push({ role, content });
  // Trim to the last HISTORY_TURNS * 2 messages
  while (buf.length > HISTORY_TURNS * 2) buf.shift();
  chatHistories.set(chatJid, buf);
}

function isOnCooldown(sender: string): boolean {
  const last = cooldowns.get(sender) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return true;
  cooldowns.set(sender, Date.now());
  return false;
}

// ── Outbound message poller ─────────────────────────────────────────────────
// Checks AppSync for PENDING homeOutboundMessage rows and delivers them via
// the connected WhatsApp socket. Keeps composer (daily summary, future
// notifications) decoupled from delivery — if the bot is offline, messages
// just sit in PENDING until it comes back up.

function resolvePersonJid(phoneNumber: string): string {
  // E.164 → baileys JID. Strip '+' and any non-digits.
  const digits = phoneNumber.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}

async function deliverOutboundMessage(
  socket: ReturnType<typeof makeWASocket>,
  msg: OutboundMessage
): Promise<void> {
  let toJid: string | null = null;

  if (msg.target === "PERSON") {
    if (!msg.personId) {
      await markOutboundMessageFailed(msg.id, "PERSON target without personId");
      return;
    }
    const person = await getPerson(msg.personId);
    if (!person?.phoneNumber) {
      await markOutboundMessageFailed(
        msg.id,
        `Person ${msg.personId} has no phoneNumber configured`
      );
      return;
    }
    toJid = resolvePersonJid(person.phoneNumber);
  } else {
    // GROUP: honor override, else fall back to configured group
    toJid = msg.groupJid ?? GROUP_JID ?? null;
    if (!toJid) {
      await markOutboundMessageFailed(
        msg.id,
        "GROUP target with no groupJid and no WHATSAPP_GROUP_JID env"
      );
      return;
    }
  }

  await socket.sendMessage(toJid, { text: msg.text });
  await markOutboundMessageSent(msg.id);
  logger.info({ id: msg.id, kind: msg.kind, toJid }, "Outbound message sent");
}

async function pollOutbound(socket: ReturnType<typeof makeWASocket>): Promise<void> {
  try {
    const pending = await listPendingOutboundMessages();
    if (pending.length === 0) return;
    logger.info({ count: pending.length }, "Processing pending outbound messages");
    for (const msg of pending) {
      try {
        await deliverOutboundMessage(socket, msg);
      } catch (err: any) {
        logger.error({ err, id: msg.id }, "Failed to deliver outbound message");
        try {
          await markOutboundMessageFailed(msg.id, err?.message ?? String(err));
        } catch (markErr) {
          logger.error({ markErr, id: msg.id }, "Failed to mark outbound as failed");
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Outbound poll failed");
  }
}

async function startBot() {
  const { state, saveCreds } = await useS3AuthState();

  // Baileys hardcodes a WA Web client version that goes stale; WhatsApp's
  // handshake rejects old versions silently (handshake fails, no QR ever
  // emitted). Fetch the latest version on each boot.
  const { version, isLatest } = await fetchLatestWaWebVersion({});
  logger.info({ version, isLatest }, "Using WA Web version");

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
  });

  // Bot's own identifiers (set on connection open). WhatsApp groups now use
  // anonymous @lid JIDs for participants alongside the legacy @s.whatsapp.net
  // format, so we track both and treat a mention of either as "us".
  let botIds: Set<string> = new Set();
  let botPhoneNumber: string | null = null;

  // Outbound message poller handle — reset on each connection cycle
  let outboundPollHandle: NodeJS.Timeout | null = null;

  // Connection updates — QR code and status
  socket.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      updateQR(qr);
      logger.info("New QR code available at /qr");
    }

    if (connection === "close") {
      updateStatus("disconnected");
      updateQR(null);
      botIds = new Set();
      botPhoneNumber = null;

      if (outboundPollHandle) {
        clearInterval(outboundPollHandle);
        outboundPollHandle = null;
      }

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        logger.info("Connection closed, reconnecting...");
        startBot();
      } else {
        logger.error("Logged out — delete S3 auth state and re-scan QR");
      }
    }

    if (connection === "open") {
      const ids = new Set<string>();
      if (socket.user?.id) ids.add(jidNormalizedUser(socket.user.id));
      if (socket.user?.lid) ids.add(jidNormalizedUser(socket.user.lid));
      botIds = ids;
      // Phone number is the user portion of the @s.whatsapp.net JID — used to
      // strip @<number> mention tokens from message text before passing to the
      // agent. The @lid form is anonymous and never appears as a text mention.
      botPhoneNumber = socket.user?.id
        ? jidNormalizedUser(socket.user.id).split("@")[0]
        : null;
      updateStatus("open");
      updateQR(null);
      logger.info({ botIds: [...botIds], botPhoneNumber }, "Connected to WhatsApp");

      // Kick off outbound message polling. Poll once immediately so a queued
      // summary gets delivered on reconnect without waiting for the interval.
      if (!outboundPollHandle) {
        pollOutbound(socket);
        outboundPollHandle = setInterval(() => pollOutbound(socket), OUTBOUND_POLL_MS);
        logger.info({ intervalMs: OUTBOUND_POLL_MS }, "Outbound message poller started");
      }
    }
  });

  // Persist creds on update
  socket.ev.on("creds.update", saveCreds);

  // Message handler
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    if (botIds.size === 0) return; // Not connected yet

    for (const msg of messages) {
      // Ignore own messages
      if (msg.key.fromMe) continue;

      // Only respond in the target group (if configured)
      const chatJid = msg.key.remoteJid;
      if (!chatJid?.endsWith("@g.us")) continue;
      if (GROUP_JID && chatJid !== GROUP_JID) continue;

      // Only respond when the bot is @-mentioned. Plain `conversation` messages
      // can't carry mentions, so we only look at extendedTextMessage. The
      // mention list may contain either the @s.whatsapp.net JID or the
      // anonymous @lid form, so we accept either.
      const ext = msg.message?.extendedTextMessage;
      const mentioned = ext?.contextInfo?.mentionedJid ?? [];
      const isMentioned = mentioned.some((j) => botIds.has(j));
      if (!isMentioned) {
        // Info-level on purpose so we can debug JID-format mismatches in
        // production without flipping the global log level.
        logger.info({ chatJid, mentioned, botIds: [...botIds] }, "Group message ignored (not mentioned)");
        continue;
      }

      const rawText = ext?.text;
      if (!rawText) continue;

      // Strip the mention token(s) so the agent sees clean input. WhatsApp
      // may render the token using either the phone-number form (@1737...)
      // or the anonymous LID form (@241579696631954) depending on whether
      // the sender has the recipient saved as a contact.
      let text = rawText;
      for (const id of botIds) {
        const user = id.split("@")[0];
        text = text.replace(new RegExp(`@${user}\\b`, "g"), "");
      }
      text = text.trim();
      if (!text) continue;

      // Get sender name
      const sender = msg.pushName || msg.key.participant?.split("@")[0] || "unknown";

      if (isOnCooldown(sender)) continue;

      logger.info({ sender, text, group: chatJid }, "Received message");

      try {
        const history = getHistory(chatJid);
        // Prefix the user's name into the message body so the agent can
        // distinguish multi-person threads in the same chat (history is
        // shared across senders for this group).
        const messageForAgent = `${sender}: ${text}`;
        const response = await invokeHomeAgent(messageForAgent, sender, history);

        // Update memory with the turn we just had so the next call sees it.
        appendHistory(chatJid, "user", messageForAgent);
        appendHistory(chatJid, "assistant", response.message);

        // Text first, so the agent's narrative arrives before the photos
        await socket.sendMessage(chatJid, { text: response.message });
        logger.info({ sender, response: response.message }, "Sent response");

        // Then any attachments (e.g. photos from send_photos tool)
        for (const att of response.attachments ?? []) {
          if (att.type === "image" && att.url) {
            try {
              await socket.sendMessage(chatJid, {
                image: { url: att.url },
                caption: att.caption ?? undefined,
              });
            } catch (err) {
              logger.error({ err, url: att.url }, "Failed to send attachment");
            }
          }
        }
      } catch (err) {
        logger.error({ err }, "Failed to invoke agent");
        await socket.sendMessage(chatJid, {
          text: "Sorry, I couldn't process that right now. Please try again.",
        });
      }
    }
  });
}

// Start QR server and bot
startServer();
startBot().catch((err) => {
  logger.fatal({ err }, "Bot failed to start");
  process.exit(1);
});
