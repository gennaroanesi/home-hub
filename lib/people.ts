// Household vs. contact book. Both live in homePerson (see the comment on
// the model): household members are the app users in `home-users`
// (lib/household.ts), managed on /admin/people; everyone else is a
// contact, managed on /contacts.

import { HOUSEHOLD_GROUP } from "./household";

export const CIRCLES = ["FAMILY", "FRIEND", "WORK", "OTHER"] as const;
export type Circle = (typeof CIRCLES)[number];

export const CIRCLE_LABELS: Record<Circle, string> = {
  FAMILY: "Family",
  FRIEND: "Friends",
  WORK: "Work",
  OTHER: "Other",
};

export function circleLabel(r: string | null | undefined): string | null {
  return r && r in CIRCLE_LABELS ? CIRCLE_LABELS[r as Circle] : null;
}

/** Groups an admin can give a member. A "friends" group comes with sharing. */
export const ASSIGNABLE_GROUPS = [HOUSEHOLD_GROUP, "admins"];

/**
 * In the household, for the admin pages: unlike isHouseholdMember,
 * inactive members still count so they can be found and reactivated.
 */
export function inHousehold(p: { groups?: (string | null)[] | null }): boolean {
  return (p.groups ?? []).includes(HOUSEHOLD_GROUP);
}

export interface PickerPerson {
  id: string;
  name: string;
  groups?: (string | null)[] | null;
  circle?: string | null;
}

export interface PickerSection<P> {
  key: "HOUSEHOLD" | Circle;
  label: string;
  people: P[];
}

/** Lowercase without accents, so "jose" finds "José". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * People pickers list the household first, then the contact book by circle
 * (Family, Friends, Work, Other; no circle counts as Other), A–Z within each,
 * keeping only names that match `query`. Empty sections are left out.
 */
export function pickerSections<P extends PickerPerson>(people: P[], query = ""): PickerSection<P>[] {
  const q = fold(query.trim());
  const sections: PickerSection<P>[] = [
    { key: "HOUSEHOLD", label: "Household", people: [] },
    ...CIRCLES.map((c) => ({ key: c, label: CIRCLE_LABELS[c], people: [] as P[] })),
  ];
  const byKey = new Map(sections.map((s) => [s.key, s]));
  for (const p of people) {
    if (q && !fold(p.name).includes(q)) continue;
    const key = inHousehold(p) ? "HOUSEHOLD" : circleLabel(p.circle) ? (p.circle as Circle) : "OTHER";
    byKey.get(key)!.people.push(p);
  }
  for (const s of sections) s.people.sort((a, b) => a.name.localeCompare(b.name));
  return sections.filter((s) => s.people.length > 0);
}

/** "Mar 4", plus the age they turn this year when the year is known (1900 = unknown). */
export function birthdayLabel(birthday: string | null | undefined, todayIso: string): string | null {
  if (!birthday) return null;
  const [y, m, d] = birthday.split("-").map(Number);
  if (!m || !d) return null;
  const md = new Date(Date.UTC(2000, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (!y || y <= 1900) return md;
  const turns = Number(todayIso.slice(0, 4)) - y;
  return `${md} · turns ${turns}`;
}

/** Days from today to the next birthday (0 = today); null without one. Feb 29 counts as Mar 1 off leap years. */
export function daysToBirthday(birthday: string | null | undefined, todayIso: string): number | null {
  if (!birthday) return null;
  const [, m, d] = birthday.split("-").map(Number);
  if (!m || !d) return null;
  const today = Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, +todayIso.slice(8, 10));
  const year = +todayIso.slice(0, 4);
  let next = Date.UTC(year, m - 1, d);
  if (next < today) next = Date.UTC(year + 1, m - 1, d);
  return Math.round((next - today) / 86_400_000);
}
