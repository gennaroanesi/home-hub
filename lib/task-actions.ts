// Completing / reopening a task, shared by the Tasks page and the home
// dashboard so both follow the same rules:
//   - recurring task → taskOccurrenceAction(COMPLETE), which logs the
//     occurrence and rolls the task to its next cycle server-side
//   - one-off task   → mark completed + pause its reminders
//   - reopen         → clear completion + resume its reminders
//
// Returns the toast copy for the caller to show; toasts stay in the UI.
// The client is `any` for the same reason as lib/reminder-parent.ts.

import { resolveCurrentPerson } from "@/lib/current-person";
import { pauseRemindersFor, resumeRemindersFor } from "@/lib/reminder-parent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataClient = any;

interface TaskRow {
  id: string;
  isCompleted?: boolean | null;
  recurrence?: string | null;
}

export interface TaskActionResult {
  title: string;
  description?: string;
}

export async function toggleTaskCompleted(
  client: DataClient,
  task: TaskRow,
): Promise<TaskActionResult> {
  if (task.isCompleted) {
    await client.models.homeTask.update({
      id: task.id,
      isCompleted: false,
      completedAt: null,
    });
    await resumeRemindersFor(client, task.id);
    return { title: "Task reopened" };
  }

  if (task.recurrence) {
    const me = await resolveCurrentPerson(client);
    const { data: result, errors } = await client.mutations.taskOccurrenceAction({
      action: "COMPLETE",
      taskId: task.id,
      byPersonId: me?.id ?? null,
    });
    if (errors?.length) throw new Error(errors[0].message);
    if (result && !result.ok) throw new Error(result.message ?? "rejected");
    return { title: "Marked done", description: "Next cycle scheduled" };
  }

  await client.models.homeTask.update({
    id: task.id,
    isCompleted: true,
    completedAt: new Date().toISOString(),
  });
  await pauseRemindersFor(client, task.id);
  return { title: "Task completed" };
}
