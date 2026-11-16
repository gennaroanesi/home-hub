// Household — the native twin of /admin/people: the app's members
// (homePerson rows in `home-users`, lib/household.ts; inactive ones too,
// so they can be reactivated). Tap a member to edit them
// (HouseholdMemberFormModal). Admins (cognito:groups includes "admins")
// also change groups there and get Invite (HouseholdInviteModal), which
// has the "No login (a kid)" option. Everyone else is in Contacts.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { fetchAuthSession } from "aws-amplify/auth";

import { configureAmplify, getClient } from "../../../lib/amplify";
import { PersonAvatar } from "../../../components/PeoplePicker";
import { HouseholdMemberFormModal } from "../../../components/HouseholdMemberFormModal";
import { HouseholdInviteModal } from "../../../components/HouseholdInviteModal";
import { listAllPages } from "../../../../lib/list-all";
import { inHousehold, memberLine, personGroups } from "../../../../lib/people";
import { relationsLine, type RelationshipRow } from "../../../../lib/relationships";
import type { Schema } from "../../../../amplify/data/resource";

type Person = Schema["homePerson"]["type"];

const ACCENT = "#735f55";

export default function Household() {
  const [people, setPeople] = useState<Person[]>([]);
  const [rels, setRels] = useState<RelationshipRow[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    const client = getClient();
    try {
      const [rows, relRows] = await Promise.all([
        listAllPages<Person>(client.models.homePerson),
        listAllPages<RelationshipRow>(client.models.homePersonRelationship).catch(() => []),
      ]);
      setPeople(rows.sort((a, b) => a.name.localeCompare(b.name)));
      setRels(relRows);
    } catch (err: any) {
      Alert.alert("Couldn't load", err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    (async () => {
      try {
        configureAmplify();
        const session = await fetchAuthSession();
        const groups = (session.tokens?.idToken?.payload?.["cognito:groups"] as string[] | undefined) ?? [];
        setIsAdmin(groups.includes("admins"));
      } catch {
        setIsAdmin(false);
      }
    })();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const members = useMemo(() => people.filter(inHousehold), [people]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  // Look the row up fresh so the modal reflects reloads (e.g. after a relationship change).
  const editing = editingId ? (byId.get(editingId) ?? null) : null;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color={ACCENT} />
        </Pressable>
        <Text style={styles.heading}>Household</Text>
        {isAdmin && (
          <Pressable onPress={() => setInviteOpen(true)} hitSlop={12} style={styles.inviteBtn}>
            <Ionicons name="mail-outline" size={18} color={ACCENT} />
            <Text style={styles.inviteText}>Invite</Text>
          </Pressable>
        )}
      </View>
      <Text style={styles.subtitle}>
        The people who use the app. Friends, family and anyone tagged in photos are in{" "}
        <Text style={styles.link} onPress={() => router.push("/more/contacts" as any)}>
          Contacts
        </Text>
        .{!isAdmin && " Inviting and group changes are admin-only."}
      </Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={members}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.listBody}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={<Text style={styles.empty}>No members yet.</Text>}
          renderItem={({ item }) => (
            <MemberRow
              person={item}
              relations={relationsLine(item.id, rels, byId)}
              onPress={() => setEditingId(item.id)}
            />
          )}
        />
      )}

      <HouseholdMemberFormModal
        visible={!!editing}
        person={editing}
        people={people}
        rels={rels}
        isAdmin={isAdmin}
        onClose={() => setEditingId(null)}
        onChanged={load}
      />
      {isAdmin && (
        <HouseholdInviteModal
          visible={inviteOpen}
          people={people}
          onClose={() => setInviteOpen(false)}
          onDone={load}
        />
      )}
    </SafeAreaView>
  );
}

function MemberRow({ person, relations, onPress }: { person: Person; relations: string; onPress: () => void }) {
  const line = memberLine(person);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <PersonAvatar person={person} size={40} />
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>
          {person.name}
          {person.active === false && <Text style={styles.rowMeta}> · inactive</Text>}
        </Text>
        <View style={styles.groupLine}>
          {personGroups(person).map((g) => (
            <View key={g} style={styles.groupChip}>
              <Text style={styles.groupChipText}>{g}</Text>
            </View>
          ))}
        </View>
        {!!line && (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {line}
          </Text>
        )}
        {!!relations && (
          <Text style={styles.rowSub} numberOfLines={1}>
            {relations}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color="#bbb" />
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
    paddingBottom: 6,
    gap: 4,
  },
  backBtn: { padding: 4 },
  heading: { fontSize: 28, fontWeight: "600", flex: 1 },
  inviteBtn: { flexDirection: "row", alignItems: "center", gap: 4, padding: 4, paddingRight: 8 },
  inviteText: { color: ACCENT, fontWeight: "600", fontSize: 15 },
  subtitle: { fontSize: 13, color: "#888", paddingHorizontal: 20, marginBottom: 10 },
  link: { color: ACCENT, fontWeight: "500" },

  listBody: { paddingHorizontal: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: "#fff",
    borderRadius: 10,
    marginVertical: 3,
    gap: 12,
  },
  rowPressed: { opacity: 0.7 },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 16, color: "#222", fontWeight: "500" },
  rowMeta: { fontSize: 13, color: "#888", marginTop: 2, fontWeight: "400" },
  rowSub: { fontSize: 13, color: "#666", marginTop: 2 },
  groupLine: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 3 },
  groupChip: { backgroundColor: "#efe9e6", borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  groupChipText: { fontSize: 11, color: ACCENT },
});
