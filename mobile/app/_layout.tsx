import { Stack } from "expo-router";
import { useEffect } from "react";

import { configureAmplify } from "../lib/amplify";
import { AppLockProvider } from "../lib/app-lock";
import { configureNotificationHandler } from "../lib/push";

export default function RootLayout() {
  // Amplify configure must run before any auth call, and the
  // notification handler must be set before any push lands. Doing it
  // here at the root means every screen can rely on both being ready.
  useEffect(() => {
    configureAmplify();
    configureNotificationHandler();
  }, []);

  return (
    <AppLockProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AppLockProvider>
  );
}
