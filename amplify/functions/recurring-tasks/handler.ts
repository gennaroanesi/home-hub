import type { Handler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { RRule } from "rrule";
import { env } from "$amplify/env/recurring-tasks";
import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

/**
 * Daily safety net for recurring tasks.
 * Scans for completed recurring tasks that don't yet have a future occurrence,
 * and creates the next one.
 */
export const handler: Handler = async () => {
  const now = new Date();

  // Get all recurring tasks (both completed and open)
  const { data: allTasks } = await client.models.homeTask.list();
  const recurring = (allTasks ?? []).filter((t) => t.recurrence && t.recurrence !== "");

  // Group by recurrence + title to find "series"
  const seriesMap = new Map<string, typeof recurring>();
  for (const task of recurring) {
    const key = `${task.title}::${task.recurrence}`;
    if (!seriesMap.has(key)) seriesMap.set(key, []);
    seriesMap.get(key)!.push(task);
  }

  let created = 0;

  for (const [, tasks] of seriesMap) {
    // Check if there's already an open (incomplete) task in this series
    const hasOpenTask = tasks.some((t) => !t.isCompleted);
    if (hasOpenTask) continue;

    // All tasks in this series are completed — create the next occurrence
    const latest = tasks.reduce((a, b) =>
      new Date(a.completedAt ?? a.createdAt) > new Date(b.completedAt ?? b.createdAt) ? a : b
    );

    try {
      const rule = RRule.fromString(latest.recurrence!);
      const nextDate = rule.after(now);
      if (!nextDate) continue;

      await client.models.homeTask.create({
        title: latest.title,
        description: latest.description ?? null,
        assignedPersonIds: (latest.assignedPersonIds ?? []).filter((id): id is string => !!id),
        dueDate: nextDate.toISOString(),
        isCompleted: false,
        recurrence: latest.recurrence,
        createdBy: "recurrence",
      });
      created++;
    } catch {
      // Invalid RRULE, skip
    }
  }

  console.log(`Recurring tasks sweep: created ${created} new tasks`);
  return { created };
};
