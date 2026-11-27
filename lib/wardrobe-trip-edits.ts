// Trip looks: the client-side edits to a saved homeWardrobeTripPlan row,
// shared by the web Trip looks tab (components/wardrobe/trip-panel.tsx) and
// the mobile trip looks screen. Each helper takes the row as loaded and
// returns the patch to write with homeWardrobeTripPlan.update, so both
// surfaces snapshot `previousPlan` (one-step undo), keep packed ticks and
// stringify AWSJSON fields the same way. Pure: no I/O.
//
// The model-backed changes (plan, tweak) go through the planTripOutfits
// mutation; see lib/wardrobe-trip.ts.

import {
  moveTripLook,
  parseJsonField,
  type TripLook,
  type TripPlan,
  type TripPlanSnapshot,
} from "./wardrobe-trip";

/** The fields of a homeWardrobeTripPlan row these helpers read. */
export interface TripPlanRow {
  status?: string | null;
  generatedAt?: string | null;
  updatedAt?: string | null;
  packItemIds?: (string | null)[] | null;
  packedItemIds?: (string | null)[] | null;
  looks?: unknown;
  tips?: string | null;
  feedback?: (string | null)[] | null;
  previousPlan?: unknown;
  mode?: string | null;
  pickedItemIds?: (string | null)[] | null;
  pickedCopies?: unknown;
}

/** What to write back. `looks` and `previousPlan` are already JSON strings (AWSJSON). */
export interface TripPlanPatch {
  packItemIds?: string[];
  packedItemIds?: string[];
  looks?: string;
  tips?: string | null;
  feedback?: string[];
  previousPlan?: string;
  error?: null;
  // PICKED plans: the picks follow the packing list, so the next check reviews what's packed now.
  pickedItemIds?: string[];
  pickedCopies?: string;
}

// The planner Lambda outlives AppSync's 30s limit, so callers poll the row.
export const TRIP_PLAN_POLL_MS = 4000;
export const TRIP_PLAN_POLL_LIMIT_MS = 150_000;

const ids = (v: (string | null)[] | null | undefined): string[] => (v ?? []).filter((x): x is string => !!x);

export function tripPlanOf(row: TripPlanRow): TripPlan {
  return { packItemIds: ids(row.packItemIds), looks: parseJsonField<TripLook[]>(row.looks, []), tips: row.tips ?? null };
}

export function tripPlanSnapshotOf(row: TripPlanRow): TripPlanSnapshot {
  return { ...tripPlanOf(row), feedback: ids(row.feedback) };
}

/** The plan to show: a READY one, or the one a running tweak / re-plan started from. */
export function shownTripPlan<R extends TripPlanRow>(row: R | null | undefined): R | null {
  if (!row) return null;
  return row.status === "READY" || (row.status === "GENERATING" && row.generatedAt) ? row : null;
}

/** A plan still being generated, recently enough that it's worth polling. */
export function tripPlanStillGenerating(row: TripPlanRow | null | undefined, now = Date.now()): boolean {
  if (row?.status !== "GENERATING") return false;
  const at = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
  return now - at < TRIP_PLAN_POLL_LIMIT_MS;
}

