// App-level Face ID lock.
//
// First-time login still goes through email + password (Cognito). Once
// signed in, the Cognito refresh token persists (~30 days) so the user
// stays signed in across app launches. THIS module sits on top: a Face
// ID gate that the user must pass before the app's UI is interactive.
//
// State:
//   - locked = true on cold launch (when signedIn and Face ID is enrolled)
//   - locked = true after the app has been in background longer than
//     LOCK_AFTER_MS, on the next foreground
//   - locked = false after a successful Face ID prompt
//
// If Face ID hardware or enrollment is missing, locking is disabled
// outright — there's no way to unlock without it. Users without Face ID
// rely on the Cognito session itself as the authentication signal.
//
// Sign-out from the lock screen clears the Cognito session, so next
// launch goes back to the password sign-in flow.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as LocalAuthentication from "expo-local-authentication";

import { signOut, useAuthSession } from "./auth";
import { requireLocalAuth } from "./local-auth";

const LOCK_AFTER_MS = 5 * 60_000;

interface AppLockContextValue {
  locked: boolean;
  unlock: () => Promise<boolean>;
}

const AppLockContext = createContext<AppLockContextValue>({
  locked: false,
  unlock: async () => true,
});

export function useAppLock(): AppLockContextValue {
  return useContext(AppLockContext);
}

export function AppLockProvider({ children }: { children: ReactNode }) {
  // Tri-state during boot: we don't know whether to lock until Face ID
  // hardware/enrollment is checked. Default to locked so a fast cold
  // start doesn't briefly flash the app's content.
  const [bootChecked, setBootChecked] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [locked, setLocked] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [hasHardware, enrolled] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (cancelled) return;
        const ok = hasHardware && enrolled;
        setEnabled(ok);
        if (!ok) setLocked(false);
      } catch {
        if (cancelled) return;
        // If LocalAuthentication itself errored (e.g. native module not
        // present on a stale dev client), don't lock — better to let
        // the user in than strand them on an unlocked-screen they can't
        // pass.
        setEnabled(false);
        setLocked(false);
      } finally {
        if (!cancelled) setBootChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-lock on foreground if the app was in background long enough.
  const backgroundedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const handler = (state: AppStateStatus) => {
      if (state === "background" || state === "inactive") {
        if (backgroundedAt.current == null) {
          backgroundedAt.current = Date.now();
        }
      } else if (state === "active") {
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        if (since != null && Date.now() - since >= LOCK_AFTER_MS) {
          setLocked(true);
        }
      }
    };
    const sub = AppState.addEventListener("change", handler);
    return () => sub.remove();
  }, [enabled]);

  const unlock = useCallback(async () => {
    const result = await requireLocalAuth({
      promptMessage: "Unlock Home Hub",
    });
    if (result.ok) {
      setLocked(false);
      return true;
    }
    return false;
  }, []);

  if (!bootChecked) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <AppLockContext.Provider value={{ locked, unlock }}>
      {children}
      <LockOverlay />
    </AppLockContext.Provider>
  );
}

/** Absolute overlay that covers everything while the app is locked. */
function LockOverlay() {
  const { locked, unlock } = useAppLock();
  const auth = useAuthSession();
  const [autoTried, setAutoTried] = useState(false);
  const [busy, setBusy] = useState(false);

  // Auto-prompt Face ID once when entering the lock state. Reset when
  // the lock clears so the next re-lock auto-prompts again.
  useEffect(() => {
    if (!locked) {
      setAutoTried(false);
      return;
    }
    if (auth.status !== "signedIn") return;
    if (autoTried) return;
    setAutoTried(true);
    setBusy(true);
    void unlock().finally(() => setBusy(false));
  }, [locked, auth.status, autoTried, unlock]);

  if (!locked) return null;
  // No point covering the sign-in screen — the lock applies only to
  // an already-authenticated session.
  if (auth.status !== "signedIn") return null;

  async function onUnlock() {
    setBusy(true);
    try {
      await unlock();
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.overlay}>
      <Text style={styles.brand}>Home Hub</Text>
      <Text style={styles.lockHint}>Locked</Text>
      <Pressable
        onPress={onUnlock}
        style={({ pressed }) => [
          styles.unlockBtn,
          (pressed || busy) && styles.unlockBtnPressed,
        ]}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="scan-outline" size={20} color="#fff" />
            <Text style={styles.unlockText}>Unlock with Face ID</Text>
          </>
        )}
      </Pressable>
      <Pressable onPress={onSignOut} hitSlop={12} style={styles.signOutBtn}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: "center", justifyContent: "center" },

  overlay: {
    position: "absolute",
    inset: 0,
    backgroundColor: "#f7f7f7",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  brand: { fontSize: 28, fontWeight: "600", color: "#222" },
  lockHint: { color: "#888", fontSize: 14, marginBottom: 16 },
  unlockBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#735f55",
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 999,
    minWidth: 220,
    justifyContent: "center",
  },
  unlockBtnPressed: { opacity: 0.7 },
  unlockText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  signOutBtn: { marginTop: 8, paddingVertical: 8 },
  signOutText: { color: "#888", fontSize: 14 },
});
