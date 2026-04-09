import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import { useS3AuthState } from "./s3-auth-state.js";
import { invokeHomeAgent } from "./appsync.js";
import { startServer, updateQR, updateStatus } from "./qr-server.js";

const logger = pino({ level: "info" });
const GROUP_JID = process.env.WHATSAPP_GROUP_JID;

if (!GROUP_JID) {
  logger.warn("WHATSAPP_GROUP_JID not set — bot will respond to all group messages");
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
      updateStatus("open");
      updateQR(null);
      logger.info("Connected to WhatsApp");
    }
  });

  // Persist creds on update
  socket.ev.on("creds.update", saveCreds);

  // Message handler
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Ignore own messages
      if (msg.key.fromMe) continue;

      // Only respond in the target group (if configured)
      const chatJid = msg.key.remoteJid;
      if (!chatJid?.endsWith("@g.us")) continue;
      if (GROUP_JID && chatJid !== GROUP_JID) continue;

      // Extract text
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text;

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
