import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  type WAMessage,
} from "@whiskeysockets/baileys";
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
  type HistoryAttachment,
} from "./appsync.js";
import { uploadAgentImage } from "./s3-upload.js";
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

function appendHistory(
  chatJid: string,
  role: "user" | "assistant",
  content: string,
  attachments?: HistoryAttachment[]
): void {
  const buf = chatHistories.get(chatJid) ?? [];
  const entry: HistoryMessage = { role, content };
  // Only user turns carry image attachments — assistant turns never do.
  // The agent handler's rehydration path only reads attachments off user
  // turns anyway, so this matches the server contract.
  if (role === "user" && attachments && attachments.length > 0) {
    entry.attachments = attachments;
  }
  buf.push(entry);
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

      // Unify text + image messages under one "ext-like" view. Plain
      // conversation messages can't carry mentions so we ignore them, but
      // both extendedTextMessage AND imageMessage (with caption) can carry
      // a contextInfo with mentions / quoted messages — we treat them the
      // same downstream.
      const extText = msg.message?.extendedTextMessage;
      const imageMsg = msg.message?.imageMessage;

      // Only one will be set in practice. Prefer imageMessage when both are
      // present (WA uses imageMessage for "photo + caption" messages; the
      // text payload lives on the image block, not on a sibling text block).
      const ext = imageMsg
        ? { text: imageMsg.caption ?? "", contextInfo: imageMsg.contextInfo }
        : extText
          ? { text: extText.text ?? "", contextInfo: extText.contextInfo }
          : null;

      if (!ext) continue;

      // Trigger 1: bot is @-mentioned (either @s.whatsapp.net or @lid form).
      // Trigger 2: user replied to a message Janet sent (contextInfo
      // participant — the quoted message's author — matches one of our
      // bot IDs). This lets "reply to Janet's message" work without
      // requiring a fresh @-mention.
      const mentionedJid = ext.contextInfo?.mentionedJid ?? [];
      const isMention = mentionedJid.some((j) => botIds.has(j));
      const quotedAuthor = ext.contextInfo?.participant ?? null;
      const isReplyToBot = !!(quotedAuthor && botIds.has(quotedAuthor));

      if (!isMention && !isReplyToBot) {
        // Info-level on purpose so we can debug JID-format mismatches in
        // production without flipping the global log level.
        logger.info(
          { chatJid, mentionedJid, quotedAuthor, botIds: [...botIds] },
          "Group message ignored (not mentioned and not a reply to bot)"
        );
        continue;
      }

      // Collect images attached to this turn. Two shapes:
      //   a) direct image-with-caption → msg.message.imageMessage
      //   b) a quoted image on a reply  → contextInfo.quotedMessage.imageMessage
      // For (b) we build a synthetic WAMessage so downloadMediaMessage has
      // the right .message shape to operate on.
      type PendingImage = { buffer: Buffer; mimetype: string };
      const pendingImages: PendingImage[] = [];

      if (imageMsg) {
        try {
          const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          pendingImages.push({
            buffer,
            mimetype: imageMsg.mimetype ?? "image/jpeg",
          });
        } catch (err) {
          logger.error({ err }, "Failed to download direct image");
        }
      }

      const quotedImage = ext.contextInfo?.quotedMessage?.imageMessage;
      if (quotedImage) {
        try {
          // Baileys' downloadMediaMessage inspects `.message.imageMessage`
          // (or videoMessage, etc.) on the WAMessage you pass in. We hand
          // it a synthetic WAMessage whose .message is the quoted content
          // directly, which is the pattern Baileys' own docs show for
          // downloading quoted media.
          const syntheticMsg = {
            key: msg.key,
            message: ext.contextInfo?.quotedMessage,
          } as unknown as WAMessage;
          const buffer = (await downloadMediaMessage(syntheticMsg, "buffer", {})) as Buffer;
          pendingImages.push({
            buffer,
            mimetype: quotedImage.mimetype ?? "image/jpeg",
          });
        } catch (err) {
          logger.error({ err }, "Failed to download quoted image");
        }
      }

      // Upload any successfully-downloaded buffers to S3. One failure
      // shouldn't abort the whole reply — log and move on.
      const imageS3Keys: string[] = [];
      for (const img of pendingImages) {
        try {
          const key = await uploadAgentImage(img.buffer, img.mimetype);
          imageS3Keys.push(key);
        } catch (err) {
          logger.error(
            { err, mimetype: img.mimetype, bytes: img.buffer?.length },
            "Failed to upload image to S3"
          );
        }
      }

      // Strip the mention token(s) so the agent sees clean input. WhatsApp
      // may render the token using either the phone-number form (@1737...)
      // or the anonymous LID form (@241579696631954) depending on whether
      // the sender has the recipient saved as a contact.
      let text = ext.text ?? "";
      for (const id of botIds) {
        const user = id.split("@")[0];
        text = text.replace(new RegExp(`@${user}\\b`, "g"), "");
      }
      text = text.trim();

      // If there's no text but we have image(s), use a default prompt so
      // the agent has something to act on. Mirrors how the web UI lets
      // users submit an image with an empty textbox.
      if (!text) {
        if (imageS3Keys.length > 0) {
          text = "What's in this image?";
        } else {
          // No text AND no images — nothing to respond to. This also
          // covers reply-to-bot triggers that were just a sticker/react.
          continue;
        }
      }

      // Get sender name
      const sender = msg.pushName || msg.key.participant?.split("@")[0] || "unknown";

      if (isOnCooldown(sender)) continue;

      logger.info(
        { sender, text, group: chatJid, images: imageS3Keys.length, isMention, isReplyToBot },
        "Received message"
      );

      try {
        const history = getHistory(chatJid);
        // Prefix the user's name into the message body so the agent can
        // distinguish multi-person threads in the same chat (history is
        // shared across senders for this group).
        const messageForAgent = `${sender}: ${text}`;
        const response = await invokeHomeAgent(
          messageForAgent,
          sender,
          history,
          imageS3Keys.length > 0 ? imageS3Keys : undefined
        );

        // Update memory with the turn we just had so the next call sees
        // it. Carry the image attachments on the user turn so the agent
        // handler's rehydration path can replay them on the next call.
        const userAttachments: HistoryAttachment[] = imageS3Keys.map((k) => ({
          type: "image",
          s3Key: k,
        }));
        appendHistory(chatJid, "user", messageForAgent, userAttachments);
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
