// Resolves the signed-in Cognito user to a homePerson row. The
// primary join is homePerson.cognitoUsername == the current Cognito
// username — set per-user from the admin people page. A name-based
// fallback is kept for the transitional period where not every
// person row has been linked yet; it can be removed once every
// logged-in user has a cognitoUsername set on their homePerson.

import { getCurrentUser, fetchUserAttributes } from "aws-amplify/auth";

interface PersonLike {
  id: string;
  name: string;
  cognitoUsername?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataClient = any;

/**
 * Return the homePerson row for the currently authenticated Cognito
 * user, or null if no match.
 */
export async function resolveCurrentPerson<P extends PersonLike = PersonLike>(
  client: DataClient
): Promise<P | null> {
  try {
    const { username } = await getCurrentUser();

    // Primary path: filter by cognitoUsername.
    if (username) {
      const { data } = await client.models.homePerson.list({
        filter: { cognitoUsername: { eq: username } },
        limit: 1,
      });
      const hit = (data ?? [])[0] as P | undefined;
      if (hit) return hit;
    }

    // Fallback: case-insensitive match on the first token of
    // custom:full_name (e.g. "Gennaro Anesi" → person named
    // "Gennaro"). Mirrors the legacy behaviour in pages/agent.tsx.
    // Remove once every logged-in user has cognitoUsername set.
    const attrs = await fetchUserAttributes();
    const fullName = (attrs["custom:full_name"] ?? "").toString().trim();
    if (!fullName) return null;
    const firstToken = fullName.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!firstToken) return null;

    const { data } = await client.models.homePerson.list({ limit: 100 });
    const people = (data ?? []) as P[];
    const exact = people.find(
      (p) => p.name.toLowerCase() === fullName.toLowerCase()
    );
    if (exact) return exact;
    return people.find((p) => p.name.toLowerCase() === firstToken) ?? null;
  } catch {
    return null;
  }
}
