// Resolves the signed-in Cognito user to a homePerson row.
//
// Tries the obvious join (cognitoUsername == Cognito username) and
// falls back to the user's email attribute, which is what
// `signIn({ username: email, password })` flows leave in
// `signInDetails.loginId` and what some rows have set as
// cognitoUsername historically (matching the web app's pattern).
//
// `triedCandidates` and `errors` are returned so the dashboard can
// surface them on miss — saves a round trip of "what does
// getCurrentUser() actually return on the device?" / "what error
// did AppSync throw silently?" debugging the next time someone sees
// the missing-link warning.

import { fetchUserAttributes, getCurrentUser } from "aws-amplify/auth";

import { getClient } from "./amplify";

export interface CurrentPerson {
  id: string;
  name: string;
}

export interface ResolveResult {
  person: CurrentPerson | null;
  triedCandidates: string[];
  errors: string[];
}

export async function resolveCurrentPerson(): Promise<ResolveResult> {
  const triedCandidates: string[] = [];
  const errors: string[] = [];

  try {
    const { username, signInDetails } = await getCurrentUser();
    if (username) triedCandidates.push(username);
    const loginId = signInDetails?.loginId;
    if (loginId && !triedCandidates.includes(loginId)) {
      triedCandidates.push(loginId);
    }
  } catch (err: any) {
    errors.push(`getCurrentUser: ${err?.message ?? String(err)}`);
  }
  try {
    const attrs = await fetchUserAttributes();
    const email = attrs.email;
    if (email && !triedCandidates.includes(email)) {
      triedCandidates.push(email);
    }
  } catch (err: any) {
    errors.push(`fetchUserAttributes: ${err?.message ?? String(err)}`);
  }

  if (triedCandidates.length === 0) {
    return { person: null, triedCandidates, errors };
  }

  const client = getClient();
  for (const cand of triedCandidates) {
    try {
      const res = await client.models.homePerson.list({
        filter: { cognitoUsername: { eq: cand } },
      });
      if (res.errors?.length) {
        for (const e of res.errors) {
          errors.push(`list[${cand}]: ${e.message}`);
        }
      }
      const hit = res.data?.[0];
      if (hit) {
        return {
          person: { id: hit.id, name: hit.name },
          triedCandidates,
          errors,
        };
      }
    } catch (err: any) {
      errors.push(`list[${cand}] threw: ${err?.message ?? String(err)}`);
    }
  }
  return { person: null, triedCandidates, errors };
}
