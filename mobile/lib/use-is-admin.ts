// Whether the signed-in user is in the Cognito `admins` group, read from
// the session's id token (cognito:groups). UI gating only; the admin
// mutations (mergePeople, setPersonGroups, invitePerson) check the
// group server-side.

import { useEffect, useState } from "react";
import { fetchAuthSession } from "aws-amplify/auth";

import { configureAmplify } from "./amplify";

export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        configureAmplify();
        const session = await fetchAuthSession();
        const groups = (session.tokens?.idToken?.payload?.["cognito:groups"] as string[] | undefined) ?? [];
        if (alive) setIsAdmin(groups.includes("admins"));
      } catch {
        if (alive) setIsAdmin(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return isAdmin;
}
