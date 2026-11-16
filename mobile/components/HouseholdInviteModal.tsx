// Admin-only: bring someone into the household — the native twin of the
// Invite dialog on /admin/people.
//   - Invite: invitePerson creates the Cognito login (Cognito emails a
//     temporary password; self sign-up is off) and links an existing
//     contact or creates the person; optional admin.
//   - "No login (a kid)": no email, no invite. Creates the homePerson row
//     if they're new, then setPersonGroups(personId, ["home-users"]),
//     which only writes homePerson.groups since there's no Cognito user.
// Picking an existing contact keeps their photos, birthday and history.

import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { getClient } from "../lib/amplify";
import { PeoplePicker } from "./PeoplePicker";
import { formStyles as styles } from "./person-form-styles";
import { HOUSEHOLD_GROUP } from "../../lib/household";
import { invitableContacts } from "../../lib/people";
import type { Schema } from "../../amplify/data/resource";

type Person = Schema["homePerson"]["type"];

interface Props {
  visible: boolean;
  people: Person[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

export function HouseholdInviteModal({ visible, people, onClose, onDone }: Props) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [personId, setPersonId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [admin, setAdmin] = useState(false);
  const [noLogin, setNoLogin] = useState(false);
  const [busy, setBusy] = useState(false);

  const invitable = useMemo(() => invitableContacts(people), [people]);

  useEffect(() => {
    if (!visible) return;
    setMode("new");
    setPersonId("");
    setName("");
    setEmail("");
    setAdmin(false);
    setNoLogin(false);
  }, [visible]);

  const existing = mode === "existing" && personId ? personId : null;
  const ready = (existing || (mode === "new" && name.trim())) && (noLogin || email.trim());

  async function submit() {
    if (!ready) return;
    setBusy(true);
    try {
      const client = getClient();
      if (noLogin) {
        let id = existing;
        if (!id) {
          const created = await client.models.homePerson.create({ name: name.trim(), active: true });
          if (created.errors?.length || !created.data)
            throw new Error(created.errors?.[0]?.message ?? "Couldn't create");
          id = created.data.id;
        }
        const res = await client.mutations.setPersonGroups({ personId: id, groups: [HOUSEHOLD_GROUP] });
        if (res.errors?.length) throw new Error(res.errors[0].message);
        Alert.alert(`${res.data?.name ?? "They"} joined the household`);
      } else {
        const res = await client.mutations.invitePerson({
          personId: existing,
          name: existing ? null : name.trim(),
          email: email.trim(),
          groups: admin ? [HOUSEHOLD_GROUP, "admins"] : [HOUSEHOLD_GROUP],
        });
        if (res.errors?.length) throw new Error(res.errors[0].message);
        Alert.alert("Invite sent", `${email.trim()} will get an email with a temporary password.`);
      }
      await onDone();
      onClose();
    } catch (err: any) {
      Alert.alert(noLogin ? "Couldn't add" : "Invite failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Pressable onPress={onClose} disabled={busy}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle}>{noLogin ? "Add to the household" : "Invite to the household"}</Text>
          <Pressable onPress={submit} disabled={busy || !ready}>
            {busy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.save, !ready && styles.disabled]}>{noLogin ? "Add" : "Send"}</Text>
            )}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Who</Text>
          <View style={styles.chipRow}>
            {(["new", "existing"] as const).map((m) => {
              const on = mode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => setMode(m)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy || (m === "existing" && invitable.length === 0)}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {m === "new" ? "Someone new" : "An existing contact"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {mode === "existing" ? (
            <>
              <PeoplePicker
                single
                required
                title="Pick a contact"
                placeholder="Pick a contact"
                people={invitable}
                selectedIds={personId ? [personId] : []}
                onChange={(ids) => {
                  const id = ids[0] ?? "";
                  setPersonId(id);
                  const p = invitable.find((x) => x.id === id);
                  if (p?.email) setEmail(p.email);
                }}
                disabled={busy}
              />
              <Text style={styles.hint}>Picking an existing contact keeps their photos, birthday and history.</Text>
            </>
          ) : (
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Name"
              placeholderTextColor="#888"
              editable={!busy}
            />
          )}

          <View style={[styles.switchRow, { marginTop: 12 }]}>
            <Text style={styles.switchLabel}>No login (a kid): household member, no invite</Text>
            <Switch value={noLogin} onValueChange={setNoLogin} disabled={busy} />
          </View>

          {!noLogin && (
            <>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="name@example.com"
                placeholderTextColor="#888"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
              />
              <Text style={styles.hint}>They sign in with this. Cognito emails them a temporary password.</Text>
              <View style={[styles.switchRow, { marginTop: 8 }]}>
                <Text style={styles.switchLabel}>Admin (can invite and change groups)</Text>
                <Switch value={admin} onValueChange={setAdmin} disabled={busy} />
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
