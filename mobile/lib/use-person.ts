// Cached homePerson lookup for the signed-in Cognito user.
//
// resolveCurrentPerson hits AppSync — fine on the dashboard, but every
// tab would re-query if it called the resolver directly. This hook
// resolves once and shares the result via a tiny module-scope cache,
// keyed on Cognito sub. The cache is cleared on sign-out via Amplify
// Hub events, same way useAuthSession listens.

import { useEffect, useState } from "react";
import { Hub } from "aws-amplify/utils";

import { resolveCurrentPerson, type CurrentPerson } from "./current-person";

let cached: CurrentPerson | null | undefined; // undefined = not yet resolved

Hub.listen("auth", (data) => {
  if (data?.payload?.event === "signedOut") {
    cached = undefined;
  }
});

export type UsePersonState =
  | { status: "loading" }
  | { status: "found"; person: CurrentPerson }
  | { status: "missing"; tried: string[]; errors: string[] };

export function usePerson(): UsePersonState {
  const [state, setState] = useState<UsePersonState>(
    cached ? { status: "found", person: cached } : { status: "loading" }
  );

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    (async () => {
      const result = await resolveCurrentPerson();
      if (cancelled) return;
      if (result.person) {
        cached = result.person;
        setState({ status: "found", person: result.person });
      } else {
        setState({
          status: "missing",
          tried: result.triedCandidates,
          errors: result.errors,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
