import type { AppSyncResolverHandler } from "aws-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { RRule } from "rrule";
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { env } from "$amplify/env/home-agent";
import type { Schema } from "../../data/resource";
import {
  DEFAULT_ICAO,
  fetchAirportWeather,
  getMorningWeatherBriefing,
} from "../../../lib/aviation-weather.js";

const anthropic = new Anthropic();
const scheduler = new SchedulerClient({});

const MODEL_ID = "claude-sonnet-4-20250514";

const SCHEDULER_LAMBDA_ARN = process.env.SCHEDULER_LAMBDA_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;

// ── Amplify data client (lazy init) ──────────────────────────────────────────

let _dataClient: ReturnType<typeof generateClient<Schema>> | null = null;

async function getDataClient() {
  if (_dataClient) return _dataClient;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _dataClient = generateClient<Schema>();
  return _dataClient;
}

// ── Person resolution ────────────────────────────────────────────────────────
// Resolves names like "Gennaro" / "Cristine" / ["both"] to person IDs.

let _peopleCache: { id: string; name: string }[] | null = null;

async function getPeople(): Promise<{ id: string; name: string }[]> {
  if (_peopleCache) return _peopleCache;
  const client = await getDataClient();
  const { data } = await client.models.homePerson.list();
  _peopleCache = (data ?? []).map((p) => ({ id: p.id, name: p.name }));
  return _peopleCache;
}

async function resolvePersonIds(names?: string[] | null): Promise<string[]> {
  if (!names || names.length === 0) return [];
  const people = await getPeople();
  // "both", "all", "household" → all people
  if (names.some((n) => ["both", "all", "household", "everyone"].includes(n.toLowerCase()))) {
    return people.map((p) => p.id);
  }
  const ids: string[] = [];
  for (const name of names) {
    const match = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (match) ids.push(match.id);
  }
  return ids;
}

