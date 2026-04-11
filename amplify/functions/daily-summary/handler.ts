import type { Handler } from "aws-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/daily-summary";
import type { Schema } from "../../data/resource";
import { HassClient } from "../hass-sync/hass-client.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const anthropic = new Anthropic();
const MODEL_ID = "claude-haiku-4-5-20251001";

// Household timezone — the schedule fires at 12:00 UTC, which is 6am CST
// (winter) / 7am CDT (summer). We format dates in this TZ for the summary.
const TZ = "America/Chicago";

// ── Date helpers ─────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  // YYYY-MM-DD in the household timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Data gathering ───────────────────────────────────────────────────────────

interface SummaryData {
  today: string;
  todayTasks: { title: string; assignedTo: string[]; overdueDays: number }[];
  todayEvents: { title: string; startLabel: string; isAllDay: boolean; assignedTo: string[] }[];
  todayDayStatuses: { person: string; status: string; notes: string | null }[];
  upcomingTrips: { name: string; type: string | null; startDate: string; endDate: string; daysAway: number; participants: string[] }[];
  upcomingAllDayEvents: { title: string; date: string; daysAway: number; assignedTo: string[] }[];
  upcomingMultiPersonEvents: { title: string; date: string; daysAway: number; assignedTo: string[] }[];
  // Home Assistant state snapshot. `available` = false when HA didn't respond
  // to the healthcheck — the summary then renders a "devices unreachable"
  // note instead of the home-status line.
  home: {
    available: boolean;
    devices: { friendlyName: string; domain: string; summary: string }[];
  };
}

async function gatherData(): Promise<SummaryData> {
  const now = new Date();
  const todayStr = isoDate(now);
  const day1Str = isoDate(addDays(now, 1));
  const day2Str = isoDate(addDays(now, 2));
  const day3Str = isoDate(addDays(now, 3));
  const upcomingDates = new Set([day1Str, day2Str, day3Str]);

  // People — used to render names
  const { data: people } = await client.models.homePerson.list();
  const peopleById = new Map((people ?? []).map((p) => [p.id, p]));
  const nameOf = (ids: (string | null | undefined)[] | null | undefined): string[] =>
    (ids ?? [])
      .filter((id): id is string => !!id)
      .map((id) => peopleById.get(id)?.name ?? "?")
      .filter(Boolean);

  // ── Today's tasks: open tasks due today or earlier ──
  const { data: allTasks } = await client.models.homeTask.list({
    filter: { isCompleted: { eq: false } },
    limit: 500,
  });
  const todayTasks = (allTasks ?? [])
    .filter((t) => {
      if (!t.dueDate) return false;
      const due = isoDate(new Date(t.dueDate));
      return due <= todayStr;
    })
    .map((t) => {
      const dueDay = new Date(t.dueDate!);
      const msPerDay = 24 * 60 * 60 * 1000;
      const overdueDays = Math.max(
        0,
        Math.floor((new Date(todayStr).getTime() - new Date(isoDate(dueDay)).getTime()) / msPerDay)
      );
      return {
        title: t.title,
        assignedTo: nameOf(t.assignedPersonIds),
        overdueDays,
      };
    });

  // ── Today's events: startAt within today ──
  // Query a wider window then filter by TZ-local date string
  const { data: allEvents } = await client.models.homeCalendarEvent.list({
    limit: 500,
  });
  const todayEvents = (allEvents ?? [])
    .filter((e) => isoDate(new Date(e.startAt)) === todayStr)
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
    .map((e) => ({
      title: e.title,
      startLabel: e.isAllDay ? "All day" : formatTime(e.startAt),
      isAllDay: !!e.isAllDay,
      assignedTo: nameOf(e.assignedPersonIds),
    }));

  // ── Today's day statuses per person ──
  const { data: todayDays } = await client.models.homeCalendarDay.list({
    filter: { date: { eq: todayStr } },
  });
  const todayDayStatuses = (todayDays ?? [])
    .map((d) => {
      const person = peopleById.get(d.personId)?.name ?? "?";
      return { person, status: d.status ?? "", notes: d.notes ?? null };
    })
    .filter((d) => d.status);

  // ── Upcoming trips: starting within the next 3 days ──
  const { data: allTrips } = await client.models.homeTrip.list({ limit: 200 });
  const upcomingTrips = (allTrips ?? [])
    .filter((t) => upcomingDates.has(t.startDate) || t.startDate === todayStr)
    .map((t) => {
      const msPerDay = 24 * 60 * 60 * 1000;
      const daysAway = Math.round(
        (new Date(t.startDate).getTime() - new Date(todayStr).getTime()) / msPerDay
      );
      return {
        name: t.name,
        type: t.type ?? null,
        startDate: t.startDate,
        endDate: t.endDate,
        daysAway,
        participants: nameOf(t.participantIds),
      };
    })
    .sort((a, b) => a.daysAway - b.daysAway);

  // ── Upcoming all-day + multi-person events within the next 3 days ──
  const upcomingEvents = (allEvents ?? [])
    .filter((e) => {
      const d = isoDate(new Date(e.startAt));
      return upcomingDates.has(d);
    })
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  const msPerDay = 24 * 60 * 60 * 1000;
  const upcomingAllDayEvents = upcomingEvents
    .filter((e) => !!e.isAllDay)
    .map((e) => {
      const d = isoDate(new Date(e.startAt));
      return {
        title: e.title,
        date: d,
        daysAway: Math.round((new Date(d).getTime() - new Date(todayStr).getTime()) / msPerDay),
        assignedTo: nameOf(e.assignedPersonIds),
      };
    });

  // Multi-person = explicitly assigned to 2+ people OR household (empty list)
  const upcomingMultiPersonEvents = upcomingEvents
    .filter((e) => {
      const assigned = (e.assignedPersonIds ?? []).filter((id): id is string => !!id);
      return assigned.length === 0 || assigned.length >= 2;
    })
    .filter((e) => !e.isAllDay) // don't double-list with all-day events
    .map((e) => {
      const d = isoDate(new Date(e.startAt));
      return {
        title: e.title,
        date: d,
        daysAway: Math.round((new Date(d).getTime() - new Date(todayStr).getTime()) / msPerDay),
        assignedTo: nameOf(e.assignedPersonIds),
      };
    });

  return {
    today: todayStr,
    todayTasks,
    todayEvents,
    todayDayStatuses,
    upcomingTrips,
    upcomingAllDayEvents,
    upcomingMultiPersonEvents,
    home: await gatherHomeState(),
  };
}

