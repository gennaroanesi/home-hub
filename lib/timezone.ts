// Small utilities for timezone guessing and formatting. Used primarily by
// the trip form to auto-populate a leg's timezone when the user picks a
// city (the CityAutocomplete returns lat/lon, we convert to an IANA TZ
// string), and to render "(CDT)"/"(EDT)" style short labels on date
// inputs so users know what zone a time is in.
//
// Bundle cost: tz-lookup ships a ~2MB polygon dataset (~300KB gzipped)
// and is pulled into whatever client page imports this module. Lambdas
// never import it. Keep the import at file scope so Webpack can
// tree-shake it out of pages that don't call guessTimezone.

// tz-lookup has no bundled TypeScript types; declare just enough for our use.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tzLookup = require("tz-lookup") as (lat: number, lon: number) => string;

/**
 * Return the IANA timezone name (e.g. "America/Chicago") for a given
 * coordinate pair, or null on failure. Pure sync, no network — tz-lookup
 * bundles its own polygon dataset.
 */
export function guessTimezone(
  latitude: number | null | undefined,
  longitude: number | null | undefined
): string | null {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }
  try {
    return tzLookup(latitude, longitude);
  } catch {
    return null;
  }
}

/**
 * Short timezone abbreviation (e.g. "CDT", "CST", "EST") for an IANA
 * zone at a particular moment. DST-aware — CDT in summer, CST in winter,
 * same input zone. Uses native Intl; no external data.
 *
 * Returns the raw IANA name if `Intl` can't resolve it (e.g. bad input)
 * or an empty string if no TZ is given.
 */
export function tzAbbreviation(
  iana: string | null | undefined,
  at: Date = new Date()
): string {
  if (!iana) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "short",
    }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? iana;
  } catch {
    return iana;
  }
}
