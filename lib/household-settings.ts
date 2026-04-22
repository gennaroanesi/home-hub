// Thin wrappers for reading the singleton homeSettings row. Used by any
// Lambda or client that needs the household timezone (or future settings).
// The singleton convention is by agreement, not schema enforcement: the UI
// only ever creates one row, and readers take the first row via list().

import { DEFAULT_HOUSEHOLD_TZ } from "./reminder-schedule";

// Narrow type for what we need from the data client — lets this module
// stay compatible with both userPool-auth (UI) and IAM-auth (Lambda)
// generateClient instances without pulling in Schema types.
interface MinimalDataClient {
  models: {
    homeSettings: {
      list: (args?: unknown) => Promise<{ data: HomeSettingsRow[] | undefined }>;
    };
  };
}
interface HomeSettingsRow {
  householdTimezone: string | null | undefined;
}

/**
 * Read the household timezone from settings. Returns DEFAULT_HOUSEHOLD_TZ
 * if no settings row exists or the row has no TZ set. Never throws — a
 * missing settings row shouldn't break anything.
 */
export async function getHouseholdTimezone(
  client: MinimalDataClient
): Promise<string> {
  try {
    const { data } = await client.models.homeSettings.list({ limit: 1 });
    const tz = data?.[0]?.householdTimezone;
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
