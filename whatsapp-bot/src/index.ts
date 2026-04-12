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
  listPersons,
  type OutboundMessage,
  type HistoryMessage,
  type HistoryAttachment,
  type ChatContext,
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

// Track message IDs sent by the bot so we can detect reply-to-bot.
// The contextInfo.participant JID on a reply may use an @lid form
// that doesn't match the bot's known JIDs, so we fall back to checking
// whether the quoted message's stanzaId is in this set.
const sentMessageIds = new Set<string>();
// Bounded by bot container restart cadence (~daily). At ~50 msgs/day
// this stays well under 1000 entries — no pruning needed.

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

// ── Known household members phone cache ────────────────────────────────────
// Used to gate DM access: only members whose phoneNumber is in homePerson
// can interact with the bot via direct message. The cache is loaded once
// at startup and refreshed every 10 minutes. Phone numbers are stored as
// E.164 (+12125551234) and compared as the digit-only suffix without the
// leading "+", since WA JIDs use the raw digits.

const KNOWN_PHONES_REFRESH_MS = 10 * 60 * 1000;
let knownPhones: Map<string, string> = new Map(); // digits → personName

async function refreshKnownPhones(): Promise<void> {
  try {
    const persons = await listPersons();
    const next = new Map<string, string>();
    for (const p of persons) {
      if (p.phoneNumber) {
        const digits = p.phoneNumber.replace(/[^\d]/g, "");
        if (digits) next.set(digits, p.name);
      }
    }
    knownPhones = next;
    logger.info({ count: next.size }, "Refreshed known household phone cache");
  } catch (err) {
    logger.error({ err }, "Failed to refresh known phones");
  }
}

