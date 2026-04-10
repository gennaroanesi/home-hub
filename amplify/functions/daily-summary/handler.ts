import type { Handler } from "aws-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/daily-summary";
import type { Schema } from "../../data/resource";

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
  };
}

// ── Composition ──────────────────────────────────────────────────────────────

function isEmpty(data: SummaryData): boolean {
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
- Group into up to two sections: "*Today*" and "*Coming up*". Omit a section entirely if it has no content.
- Under "*Today*", list tasks, events, and any notable day statuses (WFH, PTO, travel) as short bullet lines starting with "• ".
- Under "*Coming up*", only show trips, all-day events, and multi-person events within the next 3 days. Include how many days away (e.g. "in 2 days").
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
