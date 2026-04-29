// Mobile re-export of the canonical web trip helpers. Keeping this
// file as a thin wrapper means existing mobile callers keep their
// `../../lib/trip` import path while the actual logic lives in
// /lib/trip.ts (the single source of truth across web + mobile).
//
// Add mobile-only helpers BELOW the re-export if a need ever arises;
// don't fork the shared bits.

export * from "../../lib/trip";
