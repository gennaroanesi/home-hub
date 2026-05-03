// Catch-all for unmatched routes. The most common case is iOS booting
// the app with `homehub://dataUrl=homehubShareKey` — Expo Router can't
// match that path, so without this file it'd render its default
// "Unmatched route" screen while ShareHandler's hook processes the
// share intent. We just silently bounce to the home tab; ShareHandler
// (mounted in _layout.tsx) opens its modal on top once the data lands.
//
// For a household tool there's no scenario where the user types an
// arbitrary URL, so silently redirecting all unknowns is fine.

import { useEffect } from "react";
import { View } from "react-native";
import { router } from "expo-router";

export default function NotFound() {
  useEffect(() => {
    router.replace("/(tabs)");
  }, []);
  return <View />;
}
