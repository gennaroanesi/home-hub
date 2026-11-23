// Spend groups (homeFinanceSpendGroup): a trip, the nursery, a remodel.
// Tagged transactions count here instead of against the monthly budget.
// The kinds and the form → row check, shared by the Groups page, the
// "New group" forms in the transaction editors (web and phone) and the
// save_finance_spend_group op.

export const SPEND_GROUP_KINDS = ["TRIP", "PROJECT", "EVENT", "OTHER"] as const;
export type SpendGroupKind = (typeof SPEND_GROUP_KINDS)[number];
export const SPEND_GROUP_KIND_LABELS: Record<SpendGroupKind, string> = { TRIP: "Trip", PROJECT: "Project", EVENT: "Event", OTHER: "Other" };

export type SpendGroupDraft = { name: string; kind: SpendGroupKind; budget: string; startDate: string; endDate: string };

export const EMPTY_SPEND_GROUP: SpendGroupDraft = { name: "", kind: "PROJECT", budget: "", startDate: "", endDate: "" };

export type SpendGroupFields = { name: string; kind: SpendGroupKind; budget: number | null; startDate: string | null; endDate: string | null };

/** The fields to save, or the reason they can't be. */
export function spendGroupFields(d: SpendGroupDraft): { fields: SpendGroupFields } | { error: string } {
  const name = d.name.trim().replace(/\s+/g, " ");
  if (!name) return { error: "A name is required" };
  const budget = d.budget.trim() === "" ? null : Number(d.budget);
  if (budget != null && (!Number.isFinite(budget) || budget < 0)) return { error: "Budget must be a positive number" };
  const startDate = d.startDate || null;
  const endDate = d.endDate || null;
  if (startDate && endDate && endDate < startDate) return { error: "The end is before the start" };
  return { fields: { name, kind: d.kind, budget, startDate, endDate } };
}

/** Pickers list the newest groups first, then by name. */
export function sortSpendGroups<T extends { name: string; startDate?: string | null }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? "") || a.name.localeCompare(b.name));
}
