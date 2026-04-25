// Resolves the signed-in Cognito user to a homePerson row. The
// primary join is homePerson.cognitoUsername == the current Cognito
// username — set per-user from the admin people page. A name-based
// fallback covers the transitional period where not every person
// row has been linked yet.
//
// Fallback is deliberately forgiving because the Cognito "username"
// in this app is actually the email (login via email), so we try
// several candidate identifiers (full_name, email local part, raw
// username) against each homePerson.name in a few ways before
// giving up. Without this, a user whose `custom:full_name` isn't
// set ends up unmatched and the UI flashes bogus "Duo required"
// warnings even when they're linked.

import { getCurrentUser, fetchUserAttributes } from "aws-amplify/auth";

interface PersonLike {
  id: string;
  name: string;
  cognitoUsername?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DataClient = any;

function matchPerson<P extends PersonLike>(
  people: P[],
  candidate: string
): P | null {
  const lc = candidate.toLowerCase().trim();
  if (!lc) return null;
  const firstToken = lc.split(/\s+/)[0] ?? "";

  // Pass 1: exact lowercased match.
  const exact = people.find((p) => p.name.toLowerCase() === lc);
  if (exact) return exact;

  // Pass 2: first-token match (handles "Gennaro Anesi" → "Gennaro").
  if (firstToken) {
    const byToken = people.find((p) => p.name.toLowerCase() === firstToken);
    if (byToken) return byToken;
  }

  // Pass 3: person.name is a prefix of the candidate (handles
  // email local part "gennaroanesi" → "Gennaro"). Prefix rather
  // than substring keeps unrelated substrings like "ari" inside
  // "marilene" from claiming a short person named "Ari".
  const byPrefix = people.find((p) => {
    const pname = p.name.toLowerCase();
    return pname.length >= 3 && lc.startsWith(pname);
  });
  if (byPrefix) return byPrefix;

  return null;
}

/**
 * Return the homePerson row for the currently authenticated Cognito
 * user, or null if no match.
 */
export async function resolveCurrentPerson<P extends PersonLike = PersonLike>(
  client: DataClient
): Promise<P | null> {
  try {
    const { username } = await getCurrentUser();

    // Primary path: explicit join on cognitoUsername. Kept in its
    // own try/catch so a transient schema/network error doesn't
    // skip the fallback.
    if (username) {
      try {
        const { data } = await client.models.homePerson.list({
          filter: { cognitoUsername: { eq: username } },
          limit: 1,
        });
        const hit = (data ?? [])[0] as P | undefined;
        if (hit) return hit;
      } catch {
        /* fall through to fuzzy fallback */
      }
    }

    // Fallback: fuzzy match against Cognito identifiers.
    const attrs = await fetchUserAttributes();
    const { data } = await client.models.homePerson.list({ limit: 100 });
    const people = (data ?? []) as P[];

    const candidates: string[] = [];
    const fullName = (attrs["custom:full_name"] ?? "").toString().trim();
    if (fullName) candidates.push(fullName);
    if (username) {
      if (username.includes("@")) {
        const local = username.split("@")[0] ?? "";
        if (local) candidates.push(local);
      }
      candidates.push(username);
    }

    for (const cand of candidates) {
      const hit = matchPerson(people, cand);
      if (hit) return hit;
    }

    return null;
  } catch {
    return null;
  }
}