// ── Tool definitions for Claude ──────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "create_task",
    description: "Create a household task. Use recurrence for repeating tasks (RRULE format).",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household tasks.",
        },
        description: { type: "string" },
        dueDate: { type: "string", description: "ISO 8601 datetime" },
        recurrence: { type: "string", description: "RRULE string, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO" },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "update_task",
    description: "Update fields on an existing task by its ID. Only the fields you pass are changed; omit fields to leave them untouched. To mark complete use complete_task instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        taskId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household.",
        },
        dueDate: {
          type: "string",
          description: "ISO 8601 datetime. Pass empty string to clear.",
        },
        recurrence: {
          type: "string",
          description: "RRULE string, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO. Pass empty string to clear.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "list_tasks",
    description: "List open (incomplete) tasks. Optionally filter by person name.",
    input_schema: {
      type: "object" as const,
      properties: {
        person: { type: "string", description: "Person name to filter by" },
      },
    },
  },
  {
    name: "create_bill",
    description: "Create a bill to track. Use dueDay for recurring monthly bills, dueDate for one-off.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string" },
        dueDay: { type: "integer", description: "Day of month (1-31) for recurring bills" },
        dueDate: { type: "string", description: "ISO 8601 datetime for one-off bills" },
        isRecurring: { type: "boolean" },
        category: { type: "string" },
        url: { type: "string" },
        notes: { type: "string" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Empty/omitted for household.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "mark_bill_paid",
    description: "Mark a bill as paid by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        billId: { type: "string" },
      },
      required: ["billId"],
    },
  },
  {
    name: "list_bills",
    description: "List unpaid bills.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "create_event",
    description: "Create a calendar event.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        startAt: { type: "string", description: "ISO 8601 datetime" },
        endAt: { type: "string", description: "ISO 8601 datetime" },
        isAllDay: { type: "boolean" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household.",
        },
        recurrence: { type: "string" },
        location: { type: "string" },
        reminderMinutes: { type: "integer" },
      },
      required: ["title", "startAt"],
    },
  },
  {
    name: "update_event",
    description: "Update fields on an existing calendar event by its ID. Only the fields you pass are changed; omit fields to leave them untouched.",
    input_schema: {
      type: "object" as const,
      properties: {
        eventId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        startAt: { type: "string", description: "ISO 8601 datetime" },
        endAt: {
          type: "string",
          description: "ISO 8601 datetime. Pass empty string to clear.",
        },
        isAllDay: { type: "boolean" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names. Use ['both'] or empty for household.",
        },
        recurrence: {
          type: "string",
          description: "RRULE string. Pass empty string to clear.",
        },
        location: { type: "string" },
        url: { type: "string" },
        reminderMinutes: { type: "integer" },
        tripId: {
          type: "string",
          description: "ID of a homeTrip to link this event to. Pass empty string to clear.",
        },
      },
      required: ["eventId"],
    },
  },
  {
    name: "list_calendar_events",
    description: "List calendar events. By default returns events starting today or later. Pass startDate/endDate to narrow to a specific window (e.g. today+tomorrow), or person to filter by household member. Returns events sorted by start time.",
    input_schema: {
      type: "object" as const,
      properties: {
        startDate: {
          type: "string",
          description: "ISO 8601 date or datetime — only events starting on/after this. Defaults to today (local).",
        },
        endDate: {
          type: "string",
          description: "ISO 8601 date or datetime — only events starting before this (exclusive).",
        },
        person: {
          type: "string",
          description: "Optional person name. Without it, household-level events are returned alongside everyone's.",
        },
      },
    },
  },
  {
    name: "list_trips",
    description: "List planned and active trips. By default returns upcoming and current trips (endDate today or later). Pass includePast=true to include trips that have already ended. Each trip includes its transportation legs (flights, drives, etc.) inline.",
    input_schema: {
      type: "object" as const,
      properties: {
        includePast: {
          type: "boolean",
          description: "Include trips that have already ended. Default false.",
        },
      },
    },
  },
  {
    name: "list_shopping_lists",
    description: "List active shopping lists (e.g. Supermarket, Home Depot) with unchecked item counts. Pass includeArchived=true to also include archived lists.",
    input_schema: {
      type: "object" as const,
      properties: {
        includeArchived: { type: "boolean" },
      },
    },
  },
  {
    name: "archive_shopping_list",
    description: "Archive a shopping list (by name, fuzzy matched). Archived lists are hidden from the main view but kept as a record.",
    input_schema: {
      type: "object" as const,
      properties: {
        listName: { type: "string" },
      },
      required: ["listName"],
    },
  },
  {
    name: "unarchive_shopping_list",
    description: "Unarchive a previously archived shopping list.",
    input_schema: {
      type: "object" as const,
      properties: {
        listName: { type: "string" },
      },
      required: ["listName"],
    },
  },
  {
    name: "create_shopping_list",
    description: "Create a new shopping list. Only use when the user explicitly wants a new list that doesn't exist.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        emoji: { type: "string", description: "Single emoji character for the list" },
      },
      required: ["name"],
    },
  },
  {
    name: "add_shopping_item",
    description: "Add an item to a shopping list, matched by list name (fuzzy, case-insensitive). If no list name is given, uses the Supermarket list by default.",
    input_schema: {
      type: "object" as const,
      properties: {
        listName: { type: "string", description: "Name of the list, e.g. 'Supermarket' or 'Home Depot'. Fuzzy matched." },
        name: { type: "string", description: "Item name, e.g. 'olive oil'" },
        quantity: { type: "string", description: "Optional quantity, e.g. '2', '1 lb', '500g'" },
        notes: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_shopping_items",
    description: "List unchecked items in a shopping list (by name), or across all lists if no name given.",
    input_schema: {
      type: "object" as const,
      properties: {
        listName: { type: "string" },
      },
    },
  },
  {
    name: "check_shopping_item",
    description: "Mark a shopping item as bought/checked by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "schedule_reminder",
    description: "Schedule a notification reminder via EventBridge. Use for task/bill/event reminders.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: { type: "string" },
        assignedPeople: {
          type: "array",
          items: { type: "string" },
          description: "Array of person names to notify. Use ['both'] for household.",
        },
        scheduleAt: { type: "string", description: "ISO 8601 datetime for one-time reminder" },
        recurrence: { type: "string", description: "RRULE or cron expression for recurring" },
        type: { type: "string", enum: ["task", "bill", "event"] },
      },
      required: ["message"],
    },
  },
  {
    name: "send_photos",
    description:
      "Find and send up to 5 photos to the user as image attachments. Use when the user asks to see/send photos. Filters: query (fuzzy matched against album names AND trip names — pick whichever matches better), fromDate, toDate (YYYY-MM-DD inclusive). Favorited photos are sent first (curated picks from the user), then filled with the most recent non-favorites. Returns the matching photos AND a deep link to the /photos page filtered to the same set so the user can see more.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Album or trip name (fuzzy matched, case insensitive). The tool tries albums first, then falls back to trips and looks up linked albums.",
        },
        fromDate: { type: "string", description: "Earliest takenAt, YYYY-MM-DD" },
        toDate: { type: "string", description: "Latest takenAt, YYYY-MM-DD" },
        limit: { type: "integer", description: "Max photos to send (default 5, capped at 5)" },
      },
    },
  },
  {
    name: "get_home_devices",
    description:
      "List Home Assistant devices (thermostats, locks, cameras, sensors, etc.) with their last known state. Read-only in v1 — cannot control devices yet. Filter by domain (climate, lock, cover, camera, sensor, switch, etc.) or area (room name). Without filters, returns all pinned devices. State is cached from the last sync (daily + on-demand).",
    input_schema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description:
            "HA domain filter, e.g. 'climate' for thermostats, 'lock' for door locks, 'cover' for garage, 'camera'. Omit to list all pinned devices.",
        },
        area: {
          type: "string",
          description: "Room/area name, case insensitive fuzzy match. Omit to include all areas.",
        },
        pinnedOnly: {
          type: "boolean",
          description: "If true (default), only return devices marked as pinned. Pass false to include everything in the cache.",
        },
      },
    },
  },
  {
    name: "get_weather_briefing",
    description:
      "Fetch current METAR + TAF for an airport via the FAA aviationweather.gov API. Default airport is KAUS (Austin). Auto-selects 'plain' mode for household questions ('what's the weather') and 'aviation' mode when the user is flying in the next 2 days or explicitly asks about flight conditions. Returns parsed METAR fields (temp, wind, visibility, flight rules) AND raw METAR/TAF strings. Pilot-useful: flightRules is one of VFR/MVFR/IFR/LIFR derived from ceiling and visibility.",
    input_schema: {
      type: "object" as const,
      properties: {
        icao: {
          type: "string",
          description: "ICAO airport code (e.g. KAUS, KORD, KMDW). Defaults to KAUS if omitted.",
        },
        mode: {
          type: "string",
          enum: ["plain", "aviation", "auto"],
          description: "plain = household-friendly line. aviation = full METAR+TAF for flying. auto (default) picks based on upcoming flights in the calendar and trip legs.",
        },
      },
    },
  },
];

