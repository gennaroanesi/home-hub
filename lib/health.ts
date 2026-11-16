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
import { ymdInTimezone } from "./pregnancy";

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
    // The visit's time is the item's booked date / done date.
    ...(status === "SCHEDULED" ? { scheduledAt: visit.visitAt } : {}),
    ...(status === "DONE" ? { completedAt: ymdLocal(visit.visitAt) } : {}),
  });
  if (visit.careItemId !== careItemId) {
    await client.models.homeMedicalVisit.update({ id: visit.id, careItemId });
  }
  return data ? { id: data.id, title: data.title, status: data.status ?? null } : null;
}

// ── Scheduling / completing care-timeline items ──────────────────────────────

const HOUSEHOLD_TZ = "America/Chicago";
const ymdLocal = (iso: string) => ymdInTimezone(HOUSEHOLD_TZ, new Date(iso));

// What kind of visit a care item turns into when it's booked.
const VISIT_KIND_BY_CARE_CATEGORY: Record<string, VisitKind> = {
  VISIT: "PRENATAL",
  LAB: "LAB_DRAW",
  SCREENING: "LAB_DRAW",
  IMAGING: "ULTRASOUND",
  VACCINE: "VACCINE",
};

async function providerContext(client: DataClient, providerId?: string | null): Promise<VisitEventContext> {
  if (!providerId) return {};
  const { data } = await client.models.homeHealthProvider.get({ id: providerId });
  return { providerName: data?.name, providerAddress: data?.address };
}

export interface CareItemLike {
  id: string;
  title: string;
  category?: string | null;
  visitId?: string | null;
}

/**
 * Book a care item for a specific date/time. If it's linked to a visit,
 * that visit (and its calendar event) moves to the new time. Otherwise,
 * with `withVisit`, a PLANNED visit is created for it — which puts it on
 * the calendar. Without a visit it just records the date.
 */
export async function scheduleCareItem(
  client: DataClient,
  item: CareItemLike,
  opts: { scheduledAt: string; personId: string; pregnancyId: string; withVisit: boolean },
): Promise<{ visitId: string | null; eventId: string | null }> {
  let visitId: string | null = null;
  let eventId: string | null = null;

  if (item.visitId) {
    const { data: visit } = await client.models.homeMedicalVisit.get({ id: item.visitId });
    if (visit && visit.status !== "CANCELLED") {
      const { data: moved } = await client.models.homeMedicalVisit.update({
        id: visit.id,
        visitAt: opts.scheduledAt,
        status: "PLANNED",
      });
      visitId = visit.id;
      eventId = await syncVisitEvent(client, moved ?? visit, await providerContext(client, visit.providerId));
    }
  }

  if (!visitId && opts.withVisit) {
    const { data: created, errors } = await client.models.homeMedicalVisit.create({
      personId: opts.personId,
      pregnancyId: opts.pregnancyId,
      careItemId: item.id,
      visitAt: opts.scheduledAt,
      kind: VISIT_KIND_BY_CARE_CATEGORY[item.category ?? ""] ?? "OTHER",
      status: "PLANNED",
      title: item.title,
      createdBy: "timeline",
    });
    if (errors?.length || !created) throw new Error(errors?.[0]?.message ?? "Couldn't create the visit");
    visitId = created.id;
    eventId = await syncVisitEvent(client, created);
  }

  const { errors } = await client.models.homeCareItem.update({
    id: item.id,
    status: "SCHEDULED",
    scheduledAt: opts.scheduledAt,
    completedAt: null,
    ...(visitId ? { visitId } : {}),
    ...(eventId ? { eventId } : {}),
  });
  if (errors?.length) throw new Error(errors[0].message);
  return { visitId, eventId };
}

/**
 * Mark a care item done on `completedAt` (YYYY-MM-DD). A linked visit
 * that's still PLANNED is marked COMPLETED too; its calendar event stays.
 */
