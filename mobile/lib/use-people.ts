// Cached list of household members (active homePerson rows).
//
// People rarely change, so a single fetch per signed-in session is
// fine — we keep the result in a module-scope cache and refresh it on
// sign-out. Components that mount mid-session reuse the cached array
// without re-querying.

import { useEffect, useState } from "react";
import { Hub } from "aws-amplify/utils";

import { getClient } from "./amplify";
import { householdMembers } from "./household";
import { listAllPages } from "../../lib/list-all";
import type { Schema } from "../../amplify/data/resource";

export type Person = Schema["homePerson"]["type"];

let cached: Person[] | null = null;
let inFlight: Promise<Person[]> | null = null;

// Everyone pickable: the household plus the contact book (active rows).
let allCached: Person[] | null = null;
let allInFlight: Promise<Person[]> | null = null;

Hub.listen("auth", (data) => {
  if (data?.payload?.event === "signedOut") {
    cached = null;
    inFlight = null;
    allCached = null;
    allInFlight = null;
  }
});

async function fetchPeople(): Promise<Person[]> {
  const client = getClient();
  const { data } = await client.models.homePerson.list({ limit: 500 });
  // Household members only (home-users group) — guests and face-tag-only
  // people shouldn't show up as assignee / filter options for chores.
  return householdMembers(data ?? []);
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

async function fetchAllPeople(): Promise<Person[]> {
  const client = getClient();
  // Walk every page — .list caps one response at 1 MB regardless of limit.
  const rows = await listAllPages<Person>(client.models.homePerson, { limit: 1000 });
  return rows.filter((p) => p.active !== false);
}

/**
 * Every active homePerson — household and contacts — for people pickers
 * (trip participants, assignees, reminder person), same set the web
 * pages load. Use usePeople() where only the household belongs.
 */
export function useAllPeople(): { people: Person[]; loading: boolean } {
  const [people, setPeople] = useState<Person[]>(allCached ?? []);
  const [loading, setLoading] = useState(allCached === null);

  useEffect(() => {
    if (allCached) return;
    if (!allInFlight) {
      allInFlight = fetchAllPeople();
      // Let a later mount retry after a failure.
      allInFlight.catch(() => {
        allInFlight = null;
      });
    }
    let cancelled = false;
    allInFlight
      .then((rows) => {
        allCached = rows;
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
