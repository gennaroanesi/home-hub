import type { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { RRule } from "rrule";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TASK_TABLE = process.env.HOME_TASK_TABLE!;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Daily safety net for recurring tasks.
 * Scans for completed recurring tasks that don't yet have a future occurrence,
 * and creates the next one.
 */
export const handler: Handler = async () => {
  const now = new Date();
  const nowIso = now.toISOString();

  // Get all recurring tasks (both completed and open)
  const { Items: allTasks = [] } = await ddb.send(new ScanCommand({
    TableName: TASK_TABLE,
    FilterExpression: "attribute_exists(recurrence) AND recurrence <> :empty",
    ExpressionAttributeValues: { ":empty": "" },
  }));

  // Group by recurrence + title to find "series"
  const seriesMap = new Map<string, typeof allTasks>();
  for (const task of allTasks) {
    const key = `${task.title}::${task.recurrence}`;
    if (!seriesMap.has(key)) seriesMap.set(key, []);
    seriesMap.get(key)!.push(task);
  }

  let created = 0;

  for (const [, tasks] of seriesMap) {
    // Check if there's already an open (incomplete) task in this series
    const hasOpenTask = tasks.some((t: any) => !t.isCompleted);
    if (hasOpenTask) continue;

    // All tasks in this series are completed — create the next occurrence
    const latest = tasks.reduce((a: any, b: any) =>
      new Date(a.completedAt ?? a.createdAt) > new Date(b.completedAt ?? b.createdAt) ? a : b
    );

    try {
      const rule = RRule.fromString(latest.recurrence);
      const nextDate = rule.after(now);
      if (!nextDate) continue;

      const id = generateId();
      await ddb.send(new PutCommand({
        TableName: TASK_TABLE,
        Item: {
          id,
          __typename: "homeTask",
          title: latest.title,
          description: latest.description ?? null,
          assignee: latest.assignee ?? "both",
          dueDate: nextDate.toISOString(),
          isCompleted: false,
          recurrence: latest.recurrence,
          completedAt: null,
          createdBy: "recurrence",
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      }));
      created++;
    } catch {
      // Invalid RRULE, skip
    }
  }

  console.log(`Recurring tasks sweep: created ${created} new tasks`);
  return { created };
};
