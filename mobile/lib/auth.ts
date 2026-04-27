// Thin wrapper around Amplify Auth for the mobile app.
// Same Cognito user pool the web app uses; sign-in flow is plain
// email + password. We expose a `useAuthSession()` hook that
// components subscribe to instead of polling Amplify directly.

import { useEffect, useState } from "react";
import {
  fetchAuthSession,
  getCurrentUser,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  type AuthUser,
} from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";

import { configureAmplify } from "./amplify";

export type AuthState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signedIn"; user: AuthUser; idToken: string | null };

export function useAuthSession(): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    configureAmplify();
    let cancelled = false;

    async function refresh() {
      try {
        const user = await getCurrentUser();
        const session = await fetchAuthSession();
        if (cancelled) return;
        setState({
          status: "signedIn",
          user,
          idToken: session.tokens?.idToken?.toString() ?? null,
        });
      } catch {
        if (cancelled) return;
        setState({ status: "signedOut" });
      }
    }

    refresh();
    // Hub broadcasts signedIn / signedOut / tokenRefresh events. Listen
    // so the UI flips state without us having to poll.
    const unsub = Hub.listen("auth", () => refresh());

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return state;
}

export async function signIn(email: string, password: string): Promise<void> {
  configureAmplify();
  const res = await amplifySignIn({ username: email, password });
  if (!res.isSignedIn) {
    // Cognito can return interim steps (NEW_PASSWORD_REQUIRED, MFA, …).
    // Phase 0 doesn't handle those — surface so we know to wire them up.
    throw new Error(`Sign-in incomplete: ${res.nextStep?.signInStep ?? "unknown"}`);
  }
}

export async function signOut(): Promise<void> {
  await amplifySignOut();
}
