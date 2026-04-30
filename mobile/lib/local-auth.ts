// Face ID / Touch ID wrapper for sensitive in-app actions (document
// downloads today, future v2 device control HIGH actions).
//
// We deliberately use `disableDeviceFallback: true` so a stolen unlocked
// phone with the device passcode known doesn't pass the gate. Face ID
// is the actual security control — the local-passcode fallback would
// defeat the point. If Face ID isn't available (no hardware, not
// enrolled, user cancelled), the caller falls back to Duo Push, which
// goes to a separate trusted device.
//
// Web has no Face ID equivalent worth wiring; web stays Duo. The
// server-side Duo dance is the same regardless of which side initiated.

import * as LocalAuthentication from "expo-local-authentication";

export type LocalAuthOutcome =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "cancelled" | "failed" };

export interface LocalAuthOptions {
  /** Shown in the Face ID prompt (iOS) / fallback dialog (Android). */
  promptMessage: string;
}

export async function requireLocalAuth(
  options: LocalAuthOptions
): Promise<LocalAuthOutcome> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) return { ok: false, reason: "unavailable" };

  const enrolled = await LocalAuthentication.isEnrolledAsync();
  if (!enrolled) return { ok: false, reason: "unavailable" };

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: options.promptMessage,
    // Bio only — system passcode would defeat the "stolen unlocked phone"
    // threat model this gate exists to mitigate.
    disableDeviceFallback: true,
    cancelLabel: "Cancel",
  });

  if (result.success) return { ok: true };
  if (result.error === "user_cancel" || result.error === "system_cancel") {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "failed" };
}
