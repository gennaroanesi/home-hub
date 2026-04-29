// Daily safety net for recurring tasks.
//
// In the new occurrence-based model, the canonical lifecycle is:
//   - taskOccurrenceAction Lambda creates the next occurrence whenever
//     a previous one is closed (completed/skipped).
//   - This sweep covers the case where a recurring task ends up with
//     ZERO open occurrences for some reason — usually because the task
//     was just created (no client interaction yet) or the row predates
//     the occurrence model and nobody's touched it.
//
// For each recurring homeTask we check whether there's an open
// occurrence (no completedAt and no skippedAt). If not, we create one
// from the task's `dueDate` (legacy seed) or from rrule.after(now).

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

export const handler: Handler = async () => {
  const now = new Date();

  const { data: allTasks } = await client.models.homeTask.list();
  const recurring = (allTasks ?? []).filter(
    (t) => t.recurrence && t.recurrence !== ""
  );

  let created = 0;

  for (const task of recurring) {
    const { data: occurrences } = await client.models.homeTaskOccurrence.list({
      filter: { taskId: { eq: task.id } },
    });
    const open = (occurrences ?? []).find(
      (o) => !o.completedAt && !o.skippedAt
    );
    if (open) continue;

    // Pick a seed: the task's dueDate if it's still in the future, or
    // rrule.after(now) so we don't immediately spawn an overdue row.
    let scheduledFor: string | null = null;
    if (task.dueDate && new Date(task.dueDate).getTime() > now.getTime()) {
      scheduledFor = task.dueDate;
    } else {
      try {
        const rule = RRule.fromString(task.recurrence!);
        const next = rule.after(now);
        if (next) scheduledFor = next.toISOString();
      } catch {
        continue; // unparseable rrule, skip
      }
    }
    if (!scheduledFor) continue;

    await client.models.homeTaskOccurrence.create({
      taskId: task.id,
      scheduledFor,
    });
    await client.models.homeTask.update({
      id: task.id,
      dueDate: scheduledFor,
    });
    created++;
  }

  console.log(`Recurring tasks sweep: created ${created} occurrences`);
  return { created };
};
