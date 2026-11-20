// Edit a household member — the native twin of the Edit dialog on
// /admin/people. Profile fields (name, color, emoji, phone, birthday,
// timezone, notification switches, active) save through the regular
// homePerson update, which any member may do. Groups are admin-only and
// go through the setPersonGroups mutation so Cognito stays in sync; a
// member without a login (a kid) can only hold home-users, and taking
// someone out of home-users moves them to Contacts. Admins can also
// merge the member into another row (MergePersonButton → mergePeople).

import { useEffect, useRef, useState } from "react";
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
import { BirthdayField } from "./BirthdayField";
import { RelationshipsSection, type PendingRelationshipFlush } from "./RelationshipsSection";
import { MergePersonButton } from "./MergePersonButton";
import { formStyles as styles } from "./person-form-styles";
import { HOUSEHOLD_GROUP } from "../../lib/household";
import { COMMON_TIMEZONES, editableGroups, personGroups, sameGroups } from "../../lib/people";
import type { RelationshipRow } from "../../lib/relationships";
import type { Schema } from "../../amplify/data/resource";

type Person = Schema["homePerson"]["type"];

const SWATCHES = ["#3a5068", "#735f55", "#2f7d6d", "#7a4e8c", "#b5523b", "#c28a1e", "#4a7bb7", "#8a8f3c", "#c2577a", "#555555"];

interface Props {
  visible: boolean;
  person: Person | null;
  people: Person[];
  rels: RelationshipRow[];
  isAdmin: boolean;
  onClose: () => void;
  /** After a save or a relationship change; reload the list. */
  onChanged: () => void | Promise<void>;
}