// ── Shopping list resolution ─────────────────────────────────────────────────

async function resolveShoppingList(listName?: string | null, includeArchived = false) {
  const client = await getDataClient();
  const { data: lists } = await client.models.homeShoppingList.list();
  const all = (lists ?? []).filter((l) => includeArchived || !l.isArchived);
  if (all.length === 0) return null;
  if (!listName) {
    // Default: prefer one called "Supermarket"/"Grocery", else the first by sortOrder
    const supermarket = all.find((l) => l.name.toLowerCase().includes("supermarket") || l.name.toLowerCase().includes("grocer"));
    if (supermarket) return supermarket;
    return [...all].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0];
  }
  const q = listName.toLowerCase().trim();
  // Exact match first, then contains
  return (
    all.find((l) => l.name.toLowerCase() === q) ??
    all.find((l) => l.name.toLowerCase().includes(q)) ??
    all.find((l) => q.includes(l.name.toLowerCase())) ??
    null
  );
}

// ── Tool execution ───────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getNextOccurrence(rruleString: string, after: Date): Date | null {
  try {
    const rule = RRule.fromString(rruleString);
    return rule.after(after);
  } catch {
    return null;
  }
}

// Attachments accumulated during a single agent invocation. Tools push
// to this and the handler returns it on the response.
interface Attachment {
  type: "image";
  url: string;
  caption?: string | null;
}

interface ToolContext {
  attachments: Attachment[];
}