function isKnownDmSender(jid: string): string | null {
  // JID for DMs is <digits>@s.whatsapp.net
  const digits = jid.split("@")[0];
  return knownPhones.get(digits) ?? null;
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

  const sent = await socket.sendMessage(toJid, { text: msg.text });
  if (sent?.key?.id) sentMessageIds.add(sent.key.id);
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

  // getMessage is required for Baileys to handle message retries on
  // linked devices. Without it, DMs (and sometimes group messages) fail
  // to decrypt on retry and are silently dropped — messages.upsert never
  // fires. The callback should return the original message content for a
  // given key; returning undefined is safe (Baileys treats it as "message
  // not found, skip retry") but providing it enables proper delivery.
  // For now we return undefined since we don't persist raw WA messages;
  // this is enough to unblock the retry protocol handshake.
  const getMessage = async (_key: any): Promise<any> => {
    return undefined;
  };

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
    getMessage,
    // Explicitly enable history sync so the linked device receives
    // encryption keys for DM chats. Without this, only group messages
    // are delivered — DMs require the key exchange that happens during
    // history sync. syncFullHistory=false keeps it lightweight (recent
    // messages only, not the full archive).
    shouldSyncHistoryMessage: () => true,
    syncFullHistory: false,
  });

  // Bot's own identifiers (set on connection open). WhatsApp groups now use
  // anonymous @lid JIDs for participants alongside the legacy @s.whatsapp.net
  // format, so we track both and treat a mention of either as "us".
  let botIds: Set<string> = new Set();
  let botPhoneNumber: string | null = null;

  // Outbound message poller handle — reset on each connection cycle
  let outboundPollHandle: NodeJS.Timeout | null = null;
  let phoneCacheHandle: NodeJS.Timeout | null = null;

  // Log history sync events — this confirms whether the linked device
  // receives DM chat keys during the initial sync handshake.
  socket.ev.on("messaging-history.set" as any, (data: any) => {
    const chatCount = data?.chats?.length ?? 0;
    const contactCount = data?.contacts?.length ?? 0;
    const msgCount = data?.messages?.length ?? 0;
    logger.info(
      { chatCount, contactCount, msgCount, isLatest: data?.isLatest },
      "History sync received"
    );
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
      botIds = new Set();
      botPhoneNumber = null;

      if (outboundPollHandle) {
        clearInterval(outboundPollHandle);
        outboundPollHandle = null;
      }
      if (phoneCacheHandle) {
        clearInterval(phoneCacheHandle);
        phoneCacheHandle = null;
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

      // Load the known-household-phone cache so DMs from members are
      // accepted. Refresh on an interval to pick up new members.
      if (!phoneCacheHandle) {
        refreshKnownPhones();
        phoneCacheHandle = setInterval(refreshKnownPhones, KNOWN_PHONES_REFRESH_MS);
        logger.info({ intervalMs: KNOWN_PHONES_REFRESH_MS }, "Known-phones cache refresh started");
      }
    }
  });

  // Persist creds on update
  socket.ev.on("creds.update", saveCreds);

  // Message handler
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    // Log ALL upsert events to diagnose DM delivery issues. The type
    // filter below may drop DMs that arrive as "append" instead of
    // "notify" — this log line fires before the filter.
    for (const m of messages) {
      if (!m.key.fromMe) {
        const jid = m.key.remoteJid ?? "?";
        const isDm = jid.endsWith("@s.whatsapp.net");
        if (isDm) {
          logger.info(
            { type, jid, msgKeys: Object.keys(m.message ?? {}), fromMe: m.key.fromMe },
            "DM upsert event (pre-filter)"
          );
        }
      }
    }
    // DMs may arrive as type "append" (not "notify") depending on
    // Baileys' linked-device sync state for that chat. Only filter
    // out non-notify for group messages — DMs from known members
    // should always be processed regardless of upsert type.
    const hasDm = messages.some(
      (m) => !m.key.fromMe && m.key.remoteJid?.endsWith("@s.whatsapp.net")
    );
    if (type !== "notify" && !hasDm) return;
    if (botIds.size === 0) return; // Not connected yet

    for (const msg of messages) {
      // Ignore own messages
      if (msg.key.fromMe) continue;

      const chatJid = msg.key.remoteJid;
      if (!chatJid) continue;

      const isGroup = chatJid.endsWith("@g.us");
      const isDm = chatJid.endsWith("@s.whatsapp.net");

      // DM gate: only respond to known household members. Unknown DMs
      // (strangers, spam) are silently ignored.
      let dmSenderName: string | null = null;
      if (isDm) {
        dmSenderName = isKnownDmSender(chatJid);
        if (!dmSenderName) continue;
      } else if (isGroup) {
        // Group gate: only respond in the configured group (if set)
        if (GROUP_JID && chatJid !== GROUP_JID) continue;
      } else {
        // Neither group nor DM — broadcast lists, status, etc. Ignore.
        continue;
      }

      // Unify text + image messages under one "ext-like" view. Plain
      // conversation messages can't carry mentions so we ignore them in
      // groups, but DMs don't need mentions — any text from a known member
      // is treated as an agent request. Both extendedTextMessage AND
      // imageMessage (with caption) can carry a contextInfo with mentions /
      // quoted messages — we treat them the same downstream.
      const extText = msg.message?.extendedTextMessage;
      const imageMsg = msg.message?.imageMessage;
      // Plain conversation message (no extended text, no image).
      const plainText = msg.message?.conversation;

      if (isDm) {
        // Log the message type for DM debugging. This helps diagnose when
        // a message arrives as an unexpected type and gets dropped.
        const msgTypes = Object.keys(msg.message ?? {}).filter(
          (k) => k !== "messageContextInfo" && k !== "senderKeyDistributionMessage"
        );
        logger.info(
          { chatJid, isDm, dmSenderName, msgTypes, hasExtText: !!extText, hasImage: !!imageMsg, hasPlain: !!plainText },
          "DM message received"
        );
      }

      // Only one will be set in practice. Prefer imageMessage when both are
      // present (WA uses imageMessage for "photo + caption" messages; the
      // text payload lives on the image block, not on a sibling text block).
      const ext = imageMsg
        ? { text: imageMsg.caption ?? "", contextInfo: imageMsg.contextInfo }
        : extText
          ? { text: extText.text ?? "", contextInfo: extText.contextInfo }
          : isDm && plainText
            ? { text: plainText, contextInfo: undefined as any }
            : null;

      if (!ext) {
        if (isDm) {
          logger.info({ chatJid, msgTypes: Object.keys(msg.message ?? {}) }, "DM message dropped — no extractable text");
        }
        continue;
      }

      if (isGroup) {
        // Group messages require @mention OR reply-to-bot.
        const mentionedJid = ext.contextInfo?.mentionedJid ?? [];
        const isMention = mentionedJid.some((j: string) => botIds.has(j));

        // Reply-to-bot detection. Three checks in order:
        // 1. stanzaId match — the quoted message's ID is in our sent set
        //    (most reliable, works regardless of JID format)
        // 2. participant JID exact match against botIds
        // 3. participant phone-digits match against botPhoneNumber
        const quotedStanzaId = ext.contextInfo?.stanzaId ?? null;
        const quotedAuthor = ext.contextInfo?.participant ?? null;
        let isReplyToBot = !!(quotedStanzaId && sentMessageIds.has(quotedStanzaId));
        if (!isReplyToBot && quotedAuthor) {
          isReplyToBot = botIds.has(quotedAuthor);
        }
        if (!isReplyToBot && quotedAuthor && botPhoneNumber) {
          isReplyToBot = quotedAuthor.split("@")[0] === botPhoneNumber;
        }

        if (!isMention && !isReplyToBot) {
          continue;
        }
      }
      // DMs from known members always pass through — no mention needed.

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

      // Get sender name. In DMs use the known-person name from our cache
      // (more reliable than pushName which can be empty or mismatched).
      const sender = isDm && dmSenderName
        ? dmSenderName
        : msg.pushName || msg.key.participant?.split("@")[0] || "unknown";

      if (isOnCooldown(sender)) continue;

      logger.info(
        { sender, text, chatJid, isDm, images: imageS3Keys.length },
        "Received message"
      );

      try {
        const history = getHistory(chatJid);
        // Prefix the user's name into the message body so the agent can
        // distinguish multi-person threads in the same chat (history is
        // shared across senders for this group).
        const messageForAgent = `${sender}: ${text}`;
        const chatContext: ChatContext = {
          channel: isDm ? "WA_DM" : "WA_GROUP",
          chatJid,
        };
        const response = await invokeHomeAgent(
          messageForAgent,
          sender,
          history,
          imageS3Keys.length > 0 ? imageS3Keys : undefined,
          chatContext
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
        const sentMsg = await socket.sendMessage(chatJid, { text: response.message });
        if (sentMsg?.key?.id) sentMessageIds.add(sentMsg.key.id);
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
        const errMsg = await socket.sendMessage(chatJid, {
          text: "Sorry, I couldn't process that right now. Please try again.",
        });
        if (errMsg?.key?.id) sentMessageIds.add(errMsg.key.id);
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
