// Logs each screen opened (route pattern, /more/trips/[id]) for the web's
// /admin/usage page. Queued and sent in the background (lib/usage.ts),
// flushed when the app leaves the foreground. Renders nothing.

import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { useSegments } from "expo-router";
import { getCurrentUser } from "aws-amplify/auth";

import { CREATE_USAGE_EVENT, createUsageLogger, screenFromSegments, type UsageLogger } from "../../lib/usage";
import { getClient } from "../lib/amplify";

let logger: UsageLogger | null = null;
function usageLogger(): UsageLogger {
  if (!logger) {
    logger = createUsageLogger({
      platform: Platform.OS === "android" ? "ANDROID" : "IOS",
      getUsername: () =>
        getCurrentUser()
          .then((u) => u.username)
          .catch(() => null),
      send: async (rows) => {
        const client: any = getClient();
        await Promise.all(rows.map((input) => client.graphql({ query: CREATE_USAGE_EVENT, variables: { input } }).catch(() => null)));
      },
    });
  }
  return logger;
}

export function UsageTracker() {
  const segments = useSegments();
  const screen = screenFromSegments(segments);

  useEffect(() => {
    // Sign-in screens aren't usage.
    if (segments[0] === "(auth)") return;
    usageLogger().track(screen);
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") void usageLogger().flush();
    });
    return () => sub.remove();
  }, []);

  return null;
}
