// task-occurrence-action — single Lambda fronting the three actions
// the clients (web + mobile) take on a recurring-task occurrence:
//
//   completeTaskOccurrence({ taskId, byPersonId })
//   skipTaskOccurrence({ taskId, byPersonId, reason? })
//   uncompleteTaskOccurrence({ taskId })
//
// Why a Lambda mutation instead of letting clients write occurrences
// directly: closing one occurrence + creating the next one needs to
// be atomic, and the rrule math is non-trivial. We don't want web and
// mobile each carrying a copy of "what is the next scheduledFor and
// what reminders fire on it" logic — that's how they drift.
//
// Migration: when the action lands and the recurring homeTask has no
// open occurrence, this Lambda creates one from the task's dueDate
// (the legacy "next occurrence" location) and then closes it. Calls
// against tasks with no recurrence are rejected — those still go
// through homeTask.update() directly.

import type { AppSyncResolverHandler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { RRule } from "rrule";
import { env } from "$amplify/env/task-occurrence-action";
import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

type Action = "COMPLETE" | "SKIP" | "UNCOMPLETE";

interface Args {
  action: Action;
  taskId: string;
  byPersonId?: string | null;
  reason?: string | null;
}

interface Result {
  ok: boolean;
  occurrenceId: string | null;
  nextOccurrenceId: string | null;
  message: string | null;
}

export const handler: AppSyncResolverHandler<Args, Result> = async (event) => {
  const { action, taskId, byPersonId, reason } = event.arguments;
  if (!taskId) return reject("taskId required");

  const { data: task, errors: taskErrors } =
    await client.models.homeTask.get({ id: taskId });
  if (taskErrors?.length) return reject(taskErrors[0].message);
  if (!task) return reject("task not found");
  if (!task.recurrence) {
    return reject(
      "task is not recurring — use homeTask.update() for one-time tasks"
    );
  }

  // Pull all occurrences for this task. We expect a small number
  // (one open + recent closed) so list+filter is fine.
  const { data: occurrences, errors: occErrors } =
    await client.models.homeTaskOccurrence.list({
      filter: { taskId: { eq: taskId } },
    });
  if (occErrors?.length) return reject(occErrors[0].message);

  const now = new Date();

  switch (action) {
    case "COMPLETE":
    case "SKIP": {
      // Find or lazy-create the open occurrence.
      let open = (occurrences ?? []).find(
        (o) => !o.completedAt && !o.skippedAt
      );
      if (!open) {
        const seed = task.dueDate ?? now.toISOString();
        const { data: created, errors } =
          await client.models.homeTaskOccurrence.create({
            taskId,
            scheduledFor: seed,
          });
        if (errors?.length) return reject(errors[0].message);
        if (!created) return reject("could not create initial occurrence");
        open = created;
      }

      // Close the occurrence.
      const closePatch =
        action === "COMPLETE"
          ? {
              completedAt: now.toISOString(),
              completedByPersonId: byPersonId ?? null,
            }
          : {
              skippedAt: now.toISOString(),
              skipReason: reason ?? null,
            };
      const { errors: closeErrors } =
        await client.models.homeTaskOccurrence.update({
          id: open.id,
          ...closePatch,
        });
      if (closeErrors?.length) return reject(closeErrors[0].message);

      // Generate the next occurrence using the rrule + the just-closed
      // occurrence's scheduledFor as dtstart. We anchor on scheduledFor
      // (not now) so a late completion still produces the *correct*
      // next slot ("daily at 9pm" stays at 9pm).
      const next = computeNext(task.recurrence, open.scheduledFor);
      let nextId: string | null = null;
      if (next) {
        const { data: nextRow, errors: nextErrors } =
          await client.models.homeTaskOccurrence.create({
            taskId,
            scheduledFor: next.toISOString(),
          });
        if (nextErrors?.length) return reject(nextErrors[0].message);
        nextId = nextRow?.id ?? null;
      }

      // Mirror dueDate on the parent task to the next scheduledFor so
      // legacy reads (and the agent) keep working. When no next exists,
      // null it out — the series is done.
      await client.models.homeTask.update({
        id: taskId,
        dueDate: next ? next.toISOString() : null,
      });

      return {
        ok: true,
        occurrenceId: open.id,
        nextOccurrenceId: nextId,
        message: null,
      };
    }

    case "UNCOMPLETE": {
      // Reopen the most recently closed occurrence and drop any auto-
      // spawned successor that's still untouched. If a user closed the
      // successor too, we leave it alone — they took an explicit
      // action on it.
      const closed = (occurrences ?? [])
        .filter((o) => o.completedAt || o.skippedAt)
        .sort((a, b) => closedAt(b).localeCompare(closedAt(a)));
      if (closed.length === 0) return reject("nothing to uncomplete");

      const target = closed[0];
      const successor = (occurrences ?? []).find(
        (o) =>
          o.id !== target.id &&
          !o.completedAt &&
          !o.skippedAt &&
          new Date(o.scheduledFor).getTime() >
            new Date(target.scheduledFor).getTime()
      );
      if (successor) {
        await client.models.homeTaskOccurrence.delete({ id: successor.id });
      }

      const { errors } = await client.models.homeTaskOccurrence.update({
        id: target.id,
        completedAt: null,
        completedByPersonId: null,
        skippedAt: null,
        skipReason: null,
      });
      if (errors?.length) return reject(errors[0].message);

      await client.models.homeTask.update({
        id: taskId,
        dueDate: target.scheduledFor,
      });

      return {
        ok: true,
        occurrenceId: target.id,
        nextOccurrenceId: null,
        message: null,
      };
    }

    default:
      return reject(`unknown action: ${action}`);
  }
};

function reject(message: string): Result {
  return {
    ok: false,
    occurrenceId: null,
    nextOccurrenceId: null,
    message,
  };
}

function closedAt(o: { completedAt?: string | null; skippedAt?: string | null }): string {
  return o.completedAt ?? o.skippedAt ?? "";
}

/** Compute the next occurrence after `dtstart` using the RRULE. Returns
 *  null when the rule is exhausted or unparseable. */
function computeNext(rruleStr: string, dtstartIso: string): Date | null {
  try {
    const base = RRule.fromString(rruleStr);
    const dtstart = new Date(dtstartIso);
    const rule = new RRule({ ...base.origOptions, dtstart });
    return rule.after(dtstart, false /* inc */);
  } catch {
    return null;
  }
}
