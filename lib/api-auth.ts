import type { NextApiHandler, NextApiRequest, NextApiResponse } from "next";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { runWithAmplifyServerContext } from "@/lib/amplify-server";

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

async function getAuthedUser(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<AuthedUser | null> {
  try {
    const session = await runWithAmplifyServerContext({
      nextServerContext: { request: req, response: res },
      operation: (ctx) => fetchAuthSession(ctx),
    });
    const accessToken = session.tokens?.accessToken;
    if (!accessToken) return null;
    const payload = accessToken.payload as Record<string, unknown>;
    const groupsRaw = payload["cognito:groups"];
    const groups = Array.isArray(groupsRaw) ? (groupsRaw as string[]) : [];
    const sub = String(payload.sub ?? "");
    const username = String(payload.username ?? sub);
    if (!sub) return null;
    return { sub, username, groups };
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