export async function completeCareItem(
  client: DataClient,
  item: CareItemLike,
  completedAt: string,
): Promise<void> {
  const { errors } = await client.models.homeCareItem.update({
    id: item.id,
    status: "DONE",
    completedAt,
  });
  if (errors?.length) throw new Error(errors[0].message);
  if (item.visitId) {
    const { data: visit } = await client.models.homeMedicalVisit.get({ id: item.visitId });
    if (visit?.status === "PLANNED") {
      await client.models.homeMedicalVisit.update({ id: visit.id, status: "COMPLETED" });
    }
  }
}

// ── Display helpers (web /health and the mobile Health screen) ───────────────

/** Timezone the health pages show visit times in. */
export const HEALTH_TZ = HOUSEHOLD_TZ;

/** "Oct 12" for a YYYY-MM-DD (or longer ISO) string; "" when empty. */
export function formatYmdShort(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

/** "Mon, Oct 12, 9:30 AM" for a real-UTC instant, in the household timezone. */
export function formatVisitDateTime(iso: string, timeZone: string = HEALTH_TZ): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The visit's title, else its kind's label, else "Visit". */
export function visitDisplayTitle(v: { title?: string | null; kind?: string | null }): string {
  return v.title || (v.kind ? VISIT_KIND_LABELS[v.kind as VisitKind] ?? v.kind : "Visit");
}

export interface VisitVitals {
  weightLb?: number | null;
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  fetalHeartRate?: number | null;
}

/** "142 lb · BP 118/76 · FHR 150 bpm", or null when nothing was taken. */
export function visitVitalsSummary(v: VisitVitals): string | null {
  if (!(v.weightLb || v.bpSystolic || v.fetalHeartRate)) return null;
  return [
    v.weightLb ? `${v.weightLb} lb` : null,
    v.bpSystolic && v.bpDiastolic ? `BP ${v.bpSystolic}/${v.bpDiastolic}` : null,
    v.fetalHeartRate ? `FHR ${v.fetalHeartRate} bpm` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Newest visit first. */
export function sortVisitsNewestFirst<T extends { visitAt: string }>(visits: T[]): T[] {
  return visits.slice().sort((a, b) => b.visitAt.localeCompare(a.visitAt));
}

/**
 * Upcoming = planned and not yet started (soonest first); past = everything
 * else, including planned visits whose time has gone by (newest first).
 */
export function splitVisits<T extends { visitAt: string; status?: string | null }>(
  visits: T[],
  now: Date = new Date(),
): { upcoming: T[]; past: T[] } {
  const nowIso = now.toISOString();
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const v of visits) {
    if (v.status === "PLANNED" && new Date(v.visitAt).toISOString() >= nowIso) upcoming.push(v);
    else past.push(v);
  }
  upcoming.sort((a, b) => a.visitAt.localeCompare(b.visitAt));
  return { upcoming, past: sortVisitsNewestFirst(past) };
}

/**
 * Care items a visit can be linked to: the open ones, plus whatever the
 * visit already covers.
 */
export function linkableCareItems<T extends { id: string; status?: string | null }>(
  items: T[],
  currentCareItemId?: string | null,
): T[] {
  return items.filter(
    (c) => c.status === "UPCOMING" || c.status === "SCHEDULED" || c.id === currentCareItemId,
  );
}

/**
 * Whose health records to open first: whoever has an active pregnancy,
 * else the first household member, else anyone.
 */
export function defaultHealthPersonId(
  pregnancies: { personId: string; status?: string | null }[],
  household: { id: string }[],
  everyone: { id: string }[] = [],
): string {
  const active = pregnancies.find((p) => p.status === "ACTIVE");
  return active?.personId ?? household[0]?.id ?? everyone[0]?.id ?? "";
}

// ── Lab results ──────────────────────────────────────────────────────────────

export const LAB_FLAGS = ["NORMAL", "LOW", "HIGH", "ABNORMAL", "POSITIVE", "NEGATIVE", "PENDING"] as const;
export type LabFlag = (typeof LAB_FLAGS)[number];

export const LAB_FLAG_LABELS: Record<LabFlag, string> = {
  NORMAL: "Normal",
  LOW: "Low",
  HIGH: "High",
  ABNORMAL: "Abnormal",
  POSITIVE: "Positive",
  NEGATIVE: "Negative",
  PENDING: "Pending",
};

/** Flags worth drawing attention to: out of range (red) or positive (amber). */
export function labFlagTone(flag: string | null | undefined): "danger" | "warning" | "pending" | null {
  if (flag === "HIGH" || flag === "LOW" || flag === "ABNORMAL") return "danger";
  if (flag === "POSITIVE") return "warning";
  if (flag === "PENDING") return "pending";
  return null;
}

export interface LabLike {
  id: string;
  panel?: string | null;
  collectedAt?: string | null;
  createdAt: string;
  valueText?: string | null;
  unit?: string | null;
  flag?: string | null;
}

/** "11.8 g/dL", or "pending". */
export function labValueLabel(r: LabLike): string {
  return r.flag === "PENDING" ? "pending" : `${r.valueText ?? ""}${r.unit ? ` ${r.unit}` : ""}`;
}

export interface LabGroup<T extends LabLike> {
  key: string;
  label: string;
  date: string | null;
  rows: T[];
}

/**
 * Newest first, grouped by panel + collected date so a report reads as
 * one block.
 */
export function groupLabResults<T extends LabLike>(labs: T[]): LabGroup<T>[] {
  const sorted = labs
    .slice()
    .sort((a, b) => (b.collectedAt ?? b.createdAt).localeCompare(a.collectedAt ?? a.createdAt));
  const groups = new Map<string, LabGroup<T>>();
  for (const l of sorted) {
    const k = `${l.panel ?? ""}|${l.collectedAt ?? ""}`;
    if (!groups.has(k)) groups.set(k, { key: k, label: l.panel ?? "Results", date: l.collectedAt ?? null, rows: [] });
    groups.get(k)!.rows.push(l);
  }
  return Array.from(groups.values());
}

export interface LabResultInput {
  personId: string;
  testName: string;
  value?: string | null;
  unit?: string | null;
  referenceRange?: string | null;
  flag?: string | null;
  panel?: string | null;
  collectedAt?: string | null;
  createdBy?: string;
}

/** Field values for a new lab row (valueNum set when the value is numeric). */
export function labResultFields(input: LabResultInput) {
  const value = (input.value ?? "").trim();
  const n = Number(value);
  return {
    personId: input.personId,
    testName: input.testName.trim(),
    valueText: value || null,
    valueNum: value !== "" && Number.isFinite(n) ? n : null,
    unit: input.unit?.trim() || null,
    referenceRange: input.referenceRange?.trim() || null,
    flag: input.flag || null,
    panel: input.panel?.trim() || null,
    collectedAt: input.collectedAt || null,
    createdBy: input.createdBy ?? "ui",
  };
}

/** Create one lab row (bulk entry goes through Janet). */
export async function createLabResult(client: DataClient, input: LabResultInput): Promise<void> {
  const { errors } = await client.models.homeLabResult.create(labResultFields(input));
  if (errors?.length) throw new Error(errors[0].message);
}

// ── Saving a visit ───────────────────────────────────────────────────────────

export interface VisitFormValues {
  /** Real-UTC ISO instant. */
  visitAt: string;
  kind: string;
  status: string;
  title?: string | null;
  providerId?: string | null;
  questions?: string | null;
  notes?: string | null;
  followUp?: string | null;
  /** Vitals as typed ("" = not taken). */
  weight?: string;
  bpSystolic?: string;
  bpDiastolic?: string;
  fetalHeartRate?: string;
}

const numOrNull = (s: string | undefined) => (!s || s.trim() === "" ? null : Number(s));
const intOrNull = (s: string | undefined) => (!s || s.trim() === "" ? null : Math.round(Number(s)));

/** Form values → homeMedicalVisit fields (trimmed, blanks to null). */
export function visitFields(v: VisitFormValues) {
  return {
    visitAt: v.visitAt,
    kind: v.kind,
    status: v.status,
    title: v.title?.trim() || null,
    providerId: v.providerId || null,
    questions: v.questions?.trim() || null,
    notes: v.notes?.trim() || null,
    followUp: v.followUp?.trim() || null,
    weightLb: numOrNull(v.weight),
    bpSystolic: intOrNull(v.bpSystolic),
    bpDiastolic: intOrNull(v.bpDiastolic),
    fetalHeartRate: intOrNull(v.fetalHeartRate),
  };
}

export interface SaveVisitResult {
  visit: VisitLike & { careItemId?: string | null };
  eventId: string | null;
  /** Set when the visit saved but the calendar / timeline sync failed. */
  syncError: string | null;
}

/**
 * Create or update a visit, then keep its calendar event and timeline
 * item in step. Throws only when the visit itself didn't save; a sync
 * failure comes back as `syncError` (the edit isn't lost).
 */
export async function saveVisit(
  client: DataClient,
  opts: {
    visitId?: string | null;
    personId: string;
    pregnancyId?: string | null;
    values: VisitFormValues;
    /** Timeline item this visit covers; null/"" unlinks. */
    careItemId?: string | null;
    provider?: { name?: string | null; address?: string | null } | null;
    createdBy?: string;
  },
): Promise<SaveVisitResult> {
  const fields = visitFields(opts.values);
  const { data: saved, errors } = opts.visitId
    ? await client.models.homeMedicalVisit.update({ id: opts.visitId, ...fields })
    : await client.models.homeMedicalVisit.create({
        personId: opts.personId,
        pregnancyId: opts.pregnancyId ?? null,
        createdBy: opts.createdBy ?? "ui",
        ...fields,
      });
  if (errors?.length || !saved) throw new Error(errors?.[0]?.message ?? "save failed");

  try {
    const eventId = await syncVisitEvent(client, saved, {
      providerName: opts.provider?.name,
      providerAddress: opts.provider?.address,
    });
    if (opts.careItemId) {
      await linkVisitToCareItem(client, { ...saved, eventId }, opts.careItemId);
    } else if (saved.careItemId) {
      await client.models.homeMedicalVisit.update({ id: saved.id, careItemId: null });
    }
    return { visit: saved, eventId, syncError: null };
  } catch (err) {
    return { visit: saved, eventId: saved.eventId ?? null, syncError: err instanceof Error ? err.message : String(err) };
  }
}

// ── Saving a care-timeline item ──────────────────────────────────────────────

export interface CareItemDetails {
  title: string;
  category: string;
  windowStart: string;
  windowEnd: string;
  optional: boolean;
  notes?: string | null;
}

/** Why a care-item form can't be saved yet, or null. */
export function careItemFormError(f: {
  title: string;
  windowStart: string;
  windowEnd: string;
  status: string;
  scheduledAt?: string | null;
}): string | null {
  if (!f.title.trim() || !f.windowStart || !f.windowEnd) return "Title and window are required";
  if (f.windowEnd < f.windowStart) return "The window ends before it starts";
  if (f.status === "SCHEDULED" && !f.scheduledAt) return "Pick the date and time it's booked for";
  return null;
}

/** Set a status that needs no date (UPCOMING / SKIPPED / NOT_APPLICABLE). */
export async function setCareItemStatus(
  client: DataClient,
  id: string,
  status: string,
): Promise<Record<string, unknown> & { id: string }> {
  const { data, errors } = await client.models.homeCareItem.update({
    id,
    status,
    scheduledAt: null,
    completedAt: null,
  });
  if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "update failed");
  return data;
}

/**
 * Create or update a care item, then apply its status: SCHEDULED books
 * it (scheduleCareItem — moves or creates the visit), DONE completes it
 * (completeCareItem), anything else clears the dates.
 */
export async function saveCareItem(
  client: DataClient,
  opts: {
    itemId?: string | null;
    pregnancyId: string;
    personId: string;
    details: CareItemDetails;
    status: string;
    /** Real-UTC ISO instant, for SCHEDULED. */
    scheduledAt?: string | null;
    /** For SCHEDULED without a linked visit: create one (puts it on the calendar). */
    withVisit?: boolean;
    /** YYYY-MM-DD, for DONE. */
    completedAt?: string | null;
    today: string;
  },
): Promise<{ visitId: string | null }> {
  const details = {
    ...opts.details,
    title: opts.details.title.trim(),
    notes: opts.details.notes?.trim() || null,
  };
  const res = opts.itemId
    ? await client.models.homeCareItem.update({ id: opts.itemId, ...details })
    : await client.models.homeCareItem.create({
        pregnancyId: opts.pregnancyId,
        key: null,
        sortOrder: 999,
        status: "UPCOMING",
        ...details,
      });
  if (res.errors?.length || !res.data) throw new Error(res.errors?.[0]?.message ?? "save failed");
  const item = res.data;

  if (opts.status === "SCHEDULED") {
    if (!opts.scheduledAt) throw new Error("Pick the date and time it's booked for");
    const { visitId } = await scheduleCareItem(client, item, {
      scheduledAt: opts.scheduledAt,
      personId: opts.personId,
      pregnancyId: opts.pregnancyId,
      withVisit: opts.withVisit ?? true,
    });
    return { visitId };
  }
  if (opts.status === "DONE") {
    await completeCareItem(client, item, opts.completedAt || opts.today);
    return { visitId: null };
  }
  await setCareItemStatus(client, item.id, opts.status);
  return { visitId: null };
}

/** Confirmation text for deleting a care item. */
export function careItemDeletePrompt(item: { title: string; key?: string | null }): string {
  return item.key
    ? `Delete "${item.title}"? It's part of the standard timeline — marking it Skipped or N/A keeps a record instead.`
    : `Delete "${item.title}"?`;
}

export async function deleteCareItem(client: DataClient, id: string): Promise<void> {
  const { errors } = await client.models.homeCareItem.delete({ id });
  if (errors?.length) throw new Error(errors[0].message);
}

// ── Saving a provider ────────────────────────────────────────────────────────

/** Drop blank numbers; trim; default the kind to OTHER. */
export function cleanProviderPhones(phones: ProviderPhone[]): ProviderPhone[] {
  return phones
    .filter((p) => p.number.trim())
    .map((p) => ({ kind: p.kind ?? "OTHER", number: p.number.trim(), label: p.label?.trim() || null }));
}

export interface ProviderFormValues {
  name: string;
  specialty?: string | null;
  practice?: string | null;
  phones: ProviderPhone[];
  address?: string | null;
  portalUrl?: string | null;
  notes?: string | null;
}

/** Create or update a provider. New ones belong to `personId` (if given). */
export async function saveProvider(
  client: DataClient,
  opts: { providerId?: string | null; personId?: string | null; values: ProviderFormValues },
): Promise<void> {
  const v = opts.values;
  const fields = {
    name: v.name.trim(),
    specialty: v.specialty?.trim() || null,
    practice: v.practice?.trim() || null,
    phones: cleanProviderPhones(v.phones),
    // Legacy field now lives in phones; clear it so it isn't shown twice.
    phone: null,
    address: v.address?.trim() || null,
    portalUrl: v.portalUrl?.trim() || null,
    notes: v.notes?.trim() || null,
  };
  const { errors } = opts.providerId
    ? await client.models.homeHealthProvider.update({ id: opts.providerId, ...fields })
    : await client.models.homeHealthProvider.create({
        ...fields,
        personIds: opts.personId ? [opts.personId] : [],
        active: true,
      });
  if (errors?.length) throw new Error(errors[0].message);
}

/** Soft delete, like the agent: visits keep pointing at the row. */
export async function archiveProvider(client: DataClient, id: string): Promise<void> {
  const { errors } = await client.models.homeHealthProvider.update({ id, active: false });
  if (errors?.length) throw new Error(errors[0].message);
}
