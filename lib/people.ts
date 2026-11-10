// Household vs. contact book. Both live in homePerson (see the comment on
// the model): household members are the app users in `home-users`
// (lib/household.ts), managed on /admin/people; everyone else is a
// contact, managed on /contacts.

import { HOUSEHOLD_GROUP } from "./household";

export const RELATIONSHIPS = ["FAMILY", "FRIEND", "WORK", "OTHER"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  FAMILY: "Family",
  FRIEND: "Friend",
  WORK: "Work",
  OTHER: "Other",
};

export function relationshipLabel(r: string | null | undefined): string | null {
  return r && r in RELATIONSHIP_LABELS ? RELATIONSHIP_LABELS[r as Relationship] : null;
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