/** Tick / untick a packed piece. */
export function togglePackedPatch(row: TripPlanRow, id: string): TripPlanPatch {
  const cur = ids(row.packedItemIds);
  return { packedItemIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
}

/** For a PICKED plan, picks that match `packItemIds` (copies kept for pieces still picked). */
function picksPatch(row: TripPlanRow, packItemIds: string[]): Pick<TripPlanPatch, "pickedItemIds" | "pickedCopies"> {
  if (row.mode !== "PICKED") return {};
  const copies = parseJsonField<Record<string, number>>(row.pickedCopies, {});
  const kept = Object.fromEntries(Object.entries(copies).filter(([id]) => packItemIds.includes(id)));
  return { pickedItemIds: packItemIds, pickedCopies: JSON.stringify(kept) };
}

/**
 * A direct packing-list edit (replace / remove / add, lib/wardrobe-trip.ts)
 * saved through previousPlan so "Undo last change" works. Ticks only survive
 * for pieces still on the list; a new piece starts unticked.
 */
export function editTripPlanPatch(row: TripPlanRow, next: TripPlan): TripPlanPatch {
  const current = tripPlanOf(row);
  return {
    packItemIds: next.packItemIds,
    looks: JSON.stringify(next.looks),
    packedItemIds: ids(row.packedItemIds).filter((id) => next.packItemIds.includes(id) && current.packItemIds.includes(id)),
    previousPlan: JSON.stringify(tripPlanSnapshotOf(row)),
    error: null,
    ...picksPatch(row, next.packItemIds),
  };
}

/** Swaps the plan with the one before the last change, so undo can itself be undone. Null when there's nothing to undo. */
export function undoTripPlanPatch(row: TripPlanRow): TripPlanPatch | null {
  const prev = parseJsonField<TripPlanSnapshot | null>(row.previousPlan, null);
  if (!prev) return null;
  return {
    packItemIds: prev.packItemIds,
    looks: JSON.stringify(prev.looks),
    tips: prev.tips,
    feedback: prev.feedback ?? [],
    packedItemIds: ids(row.packedItemIds).filter((id) => prev.packItemIds.includes(id)),
    previousPlan: JSON.stringify(tripPlanSnapshotOf(row)),
    error: null,
    ...picksPatch(row, prev.packItemIds),
  };
}

/**
 * Moves look `n` to another day (null = any day); the look already on that
 * day takes the old one's. Null when nothing changes.
 */
export function moveTripLookPatch(
  row: TripPlanRow,
  n: number,
  date: string | null,
): { patch: TripPlanPatch; moved: TripLook; swappedWith: TripLook | null } | null {
  const current = tripPlanOf(row);
  const { plan: next, swappedWith } = moveTripLook({ packItemIds: [], looks: current.looks, tips: null }, n, date);
  if (next.looks === current.looks) return null;
  return {
    patch: { looks: JSON.stringify(next.looks), previousPlan: JSON.stringify(tripPlanSnapshotOf(row)), error: null },
    moved: current.looks[n],
    swappedWith,
  };
}

export interface SavedLookLike {
  id: string;
  title?: string | null;
  occasion?: string | null;
  note?: string | null;
  itemIds?: (string | null)[] | null;
}

/**
 * Pins look `n` to a saved closet look, taking any edits made while saving
 * (title, occasion, note, pieces), or unpins it (saved = null). The look's
 * pieces go on the packing list. Null when there's no look `n`.
 */
export function pinTripLookPatch(row: TripPlanRow, n: number, saved: SavedLookLike | null): TripPlanPatch | null {
  const list = parseJsonField<TripLook[]>(row.looks, []).slice();
  const l = list[n];
  if (!l) return null;
  const itemIds = saved ? ids(saved.itemIds) : l.itemIds;
  list[n] = saved
    ? {
        ...l,
        lookId: saved.id,
        title: saved.title || l.title,
        occasion: saved.occasion ?? l.occasion,
        why: saved.note ?? l.why,
        itemIds: itemIds.length ? itemIds : l.itemIds,
      }
    : { ...l, lookId: null };
  const pack = ids(row.packItemIds);
  for (const id of list[n].itemIds) if (!pack.includes(id)) pack.push(id);
  return { looks: JSON.stringify(list), packItemIds: pack, ...picksPatch(row, pack) };
}

/** Forget one remembered tweak (later plans stop following it). */
export function forgetFeedbackPatch(row: TripPlanRow, n: number): TripPlanPatch {
  return { feedback: ids(row.feedback).filter((_, i) => i !== n) };
}

/** Toast text after a direct packing-list edit: "2 looks changed; 1 saved look keeps the Oxford". */
export function packEditSummary(changedLooks: number, pinnedKept: number, keptName?: string): string {
  return (
    `${changedLooks} look${changedLooks === 1 ? "" : "s"} changed` +
    (pinnedKept && keptName ? `; ${pinnedKept} saved look${pinnedKept === 1 ? " keeps" : "s keep"} the ${keptName}` : "")
  );
}

/** "Sat, Nov 14" for a YYYY-MM-DD trip day. */
export function tripDayLabel(ymd: string): string {
  return new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Trips a person is on; trips with no participants count for everyone. */
export function tripsForPerson<T extends { participantIds?: (string | null)[] | null }>(trips: T[], personId: string): T[] {
  return trips.filter((t) => {
    const p = ids(t.participantIds);
    return !p.length || p.includes(personId);
  });
}

/** Upcoming and ongoing trips first (soonest first), then past ones (latest first). */
export function sortTripsForPlanning<T extends { startDate: string; endDate: string }>(trips: T[], today: string): T[] {
  const live = trips.filter((t) => t.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = trips.filter((t) => t.endDate < today).sort((a, b) => b.startDate.localeCompare(a.startDate));
  return [...live, ...past];
}

/** Packing-list pieces grouped by category, in list order. */
export function groupByCategory<T extends { category: string }>(items: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) m.set(it.category, [...(m.get(it.category) ?? []), it]);
  return Array.from(m.entries());
}

/** The newest plan row (one per trip + person, but tolerate strays). */
export function latestTripPlan<R extends { updatedAt: string }>(rows: R[]): R | null {
  return rows.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}
