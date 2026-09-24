// Shared health-record helpers for the /health page and the agent:
// visit ↔ calendar-event sync, visit deletion, provider phone numbers.
//
// Visits own their calendar event: every non-cancelled visit has one
// (homeMedicalVisit.eventId), kept in step by syncVisitEvent after each
// save. The event is what shows up on the calendar, in the daily summary
// and in reminders; the visit row holds the clinical record.
//
// Write helpers take the Amplify data client as `any` so the browser
// (userPool) and Lambda (IAM) clients both fit — see lib/note-parent.ts.

import { cascadeDeleteNotesFor } from "./note-parent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataClient = any;

export const VISIT_KINDS = [
  "PRENATAL",
  "ULTRASOUND",
  "LAB_DRAW",
  "CHECKUP",
  "SPECIALIST",
  "VACCINE",
  "URGENT",
  "OTHER",
] as const;
export type VisitKind = (typeof VISIT_KINDS)[number];

export const VISIT_KIND_LABELS: Record<VisitKind, string> = {
  PRENATAL: "Prenatal",
  ULTRASOUND: "Ultrasound",
  LAB_DRAW: "Lab draw",
  CHECKUP: "Checkup",
  SPECIALIST: "Specialist",
  VACCINE: "Vaccine",
  URGENT: "Urgent",
  OTHER: "Other",
};

// ── Visit → calendar event ───────────────────────────────────────────────────

export interface VisitLike {
  id: string;
  personId: string;
  visitAt: string;
  status?: string | null;
  kind?: string | null;
  title?: string | null;
  eventId?: string | null;
}

export interface VisitEventContext {
  providerName?: string | null;
  providerAddress?: string | null;
}

const HOUR_MS = 60 * 60 * 1000;

/** "Intake visit · Dr. Lee" — the visit title (or kind), plus the provider. */
export function visitEventTitle(visit: VisitLike, ctx: VisitEventContext = {}): string {
  const base =
    visit.title?.trim() ||
    (visit.kind && visit.kind !== "OTHER" && visit.kind in VISIT_KIND_LABELS
      ? `${VISIT_KIND_LABELS[visit.kind as VisitKind]} visit`
      : "Appointment");
  return ctx.providerName ? `${base} · ${ctx.providerName}` : base;
}

function visitEventDescription(ctx: VisitEventContext): string {
  return [ctx.providerAddress, "Linked to a visit on the Health page — edit the time there."]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Create, update or remove the visit's calendar event to match the visit.
 * - CANCELLED → the event is deleted and eventId cleared.
 * - Linked event still exists → title and start move with the visit (its
 *   duration and description are left as the user set them).
 * - Otherwise → a 1-hour event is created and linked.
 * Returns the event id (null when cancelled).
 */
export async function syncVisitEvent(
  client: DataClient,
  visit: VisitLike,
  ctx: VisitEventContext = {},
): Promise<string | null> {
  if (visit.status === "CANCELLED") {
    if (visit.eventId) {
      await client.models.homeCalendarEvent.delete({ id: visit.eventId });
      await client.models.homeMedicalVisit.update({ id: visit.id, eventId: null });
    }
    return null;
  }

  const title = visitEventTitle(visit, ctx);
  const start = new Date(visit.visitAt);

  if (visit.eventId) {
    const { data: existing } = await client.models.homeCalendarEvent.get({ id: visit.eventId });
    if (existing) {
      const duration = existing.endAt
        ? Math.max(0, Date.parse(existing.endAt) - Date.parse(existing.startAt))
        : HOUR_MS;
      await client.models.homeCalendarEvent.update({
        id: existing.id,
        title,
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + duration).toISOString(),
      });
      return existing.id;
    }
    // Event was deleted from the calendar — fall through and recreate it.
  }

  const { data: created, errors } = await client.models.homeCalendarEvent.create({
    title,
    description: visitEventDescription(ctx),
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + HOUR_MS).toISOString(),
    isAllDay: false,
    assignedPersonIds: [visit.personId],
  });
  if (errors?.length || !created) {
    throw new Error(errors?.[0]?.message ?? "Couldn't create the calendar event");
  }
  await client.models.homeMedicalVisit.update({ id: visit.id, eventId: created.id });
  return created.id;
}

/** Delete a visit together with its calendar event and notes. */
export async function deleteVisit(client: DataClient, visit: VisitLike): Promise<void> {
  if (visit.eventId) await client.models.homeCalendarEvent.delete({ id: visit.eventId });
  await cascadeDeleteNotesFor(client, visit.id);
  const { errors } = await client.models.homeMedicalVisit.delete({ id: visit.id });
  if (errors?.length) throw new Error(errors[0].message);
}

// ── Provider phones ──────────────────────────────────────────────────────────

export const PHONE_KINDS = [
  "CLINIC",
  "PERSONAL",
  "AFTER_HOURS",
  "NURSE_LINE",
  "SCHEDULING",
  "BILLING",
  "FAX",
  "OTHER",
] as const;
export type PhoneKind = (typeof PHONE_KINDS)[number];

export const PHONE_KIND_LABELS: Record<PhoneKind, string> = {
  CLINIC: "Clinic",
  PERSONAL: "Personal / cell",
  AFTER_HOURS: "After hours",
  NURSE_LINE: "Nurse line",
  SCHEDULING: "Scheduling",
  BILLING: "Billing",
  FAX: "Fax",
  OTHER: "Other",
};

export interface ProviderPhone {
  kind?: PhoneKind | null;
  number: string;
  label?: string | null;
}

/**
 * A provider's phone numbers. Rows created before `phones` existed only
 * have the single legacy `phone`, surfaced here as a clinic number.
 */
export function providerPhones(p: {
  phone?: string | null;
  phones?: (ProviderPhone | null | undefined)[] | null;
}): ProviderPhone[] {
  const phones = (p.phones ?? []).filter((x): x is ProviderPhone => !!x?.number);
  if (phones.length > 0) return phones;
  return p.phone ? [{ kind: "CLINIC", number: p.phone, label: null }] : [];
}

// ── Visit → care-timeline item ───────────────────────────────────────────────

/**
 * Link a visit to the care-timeline item it fulfils and move the item
 * along: a planned visit makes it SCHEDULED, a completed one DONE (dated
 * the visit day). Cancelled visits leave the item's status alone.
 */
export async function linkVisitToCareItem(
  client: DataClient,
  visit: VisitLike & { careItemId?: string | null },
  careItemId: string,
): Promise<{ id: string; title: string; status: string | null } | null> {
  const status =
    visit.status === "COMPLETED" ? "DONE" : visit.status === "PLANNED" ? "SCHEDULED" : undefined;
  const { data } = await client.models.homeCareItem.update({
    id: careItemId,
    visitId: visit.id,
    ...(status ? { status } : {}),
    ...(visit.eventId ? { eventId: visit.eventId } : {}),
    ...(status === "DONE" ? { completedAt: visit.visitAt.slice(0, 10) } : {}),
  });
  if (visit.careItemId !== careItemId) {
    await client.models.homeMedicalVisit.update({ id: visit.id, careItemId });
  }
  return data ? { id: data.id, title: data.title, status: data.status ?? null } : null;
}
