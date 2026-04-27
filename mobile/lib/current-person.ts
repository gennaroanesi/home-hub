// Resolves the signed-in Cognito user to a homePerson row.
//
// Mobile-only sibling of lib/current-person.ts in the web app. The
// web version carries a fuzzy-match fallback for users whose
// cognitoUsername field was unset before that field was added; for
// the mobile app we require the link to be set explicitly via the
// admin people page. Anyone using the mobile app is by definition a
// recent / linked user.

import { getCurrentUser } from "aws-amplify/auth";

import { getClient } from "./amplify";

export interface CurrentPerson {
  id: string;
  name: string;
}

export async function resolveCurrentPerson(): Promise<CurrentPerson | null> {
  const { username } = await getCurrentUser();
  if (!username) return null;
  const client = getClient();
  const { data } = await client.models.homePerson.list({
    filter: { cognitoUsername: { eq: username } },
  });
  const hit = data?.[0];
  if (!hit) return null;
  return { id: hit.id, name: hit.name };
}
