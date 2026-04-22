// Propagates parent-lifecycle changes (delete, complete, uncomplete)
// into their linked reminders. The UI calls these from task/event/trip
// delete + complete handlers, and the agent Lambda calls the same
// helpers when Janet performs the equivalent action on behalf of a
// user. That way we don't end up paging someone about a meeting they
// cancelled or a task they already finished.
//
// The client parameter is `any` so this module stays compatible with
// both userPool-auth (UI) and IAM-auth (Lambda) generated clients —
// same workaround as lib/household-settings.ts. See the feedback
// memory on the variance conflict.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataClient = any;

interface ReminderRow {
  id: string;
  status: string | null | undefined;
}

async function listByParent(
  client: DataClient,
  parentId: string
): Promise<ReminderRow[]> {
  const { data } = await client.models.homeReminder.list({
    filter: { parentId: { eq: parentId } },
    limit: 100,
  });
  return (data ?? []) as ReminderRow[];
}

/**
 * Delete every reminder linked to `parentId`. Safe to call for a
 * parent that has no reminders — it just finds nothing.
 */
export async function cascadeDeleteRemindersFor(
  client: DataClient,
  parentId: string
): Promise<void> {
  const reminders = await listByParent(client, parentId);
  for (const r of reminders) {
    await client.models.homeReminder.delete({ id: r.id });
  }
}

/**
 * Pause every PENDING reminder linked to `parentId`. Used when a task
 * is marked complete — the reminder stops firing but stays on the
 * record, so un-completing the task resumes it cleanly. CANCELLED /
 * EXPIRED are terminal and ignored; already-PAUSED is left alone.
 */
export async function pauseRemindersFor(
  client: DataClient,
  parentId: string
): Promise<void> {
  const reminders = await listByParent(client, parentId);
  for (const r of reminders) {
    if (r.status === "PENDING") {
      await client.models.homeReminder.update({ id: r.id, status: "PAUSED" });
    }
  }
}

/**
 * Flip PAUSED reminders back to PENDING for `parentId`. The mirror of
 * pauseRemindersFor — used when a completed task is un-completed so
 * its auto-paused reminders resume.
 *
 * Note: this resumes PAUSED reminders indiscriminately, so a reminder
 * the user manually paused will also resume. Acceptable tradeoff for
 * now — alternative would be tracking "paused by cascade" vs "paused
 * by user" which adds schema complexity for a rare case.
 */
export async function resumeRemindersFor(
  client: DataClient,
  parentId: string
): Promise<void> {
  const reminders = await listByParent(client, parentId);
  for (const r of reminders) {
    if (r.status === "PAUSED") {
      await client.models.homeReminder.update({ id: r.id, status: "PENDING" });
    }
  }
}
