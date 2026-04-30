import type { NextApiRequest, NextApiResponse } from "next";
import { preauth } from "@/lib/duo-server";
import { withHomeUserAuth } from "@/lib/api-auth";

/**
 * POST /api/security/duo-preauth
 * Body: { username: string }
 *
 * Verifies that a Duo username is enrolled and can receive a push
 * before the /security page saves a homePersonAuth row. Catches typos
 * and missing Duo enrollments immediately.
 *
 * Returns:
 *  - { ok: true }  if the user can authenticate (preauth result "auth"
 *    or "allow")
 *  - { ok: false, reason: "..." } otherwise
 *
 * NOTE: The Amplify Hosting compute role must have
 * secretsmanager:GetSecretValue on the home-hub/duo-auth-api secret.
 * If you get a permissions error, add the grant in backend.ts or via
 * the IAM console on the Amplify SSR Lambda's execution role.
 */
async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { username } = req.body ?? {};
  if (!username || typeof username !== "string") {
    return res.status(400).json({ error: "username required" });
  }

  try {
    const result = await preauth(username.trim());

    if (result.result === "auth" || result.result === "allow") {
      // User is enrolled and can authenticate. "auth" means they have a
      // device and can receive a push; "allow" means bypass/pre-approved.
      const hasPush = (result.devices ?? []).some((d) =>
        (d.capabilities ?? []).includes("push")
      );
      return res.status(200).json({
        ok: true,
        hasPushDevice: hasPush,
        note: hasPush
          ? undefined
          : "User is enrolled but has no push-capable device. They may need to activate Duo Mobile.",
      });
    }

    // "deny" or "enroll" — cannot authenticate
    const reasons: Record<string, string> = {
      deny: "This Duo user is locked out or denied. Check the Duo admin panel.",
      enroll:
        "This Duo username exists but the user hasn't completed enrollment. They need to open the Duo Mobile enrollment link first.",
    };
    return res.status(200).json({
      ok: false,
      reason:
        reasons[result.result] ??
        result.status_msg ??
        `Unexpected preauth result: ${result.result}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("duo-preauth error:", message);

    // Surface Duo's "invalid_request" or "40301 Access denied" errors
    // clearly — they usually mean the username doesn't exist in the Duo
    // admin panel at all.
    if (message.includes("40301") || message.includes("Invalid username")) {
      return res.status(200).json({
        ok: false,
        reason:
          "That username was not found in Duo. Make sure it matches exactly what's in the Duo admin panel.",
      });
    }

    return res.status(500).json({
      error: "Failed to contact Duo API",
      detail: message,
    });
  }
}

export default withHomeUserAuth(handler);
