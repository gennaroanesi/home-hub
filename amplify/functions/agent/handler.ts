import type { AppSyncResolverHandler } from "aws-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { RRule } from "rrule";
import {
  SchedulerClient,
  CreateScheduleCommand,
} from "@aws-sdk/client-scheduler";

const anthropic = new Anthropic();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const scheduler = new SchedulerClient({});

const MODEL_ID = "claude-sonnet-4-20250514";

// Table names are injected as env vars by backend.ts
const TASK_TABLE = process.env.HOME_TASK_TABLE!;
const BILL_TABLE = process.env.HOME_BILL_TABLE!;
const EVENT_TABLE = process.env.HOME_CALENDAR_EVENT_TABLE!;
const SCHEDULER_LAMBDA_ARN = process.env.SCHEDULER_LAMBDA_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;

// ── Tool definitions for Claude ──────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "create_task",
    description: "Create a household task. Use recurrence for repeating tasks (RRULE format).",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        assignee: { type: "string", enum: ["gennaro", "cristine", "both"] },
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
    description: "List open (incomplete) tasks. Optionally filter by assignee.",
    input_schema: {
      type: "object" as const,
      properties: {
        assignee: { type: "string", enum: ["gennaro", "cristine", "both"] },
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
        assignee: { type: "string", enum: ["gennaro", "cristine", "both"] },
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
        assignee: { type: "string", enum: ["gennaro", "cristine", "both"] },
        scheduleAt: { type: "string", description: "ISO 8601 datetime for one-time reminder" },
        recurrence: { type: "string", description: "RRULE or cron expression for recurring" },
        type: { type: "string", enum: ["task", "bill", "event"] },
      },
      required: ["message", "assignee"],
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
  switch (name) {
    case "create_task": {
      const id = generateId();
      const now = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: TASK_TABLE,
        Item: {
          id,
          __typename: "homeTask",
          title: input.title,
          description: input.description ?? null,
          assignee: input.assignee ?? "both",
          dueDate: input.dueDate ?? null,
          isCompleted: false,
          recurrence: input.recurrence ?? null,
          completedAt: null,
          createdBy: "agent",
          createdAt: now,
          updatedAt: now,
        },
      }));
      return JSON.stringify({ success: true, taskId: id, title: input.title });
    }

    case "complete_task": {
      const now = new Date();
      const nowIso = now.toISOString();

      // Fetch the task to check for recurrence
      const { Item: task } = await ddb.send(new GetCommand({
        TableName: TASK_TABLE,
        Key: { id: input.taskId },
      }));

      await ddb.send(new UpdateCommand({
        TableName: TASK_TABLE,
        Key: { id: input.taskId },
        UpdateExpression: "SET isCompleted = :done, completedAt = :now, updatedAt = :now",
        ExpressionAttributeValues: { ":done": true, ":now": nowIso },
      }));

      // If recurring, create the next occurrence
      let nextTaskId: string | null = null;
      if (task?.recurrence) {
        const nextDate = getNextOccurrence(task.recurrence, now);
        if (nextDate) {
          nextTaskId = generateId();
          await ddb.send(new PutCommand({
            TableName: TASK_TABLE,
            Item: {
              id: nextTaskId,
              __typename: "homeTask",
              title: task.title,
              description: task.description ?? null,
              assignee: task.assignee ?? "both",
              dueDate: nextDate.toISOString(),
              isCompleted: false,
              recurrence: task.recurrence,
              completedAt: null,
              createdBy: "recurrence",
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          }));
        }
      }

      return JSON.stringify({
        success: true,
        taskId: input.taskId,
        nextTaskId,
        nextDueDate: nextTaskId ? task?.recurrence : null,
      });
    }

    case "list_tasks": {
      const result = await ddb.send(new ScanCommand({
        TableName: TASK_TABLE,
        FilterExpression: input.assignee
          ? "isCompleted = :false AND assignee = :assignee"
          : "isCompleted = :false",
        ExpressionAttributeValues: input.assignee
          ? { ":false": false, ":assignee": input.assignee }
          : { ":false": false },
      }));
      return JSON.stringify({ tasks: result.Items ?? [] });
    }

    case "create_bill": {
      const id = generateId();
      const now = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: BILL_TABLE,
        Item: {
          id,
          __typename: "homeBill",
          name: input.name,
          amount: input.amount ?? null,
          currency: input.currency ?? "USD",
          dueDay: input.dueDay ?? null,
          dueDate: input.dueDate ?? null,
          isRecurring: input.isRecurring ?? true,
          isPaid: false,
          paidAt: null,
          category: input.category ?? null,
          url: input.url ?? null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        },
      }));
      return JSON.stringify({ success: true, billId: id, name: input.name });
    }

    case "mark_bill_paid": {
      const now = new Date().toISOString();
      await ddb.send(new UpdateCommand({
        TableName: BILL_TABLE,
        Key: { id: input.billId },
        UpdateExpression: "SET isPaid = :paid, paidAt = :now, updatedAt = :now",
        ExpressionAttributeValues: { ":paid": true, ":now": now },
      }));
      return JSON.stringify({ success: true, billId: input.billId });
    }

    case "list_bills": {
      const result = await ddb.send(new ScanCommand({
        TableName: BILL_TABLE,
        FilterExpression: "isPaid = :false",
        ExpressionAttributeValues: { ":false": false },
      }));
      return JSON.stringify({ bills: result.Items ?? [] });
    }

    case "create_event": {
      const id = generateId();
      const now = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: EVENT_TABLE,
        Item: {
          id,
          __typename: "homeCalendarEvent",
          title: input.title,
          description: input.description ?? null,
          startAt: input.startAt,
          endAt: input.endAt ?? null,
          isAllDay: input.isAllDay ?? false,
          assignee: input.assignee ?? "both",
          recurrence: input.recurrence ?? null,
          location: input.location ?? null,
          reminderMinutes: input.reminderMinutes ?? null,
          createdAt: now,
          updatedAt: now,
        },
      }));
      return JSON.stringify({ success: true, eventId: id, title: input.title });
    }

    case "schedule_reminder": {
      const scheduleName = `home-reminder-${generateId()}`;
      const scheduleExpression = input.recurrence
        ? `cron(${input.recurrence})`
        : `at(${input.scheduleAt})`;

      await scheduler.send(new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: scheduleExpression,
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: SCHEDULER_LAMBDA_ARN,
          RoleArn: SCHEDULER_ROLE_ARN,
          Input: JSON.stringify({
            assignee: input.assignee,
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
  const systemPrompt = `You are a helpful household assistant for Gennaro and Cristine. You help them manage tasks, bills, calendar events, and reminders for their shared home.

Current date/time: ${now.toISOString()} (${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" })})
Timezone: America/New_York (Eastern)
Message sender: ${sender}

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
