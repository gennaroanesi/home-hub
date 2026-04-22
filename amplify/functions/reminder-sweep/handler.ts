import type { Handler } from "aws-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/reminder-sweep";
import type { Schema } from "../../data/resource";
import {
  type ReminderItem,
  parseItems,
  nextOccurrence,
  earliestNextOccurrence,
} from "../../../lib/reminder-schedule.js";
import {
  getHouseholdTimezone,
  resolveReminderTimezone,
} from "../../../lib/household-settings.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const anthropic = new Anthropic();
const MODEL_ID = "claude-haiku-4-5-20251001";

// Early-bias window: items that come due within this many minutes from
// now are considered "due now" and will fire on this sweep. Cheap
// insurance against items missing their window due to sweep timing —
// we'd rather tell someone about a pill 5 minutes early than late.
const EARLY_BIAS_MIN = 15;

// Lookback window: also catch items whose next occurrence fell in the
// last few minutes (in case a sweep missed). Smaller than early-bias
// because late delivery is worse than early.
const LOOKBACK_MIN = 5;

// How many recent sent messages to load for LLM composition context.
// Helps Haiku vary wording and not repeat itself.
const LLM_HISTORY_LIMIT = 5;

// ── Composition ─────────────────────────────────────────────────────────────

async function composeWithLlm(
  reminder: { name: string; kind?: string | null },
  dueItems: ReminderItem[],
  recentMessages: { sentAt: string; text: string }[],
  now: Date
): Promise<string> {
  const timeLabel = now.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
  const itemsText = dueItems
    .map((i) => `- ${i.name}${i.notes ? ` (${i.notes})` : ""}`)
    .join("\n");
  const historyText =
    recentMessages.length > 0
      ? recentMessages
          .map((m) => {
            const when = new Date(m.sentAt).toLocaleString("en-US", {
              timeZone: "America/Chicago",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            });
            return `[${when}] ${m.text}`;
          })
          .join("\n")
      : "(no recent messages)";

  const prompt = `You are Janet, a household assistant. Compose a brief WhatsApp reminder message.

Reminder: ${reminder.name}
${reminder.kind ? `Kind: ${reminder.kind}` : ""}
Current time: ${timeLabel} Central

Items due now:
${itemsText}

Last ${recentMessages.length} messages sent for this reminder (avoid repeating phrasing):
${historyText}

Constraints:
- Output ONLY the message text. No preamble, no explanation, no quotes.
- Brief — aim for under 30 words unless listing many items.
- Include WHAT needs to be done (item names), so the recipient doesn't have to look it up.
- Vary phrasing vs the recent history when possible.
- At most one emoji, only if it adds value.
- Friendly but not cloying.`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL_ID,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text || composeDeterministic(reminder, dueItems);
  } catch (err) {
    console.warn("LLM compose failed, falling back to deterministic:", err);
    return composeDeterministic(reminder, dueItems);
  }
}

function composeDeterministic(
  reminder: { name: string },
  dueItems: ReminderItem[]
): string {
  if (dueItems.length === 1) {
    const item = dueItems[0];
    return item.notes ? `${item.name} — ${item.notes}` : item.name;
  }
  const list = dueItems
    .map((i) => `• ${i.name}${i.notes ? ` (${i.notes})` : ""}`)
    .join("\n");
  return `*${reminder.name}*\n${list}`;
}

// ── Per-reminder processing ─────────────────────────────────────────────────

