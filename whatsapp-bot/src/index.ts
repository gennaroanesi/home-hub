import makeWASocket, { DisconnectReason, jidNormalizedUser, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import { useS3AuthState } from "./s3-auth-state.js";
import { invokeHomeAgent } from "./appsync.js";
import { startServer, updateQR, updateStatus } from "./qr-server.js";

const logger = pino({ level: "info" });
const GROUP_JID = process.env.WHATSAPP_GROUP_JID;

if (GROUP_JID) {
  logger.info({ group: GROUP_JID }, "Bot will only respond to @-mentions in the configured group");
} else {
  logger.info("Bot will only respond to @-mentions in any group");
}

// Simple cooldown to avoid flooding the agent
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 3000;

function isOnCooldown(sender: string): boolean {
  const last = cooldowns.get(sender) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return true;
  cooldowns.set(sender, Date.now());
  return false;
}

async function startBot() {
  const { state, saveCreds } = await useS3AuthState();

  const socket = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
  });

  // Bot's own JID (set on connection open). Normalized to strip device suffix
  // so it matches the format used in contextInfo.mentionedJid.
  let botJid: string | null = null;

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
      botJid = null;

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
      botJid = socket.user?.id ? jidNormalizedUser(socket.user.id) : null;
      updateStatus("open");
      updateQR(null);
      logger.info({ botJid }, "Connected to WhatsApp");
    }
  });

  // Persist creds on update
  socket.ev.on("creds.update", saveCreds);

  // Message handler
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    if (!botJid) return; // Not connected yet

    for (const msg of messages) {
      // Ignore own messages
      if (msg.key.fromMe) continue;

      // Only respond in the target group (if configured)
      const chatJid = msg.key.remoteJid;
      if (!chatJid?.endsWith("@g.us")) continue;
      if (GROUP_JID && chatJid !== GROUP_JID) continue;

      // Only respond when the bot is @-mentioned. Plain `conversation` messages
      // can't carry mentions, so we only look at extendedTextMessage.
      const ext = msg.message?.extendedTextMessage;
      const mentioned = ext?.contextInfo?.mentionedJid ?? [];
      if (!mentioned.includes(botJid)) continue;

      const rawText = ext?.text;
      if (!rawText) continue;

      // Strip the @<botNumber> mention token so the agent sees clean input
      const botNumber = botJid.split("@")[0];
      const text = rawText.replace(new RegExp(`@${botNumber}\\b`, "g"), "").trim();
      if (!text) continue;

      // Get sender name
      const sender = msg.pushName || msg.key.participant?.split("@")[0] || "unknown";

      if (isOnCooldown(sender)) continue;

      logger.info({ sender, text, group: chatJid }, "Received message");

      try {
        const response = await invokeHomeAgent(text, sender);

        await socket.sendMessage(chatJid, { text: response.message });
        logger.info({ sender, response: response.message }, "Sent response");
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
