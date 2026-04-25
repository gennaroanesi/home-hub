// Resolves the signed-in Cognito user to a homePerson row using the
// `custom:full_name` attribute as the join key. Pages need this to
// pick the *current* user's linked resources (Duo auth, preferences)
// rather than grabbing the first row that happens to come back — the
// classic source of the "I'm Gennaro but the app pushed Duo to
// Cristine" bug.

import { fetchUserAttributes } from "aws-amplify/auth";

interface PersonLike {
  id: string;
  name: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataClient = any;

/**
 * Return the homePerson row for the currently authenticated Cognito
 * user, or null if no match. Matching is case-insensitive on the
 * first token of `custom:full_name` (e.g. "Gennaro Anesi" → person
 * named "Gennaro"). That's brittle by design — a proper linkage
 * would live in homePerson itself, but until then this is faithful
 * to the existing pattern in pages/agent.tsx.
 */
export async function resolveCurrentPerson<P extends PersonLike = PersonLike>(
  client: DataClient
): Promise<P | null> {
  try {
    const attrs = await fetchUserAttributes();
    const fullName = (attrs["custom:full_name"] ?? "").toString().trim();
    if (!fullName) return null;
    const firstToken = fullName.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!firstToken) return null;

    const { data } = await client.models.homePerson.list({ limit: 100 });
    const people = (data ?? []) as P[];
    // Prefer an exact full-name match, then fall back to first-token.
    const exact = people.find((p) => p.name.toLowerCase() === fullName.toLowerCase());
    if (exact) return exact;
    return people.find((p) => p.name.toLowerCase() === firstToken) ?? null;
  } catch {
    return null;
  }
}
