// One contact: photo, circle, birthday, phone / email (tap to call or
// write), notes, and their relationships (add / unlink through the
// save_relationship op). The pencil opens ContactFormModal; Delete drops
// their relationship rows first so no link points at nobody, then the
// person, as /contacts does. Admins also get "Merge into…"
// (MergePersonButton → mergePeople), then go back: this row is gone.

import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import { resizedImageUrl } from "../../../../lib/image";
import { ContactFormModal } from "../../../../components/ContactFormModal";
import { RelationshipsSection } from "../../../../components/RelationshipsSection";
import { MergePersonButton } from "../../../../components/MergePersonButton";
import { Markdown } from "../../../../components/Markdown";
import { useIsAdmin } from "../../../../lib/use-is-admin";
import { listAllPages } from "../../../../../lib/list-all";
import { todayIso } from "../../../../../lib/finance/dates";
import { birthdayLabel, circleLabel, inHousehold } from "../../../../../lib/people";
import type { RelationshipRow } from "../../../../../lib/relationships";
import type { Schema } from "../../../../../amplify/data/resource";

type Person = Schema["homePerson"]["type"];

const ACCENT = "#735f55";

export default function ContactDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [people, setPeople] = useState<Person[]>([]);
  const [rels, setRels] = useState<RelationshipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isAdmin = useIsAdmin();

  const load = useCallback(async () => {
    const client = getClient();
    try {
      const [rows, relRows] = await Promise.all([
        listAllPages<Person>(client.models.homePerson),
        listAllPages<RelationshipRow>(client.models.homePersonRelationship).catch(() => []),
      ]);
      setPeople(rows);
      setRels(relRows);
    } catch (err: any) {
      Alert.alert("Couldn't load", err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const person = useMemo(() => people.find((p) => p.id === id) ?? null, [people, id]);

  function remove() {
    if (!person) return;
    Alert.alert(
      `Delete ${person.name}?`,
      "Photo tags and anything assigned to them will be unlinked.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              const client = getClient();
              await Promise.all(
                rels
                  .filter((r) => r.personId === person.id || r.relatedPersonId === person.id)
                  .map((r) => client.models.homePersonRelationship.delete({ id: r.id }))
              );
              const { errors } = await client.models.homePerson.delete({ id: person.id });
              if (errors?.length) throw new Error(errors[0].message);
              router.back();
            } catch (err: any) {
              Alert.alert("Couldn't delete", err?.message ?? String(err));
              setDeleting(false);
            }
          },
        },
      ]
    );
  }

  const member = person ? inHousehold(person) : false;
  const today = todayIso();

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color={ACCENT} />
        </Pressable>
        <Text style={styles.heading} numberOfLines={1}>
          {person?.name ?? ""}
        </Text>
        {person && !member && (
          <Pressable onPress={() => setEditOpen(true)} hitSlop={12} style={styles.editBtn}>
            <Ionicons name="create-outline" size={24} color={ACCENT} />
          </Pressable>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : !person ? (
        <Text style={styles.empty}>This contact is gone.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            {person.photoKey ? (
              <Image source={{ uri: resizedImageUrl(person.photoKey, 480) }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, styles.photoPlaceholder, { backgroundColor: person.color ?? "#3a5068" }]}>
                <Text style={styles.photoInitial}>{person.emoji || person.name[0]?.toUpperCase()}</Text>
              </View>
            )}
            <Text style={styles.name}>{person.name}</Text>
            <View style={styles.tagRow}>
              {!!circleLabel(person.circle) && (
                <View style={styles.tag}>
                  <Text style={styles.tagText}>{circleLabel(person.circle)}</Text>
                </View>
              )}
              {!!person.cognitoUsername && !member && (
                <View style={[styles.tag, styles.loginTag]}>
                  <Text style={[styles.tagText, styles.loginTagText]}>has a login, not in the household</Text>
                </View>
              )}
            </View>
          </View>

          {member && (
            <Pressable onPress={() => router.push("/more/household" as any)} style={styles.note}>
              <Text style={styles.noteText}>
                {person.name} is in the household; edit them in Household.
              </Text>
            </Pressable>
          )}

          <View style={styles.card}>
            <InfoRow icon="gift-outline" label="Birthday" value={birthdayLabel(person.birthday, today)} />
            <InfoRow
              icon="call-outline"
              label="Phone"
              value={person.phoneNumber}
              onPress={person.phoneNumber ? () => Linking.openURL(`tel:${person.phoneNumber!.replace(/\s/g, "")}`) : undefined}
            />
            <InfoRow
              icon="mail-outline"
              label="Email"
              value={person.email}
              onPress={person.email ? () => Linking.openURL(`mailto:${person.email}`) : undefined}
            />
            {person.notes ? (
              <View style={styles.infoRow}>
                <Ionicons name="document-text-outline" size={18} color="#999" style={styles.infoIcon} />
                <Text style={styles.infoLabel}>Notes</Text>
                <View style={{ flex: 1 }}>
                  <Markdown content={person.notes} />
                </View>
              </View>
            ) : (
              <InfoRow icon="document-text-outline" label="Notes" value={null} last />
            )}
          </View>

          <RelationshipsSection
            person={person}
            people={people}
            rels={rels}
            onChanged={load}
            disabled={deleting}
          />

          {isAdmin && (
            <MergePersonButton
              source={person}
              people={people}
              disabled={deleting}
              onMerged={() => router.back()}
            />
          )}

          {!member && (
            <Pressable onPress={remove} style={styles.deleteBtn} disabled={deleting}>
              {deleting ? <ActivityIndicator /> : <Text style={styles.deleteText}>Delete contact</Text>}
            </Pressable>
          )}
        </ScrollView>
      )}

      <ContactFormModal
        visible={editOpen}
        contact={person}
        onClose={() => setEditOpen(false)}
        onSaved={() => void load()}
      />
    </SafeAreaView>
  );
}

