// Simple compile-time feature flags for home-hub. Flip a value here to
// enable/disable a feature, commit, push — the next Amplify deploy picks
// it up. No runtime toggle infra; we don't need it at household scale.

/**
 * When a household member accesses another member's PERSONAL-scope
 * document (e.g. Gennaro downloads Cristine's passport), DM the owner
 * with a heads-up notification. Disabled by default for the first week
 * of dogfooding; flip to `true` once you're confident the signal is
 * useful and not noise.
 */
export const DOCUMENT_ACCESS_NOTIFICATIONS_ENABLED = false;
