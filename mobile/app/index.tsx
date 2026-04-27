// Phase 0 root screen. One file flips between the sign-in form and the
// dashboard based on `useAuthSession`. We'll split into proper auth /
// app route groups in Phase 1 once there are multiple authed screens.

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useAuthSession, signIn, signOut } from "../lib/auth";
import { resolveCurrentPerson, type CurrentPerson } from "../lib/current-person";
import { registerForPushNotifications, type PushRegistration } from "../lib/push";

export default function Index() {
  const auth = useAuthSession();

  if (auth.status === "loading") {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (auth.status === "signedOut") {
    return <SignInForm />;
  }

  return <Dashboard />;
}

// ── Sign in ────────────────────────────────────────────────────────────────

function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (!email || !password) return;
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err: any) {
      Alert.alert("Sign-in failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.formScreen}>
      <View style={styles.formCard}>
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

// ── Dashboard ──────────────────────────────────────────────────────────────

function Dashboard() {
  const [person, setPerson] = useState<CurrentPerson | null | "loading" | "missing">(
    "loading"
  );
  const [push, setPush] = useState<PushRegistration | null | "pending">("pending");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await resolveCurrentPerson();
        if (cancelled) return;
        setPerson(p ?? "missing");
        if (!p) return;
        const reg = await registerForPushNotifications(p.id);
        if (cancelled) return;
        setPush(reg);
      } catch (err: any) {
        if (cancelled) return;
        Alert.alert("Setup failed", err?.message ?? String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SafeAreaView style={styles.dashboardScreen}>
      <View style={styles.dashboardBody}>
        <Text style={styles.heading}>
          {person === "loading" || person === "missing" || person === null
            ? "Home Hub"
            : `Hi, ${person.name}`}
        </Text>
        {person === "missing" && (
          <Text style={styles.warn}>
            No homePerson row is linked to your Cognito user. Open the admin people
            page on the web and set cognitoUsername on your row.
          </Text>
        )}
        <PushStatus reg={push} />
      </View>
      <Pressable onPress={signOut} style={styles.signOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function PushStatus({ reg }: { reg: PushRegistration | null | "pending" }) {
  if (reg === "pending") {
    return <Text style={styles.muted}>Registering for push…</Text>;
  }
  if (reg === null) {
    return (
      <Text style={styles.muted}>
        Push not registered (simulator or permission denied).
      </Text>
    );
  }
  return (
    <View style={styles.pushBlock}>
      <Text style={styles.pushLabel}>{reg.deviceLabel}</Text>
      <Text style={styles.pushToken} selectable>
        {reg.expoPushToken}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },

  formScreen: { flex: 1, justifyContent: "center", padding: 24 },
  formCard: { gap: 12 },
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

  dashboardScreen: { flex: 1, padding: 24, justifyContent: "space-between" },
  dashboardBody: { gap: 16, marginTop: 32 },
  warn: { color: "#a44", fontSize: 13 },
  muted: { color: "#888", fontSize: 13 },
  pushBlock: { gap: 4 },
  pushLabel: { fontWeight: "600", fontSize: 14 },
  pushToken: { fontFamily: "Menlo", fontSize: 11, color: "#444" },
  signOut: { alignSelf: "center", padding: 12 },
  signOutText: { color: "#888" },
});