// ── Home Assistant state ─────────────────────────────────────────────────────
// Reads pinned devices from the cache (populated by hass-sync 10 min before
// this lambda runs) and formats a short summary per device. We don't call HA
// directly from here — the cache is always fresh enough, and if HA was down
// the hass-sync scheduled run will have left stale data which is still a
// reasonable "as of last sync" snapshot.
//
// The one live call we do make is a healthcheck — so we can tell the model
// "HA is unreachable right now" vs "here's the last known state".

async function gatherHomeState(): Promise<SummaryData["home"]> {
  let available = false;
  try {
    const baseUrl = process.env.HASS_BASE_URL;
    const token = process.env.HASS_TOKEN;
    if (baseUrl && token) {
      const hass = new HassClient(baseUrl, token);
      available = await hass.healthcheck();
    }
  } catch {
    available = false;
  }

  // Read pinned devices from the cache regardless — even if HA is down
  // right now, the cached state is still useful context.
  let devices: { friendlyName: string; domain: string; summary: string }[] = [];
  try {
    const { data: pinned } = await client.models.homeDevice.list({
      filter: { isPinned: { eq: true } },
      limit: 100,
    });
    devices = (pinned ?? [])
      .map((d) => ({
        friendlyName: d.friendlyName ?? d.entityId,
        domain: d.domain ?? "unknown",
        summary: summarizeDeviceState(d.domain ?? "", parseLastState(d.lastState)),
      }))
      .filter((d) => d.summary !== "");
  } catch (err) {
    console.warn("Failed to read pinned devices from cache:", err);
  }

  return { available, devices };
}

/**
 * homeDevice.lastState is stored as a JSON string (hass-sync writes
 * it that way to satisfy AppSync's AWSJSON scalar input validation).
 * This helper unwraps either a string OR an already-parsed object
 * for backward compatibility with any pre-existing rows.
 */
function parseLastState(
  raw: unknown
): { state?: string; attributes?: Record<string, any> } | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") {
    return raw as { state?: string; attributes?: Record<string, any> };
  }
  return null;
}

/**
 * Condense an HA state blob into a short human-readable string.
 *
 * Design principle: **only mention things worth mentioning.** A morning
 * briefing that lists every pinned device every day becomes noise.
 * Rules by domain:
 *
 *   climate      — always show indoor temp + mode (useful context)
 *   lock         — show only if UNLOCKED (actionable alert)
 *   cover        — show only if not closed (garage open → alert)
 *   vacuum       — show only if actively cleaning or in an error state
 *   appliances   — show only if running (forgot the laundry)
 *   battery      — any device at <20% appends "⚠️ low battery" to its line
 *
 * Returns "" to drop the device from the summary entirely.
 */
