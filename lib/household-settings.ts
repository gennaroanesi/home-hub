// Thin wrappers for reading the singleton homeSettings row. Used by any
// Lambda or client that needs the household timezone (or future settings).
// The singleton convention is by agreement, not schema enforcement: the UI
// only ever creates one row, and readers take the first row via list().

import { DEFAULT_HOUSEHOLD_TZ } from "./reminder-schedule";

/**
 * Read the household timezone from settings. Returns DEFAULT_HOUSEHOLD_TZ
 * if no settings row exists or the row has no TZ set. Never throws — a
 * missing settings row shouldn't break anything.
 *
 * The client parameter is typed `any` so this helper stays compatible
 * with both the userPool-auth UI client and the IAM-auth Lambda client,
 * which have subtly different generated method signatures that don't
 * reduce to a common narrower interface without variance conflicts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getHouseholdTimezone(client: any): Promise<string> {
  try {
    // No limit:1 — that's the DDB scan-page size, and if the table
    // ever has >1 row we'd return whichever one happened to be at
    // the head of the scan. Default page size is fine.
    const { data } = await client.models.homeSettings.list();
    const tz = data?.[0]?.householdTimezone as string | null | undefined;
    return tz ?? DEFAULT_HOUSEHOLD_TZ;
  } catch {
    return DEFAULT_HOUSEHOLD_TZ;
  }
}

/**
 * Resolve the effective timezone for a reminder. Falls through the
 * precedence chain:
 *   1. targetPersonTz (if the reminder is PERSON-targeted and that
 *      person has a defaultTimezone set)
 *   2. householdTz
 *   3. DEFAULT_HOUSEHOLD_TZ
 *
 * Pure helper — no I/O. Callers pre-fetch the household TZ and the
 * target person's TZ, then call this to pick.
 */
export function resolveReminderTimezone(args: {
  targetKind?: string | null;
  targetPersonTz?: string | null;
  householdTz?: string | null;
}): string {
  if (args.targetKind === "PERSON" && args.targetPersonTz) {
    return args.targetPersonTz;
  }
  return args.householdTz ?? DEFAULT_HOUSEHOLD_TZ;
}
