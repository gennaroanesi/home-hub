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
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { useS3AuthState } from "./s3-auth-state.js";
import {
  listPendingOutboundMessages,
  markOutboundMessageSent,
  markOutboundMessageFailed,
  getPerson,
  listPersons,
  createInboundMessage,
  createAttachment,
  listAttachmentsByParent,
  type OutboundMessage,
  type HistoryMessage,
  type HistoryAttachment,
  type ChatContext,
} from "./appsync.js";
import { uploadInboundAttachment } from "./s3-upload.js";
import { startServer, updateQR, updateStatus } from "./qr-server.js";

const logger = pino({ level: "info" });
const GROUP_JID = process.env.WHATSAPP_GROUP_JID;
// Short interval because agent responses arrive via this queue — user is
// actively waiting for them. 5s is the minimum that keeps cost trivial
// (~12 AppSync list calls / min against an indexed status filter).
const OUTBOUND_POLL_MS = 5_000;

// Agent Lambda ARN (set by backend.ts). The bot invokes the Lambda with
// InvocationType="Event" (fire-and-forget) to sidestep AppSync's 30s
// resolver timeout — Duo flows and long tool-chain responses need the
// full 120s Lambda budget. Responses come back via the outbound queue.
const AGENT_LAMBDA_ARN = process.env.AGENT_LAMBDA_ARN;
const lambda = new LambdaClient({});

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

function getHistory(key: string): HistoryMessage[] {
  return chatHistories.get(key) ?? [];
}

function appendHistory(
  key: string,
  role: "user" | "assistant",
  content: string,
  attachments?: HistoryAttachment[]
): void {
  const buf = chatHistories.get(key) ?? [];
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
  chatHistories.set(key, buf);
}

