import { Redirect, Stack } from "expo-router";

import { useAuthSession } from "../../lib/auth";

// The root index picks sign-in vs. tabs once, at launch, and is gone by
// the time someone signs in; so the sign-in group watches the session
// itself and moves into the app as soon as there is one.
export default function AuthLayout() {
  const auth = useAuthSession();
  if (auth.status === "signedIn") return <Redirect href="/(tabs)" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
