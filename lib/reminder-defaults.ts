// Factories that build the pre-filled ReminderModalInitialValues for
// "create reminder from X" flows. Lives in lib/ so page components
// don't have to know the conventions (lead times, item shape,
// assignee → personId mapping).
//
// Convention refresher:
//   TASK  → item fires at the task's dueDate
//   EVENT → item fires 1 hour before the event's startAt
//   TRIP  → item fires at 9am local on the trip's startDate
//
// These are first-pass defaults chosen with the user; they're meant
// to be good enough that a typical reminder can be saved in one
// click, and the user can still edit anything before saving.

import type { ReminderModalInitialValues } from "@/components/reminder-modal";

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Pick a target (group or a single person) from an array of assignee
 * IDs. Reminders currently only support a single personId, so when a
 * task/event is assigned to multiple people we fall back to GROUP
 * (the user can change it in the modal).
 */
function pickTarget(assignedIds: string[] | null | undefined): {
  targetKind: "PERSON" | "GROUP";
  personId?: string;
} {
  const ids = (assignedIds ?? []).filter((id): id is string => !!id);
  if (ids.length === 1) return { targetKind: "PERSON", personId: ids[0] };
  return { targetKind: "GROUP" };
}

export function buildReminderDefaultsForTask(args: {
  title: string;
  dueDate: string | null | undefined; // ISO datetime
  assignedPersonIds: string[];
}): ReminderModalInitialValues {
  const { targetKind, personId } = pickTarget(args.assignedPersonIds);
  return {
    name: args.title,
    targetKind,
    personId,
    kind: "task",
    items: [
      {
        id: genId(),
        name: args.title,
        firesAt: args.dueDate || null,
        rrule: null,
      },
    ],
  };
}

export function buildReminderDefaultsForEvent(args: {
  title: string;
  startAt: string | null | undefined; // ISO datetime
  assignedPersonIds: string[];
}): ReminderModalInitialValues {
  const { targetKind, personId } = pickTarget(args.assignedPersonIds);
  // 1h-before-start default. Degenerates to null (user picks) when
  // the event has no start time yet.
  let firesAt: string | null = null;
  if (args.startAt) {
    const d = new Date(args.startAt);
    if (!Number.isNaN(d.getTime())) {
      d.setHours(d.getHours() - 1);
      firesAt = d.toISOString();
    }
  }
  return {
    name: args.title,
    targetKind,
    personId,
    kind: "event",
    items: [
      {
        id: genId(),
        name: args.title,
        firesAt,
        rrule: null,
      },
    ],
  };
}

export function buildReminderDefaultsForTrip(args: {
  name: string;
  startDate: string | null | undefined; // YYYY-MM-DD
  participantIds: string[];
}): ReminderModalInitialValues {
  const { targetKind, personId } = pickTarget(args.participantIds);
  // Trip startDate is a date, not a datetime — pin the reminder at
  // 9am local on that day. Produced as an ISO-ish datetime-local
  // string the SchedulePicker / save code both accept (they run it
  // through `new Date(...)` which parses it in the viewer's TZ; good
  // enough for "wake me up on trip day" semantics).
  const firesAt = args.startDate ? `${args.startDate}T09:00:00` : null;
  return {
    name: args.name,
    targetKind,
    personId,
    kind: "trip",
    items: [
      {
        id: genId(),
        name: args.name,
        firesAt,
        rrule: null,
      },
    ],
  };
}
