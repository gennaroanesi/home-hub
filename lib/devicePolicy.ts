// Central risk matrix for Home Assistant device control.
//
// This module is the single source of truth for "can this actor perform
// this action on this device?". It's imported by the /devices frontend,
// the agent handler, and (in v2) the control endpoints.
//
// Why code, not a database table:
//   - the matrix is small enough (≤20 rules) that a typed config is more
//     readable than a DB admin UI
//   - changing policy is sensitive — it should go through code review + git
//     history, not a "save" button that bypasses both
//   - if we find ourselves editing this file often, that's the signal to
//     graduate to a DB-driven admin UI
//
// v1 is read-only, so this module is defined but only `canPerform(sensitivity,
// "read", ctx)` is consulted. The control rules exist so v2 ships as a
// wiring exercise, not a design exercise.

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Per-device sensitivity tier. Set manually on homeDevice.sensitivity during
 * enrollment. Each tier maps to a row in the risk matrix.
 *
 *   READ_ONLY — sensors, anything with no actionable state
 *   LOW       — comfort toggles the worst case of which is "the room is cold"
 *               (thermostat small swings, lights, TV, roomba, small appliance)
 *   MEDIUM    — comfort actions with larger blast radius (large HVAC swings,
 *               stopping an appliance mid-cycle, disabling motion detection)
 *   HIGH      — physical access: unlocking doors, opening the garage,
 *               disarming security
 */
export type Sensitivity = "READ_ONLY" | "LOW" | "MEDIUM" | "HIGH";

/**
 * What the actor is trying to do.
 *   read             — get current state / snapshot
 *   control_safe     — an action that makes the house safer (lock door,
 *                      close garage). Never gated harder than the equivalent
 *                      "unsafe" direction.
 *   control_unsafe   — the corresponding unsafe direction (unlock, open).
 *                      Only meaningful for HIGH sensitivity devices; for
 *                      LOW/MEDIUM the two are treated identically.
 */
export type Action = "read" | "control_safe" | "control_unsafe";

/**
 * Where the request came from and what we know about the session.
 */
export interface PolicyContext {
  /** "UI" = logged-in Cognito session in the browser. "AGENT" = WhatsApp. */
  origin: "UI" | "AGENT";
  /**
   * Whether the sender is currently on the home wifi, determined by checking
   * their person's `homeDeviceTrackerEntity` against HA. Fail closed: if
   * unknown or HA is down, pass `false`.
   */
  senderHomeWifi: boolean;
  /**
   * Whether the UI session has recently completed a password re-auth (within
   * the 5-min grace window). Always false for agent-origin requests.
   */
  elevatedSession: boolean;
}

/**
 * The policy decision. `allowed=false` means refuse outright. `allowed=true`
 * with `requires` set means the caller must satisfy that requirement before
 * executing (the policy module doesn't perform the challenge itself).
 */
export interface PolicyDecision {
  allowed: boolean;
  /** Human-readable reason, suitable for logging and error messages. */
  reason: string;
  /**
   * If set, the caller must complete this challenge before executing the
   * action. "password_reauth" = UI password re-entry. "reply_confirm" = WA
   * reply "yes" within 60s. "ui_confirm" = simple modal confirmation.
   */
  requires?: "password_reauth" | "reply_confirm" | "ui_confirm" | "duo_push";
}

// ── The matrix ───────────────────────────────────────────────────────────────
//
// Each row is indexed by `${sensitivity}:${action}` and keyed by the context
// shape. Kept as a function rather than a nested object for readability — a
// flat switch is easier to audit than a 4-level lookup.

/**
 * Evaluate whether `action` is allowed on a device with `sensitivity`, given
 * the request `ctx`. Pure function — no I/O, no side effects.
 *
 * Reading state is always allowed. This is the only case v1 consults.
 */
export function canPerform(
  sensitivity: Sensitivity,
  action: Action,
  ctx: PolicyContext
): PolicyDecision {
  // ── Reads: always allowed ──
  if (action === "read") {
    return { allowed: true, reason: "read is always allowed" };
  }

  // ── READ_ONLY devices: no control path exists ──
  if (sensitivity === "READ_ONLY") {
    return {
      allowed: false,
      reason: "device is marked READ_ONLY — controls are not enabled",
    };
  }

  // ── HIGH sensitivity: locks, garage, alarm ──
  if (sensitivity === "HIGH") {
    if (ctx.origin === "AGENT") {
      // Duo Push adds the missing second factor. The policy now allows HIGH
      // agent control gated on Duo approval — the same mechanism used for
      // document vault access.
      return {
        allowed: true,
        reason: "HIGH via agent, requires Duo Push",
        requires: "duo_push",
      };
    }
    // UI: unsafe directions require a password re-auth (elevated session).
    // Safe directions (lock door, close garage) allowed with a UI confirm.
    if (action === "control_unsafe") {
      if (!ctx.elevatedSession) {
        return {
          allowed: false,
          reason: "password re-auth required for HIGH-sensitivity unsafe action",
          requires: "password_reauth",
        };
      }
      return { allowed: true, reason: "elevated UI session" };
    }
    return {
      allowed: true,
      reason: "safe direction on HIGH-sensitivity device",
      requires: "ui_confirm",
    };
  }

  // ── MEDIUM sensitivity: larger-blast-radius comfort ──
  if (sensitivity === "MEDIUM") {
    if (ctx.origin === "UI") {
      return {
        allowed: true,
        reason: "MEDIUM via UI",
        requires: "ui_confirm",
      };
    }
    // AGENT path
    if (ctx.senderHomeWifi) {
      return {
        allowed: true,
        reason: "MEDIUM via agent, sender on home wifi",
        requires: "reply_confirm",
      };
    }
    return {
      allowed: false,
      reason: "MEDIUM actions from WhatsApp require home wifi; use the app",
    };
  }

  // ── LOW sensitivity: everyday comfort ──
  // LOW devices are green on every path; the only gate is a reply confirm
  // for remote agent requests, as a cheap second factor against a hijacked
  // WhatsApp session.
  if (sensitivity === "LOW") {
    if (ctx.origin === "UI") {
      return { allowed: true, reason: "LOW via UI" };
    }
    if (ctx.senderHomeWifi) {
      return { allowed: true, reason: "LOW via agent, home wifi" };
    }
    return {
      allowed: true,
      reason: "LOW via agent, remote",
      requires: "reply_confirm",
    };
  }

  // Exhaustiveness check — TS will error if a new sensitivity tier is added
  // without a branch above.
  const _exhaustive: never = sensitivity;
  return { allowed: false, reason: `unknown sensitivity ${_exhaustive}` };
}

// ── Convenience: default pinning and sensitivity for newly-discovered devices
//
// When the hass-sync Lambda encounters an entity it's never seen before, it
// needs to pick an initial `sensitivity` and `isPinned` value. These are
// conservative defaults — anything actionable gets READ_ONLY until a human
// deliberately bumps it, so we can never accidentally expose a new device to
// control paths.

/**
 * Domains whose entities should be pinned on the /devices dashboard by default.
 * Everything else syncs into the cache but stays off the dashboard until the
 * user pins it manually.
 */
export const AUTO_PIN_DOMAINS = new Set([
  "climate",
  "lock",
  "cover",
  "camera",
]);

/**
 * Initial sensitivity for a newly-discovered device. Always READ_ONLY —
 * controls are opt-in, never opt-out. v1 never consults this for control
 * decisions anyway.
 */
export function defaultSensitivityFor(_domain: string): Sensitivity {
  return "READ_ONLY";
}
