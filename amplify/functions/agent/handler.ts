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
];

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

async function executeTool(name: string, input: Record<string, any>): Promise<string> {
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
}

export const handler: AppSyncResolverHandler<AgentArgs, AgentResponse> = async (event) => {
  const { message: userMessage, history: conversationHistory = [], sender = "unknown" } = event.arguments;

  const now = new Date();
  const people = await getPeople();
  const peopleNames = people.map((p) => p.name).join(", ");

  const systemPrompt = `You are a helpful household assistant. You help manage tasks, bills, calendar events, and reminders for the household.

Household members: ${peopleNames}
Current date/time: ${now.toISOString()} (${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" })})
Timezone: America/New_York (Eastern)
Message sender: ${sender}

When assigning tasks/bills/events to people, pass their names in the assignedPeople array (e.g. ["Gennaro"], ["Cristine"], or ["both"] for the whole household). Empty/omitted = household.

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
        const result = await executeTool(block.name, block.input as Record<string, any>);
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
  };
};
