// Mobile re-export of the canonical web checklist helpers. Same
// pattern as mobile/lib/trip.ts — the actual logic lives in
// /lib/checklist.ts so web + mobile share one source of truth.
//
// Add mobile-only helpers BELOW the re-export if a need ever arises;
// don't fork the shared bits.

export * from "../../lib/checklist";