function InfoRow({
  icon,
  label,
  value,
  onPress,
  multiline = false,
  last = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string | null | undefined;
  onPress?: () => void;
  multiline?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.infoRow, !last && styles.divider, pressed && styles.rowPressed]}
    >
      <Ionicons name={icon} size={18} color="#999" style={styles.infoIcon} />
      <Text style={styles.infoLabel}>{label}</Text>
      <Text
        style={[styles.infoValue, !value && styles.infoEmpty, !!onPress && styles.infoLink]}
        numberOfLines={multiline ? undefined : 1}
      >
        {value || "—"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 4,
  },
  backBtn: { padding: 4 },
  heading: { fontSize: 22, fontWeight: "600", flex: 1 },
  editBtn: { padding: 4, paddingRight: 8 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  body: { paddingHorizontal: 20, paddingBottom: 60, gap: 8 },
  hero: { alignItems: "center", marginBottom: 8 },
  photo: { width: 120, height: 120, borderRadius: 60, backgroundColor: "#eee" },
  photoPlaceholder: { alignItems: "center", justifyContent: "center" },
  photoInitial: { fontSize: 48, color: "#fff", fontWeight: "500" },
  name: { fontSize: 22, fontWeight: "600", marginTop: 10, color: "#222" },
  tagRow: { flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap", justifyContent: "center" },
  tag: { backgroundColor: "#f0eeec", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  tagText: { fontSize: 12, color: "#666" },
  loginTag: { backgroundColor: "#fdf0d5" },
  loginTagText: { color: "#a06a00" },

  note: { backgroundColor: "#fdf6e9", borderRadius: 10, padding: 12 },
  noteText: { color: "#7a5a1e", fontSize: 14 },

  card: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  infoRow: { flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 12, paddingVertical: 11 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#eee" },
  rowPressed: { backgroundColor: "#f4f4f4" },
  infoIcon: { marginRight: 8, marginTop: 1 },
  infoLabel: { width: 72, fontSize: 14, color: "#888" },
  infoValue: { flex: 1, fontSize: 15, color: "#222" },
  infoEmpty: { color: "#bbb" },
  infoLink: { color: ACCENT },

  deleteBtn: {
    marginTop: 24,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5c4c4",
  },
  deleteText: { color: "#c44", fontWeight: "500", fontSize: 15 },
});
