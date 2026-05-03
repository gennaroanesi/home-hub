import { Stack } from "expo-router";
import { useEffect } from "react";
import { ShareIntentProvider } from "expo-share-intent";

import { configureAmplify } from "../lib/amplify";
import { AppLockProvider } from "../lib/app-lock";
import { configureNotificationHandler } from "../lib/push";
import { ShareHandler } from "../components/ShareHandler";

export default function RootLayout() {
  // Amplify configure must run before any auth call, and the
  // notification handler must be set before any push lands. Doing it
  // here at the root means every screen can rely on both being ready.
  useEffect(() => {
    configureAmplify();
    configureNotificationHandler();
  }, []);

  return (
    <ShareIntentProvider
      options={{
        // Don't wipe the shared file when iOS sends the app to inactive
        // — the AppLock Face ID prompt does exactly that, and without
        // this the share modal closes itself before the user can see it.
        resetOnBackground: false,
      }}
    >
      <AppLockProvider>
        <Stack screenOptions={{ headerShown: false }} />
        <ShareHandler />
      </AppLockProvider>
    </ShareIntentProvider>
  );
}
