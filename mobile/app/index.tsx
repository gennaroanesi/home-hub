// Auth gate. Picks the right route group based on Cognito session
// state. Auth state changes flow through Amplify's Hub so this
// re-renders automatically on sign-in / sign-out.

import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useAuthSession } from "../lib/auth";

export default function Index() {
  const auth = useAuthSession();
  if (auth.status === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  if (auth.status === "signedIn") return <Redirect href="/(tabs)" />;
  return <Redirect href="/(auth)/sign-in" />;
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
});