async function processReminder(
  reminder: Schema["homeReminder"]["type"],
  now: Date,
  householdTz: string
): Promise<{
  fired: boolean;
  nextScheduledAt: string | null;
  updatedItems: ReminderItem[];
}> {
  const items = parseItems(reminder.items);
  if (items.length === 0) {
    return { fired: false, nextScheduledAt: null, updatedItems: [] };
  }

  // Resolve effective TZ: person's TZ if the reminder is PERSON-targeted
  // and that person has a defaultTimezone set; else household TZ.
  let targetPersonTz: string | null = null;
  if (reminder.targetKind === "PERSON" && reminder.personId) {
    try {
      const { data: person } = await client.models.homePerson.get({
        id: reminder.personId,
      });
      targetPersonTz = person?.defaultTimezone ?? null;
    } catch {
      // fall through to household TZ
    }
  }
  const tz = resolveReminderTimezone({
    targetKind: reminder.targetKind,
    targetPersonTz,
    householdTz,
  });

  // Window: items whose next occurrence falls in (now - lookback, now + earlyBias]
  const windowStart = new Date(now.getTime() - LOOKBACK_MIN * 60_000);
  const windowEnd = new Date(now.getTime() + EARLY_BIAS_MIN * 60_000);

  // For each item, compute its next occurrence past the last fire (or start).
  const dueItems: ReminderItem[] = [];
  const updatedItems: ReminderItem[] = [];
  for (const item of items) {
    const lastSeen = item.lastFiredAt ? new Date(item.lastFiredAt) : windowStart;
    const searchFrom = lastSeen > windowStart ? lastSeen : windowStart;
    const next = nextOccurrence(item, searchFrom, tz);
    if (next && next >= windowStart && next <= windowEnd) {
      dueItems.push(item);
      updatedItems.push({ ...item, lastFiredAt: next.toISOString() });
    } else {
      updatedItems.push(item);
    }
  }

  if (dueItems.length === 0) {
    // Nothing due yet — recompute scheduledAt and move on.
    const nextAcross = earliestNextOccurrence(items, now, tz);
    return {
      fired: false,
      nextScheduledAt: nextAcross
        ? new Date(nextAcross.getTime() - EARLY_BIAS_MIN * 60_000).toISOString()
        : null,
      updatedItems: items,
    };
  }

  // Fetch recent messages for LLM context (only if needed)
  let recentMessages: { sentAt: string; text: string }[] = [];
  if (reminder.useLlm) {
    try {
      const { data: history } = await client.models.homeOutboundMessage.list({
        filter: { sourceReminderId: { eq: reminder.id } },
        limit: 50,
      });
      recentMessages = (history ?? [])
        .filter((m) => m.sentAt)
        .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))
        .slice(0, LLM_HISTORY_LIMIT)
        .map((m) => ({ sentAt: m.sentAt ?? "", text: m.text }));
    } catch (err) {
      console.warn("Failed to load recent messages for LLM context:", err);
    }
  }

  // Compose message text
  const text = reminder.useLlm
    ? await composeWithLlm(
        { name: reminder.name, kind: reminder.kind },
        dueItems,
        recentMessages,
        now
      )
    : composeDeterministic({ name: reminder.name }, dueItems);

  // Write outbound message
  const firedItemIds = dueItems.map((i) => i.id);
  const outboundPayload = {
    channel: "WHATSAPP" as const,
    target: reminder.targetKind ?? "GROUP",
    personId: reminder.personId ?? null,
    groupJid: reminder.groupJid ?? null,
    text,
    status: "PENDING" as const,
    kind: reminder.kind ?? "reminder",
    sourceReminderId: reminder.id,
    sourceReminderItemIds: firedItemIds,
  };
  const { errors: outErrors } = await client.models.homeOutboundMessage.create(
    outboundPayload
  );
  if (outErrors?.length) {
    throw new Error(
      `Failed to write outbound message for reminder ${reminder.id}: ${JSON.stringify(outErrors)}`
    );
  }

  // Compute next scheduledAt across items after this firing
  const nextAcross = earliestNextOccurrence(updatedItems, now, tz);

  return {
    fired: true,
    nextScheduledAt: nextAcross
      ? new Date(nextAcross.getTime() - EARLY_BIAS_MIN * 60_000).toISOString()
      : null,
    updatedItems,
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────

export const handler: Handler = async () => {
  const now = new Date();
  console.log(`reminder-sweep: starting at ${now.toISOString()}`);

  // Household TZ is read once per sweep. Per-person overrides are
  // resolved inside processReminder when the reminder is PERSON-targeted.
  const householdTz = await getHouseholdTimezone(client);
  console.log(`reminder-sweep: household TZ = ${householdTz}`);

  // Find reminders whose scheduledAt has come due. Filter on PENDING
  // status to skip paused/cancelled/expired reminders.
  const dueByTime = now.toISOString();
  const { data: reminders, errors: listErrors } =
    await client.models.homeReminder.list({
      filter: {
        and: [
          { status: { eq: "PENDING" } },
          { scheduledAt: { le: dueByTime } },
        ],
      },
      limit: 200,
    });

  if (listErrors?.length) {
    console.error("Failed to list reminders:", listErrors);
    throw new Error(listErrors[0].message);
  }

  const candidates = reminders ?? [];
  console.log(`reminder-sweep: ${candidates.length} candidate reminders`);

  let fired = 0;
  let skipped = 0;
  let expired = 0;
  let failed = 0;

  for (const reminder of candidates) {
    try {
      const result = await processReminder(reminder, now, householdTz);

      if (result.fired) {
        fired++;
        // Use the updatedItems (with new lastFiredAt) returned by
        // processReminder. Avoids duplicating the window + occurrence
        // math here — and ensures the per-reminder TZ resolution is
        // consistent between the fire decision and the DB update.

        // If no more occurrences across any item, mark EXPIRED
        if (result.nextScheduledAt === null) {
          await client.models.homeReminder.update({
            id: reminder.id,
            // a.json() fields must be pre-stringified at the wire level.
            items: JSON.stringify(result.updatedItems) as any,
            status: "EXPIRED",
          });
          expired++;
        } else {
          await client.models.homeReminder.update({
            id: reminder.id,
            // a.json() fields must be pre-stringified at the wire level.
            items: JSON.stringify(result.updatedItems) as any,
            scheduledAt: result.nextScheduledAt,
          });
        }
      } else {
        skipped++;
        // Recompute scheduledAt if it was stale (e.g. reminder was paused
        // then resumed with items that have moved on)
        if (result.nextScheduledAt === null) {
          await client.models.homeReminder.update({
            id: reminder.id,
            status: "EXPIRED",
          });
          expired++;
        } else if (result.nextScheduledAt !== reminder.scheduledAt) {
          await client.models.homeReminder.update({
            id: reminder.id,
            scheduledAt: result.nextScheduledAt,
          });
        }
      }
    } catch (err) {
      console.error(`reminder-sweep: failed for ${reminder.id}:`, err);
      failed++;
    }
  }

  const result = { fired, skipped, expired, failed };
  console.log("reminder-sweep:", JSON.stringify(result));
  return result;
};
