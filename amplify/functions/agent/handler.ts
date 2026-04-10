import type { AppSyncResolverHandler } from "aws-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { RRule } from "rrule";
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { env } from "$amplify/env/home-agent";
import type { Schema } from "../../data/resource";

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
      "Find and send up to 5 photos to the user as image attachments. Use when the user asks to see/send photos. Filters: query (fuzzy matched against album names AND trip names — pick whichever matches better), fromDate, toDate (YYYY-MM-DD inclusive). Returns the matching photos AND a deep link to the /photos page filtered to the same set so the user can see more.",
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

      const sorted = candidates.sort((a, b) => {
        const aDate = a.takenAt ?? a.createdAt;
        const bDate = b.takenAt ?? b.createdAt;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      });
      const totalMatching = sorted.length;
      const selected = sorted.slice(0, limit);

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

  const systemPrompt = `You are a helpful household assistant. You help manage tasks, bills, calendar events, shopping lists, photos, and reminders for the household.

Household members: ${peopleNames}
Today is ${dateFmt.format(now)}. Current local time: ${timeFmt.format(now)}.
Timezone: ${TZ} (Central)
Message sender: ${sender}

When assigning tasks/bills/events to people, pass their names in the assignedPeople array (e.g. ["Gennaro"], ["Cristine"], or ["both"] for the whole household). Empty/omitted = household.

When the user asks to see photos, call send_photos DIRECTLY with whatever album or trip name they mentioned (it does fuzzy matching internally — do NOT call list_trips or list_albums first). Pass the name in the "query" param. It's capped at 5 photos per call — if more match, mention the count and share the deepLink the tool returns so the user can view the rest.

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
