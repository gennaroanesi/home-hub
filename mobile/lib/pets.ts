// Pet helpers — types + cosmetic config + date helpers shared
// between the list, detail, and form screens. Mirrors the same
// shape as lib/documents.ts: type unions for the schema enums,
// emoji + label maps for display, small comparators.

import type { Schema } from "../../amplify/data/resource";

export type Pet = Schema["homePet"]["type"];
export type PetMedication = Schema["homePetMedication"]["type"];
export type PetVaccine = Schema["homePetVaccine"]["type"];

export type PetSpecies = "DOG" | "CAT" | "OTHER";

export const SPECIES_LABEL: Record<PetSpecies, string> = {
  DOG: "Dog",
  CAT: "Cat",
  OTHER: "Other",
};

export const SPECIES_EMOJI: Record<PetSpecies, string> = {
  DOG: "🐶",
  CAT: "🐱",
  OTHER: "🐾",
};

/** Years (with 1 decimal under 2y) since dob, or null if no dob. */
export function ageLabel(dob: string | null | undefined): string | null {
  if (!dob) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  if (!m) return null;
  const birth = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const years = (now.getTime() - birth.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (years < 0) return null;
  if (years < 1) {
    const months = Math.max(0, Math.round(years * 12));
    return `${months} mo`;
  }
  if (years < 2) return `${years.toFixed(1)} yrs`;
  return `${Math.floor(years)} yrs`;
}

/** Days until a YYYY-MM-DD; negative = past, null = no date. */
export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (24 * 3600 * 1000));
}

/** Human-readable next-due label for vaccines. */
export function nextDueLabel(dateStr: string | null | undefined): string | null {
  const days = daysUntil(dateStr);
  if (days == null) return null;
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days <= 30) return `Due in ${days}d`;
  if (days <= 180) {
    const months = Math.round(days / 30);
    return `Due in ${months} mo`;
  }
  const m = /^(\d{4})/.exec(dateStr ?? "");
  return m ? `Due ${m[1]}` : `Due in ${days}d`;
}

export function isVaccineDueSoon(v: PetVaccine): boolean {
  const days = daysUntil(v.nextDueAt);
  return days !== null && days <= 60;
}

/** Sort: active meds first, then by name. */
export function compareMedications(
  a: PetMedication,
  b: PetMedication
): number {
  const aActive = a.isActive !== false;
  const bActive = b.isActive !== false;
  if (aActive !== bActive) return aActive ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Sort: due-soon-or-overdue first; then by administeredAt desc. */
export function compareVaccines(a: PetVaccine, b: PetVaccine): number {
  const aDue = daysUntil(a.nextDueAt);
  const bDue = daysUntil(b.nextDueAt);
  // Both have a due date — earlier (more overdue / sooner) wins.
  if (aDue != null && bDue != null && aDue !== bDue) return aDue - bDue;
  if (aDue != null && bDue == null) return -1;
  if (bDue != null && aDue == null) return 1;
  // No tiebreak via due — fall back to most-recently-administered.
  return (b.administeredAt ?? "").localeCompare(a.administeredAt ?? "");
}

/** "Apr 27, 2026" — display a YYYY-MM-DD date. */
export function formatDate(s: string | null | undefined): string {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
