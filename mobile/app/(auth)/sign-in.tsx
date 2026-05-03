import { useState } from "react";
import {
  Alert,
  Button,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Hub } from "aws-amplify/utils";
import { getCurrentUser, signOut } from "aws-amplify/auth";

import { signIn } from "../../lib/auth";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (!email || !password) return;
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      // Auth Hub fires `signedIn` → root <Index> re-renders → redirect to (tabs).
    } catch (err: any) {
      // Recovery path: if Amplify says "a user is already logged in",
      // useAuthSession hasn't realized it (stale "signedOut" state).
      // Confirm via getCurrentUser() and nudge the Hub so the route
      // guard re-evaluates and bounces the user into the app.
      const message = err?.message ?? String(err);
      const alreadyLoggedIn =
        err?.name === "UserAlreadyAuthenticatedException" ||
        /already.*log/i.test(message);
      if (alreadyLoggedIn) {
        try {
          await getCurrentUser();
          Hub.dispatch("auth", { event: "signedIn" });
          return;
        } catch {
          // The local session is actually broken — clear it and let
          // the user try again with fresh credentials.
          try {
            await signOut();
          } catch {}
          Alert.alert("Session reset", "Please sign in again.");
          return;
        }
      }
      Alert.alert("Sign-in failed", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.card}>
          <Text style={styles.heading}>Home Hub</Text>
          <Text style={styles.sub}>Sign in to continue</Text>
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="username"
            value={email}
            onChangeText={setEmail}
            editable={!busy}
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor="#888"
            secureTextEntry
            textContentType="password"
            value={password}
            onChangeText={setPassword}
            editable={!busy}
          />
          <Button title={busy ? "Signing in…" : "Sign in"} onPress={onSubmit} disabled={busy} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24 },
  flex: { flex: 1, justifyContent: "center" },
  card: { gap: 12 },
  heading: { fontSize: 28, fontWeight: "600" },
  sub: { color: "#666", marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
});
