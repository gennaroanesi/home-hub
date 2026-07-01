// Shared checklist types, constants, and pure helpers — single source
// of truth for both the web (/checklists, components/checklist-panel)
// and the mobile checklist screens. mobile/lib/checklist.ts is a thin
// re-export so the two surfaces never drift.
//
// Keep this file dependency-free beyond the Amplify Schema type import:
// no React, no UI libs, nothing platform-specific. Pure data/derivation
// only — anything that touches state or renders belongs in the caller.

import type { Schema } from "../amplify/data/resource";

export type Checklist = Schema["homeChecklist"]["type"];
export type ChecklistItem = Schema["homeChecklistItem"]["type"];

export type EntityType =
  | "TRIP"
  | "EVENT"
  | "BILL"
  | "DOCUMENT"
  | "TASK"
  | "TEMPLATE"
  | "OTHER";

// Display order for the "All checklists" page (TEMPLATE renders in
// its own section above so it's excluded here).
export const ENTITY_TYPE_ORDER: EntityType[] = [
  "TRIP",
  "EVENT",
  "TASK",
  "BILL",
  "DOCUMENT",
  "OTHER",
];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  TRIP: "Trips",
  EVENT: "Events",
  TASK: "Tasks",
  BILL: "Bills",
  DOCUMENT: "Documents",
  TEMPLATE: "Templates",
  OTHER: "Other",
};

// Single-entity label (used in form pickers / one-row contexts).
export const ENTITY_TYPE_SINGULAR: Record<EntityType, string> = {
  TRIP: "Trip",
  EVENT: "Event",
  TASK: "Task",
  BILL: "Bill",
  DOCUMENT: "Document",
  TEMPLATE: "Template",
  OTHER: "Other",
};

// Constant entityId we use for the TEMPLATE bucket. All template
// checklists share this id (entityType + entityId composite is what
// distinguishes them; TEMPLATE doesn't reference any real entity).
export const TEMPLATE_ENTITY_ID = "templates";

// Sentinel section key for items with no explicit section. Callers
// that render section headers should special-case this to render as
// "Ungrouped" (or hide the header entirely if it's the only group).
export const UNGROUPED = "__ungrouped__";

export interface SectionGroup {
  sectionId: string; // UNGROUPED sentinel or the actual section name
  sectionName: string; // human-readable
  items: ChecklistItem[];
  sortOrder: number; // ordering among sibling sections
}

/**
 * Group a flat list of items into ordered sections.
 *
 * Ungrouped items always come first (under the UNGROUPED sentinel).
 * Remaining sections honor the explicit `sectionOrder` argument when
 * present, falling back to the minimum item sortOrder. Items inside
 * each section are sorted by their own sortOrder.
 *
 * `sectionOrder` is optional — pass `[]` to fall back entirely to the
 * derived order (useful on read-only surfaces like mobile that don't
 * track section ordering in state).
 */
export function buildSectionGroups(
  items: ChecklistItem[],
  sectionOrder: string[] = []
): SectionGroup[] {
  const map = new Map<string, ChecklistItem[]>();
  for (const item of items) {
    const key = item.section || UNGROUPED;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  Array.from(map.values()).forEach((groupItems) => {
    groupItems.sort(
      (a: ChecklistItem, b: ChecklistItem) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
    );
  });

  const groups: SectionGroup[] = [];
  if (map.has(UNGROUPED)) {
    groups.push({
      sectionId: UNGROUPED,
      sectionName: "Ungrouped",
      items: map.get(UNGROUPED)!,
      sortOrder: -1,
    });
    map.delete(UNGROUPED);
  }

  const remaining = Array.from(map.keys()).sort((a, b) => {
    const aIdx = sectionOrder.indexOf(a);
    const bIdx = sectionOrder.indexOf(b);
    const aOrder = aIdx >= 0 ? aIdx : 9999;
    const bOrder = bIdx >= 0 ? bIdx : 9999;
    return aOrder - bOrder || a.localeCompare(b);
  });
  for (const key of remaining) {
    const idx = sectionOrder.indexOf(key);
    groups.push({
      sectionId: key,
      sectionName: key,
      items: map.get(key)!,
      sortOrder: idx >= 0 ? idx : 9999,
    });
  }
  return groups;
}

/**
 * Derive section names in their natural order from a flat list of
 * items (lowest sortOrder first). Useful for seeding section-ordering
 * state when none is persisted.
 */
export function deriveSectionOrder(items: ChecklistItem[]): string[] {
  const minOrderBySection = new Map<string, number>();
  for (const item of items) {
    const sec = item.section;
    if (!sec) continue;
    const order = item.sortOrder ?? 0;
    const existing = minOrderBySection.get(sec);
    if (existing === undefined || order < existing) {
      minOrderBySection.set(sec, order);
    }
  }
  return Array.from(minOrderBySection.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
}

export interface ChecklistProgress {
  done: number;
  total: number;
  /** Integer 0–100, or 0 if total === 0. */
  pct: number;
}

export function progress(items: ChecklistItem[]): ChecklistProgress {
  const total = items.length;
  const done = items.filter((i) => !!i.isDone).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, pct };
}

// ── Archive filter ────────────────────────────────────────────────
// A row is "archived" when isArchived === true. null/undefined counts
// as active so existing rows created before this field lands stay
// visible without a backfill.

export type ArchiveFilter = "ACTIVE" | "ARCHIVED" | "ALL";

export const ARCHIVE_FILTERS: { id: ArchiveFilter; label: string }[] = [
  { id: "ACTIVE", label: "Active" },
  { id: "ARCHIVED", label: "Archived" },
  { id: "ALL", label: "All" },
];

export function isArchived(cl: Pick<Checklist, "isArchived">): boolean {
  return cl.isArchived === true;
}

export function matchesArchiveFilter(
  cl: Pick<Checklist, "isArchived">,
  filter: ArchiveFilter
): boolean {
  const archived = isArchived(cl);
  if (filter === "ACTIVE") return !archived;
  if (filter === "ARCHIVED") return archived;
  return true;
}
