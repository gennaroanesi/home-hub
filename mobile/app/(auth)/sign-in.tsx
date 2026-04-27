import { useState } from "react";
import {
  Alert,
  Button,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

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
      Alert.alert("Sign-in failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.heading}>Home Hub</Text>
        <Text style={styles.sub}>Sign in to continue</Text>
        <TextInput
          style={styles.input}
          placeholder="Email"
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
          secureTextEntry
          textContentType="password"
          value={password}
          onChangeText={setPassword}
          editable={!busy}
        />
        <Button title={busy ? "Signing in…" : "Sign in"} onPress={onSubmit} disabled={busy} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", padding: 24 },
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