async function executeTool(
  name: string,
  input: Record<string, any>,
  ctx: ToolContext
): Promise<string> {
  const client = await getDataClient();

  switch (name) {
    case "create_task": {
      const assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      const { data, errors } = await client.models.homeTask.create({
        title: input.title,
        description: input.description ?? null,
        assignedPersonIds,
        dueDate: input.dueDate ?? null,
        isCompleted: false,
        recurrence: input.recurrence ?? null,
        createdBy: "agent",
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, taskId: data?.id, title: input.title });
    }

    case "complete_task": {
      // Fetch the task to check for recurrence
      const { data: task } = await client.models.homeTask.get({ id: input.taskId });
      if (!task) return JSON.stringify({ error: "Task not found" });

      await client.models.homeTask.update({
        id: input.taskId,
        isCompleted: true,
        completedAt: new Date().toISOString(),
      });

      // If recurring, create the next occurrence
      let nextTaskId: string | null = null;
      if (task.recurrence) {
        const nextDate = getNextOccurrence(task.recurrence, new Date());
        if (nextDate) {
          const { data: nextTask } = await client.models.homeTask.create({
            title: task.title,
            description: task.description ?? null,
            assignedPersonIds: (task.assignedPersonIds ?? []).filter((id): id is string => !!id),
            dueDate: nextDate.toISOString(),
            isCompleted: false,
            recurrence: task.recurrence,
            createdBy: "recurrence",
          });
          nextTaskId = nextTask?.id ?? null;
        }
      }

      return JSON.stringify({
        success: true,
        taskId: input.taskId,
        nextTaskId,
      });
    }

    case "update_task": {
      const updates: { id: string } & Record<string, any> = { id: input.taskId };
      if (input.title !== undefined) updates.title = input.title;
      if (input.description !== undefined) updates.description = input.description || null;
      if (input.assignedPeople !== undefined) {
        updates.assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      }
      if (input.dueDate !== undefined) updates.dueDate = input.dueDate || null;
      if (input.recurrence !== undefined) updates.recurrence = input.recurrence || null;
      const { data, errors } = await client.models.homeTask.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, taskId: data?.id, title: data?.title });
    }

    case "list_tasks": {
      const { data: tasks } = await client.models.homeTask.list({
        filter: { isCompleted: { eq: false } },
      });
      let filtered = tasks ?? [];
      if (input.person) {
        const personIds = await resolvePersonIds([input.person]);
        if (personIds.length > 0) {
          filtered = filtered.filter((t) => {
            const assigned = (t.assignedPersonIds ?? []).filter((id): id is string => !!id);
            return assigned.length === 0 || assigned.some((id) => personIds.includes(id));
          });
        }
      }
      return JSON.stringify({ tasks: filtered });
    }

    case "create_bill": {
      const assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      const { data, errors } = await client.models.homeBill.create({
        name: input.name,
        amount: input.amount ?? null,
        currency: input.currency ?? "USD",
        dueDay: input.dueDay ?? null,
        dueDate: input.dueDate ?? null,
        isRecurring: input.isRecurring ?? true,
        isPaid: false,
        category: input.category ?? null,
        url: input.url ?? null,
        notes: input.notes ?? null,
        assignedPersonIds,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, billId: data?.id, name: input.name });
    }

    case "mark_bill_paid": {
      await client.models.homeBill.update({
        id: input.billId,
        isPaid: true,
        paidAt: new Date().toISOString(),
      });
      return JSON.stringify({ success: true, billId: input.billId });
    }

    case "list_bills": {
      const { data: bills } = await client.models.homeBill.list({
        filter: { isPaid: { eq: false } },
      });
      return JSON.stringify({ bills: bills ?? [] });
    }

    case "create_event": {
      const assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      const { data, errors } = await client.models.homeCalendarEvent.create({
        title: input.title,
        description: input.description ?? null,
        startAt: input.startAt,
        endAt: input.endAt ?? null,
        isAllDay: input.isAllDay ?? false,
        assignedPersonIds,
        recurrence: input.recurrence ?? null,
        location: input.location ?? null,
        reminderMinutes: input.reminderMinutes ?? null,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, eventId: data?.id, title: input.title });
    }

    case "update_event": {
      const updates: { id: string } & Record<string, any> = { id: input.eventId };
      if (input.title !== undefined) updates.title = input.title;
      if (input.description !== undefined) updates.description = input.description || null;
      if (input.startAt !== undefined) updates.startAt = input.startAt;
      if (input.endAt !== undefined) updates.endAt = input.endAt || null;
      if (input.isAllDay !== undefined) updates.isAllDay = input.isAllDay;
      if (input.assignedPeople !== undefined) {
        updates.assignedPersonIds = await resolvePersonIds(input.assignedPeople);
      }
      if (input.recurrence !== undefined) updates.recurrence = input.recurrence || null;
      if (input.location !== undefined) updates.location = input.location || null;
      if (input.url !== undefined) updates.url = input.url || null;
      if (input.reminderMinutes !== undefined) updates.reminderMinutes = input.reminderMinutes;
      if (input.tripId !== undefined) updates.tripId = input.tripId || null;
      const { data, errors } = await client.models.homeCalendarEvent.update(updates);
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, eventId: data?.id, title: data?.title });
    }

    case "list_calendar_events": {
      const { data: events } = await client.models.homeCalendarEvent.list();
      let filtered = events ?? [];

      // Default startDate to today (local CT) if not provided so we don't
      // dump every past event into the model context. Use the same TZ as
      // the system prompt so weekday-relative reasoning lines up.
      const startBound =
        input.startDate ??
        new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
      filtered = filtered.filter((e) => e.startAt && e.startAt >= startBound);

      if (input.endDate) {
        filtered = filtered.filter((e) => e.startAt && e.startAt < input.endDate);
      }

      if (input.person) {
        const personIds = await resolvePersonIds([input.person]);
        if (personIds.length > 0) {
          filtered = filtered.filter((e) => {
            const assigned = (e.assignedPersonIds ?? []).filter((id): id is string => !!id);
            return assigned.length === 0 || assigned.some((id) => personIds.includes(id));
          });
        }
      }

      filtered.sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""));
      return JSON.stringify({ events: filtered });
    }

    case "list_trips": {
      const { data: trips } = await client.models.homeTrip.list();
      let filtered = trips ?? [];

      if (!input.includePast) {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
          new Date()
        );
        filtered = filtered.filter((t) => t.endDate && t.endDate >= today);
      }

      filtered.sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));

      // Fetch transportation legs for each trip in parallel and inline them.
      const tripsWithLegs = await Promise.all(
        filtered.map(async (trip) => {
          const { data: legs } = await client.models.homeTripLeg.list({
            filter: { tripId: { eq: trip.id } },
          });
          const sortedLegs = (legs ?? []).sort((a, b) => {
            const orderA = a.sortOrder ?? 0;
            const orderB = b.sortOrder ?? 0;
            if (orderA !== orderB) return orderA - orderB;
            return (a.departAt ?? "").localeCompare(b.departAt ?? "");
          });
          return { ...trip, legs: sortedLegs };
        })
      );

      return JSON.stringify({ trips: tripsWithLegs });
    }

    case "list_shopping_lists": {
      const { data: lists } = await client.models.homeShoppingList.list();
      const filtered = (lists ?? []).filter((l) => input.includeArchived || !l.isArchived);
      const results = await Promise.all(
        filtered.map(async (l) => {
          const { data: items } = await client.models.homeShoppingItem.list({
            filter: { listId: { eq: l.id }, isChecked: { eq: false } },
          });
          return {
            id: l.id,
            name: l.name,
            emoji: l.emoji,
            isArchived: !!l.isArchived,
            uncheckedCount: (items ?? []).length,
          };
        })
      );
      return JSON.stringify({ lists: results });
    }

    case "archive_shopping_list": {
      const list = await resolveShoppingList(input.listName);
      if (!list) return JSON.stringify({ error: `No active list matching "${input.listName}"` });
      await client.models.homeShoppingList.update({
        id: list.id,
        isArchived: true,
        archivedAt: new Date().toISOString(),
      });
      return JSON.stringify({ success: true, listId: list.id, name: list.name });
    }

    case "unarchive_shopping_list": {
      const list = await resolveShoppingList(input.listName, true);
      if (!list) return JSON.stringify({ error: `No list matching "${input.listName}"` });
      await client.models.homeShoppingList.update({
        id: list.id,
        isArchived: false,
        archivedAt: null,
      });
      return JSON.stringify({ success: true, listId: list.id, name: list.name });
    }

    case "create_shopping_list": {
      const { data, errors } = await client.models.homeShoppingList.create({
        name: input.name,
        emoji: input.emoji ?? null,
        sortOrder: 0,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({ success: true, listId: data?.id, name: input.name });
    }

    case "add_shopping_item": {
      const list = await resolveShoppingList(input.listName);
      if (!list) {
        return JSON.stringify({
          error: input.listName
            ? `No shopping list matching "${input.listName}". Use create_shopping_list first.`
            : "No shopping lists exist. Use create_shopping_list first.",
        });
      }
      const { data, errors } = await client.models.homeShoppingItem.create({
        listId: list.id,
        name: input.name,
        quantity: input.quantity ?? null,
        notes: input.notes ?? null,
        isChecked: false,
        addedBy: "agent",
        sortOrder: 0,
      });
      if (errors) return JSON.stringify({ error: errors[0].message });
      return JSON.stringify({
        success: true,
        itemId: data?.id,
        name: input.name,
        listName: list.name,
      });
    }

    case "list_shopping_items": {
      if (input.listName) {
        const list = await resolveShoppingList(input.listName);
        if (!list) return JSON.stringify({ error: `No shopping list matching "${input.listName}"` });
        const { data: items } = await client.models.homeShoppingItem.list({
          filter: { listId: { eq: list.id }, isChecked: { eq: false } },
        });
        return JSON.stringify({ listName: list.name, items: items ?? [] });
      }
      const { data: items } = await client.models.homeShoppingItem.list({
        filter: { isChecked: { eq: false } },
      });
      return JSON.stringify({ items: items ?? [] });
    }

    case "check_shopping_item": {
      await client.models.homeShoppingItem.update({
        id: input.itemId,
        isChecked: true,
        checkedAt: new Date().toISOString(),
      });
      return JSON.stringify({ success: true, itemId: input.itemId });
    }

    case "send_photos": {
      const limit = Math.min(input.limit ?? 5, 5);

      // Resolve query → set of album IDs to match against
      let albumIds: string[] = [];
      let matchedLabel: string | null = null;
      if (input.query) {
        const q = String(input.query).toLowerCase().trim();

        // Try to match an album by name first
        const { data: albums } = await client.models.homeAlbum.list();
        const albumMatch =
          (albums ?? []).find((a) => a.name.toLowerCase() === q) ??
          (albums ?? []).find((a) => a.name.toLowerCase().includes(q)) ??
          (albums ?? []).find((a) => q.includes(a.name.toLowerCase()));

        if (albumMatch) {
          albumIds = [albumMatch.id];
          matchedLabel = albumMatch.name;
        } else {
          // Fall back to trip name → linked albums
          const { data: trips } = await client.models.homeTrip.list();
          const trip =
            (trips ?? []).find((t) => t.name.toLowerCase() === q) ??
            (trips ?? []).find((t) => t.name.toLowerCase().includes(q)) ??
            (trips ?? []).find((t) => q.includes(t.name.toLowerCase()));
          if (!trip) {
            return JSON.stringify({
              error: `No album or trip matching "${input.query}"`,
            });
          }
          // Find albums whose tripIds includes this trip
          const linked = (albums ?? []).filter((a) =>
            (a.tripIds ?? [])
              .filter((id): id is string => !!id)
              .includes(trip.id)
          );
          if (linked.length === 0) {
            return JSON.stringify({
              error: `Trip "${trip.name}" has no linked albums yet — create one first`,
            });
          }
          albumIds = linked.map((a) => a.id);
          matchedLabel = trip.name;
        }
      }

      // Get the photo IDs that belong to the matched albums (if any)
      let photoIdSet: Set<string> | null = null;
      if (albumIds.length > 0) {
        const allJoins: { photoId: string }[] = [];
        for (const albumId of albumIds) {
          const { data: joins } = await client.models.homeAlbumPhoto.list({
            filter: { albumId: { eq: albumId } },
            limit: 1000,
          });
          for (const j of joins ?? []) {
            allJoins.push({ photoId: j.photoId });
          }
        }
        photoIdSet = new Set(allJoins.map((j) => j.photoId));
      }

      // Build the date filter
      const filter: Record<string, any> = {};
      if (input.fromDate) {
        const from = new Date(input.fromDate).toISOString();
        filter.takenAt = { ...(filter.takenAt ?? {}), ge: from };
      }
      if (input.toDate) {
        const to = new Date(`${input.toDate}T23:59:59.999Z`).toISOString();
        filter.takenAt = { ...(filter.takenAt ?? {}), le: to };
      }

      const { data: photos } = await client.models.homePhoto.list({
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        limit: 1000,
      });

      let candidates = photos ?? [];
      if (photoIdSet) {
        candidates = candidates.filter((p) => photoIdSet!.has(p.id));
      }

      // Sort newest first as the base order
      const byDateDesc = (a: typeof candidates[number], b: typeof candidates[number]) => {
        const aDate = a.takenAt ?? a.createdAt;
        const bDate = b.takenAt ?? b.createdAt;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      };

      // Prefer favorites: take all favorited photos (sorted newest first),
      // then fill the remaining slots with non-favorites (also newest first).
      // Example: 3 favorites + 10 total + limit 5 → 3 favorites + 2 newest others.
      const favorites = candidates.filter((p) => p.isFavorite).sort(byDateDesc);
      const others = candidates.filter((p) => !p.isFavorite).sort(byDateDesc);
      const sorted = [...favorites, ...others];

      const totalMatching = sorted.length;
      const selected = sorted.slice(0, limit);
      const favoritesSent = selected.filter((p) => p.isFavorite).length;

      // Build CloudFront URLs and add to attachments. Use JPEG (not WebP)
      // because WhatsApp clients can fail to download WebP inline images.
      const CLOUDFRONT = "https://d2vnnym2o6bm6m.cloudfront.net";
      function buildUrl(s3key: string, width = 1024, quality = 80): string {
        return `${CLOUDFRONT}/${s3key}?format=jpeg&width=${width}&quality=${quality}`;
      }

      // Build a deep link to /photos with the same filter
      const APP_URL = process.env.APP_URL ?? "https://home.cristinegennaro.com";
      const params = new URLSearchParams();
      if (albumIds.length === 1) params.set("album", albumIds[0]);
      if (input.fromDate) params.set("from", input.fromDate);
      if (input.toDate) params.set("to", input.toDate);
      const deepLink = `${APP_URL}/photos${params.toString() ? `?${params}` : ""}`;

      for (const p of selected) {
        const dateLabel = p.takenAt ? new Date(p.takenAt).toLocaleDateString() : "";
        const captionParts = [matchedLabel ?? "", dateLabel, p.originalFilename ?? ""].filter(Boolean);
        ctx.attachments.push({
          type: "image",
          url: buildUrl(p.s3key),
          caption: captionParts.join(" · ") || null,
        });
      }

      return JSON.stringify({
        success: true,
        sent: selected.length,
        favoritesSent,
        totalFavorites: favorites.length,
        totalMatching,
        deepLink,
        more: totalMatching > selected.length ? totalMatching - selected.length : 0,
      });
    }

    case "schedule_reminder": {
      const scheduleName = `home-reminder-${generateId()}`;
      const scheduleExpression = input.recurrence
        ? `cron(${input.recurrence})`
        : `at(${input.scheduleAt})`;
      const assignedPersonIds = await resolvePersonIds(input.assignedPeople);

      await scheduler.send(new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: scheduleExpression,
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: SCHEDULER_LAMBDA_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({
            assignedPersonIds,
            message: input.message,
            type: input.type ?? "task",
          }),
        },
        ActionAfterCompletion: input.recurrence ? "NONE" : "DELETE",
      }));
      return JSON.stringify({ success: true, scheduleName });
    }

    case "get_home_devices": {
      const pinnedOnly = input.pinnedOnly !== false;
      const { data: devices } = await client.models.homeDevice.list({ limit: 500 });
      let filtered = devices ?? [];

      if (pinnedOnly) filtered = filtered.filter((d) => d.isPinned);
      if (input.domain) filtered = filtered.filter((d) => d.domain === input.domain);
      if (input.area) {
        const q = input.area.toLowerCase();
        filtered = filtered.filter((d) => d.area?.toLowerCase().includes(q));
      }

      // Shape the response for Claude — only fields it needs, no internal ids.
      // lastState is the HA state blob so Claude can interpret e.g. climate
      // attributes (current_temperature, temperature, hvac_mode) or lock
      // state strings ("locked"/"unlocked"). It's stored as a JSON string
      // (see hass-sync for why) so we parse it here before handing to Claude.
      const parseLastState = (raw: unknown): unknown => {
        if (raw == null) return null;
        if (typeof raw === "string") {
          try { return JSON.parse(raw); } catch { return null; }
        }
        return raw;
      };
      const shaped = filtered.map((d) => ({
        entityId: d.entityId,
        friendlyName: d.friendlyName,
        domain: d.domain,
        area: d.area,
        sensitivity: d.sensitivity,
        state: parseLastState(d.lastState),
        lastSyncedAt: d.lastSyncedAt,
      }));

      return JSON.stringify({
        devices: shaped,
        count: shaped.length,
        note:
          "Read-only in v1. To control devices, ask the user to do it in the web app for now.",
      });
    }

    case "get_weather_briefing": {
      const icao = (input.icao ?? DEFAULT_ICAO).toUpperCase();
      const mode = input.mode ?? "auto";

      // If user explicitly asked for plain or aviation, skip the trip/
      // calendar scan — they've already made the choice. For "auto",
      // fetch the signals and let detectFlyingWindow decide.
      if (mode === "plain" || mode === "aviation") {
        const { metar, taf } = await fetchAirportWeather(icao);
        return JSON.stringify({
          icao,
          mode,
          metar,
          taf,
          flyingContext: { flying: mode === "aviation" },
          note:
            mode === "aviation"
              ? "Render as a pilot briefing: raw METAR, raw TAF, flight rules verdict."
              : "Render as a one-line plain-English weather summary.",
        });
      }

      // Auto mode: pull trip legs + upcoming events so the briefing
      // can decide plain vs aviation. Cap at modest limits — we only
      // care about the next 2 days.
      const [legsRes, eventsRes] = await Promise.all([
        client.models.homeTripLeg.list({ limit: 500 }),
        client.models.homeCalendarEvent.list({ limit: 500 }),
      ]);
      const briefing = await getMorningWeatherBriefing(icao, {
        tripLegs: (legsRes.data ?? []).map((l) => ({
          mode: l.mode,
          departAt: l.departAt,
        })),
        events: (eventsRes.data ?? []).map((e) => ({
          title: e.title,
          description: e.description,
          startAt: e.startAt,
        })),
        lookaheadDays: 2,
      });

      return JSON.stringify({
        icao: briefing.icao,
        mode: briefing.mode,
        metar: briefing.metar,
        taf: briefing.taf,
        flyingContext: briefing.flyingContext,
        note:
          briefing.mode === "aviation"
            ? `Auto-selected aviation mode: ${briefing.flyingContext.source} "${briefing.flyingContext.title}" at ${briefing.flyingContext.when}. Render as a pilot briefing.`
            : "Auto-selected plain mode (no flights detected in next 2 days). Render as a one-line summary.",
      });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

interface AgentArgs {
  message: string;
  history?: any[];
  sender?: string;
}

interface AgentResponse {
  message: string;
  actionsTaken: { tool: string; result: any }[];
  attachments?: Attachment[];
}

export const handler: AppSyncResolverHandler<AgentArgs, AgentResponse> = async (event) => {
  const { message: userMessage, history: conversationHistory = [], sender = "unknown" } = event.arguments;

  const now = new Date();
  const people = await getPeople();
  const peopleNames = people.map((p) => p.name).join(", ");

  // Format date and time consistently in the household's local timezone.
  // Mixing `now.toISOString()` (UTC) with a localized weekday previously
  // produced inconsistent strings like "Thursday April 10" — UTC date but
  // local day name — which made the model compute weekday-relative dates
  // ("Saturday") off by one day.
  const TZ = "America/Chicago";
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const systemPrompt = `You are Janet, the household assistant for Gennaro and Cristine. You help manage tasks, bills, calendar events, shopping lists, photos, home devices, weather briefings, and reminders.

Household members: ${peopleNames}
Today is ${dateFmt.format(now)}. Current local time: ${timeFmt.format(now)}.
Timezone: ${TZ} (Central)
Message sender: ${sender}

When assigning tasks/bills/events to people, pass their names in the assignedPeople array (e.g. ["Gennaro"], ["Cristine"], or ["both"] for the whole household). Empty/omitted = household.

When the user asks to see photos, call send_photos DIRECTLY with whatever album or trip name they mentioned (it does fuzzy matching internally — do NOT call list_trips or list_albums first). Pass the name in the "query" param. It's capped at 5 photos per call — if more match, mention the count and share the deepLink the tool returns so the user can view the rest.

Home devices (thermostat, locks, cameras, etc.) can be read via get_home_devices. Device control is NOT available yet — if the user asks to change something (e.g. "set the thermostat to 72"), tell them to do it in the web app.

For weather / TAF / METAR / "what's the forecast" / "what's the wind" questions, call get_weather_briefing. By default it uses KAUS and auto-selects plain vs aviation mode. Pass mode="aviation" if the user is clearly asking about flying conditions, or pass a different ICAO if they name an airport. The tool returns structured data including the raw METAR and TAF — for a household-level question render a plain line; for a pilot question include the raw strings and the VFR/MVFR/IFR verdict.

Be concise and friendly. When creating items, confirm what you did. If the user's request is ambiguous, ask for clarification. Use the tools available to take actions — don't just describe what you would do.`;

  // Build messages for Anthropic API format
  // History comes from AppSync as JSON — normalize to valid MessageParam[]
  const validHistory: Anthropic.MessageParam[] = (conversationHistory ?? [])
    .filter((m: any) => m && m.role && m.content)
    .map((m: any) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : String(m.content),
    }));

  const messages: Anthropic.MessageParam[] = [
    ...validHistory,
    { role: "user" as const, content: userMessage },
  ];

  const actionsTaken: { tool: string; result: any }[] = [];
  const toolCtx: ToolContext = { attachments: [] };

  // Agentic loop
  let response = await anthropic.messages.create({
    model: MODEL_ID,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools,
  });

  while (response.stop_reason === "tool_use") {
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await executeTool(block.name, block.input as Record<string, any>, toolCtx);
        actionsTaken.push({ tool: block.name, result: JSON.parse(result) });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: MODEL_ID,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools,
    });
  }

  // Extract final text response
  const assistantText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    message: assistantText,
    actionsTaken,
    attachments: toolCtx.attachments,
  };
};
