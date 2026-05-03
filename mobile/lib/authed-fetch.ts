// Drop-in replacement for `fetch()` that adds the current Cognito
// access token as `Authorization: Bearer <jwt>`. The web Next.js API
// routes (`pages/api/**`) gate on `withHomeUserAuth` which now accepts
// either a session cookie (browser) or this header (RN, share ext).
//
// If no session is available the fetch goes out anyway — the server
// will return 401 and the caller can surface that. We don't throw
// here so callers can keep their existing try/catch shape.

import { fetchAuthSession } from "aws-amplify/auth";
import { configureAmplify } from "./amplify";

export async function authedFetch(
  input: RequestInfo,
  init?: RequestInit
): Promise<Response> {
  configureAmplify();

  let bearer: string | null = null;
  try {
    const session = await fetchAuthSession();
    bearer = session.tokens?.accessToken?.toString() ?? null;
  } catch {
    // No session — fall through and let the server return 401.
  }

  const headers = new Headers(init?.headers ?? {});
  if (bearer && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${bearer}`);
  }

  return fetch(input, { ...init, headers });
}