export function HouseholdMemberFormModal({ visible, person, people, rels, isAdmin, onClose, onChanged }: Props) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3a5068");
  const [emoji, setEmoji] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [birthday, setBirthday] = useState("");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(true);
  const [notifyPush, setNotifyPush] = useState(true);
  const [active, setActive] = useState(true);
  const [showInFinance, setShowInFinance] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const relFlush = useRef<PendingRelationshipFlush | null>(null);

  useEffect(() => {
    if (!visible || !person) return;
    setName(person.name);
    setColor(person.color ?? "#3a5068");
    setEmoji(person.emoji ?? "");
    setPhoneNumber(person.phoneNumber ?? "");
    setBirthday(person.birthday ?? "");
    setTimezone(person.defaultTimezone ?? "America/Chicago");
    setNotifyWhatsApp(person.notifyWhatsApp !== false);
    setNotifyPush(person.notifyPush !== false);
    setActive(person.active !== false);
    setShowInFinance(person.showInFinance === true);
    setGroups(personGroups(person));
  }, [visible, person]);

  async function save() {
    if (!person || !name.trim()) return;
    // A relationship filled in but not "Add"ed is saved too (or blocks).
    if (relFlush.current && !(await relFlush.current())) return;
    setBusy(true);
    try {
      const client = getClient();
      const { data: saved, errors } = await client.models.homePerson.update({
        id: person.id,
        name: name.trim(),
        color: color.trim() || "#3a5068",
        emoji: emoji.trim() || null,
        phoneNumber: phoneNumber.trim() || null,
        birthday: birthday || null,
        defaultTimezone: timezone.trim() || "America/Chicago",
        notifyWhatsApp,
        notifyPush,
        active,
        // Only meaningful without a login (members with one always show in finances).
        ...(person.cognitoUsername ? {} : { showInFinance }),
      });
      if (errors?.length || !saved) {
        Alert.alert("Couldn't save", errors?.[0]?.message ?? "No response");
        return;
      }

      // Group changes route through the admin mutation so Cognito stays in sync.
      if (isAdmin && !sameGroups(personGroups(saved), groups)) {
        try {
          const res = await client.mutations.setPersonGroups({ personId: saved.id, groups });
          if (res.errors?.length) throw new Error(res.errors[0].message);
          Alert.alert(
            "Groups updated",
            groups.includes(HOUSEHOLD_GROUP)
              ? saved.cognitoUsername
                ? "Takes effect on their next sign-in."
                : undefined
              : `${saved.name} is no longer in the household; they're under Contacts now.`
          );
        } catch (err: any) {
          Alert.alert("Failed to update groups", err?.message ?? String(err));
        }
      }

      await onChanged();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  function toggleGroup(g: string) {
    if (!isAdmin) return;
    setGroups((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }

  const hexOk = /^#[0-9a-fA-F]{6}$/.test(color);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Pressable onPress={onClose} disabled={busy}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            Edit {person?.name}
          </Text>
          <Pressable onPress={save} disabled={busy || !name.trim()}>
            {busy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.save, !name.trim() && styles.disabled]}>Save</Text>
            )}
          </Pressable>
        </View>

        {person && (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Name</Text>
            <TextInput style={styles.input} value={name} onChangeText={setName} editable={!busy} />

            <Text style={styles.label}>Color</Text>
            <View style={styles.chipRow}>
              {SWATCHES.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setColor(c)}
                  disabled={busy}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    backgroundColor: c,
                    borderWidth: color.toLowerCase() === c ? 3 : 0,
                    borderColor: "#222",
                  }}
                />
              ))}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View
                style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: hexOk ? color : "#eee" }}
              />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={color}
                onChangeText={setColor}
                placeholder="#3a5068"
                placeholderTextColor="#888"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
              />
            </View>

            <Text style={styles.label}>Emoji</Text>
            <TextInput
              style={styles.input}
              value={emoji}
              onChangeText={setEmoji}
              placeholder="🐱"
              placeholderTextColor="#888"
              editable={!busy}
            />

            <Text style={styles.label}>Phone number</Text>
            <TextInput
              style={styles.input}
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              placeholder="+12125551234"
              placeholderTextColor="#888"
              keyboardType="phone-pad"
              editable={!busy}
            />
            <Text style={styles.hint}>E.164. Lets them DM Janet on WhatsApp and get personal messages.</Text>

            <Text style={styles.label}>Birthday</Text>
            <BirthdayField value={birthday} onChange={setBirthday} disabled={busy} />

            <Text style={styles.label}>Default timezone</Text>
            <TextInput
              style={styles.input}
              value={timezone}
              onChangeText={setTimezone}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
            />
            <View style={styles.chipRow}>
              {COMMON_TIMEZONES.map((tz) => {
                const on = timezone === tz;
                return (
                  <Pressable
                    key={tz}
                    onPress={() => setTimezone(tz)}
                    style={[styles.chip, on && styles.chipOn]}
                    disabled={busy}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{tz.replace(/^.*\//, "").replace(/_/g, " ")}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[styles.hint, { marginTop: 8 }]}>
              Login: {person.email ?? "no email"}
              {person.cognitoUsername ? "" : " · not linked to a login"}
            </Text>

            <Text style={styles.label}>Notifications</Text>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>WhatsApp messages</Text>
              <Switch value={notifyWhatsApp} onValueChange={setNotifyWhatsApp} disabled={busy} />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>App push notifications</Text>
              <Switch value={notifyPush} onValueChange={setNotifyPush} disabled={busy} />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Active</Text>
              <Switch value={active} onValueChange={setActive} disabled={busy} />
            </View>
            {!person.cognitoUsername && (
              <>
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>Show in finances</Text>
                  <Switch value={showInFinance} onValueChange={setShowInFinance} disabled={busy} />
                </View>
                <Text style={styles.hint}>Show in finances (accounts, paychecks) even without a login</Text>
              </>
            )}

            <Text style={styles.label}>Groups{isAdmin ? "" : " (read-only)"}</Text>
            <View style={styles.chipRow}>
              {editableGroups(person).map((g) => {
                const on = groups.includes(g);
                return (
                  <Pressable
                    key={g}
                    onPress={() => toggleGroup(g)}
                    style={[styles.chip, on && styles.chipOn, !isAdmin && { opacity: 0.7 }]}
                    disabled={busy || !isAdmin}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{g}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.hint}>
              {person.cognitoUsername
                ? `Without ${HOUSEHOLD_GROUP} they leave the household and can't see its data. Changes apply on their next sign-in.`
                : `No login, so ${HOUSEHOLD_GROUP} is the only group. Without it they move to Contacts.`}
            </Text>

            <RelationshipsSection person={person} people={people} rels={rels} onChanged={onChanged} disabled={busy} flushRef={relFlush} />

            {isAdmin && (
              <MergePersonButton
                source={person}
                people={people}
                disabled={busy}
                onMerged={async () => {
                  onClose();
                  await onChanged();
                }}
              />
            )}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}
