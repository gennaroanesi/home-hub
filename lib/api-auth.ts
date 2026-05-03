import type { NextApiHandler, NextApiRequest, NextApiResponse } from "next";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { runWithAmplifyServerContext } from "@/lib/amplify-server";
import outputs from "@/amplify_outputs.json";

export type AuthedUser = {
  sub: string;
  username: string;
  groups: string[];
};

export type AuthedHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  user: AuthedUser
) => void | Promise<void>;

// JWT verifier for `Authorization: Bearer <accessToken>` callers — mobile
// app, share extension, anything that doesn't carry a session cookie.
// The verifier caches JWKs across calls; first request pays the fetch.
const jwtVerifier = CognitoJwtVerifier.create({
  userPoolId: outputs.auth.user_pool_id,
  tokenUse: "access",
  clientId: outputs.auth.user_pool_client_id,
});

function userFromPayload(payload: Record<string, unknown>): AuthedUser | null {
  const sub = String(payload.sub ?? "");
  if (!sub) return null;
  const username = String(payload.username ?? sub);
  const groupsRaw = payload["cognito:groups"];
  const groups = Array.isArray(groupsRaw) ? (groupsRaw as string[]) : [];
  return { sub, username, groups };
}

async function getAuthedUser(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<AuthedUser | null> {
  // Path A — Bearer token (mobile, share extension, scripts).
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    try {
      const payload = await jwtVerifier.verify(token);
      return userFromPayload(payload as unknown as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  // Path B — cookie-based Cognito session (web, same-origin).
  try {
    const session = await runWithAmplifyServerContext({
      nextServerContext: { request: req, response: res },
      operation: (ctx) => fetchAuthSession(ctx),
    });
    const accessToken = session.tokens?.accessToken;
    if (!accessToken) return null;
    return userFromPayload(accessToken.payload as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Wrap a Next.js API handler so it requires a Cognito session whose
 * access token contains the `home-users` group claim.
 *
 * Responds 401 if no valid session is present, 403 if the session is
 * valid but the user is not in `home-users`. On success, the wrapped
 * handler receives the resolved AuthedUser as a third arg.
 */
export function withHomeUserAuth(handler: AuthedHandler): NextApiHandler {
  return async (req, res) => {
    const user = await getAuthedUser(req, res);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!user.groups.includes("home-users")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return handler(req, res, user);
  };
}
