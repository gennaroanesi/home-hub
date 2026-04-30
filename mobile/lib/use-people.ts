// Cached list of household members (active homePerson rows).
//
// People rarely change, so a single fetch per signed-in session is
// fine — we keep the result in a module-scope cache and refresh it on
// sign-out. Components that mount mid-session reuse the cached array
// without re-querying.

import { useEffect, useState } from "react";
import { Hub } from "aws-amplify/utils";

import { getClient } from "./amplify";
import type { Schema } from "../../amplify/data/resource";

export type Person = Schema["homePerson"]["type"];

let cached: Person[] | null = null;
let inFlight: Promise<Person[]> | null = null;

Hub.listen("auth", (data) => {
  if (data?.payload?.event === "signedOut") {
    cached = null;
    inFlight = null;
  }
});

async function fetchPeople(): Promise<Person[]> {
  const client = getClient();
  const { data } = await client.models.homePerson.list();
  // Household members only. We key off the home-users Cognito group
  // (cached in homePerson.groups by setPersonGroups) rather than the
  // mere presence of cognitoUsername — invited guests will have a
  // cognitoUsername too but won't be in home-users, and they
  // shouldn't show up as assignee / filter options for chores.
  return (data ?? []).filter((p) => {
    if (p.active === false) return false;
    const groups = (p.groups ?? []).filter((g): g is string => !!g);
    return groups.includes("home-users");
  });
}

export function usePeople(): { people: Person[]; loading: boolean } {
  const [people, setPeople] = useState<Person[]>(cached ?? []);
  const [loading, setLoading] = useState(cached === null);

  useEffect(() => {
    if (cached) return;
    if (!inFlight) inFlight = fetchPeople();
    let cancelled = false;
    inFlight
      .then((rows) => {
        cached = rows;
        if (!cancelled) {
          setPeople(rows);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { people, loading };
}

/** Format a list of person ids as "Alex", "Alex and Sam", or "Household". */
export function formatAssignees(
  ids: (string | null | undefined)[],
  people: Person[]
): string {
  const names = ids
    .filter((id): id is string => !!id)
    .map((id) => people.find((p) => p.id === id)?.name)
    .filter((n): n is string => !!n);
  if (names.length === 0) return "Household";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