// History key: groups use chatJid directly (stable across WA protocol
// versions). DMs use `person:${personId}` because the inbound chatJid is
// the @lid form (Baileys v7) while the outbound delivery JID is the
// phone-based @s.whatsapp.net form — keying by personId makes both
// directions converge on the same conversation history.
function historyKey(
  chatJid: string,
  isDm: boolean,
  personId?: string | null
): string {
  if (isDm && personId) return `person:${personId}`;
  return chatJid;
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
// digits → { name, id }. We store the person id in addition to the name
// so DM replies can be routed through homeOutboundMessage with
// target=PERSON without re-querying homePerson every turn.
interface KnownPerson {
  name: string;
  id: string;
}
let knownPhones: Map<string, KnownPerson> = new Map();

async function refreshKnownPhones(): Promise<void> {
  try {
    const persons = await listPersons();
    const next = new Map<string, KnownPerson>();
    for (const p of persons) {
      if (p.phoneNumber) {
        const digits = p.phoneNumber.replace(/[^\d]/g, "");
        if (digits) next.set(digits, { name: p.name, id: p.id });
      }
    }
    knownPhones = next;
    logger.info({ count: next.size }, "Refreshed known household phone cache");
  } catch (err) {
    logger.error({ err }, "Failed to refresh known phones");
  }
}

function isKnownDmSender(jid: string): KnownPerson | null {
  // JID for DMs is <digits>@s.whatsapp.net or <lid>@lid (v7+ addressing).
  // For @lid JIDs the digits won't match a phone number, so callers should
  // also try the remoteJidAlt (phone-based JID) when available.
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

  // Send text first so the agent's narrative lands before any attachments.
  const sent = await socket.sendMessage(toJid, { text: msg.text });
  if (sent?.key?.id) sentMessageIds.add(sent.key.id);

  // Pull attachments linked to this outbound message (agent_reply with
  // photos from send_photos, future scheduler-generated documents, etc.)
  // and deliver each via the Baileys media message type appropriate to
  // its contentType. Empty for most outbound messages — one extra AppSync
  // read per delivery is negligible.
  try {
    const atts = await listAttachmentsByParent(msg.id);
    // Batch images so they land as a WhatsApp album. WA groups multiple
    // images into one album-style card when they arrive back-to-back,
    // and parallel sends achieve that without any album-specific API
    // (which Baileys 7 doesn't expose directly). Non-image attachments
    // (PDFs, future docs) stay serialized — WA doesn't album documents.
    const images = atts.filter((a) => (a.contentType ?? "").startsWith("image/"));
    const docs = atts.filter((a) => !(a.contentType ?? "").startsWith("image/"));

    if (images.length > 0) {
      await Promise.all(
        images.map((att) =>
          deliverAttachment(socket, toJid!, att).catch((err) => {
            logger.error(
              { err, attachmentId: att.id, outboundId: msg.id },
              "Failed to deliver image"
            );
          })
        )
      );
    }
    for (const doc of docs) {
      try {
        await deliverAttachment(socket, toJid, doc);
      } catch (err) {
        logger.error(
          { err, attachmentId: doc.id, outboundId: msg.id },
          "Failed to deliver document"
        );
      }
    }
  } catch (err) {
    logger.error({ err, outboundId: msg.id }, "Failed to list attachments");
  }

  await markOutboundMessageSent(msg.id);

  // If this is an agent reply, append the assistant turn to in-memory
  // history so the next user message sees it. See historyKey() for why
  // DMs key by personId rather than chatJid.
  if (msg.kind === "agent_reply") {
    const isDm = msg.target === "PERSON";
    const keyJid = isDm ? toJid : (msg.groupJid ?? toJid);
    const hKey = historyKey(keyJid, isDm, msg.personId);
    appendHistory(hKey, "assistant", msg.text);
  }

  logger.info({ id: msg.id, kind: msg.kind, toJid }, "Outbound message sent");
}

// Deliver a single homeAttachment row via WhatsApp. Dispatches on
// contentType so adding a new media type (e.g. video) only requires a new
// branch here + a new upload helper; the schema is already polymorphic.
async function deliverAttachment(
  socket: ReturnType<typeof makeWASocket>,
  toJid: string,
  att: { s3Key: string; filename: string | null; contentType: string | null; caption: string | null }
): Promise<void> {
  // HACK: the agent handler stores CloudFront URLs (from send_photos) in
  // the s3Key field for outbound attachments. Detect URL-ness and pass
  // straight to Baileys. A future session should add a proper `sourceUrl`
  // field on homeAttachment to avoid this overload.
  const urlOrKey = att.s3Key;
  const isUrl = /^https?:\/\//i.test(urlOrKey);
  if (!isUrl) {
    // Non-URL s3 keys aren't supported yet — the bot's task role doesn't
    // have GetObject on arbitrary keys. Log + skip. When needed, add a
    // presign step here.
    logger.warn(
      { s3Key: urlOrKey, outboundAttachment: true },
      "Skipping non-URL outbound attachment (presign not implemented)"
    );
    return;
  }

  const caption = att.caption ?? undefined;
  const contentType = att.contentType ?? "";
  if (contentType.startsWith("image/")) {
    const sent = await socket.sendMessage(toJid, { image: { url: urlOrKey }, caption });
    if (sent?.key?.id) sentMessageIds.add(sent.key.id);
    return;
  }
  if (contentType === "application/pdf" || contentType.startsWith("application/")) {
    const sent = await socket.sendMessage(toJid, {
      document: { url: urlOrKey },
      mimetype: contentType || "application/pdf",
      fileName: att.filename ?? "document.pdf",
      caption,
    });
    if (sent?.key?.id) sentMessageIds.add(sent.key.id);
    return;
  }

  logger.warn({ contentType, s3Key: urlOrKey }, "Unsupported outbound attachment contentType");
}

// Tracks outbound IDs currently being delivered. Needed because marking
// a row SENT is the last step of deliverOutboundMessage, so a delivery
// that takes longer than OUTBOUND_POLL_MS (e.g. send_photos with 5
// images going through Baileys' encrypted upload) would otherwise get
// re-picked-up on the next poll and double-sent. Not a true lock (single
// process), but each ECS task runs desiredCount=1 so in-process tracking
// is sufficient. If we ever scale >1 task we'd need a "DELIVERING"
// status in the table instead.
const deliveringIds = new Set<string>();

async function pollOutbound(socket: ReturnType<typeof makeWASocket>): Promise<void> {
  try {
    const pending = await listPendingOutboundMessages();
    if (pending.length === 0) return;
    const fresh = pending.filter((m) => !deliveringIds.has(m.id));
    if (fresh.length === 0) return; // all in-flight already
    logger.info(
      { count: fresh.length, inFlight: deliveringIds.size },
      "Processing pending outbound messages"
    );
    for (const msg of fresh) {
      deliveringIds.add(msg.id);
      try {
        await deliverOutboundMessage(socket, msg);
      } catch (err: any) {
        logger.error({ err, id: msg.id }, "Failed to deliver outbound message");
        try {
          await markOutboundMessageFailed(msg.id, err?.message ?? String(err));
        } catch (markErr) {
          logger.error({ markErr, id: msg.id }, "Failed to mark outbound as failed");
        }
      } finally {
        deliveringIds.delete(msg.id);
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
        const isDm = jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
        if (isDm) {
          logger.info(
            { type, jid, altJid: (m.key as any).remoteJidAlt, msgKeys: Object.keys(m.message ?? {}), fromMe: m.key.fromMe },
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
      (m) => !m.key.fromMe && (
        m.key.remoteJid?.endsWith("@s.whatsapp.net") ||
        m.key.remoteJid?.endsWith("@lid")
      )
    );
    if (type !== "notify" && !hasDm) return;
    if (botIds.size === 0) return; // Not connected yet

    for (const msg of messages) {
      // Ignore own messages
      if (msg.key.fromMe) continue;

      const chatJid = msg.key.remoteJid;
      if (!chatJid) continue;

      const isGroup = chatJid.endsWith("@g.us");
      const isDm = chatJid.endsWith("@s.whatsapp.net") || chatJid.endsWith("@lid");

      // DM gate: only respond to known household members. Unknown DMs
      // (strangers, spam) are silently ignored.
      // Baileys v7 uses LID addressing — the phone-based JID is in
      // remoteJidAlt. Try both for the known-sender lookup.
      let dmSender: KnownPerson | null = null;
      if (isDm) {
        dmSender = isKnownDmSender(chatJid);
        const altJid = (msg.key as any).remoteJidAlt as string | undefined;
        if (!dmSender && altJid) {
          dmSender = isKnownDmSender(altJid);
        }
        if (!dmSender) continue;
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
          { chatJid, isDm, dmSenderName: dmSender?.name, dmSenderId: dmSender?.id, msgTypes, hasExtText: !!extText, hasImage: !!imageMsg, hasPlain: !!plainText },
          "DM message received"
        );
      }

      // Unified view over the message types that can carry text + a
      // contextInfo block (mentions, quoted replies). WA puts the caption
      // on the media block itself for photo/doc messages rather than on a
      // sibling text block, so we surface all of these uniformly.
      const docMsg = msg.message?.documentMessage;
      // PDF-only for now. The agent handler supports Claude's document
      // content-block which is PDF-only; other doc types would need OCR
      // or text extraction upstream.
      const isPdfDoc = !!docMsg && docMsg.mimetype === "application/pdf";

      const ext = imageMsg
        ? { text: imageMsg.caption ?? "", contextInfo: imageMsg.contextInfo }
        : isPdfDoc
          ? { text: docMsg?.caption ?? "", contextInfo: docMsg?.contextInfo }
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

      // Collect attachments (images + PDFs). Three shapes:
      //   a) direct image/pdf → msg.message.imageMessage / .documentMessage
      //   b) quoted media on a reply → contextInfo.quotedMessage.*
      // For (b) we build a synthetic WAMessage so downloadMediaMessage has
      // the right .message shape to operate on.
      type PendingAttachment = {
        buffer: Buffer;
        mimetype: string;
        filename: string;
      };
      const pendingAttachments: PendingAttachment[] = [];

      if (imageMsg) {
        try {
          const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          const mimetype = imageMsg.mimetype ?? "image/jpeg";
          pendingAttachments.push({
            buffer,
            mimetype,
            filename: `image.${mimetype.split("/")[1] ?? "jpg"}`,
          });
        } catch (err) {
          logger.error({ err }, "Failed to download direct image");
        }
      }

      if (isPdfDoc) {
        try {
          const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          pendingAttachments.push({
            buffer,
            mimetype: "application/pdf",
            filename: docMsg?.fileName ?? docMsg?.title ?? "document.pdf",
          });
        } catch (err) {
          logger.error({ err }, "Failed to download direct PDF");
        }
      }

      const quotedImage = ext.contextInfo?.quotedMessage?.imageMessage;
      if (quotedImage) {
        try {
          const syntheticMsg = {
            key: msg.key,
            message: ext.contextInfo?.quotedMessage,
          } as unknown as WAMessage;
          const buffer = (await downloadMediaMessage(syntheticMsg, "buffer", {})) as Buffer;
          const mimetype = quotedImage.mimetype ?? "image/jpeg";
          pendingAttachments.push({
            buffer,
            mimetype,
            filename: `image.${mimetype.split("/")[1] ?? "jpg"}`,
          });
        } catch (err) {
          logger.error({ err }, "Failed to download quoted image");
        }
      }

      const quotedDoc = ext.contextInfo?.quotedMessage?.documentMessage;
      if (quotedDoc && quotedDoc.mimetype === "application/pdf") {
        try {
          const syntheticMsg = {
            key: msg.key,
            message: ext.contextInfo?.quotedMessage,
          } as unknown as WAMessage;
          const buffer = (await downloadMediaMessage(syntheticMsg, "buffer", {})) as Buffer;
          pendingAttachments.push({
            buffer,
            mimetype: "application/pdf",
            filename: quotedDoc.fileName ?? quotedDoc.title ?? "document.pdf",
          });
        } catch (err) {
          logger.error({ err }, "Failed to download quoted PDF");
        }
      }

      // Upload buffers to S3. One failure shouldn't abort — log and move on.
      type UploadedAttachment = {
        s3Key: string;
        contentType: string;
        filename: string;
        sizeBytes: number;
      };
      const uploadedAttachments: UploadedAttachment[] = [];
      for (const att of pendingAttachments) {
        try {
          const key = await uploadInboundAttachment(att.buffer, att.mimetype);
          uploadedAttachments.push({
            s3Key: key,
            contentType: att.mimetype,
            filename: att.filename,
            sizeBytes: att.buffer.length,
          });
        } catch (err) {
          logger.error(
            { err, mimetype: att.mimetype, bytes: att.buffer?.length },
            "Failed to upload attachment to S3"
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

      // If there's no text but we have attachment(s), use a default prompt
      // so the agent has something to act on.
      if (!text) {
        if (uploadedAttachments.length > 0) {
          const hasPdf = uploadedAttachments.some((a) => a.contentType === "application/pdf");
          text = hasPdf ? "What's in this document?" : "What's in this image?";
        } else {
          // No text AND no attachments — nothing to respond to. This also
          // covers reply-to-bot triggers that were just a sticker/react.
          continue;
        }
      }

      // Get sender name. In DMs use the known-person name from our cache
      // (more reliable than pushName which can be empty or mismatched).
      const sender = isDm && dmSender
        ? dmSender.name
        : msg.pushName || msg.key.participant?.split("@")[0] || "unknown";

      if (isOnCooldown(sender)) continue;

      logger.info(
        { sender, text, chatJid, isDm, attachments: uploadedAttachments.length },
        "Received message"
      );

      try {
        if (!AGENT_LAMBDA_ARN) {
          throw new Error("AGENT_LAMBDA_ARN env var not set");
        }

        const hKey = historyKey(chatJid, isDm, dmSender?.id);
        const history = getHistory(hKey);

        // Prefix the user's name into the message body so the agent can
        // distinguish multi-person threads in the same chat (history is
        // shared across senders for this chat).
        const messageForAgent = `${sender}: ${text}`;
        const chatContext: ChatContext = {
          channel: isDm ? "WA_DM" : "WA_GROUP",
          chatJid,
        };

        // Reply routing: DMs go to the person (resolved via personId);
        // groups go back to the originating group (via its JID).
        const replyTarget = isDm && dmSender
          ? { target: "PERSON" as const, personId: dmSender.id }
          : { target: "GROUP" as const, groupJid: chatJid };

        // Persist the inbound message BEFORE invoking the Lambda so the
        // handler has an ID to attach its response to. The ID is also
        // the idempotency key — retries see PENDING vs PROCESSING /
        // RESPONDED and no-op.
        const altJid = (msg.key as any).remoteJidAlt as string | undefined;
        const senderJid = msg.key.participant ?? msg.key.remoteJid ?? chatJid;
        const inboundMessageId = await createInboundMessage({
          waMessageId: msg.key.id ?? "",
          chatJid,
          senderJid,
          senderJidAlt: altJid ?? null,
          senderName: sender,
          senderPersonId: dmSender?.id ?? null,
          channel: isDm ? "WA_DM" : "WA_GROUP",
          text: messageForAgent,
        });

        // Link each attachment to the inbound message. The handler
        // queries homeAttachment by parentId to load these back.
        for (const att of uploadedAttachments) {
          try {
            await createAttachment({
              parentType: "INBOUND_MESSAGE",
              parentId: inboundMessageId,
              s3Key: att.s3Key,
              filename: att.filename,
              contentType: att.contentType,
              sizeBytes: att.sizeBytes,
              uploadedBy: sender,
            });
          } catch (err) {
            logger.error({ err, s3Key: att.s3Key }, "Failed to create attachment row");
          }
        }

        // Append user turn to history immediately so follow-up messages
        // (while the agent is still working on this one) see the full
        // context. The assistant turn is appended when the response
        // arrives via the outbound poller (see deliverOutboundMessage).
        const userAttachments: HistoryAttachment[] = uploadedAttachments.map((a) => ({
          type: a.contentType === "application/pdf" ? "pdf" : "image",
          s3Key: a.s3Key,
        }));
        appendHistory(hKey, "user", messageForAgent, userAttachments);

        // Fire-and-forget async invoke. 202 returns immediately; the
        // Lambda has the full 120s budget (vs AppSync's 30s) to handle
        // Duo flows, image analysis, long tool chains, etc.
        await lambda.send(
          new InvokeCommand({
            FunctionName: AGENT_LAMBDA_ARN,
            InvocationType: "Event",
            Payload: Buffer.from(
              JSON.stringify({
                inboundMessageId,
                history,
                sender,
                chatContext,
                replyTarget,
              })
            ),
          })
        );

        logger.info(
          { inboundMessageId, sender, chatJid, attachments: uploadedAttachments.length },
          "Invoked agent async"
        );
      } catch (err) {
        logger.error({ err }, "Failed to queue agent request");
        try {
          const errMsg = await socket.sendMessage(chatJid, {
            text: "Sorry, I couldn't queue that for processing. Please try again.",
          });
          if (errMsg?.key?.id) sentMessageIds.add(errMsg.key.id);
        } catch (sendErr) {
          logger.error({ sendErr }, "Failed to send error message to user");
        }
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