function summarizeDeviceState(
  domain: string,
  state: { state?: string; attributes?: Record<string, any> } | null
): string {
  if (!state) return "";
  const attrs = state.attributes ?? {};
  const s = state.state ?? "";

  // Low-battery suffix — applies to any domain. HA exposes this as
  // attributes.battery_level on devices that report it (locks, some
  // cameras, sensors). 20% cutoff is generous but not alarmist.
  const batteryLevel = attrs.battery_level;
  const lowBattery =
    typeof batteryLevel === "number" && batteryLevel < 20
      ? ` ⚠️ low battery (${batteryLevel}%)`
      : "";

  switch (domain) {
    case "climate": {
      // Always mentioned — glanceable context for "is the HVAC sane".
      const current = attrs.current_temperature;
      const target = attrs.temperature;
      const unit = attrs.temperature_unit ?? "°F";
      const parts: string[] = [];
      if (typeof current === "number") parts.push(`${Math.round(current)}${unit}`);
      if (typeof target === "number" && target !== current)
        parts.push(`→ ${Math.round(target)}${unit}`);
      if (s && s !== "off" && s !== "unavailable") parts.push(s);
      return parts.length > 0 ? parts.join(" ") + lowBattery : lowBattery.trim();
    }

    case "lock":
      // Only alert on unlocked state. "locked" is the desired state
      // and doesn't need a daily line. Unknown / unavailable filtered
      // out (usually means the radio missed the last poll).
      if (s === "unlocked") return "UNLOCKED" + lowBattery;
      return lowBattery.trim();

    case "cover":
      // Garage doors, gates. "closed" is desired; everything else
      // (open, opening, closing) gets a line.
      if (s === "closed" || s === "unavailable" || s === "") return lowBattery.trim();
      return (s === "open" ? "OPEN" : s) + lowBattery;

    case "vacuum":
      // Only when actively doing something or stuck.
      if (s === "cleaning" || s === "returning") return s + lowBattery;
      if (s === "error") return "⚠️ error" + lowBattery;
      return lowBattery.trim();

    default: {
      // Generic appliance heuristic for media_player, washer, dryer,
      // etc. Only surface when the state indicates active use.
      const activeStates = new Set([
        "on",
        "running",
        "playing",
        "washing",
        "drying",
        "in_progress",
      ]);
      if (activeStates.has(s)) return s + lowBattery;
      return lowBattery.trim();
    }
  }
}

// ── Composition ──────────────────────────────────────────────────────────────

function isEmpty(data: SummaryData): boolean {
  // Home device state alone isn't enough to justify a summary — if there's
  // nothing going on otherwise, we still send the friendly "all clear" and
  // skip the Anthropic call entirely. HA unavailability is noted in the
  // "all clear" version below when relevant.
  return (
    data.todayTasks.length === 0 &&
    data.todayEvents.length === 0 &&
    data.todayDayStatuses.length === 0 &&
    data.upcomingTrips.length === 0 &&
    data.upcomingAllDayEvents.length === 0 &&
    data.upcomingMultiPersonEvents.length === 0
  );
}

async function composeSummary(data: SummaryData): Promise<string> {
  if (isEmpty(data)) {
    const dateLabel = new Date(data.today).toLocaleDateString("en-US", {
      timeZone: TZ,
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    return `*Good morning!* ${dateLabel}\n\nAll clear today — nothing big coming up in the next few days. 🌤️`;
  }

  const prompt = `You are formatting a concise daily household summary for a WhatsApp group chat.
The household is Gennaro and Cristine. Keep it warm but brief.

Today: ${data.today}

Structured data (JSON):
${JSON.stringify(data, null, 2)}

Formatting rules:
- Start with a short greeting line with the day of week and date (e.g. "*Good morning! Thursday, April 9*").
- Use WhatsApp-flavored markdown: *bold* for headers, no other formatting.
- Group into up to three sections: "*Today*", "*Coming up*", and "*Home*". Omit a section entirely if it has no content.
- Under "*Today*", list tasks, events, and any notable day statuses (WFH, PTO, travel) as short bullet lines starting with "• ".
- Under "*Coming up*", only show trips, all-day events, and multi-person events within the next 3 days. Include how many days away (e.g. "in 2 days").
- Under "*Home*", render whatever is in data.home.devices as compact lines. The data is pre-filtered: devices only appear if they're notable (unlocked doors, open garage, running washer, low battery, current indoor temperature). Keep it short — a single line per device or merge into a summary line like "🏠 Inside 68°F heat, all else normal". If data.home.devices is empty but home.available is true, omit the Home section entirely. Drop the section if home.available is false — instead add a single line "⚠️ Home devices unreachable — can't read device state" under the greeting.
- For tasks that are overdue, prefix with "⚠️".
- Keep it concise — no filler, no preamble about being an assistant. Don't add anything not in the data.
- Total length under 300 words.
- Do not wrap the output in code blocks. Output plain text only.`;

  const response = await anthropic.messages.create({
    model: MODEL_ID,
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return text || "Daily summary unavailable.";
}

// ── Main handler ─────────────────────────────────────────────────────────────

export const handler: Handler = async () => {
  console.log("Daily summary — gathering data");
  const data = await gatherData();
  console.log("Daily summary data:", JSON.stringify(data));

  const text = await composeSummary(data);
  console.log("Daily summary composed:", text);

  const { data: created, errors } = await client.models.homeOutboundMessage.create({
    channel: "WHATSAPP",
    target: "GROUP",
    text,
    status: "PENDING",
    kind: "daily_summary",
  });

  if (errors?.length) {
    console.error("Failed to create outbound message:", errors);
    throw new Error(errors[0].message);
  }

  console.log("Outbound message queued:", created?.id);
  return { messageId: created?.id, length: text.length };
};
