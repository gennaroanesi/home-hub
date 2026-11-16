// Contacts — the native twin of /contacts. Two tabs:
//   - People: everyone in homePerson who isn't in the household, grouped
//     by circle (Family, Friends, Work, Other, Unsorted; lib/people.ts
//     contactSections), searchable by name / email / phone / notes, or
//     sorted by next birthday. Tap for the detail screen ([id].tsx).
//   - Businesses: homeBusiness rows plus health providers (read-only),
//     from the list_businesses op. Tap a business to edit it.
// Household members are on /more/household.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import { callOp } from "../../../../lib/ops";
import { PersonAvatar } from "../../../../components/PeoplePicker";
import { ContactFormModal } from "../../../../components/ContactFormModal";
import { BusinessFormModal } from "../../../../components/BusinessFormModal";
import { listAllPages } from "../../../../../lib/list-all";
import { todayIso } from "../../../../../lib/finance/dates";
import {
  birthdayLabel,
  contactMatches,
  contactSections,
  daysToBirthday,
  inHousehold,
} from "../../../../../lib/people";
import { relationsLine, type RelationshipRow } from "../../../../../lib/relationships";
import {
  BUSINESS_CATEGORIES,
  businessCategoryLabel,
  businessMatches,
  type BusinessRow,
} from "../../../../../lib/businesses";
import type { Schema } from "../../../../../amplify/data/resource";

type Person = Schema["homePerson"]["type"];
type Tab = "people" | "businesses";

const ACCENT = "#735f55";

export default function Contacts() {
  // ?tab=businesses opens that tab (the More menu links straight to it).
  const params = useLocalSearchParams<{ tab?: string }>();
  const paramTab: Tab | null = params.tab === "businesses" || params.tab === "people" ? params.tab : null;
  const [tab, setTab] = useState<Tab>(paramTab ?? "people");
  useEffect(() => {
    if (paramTab) setTab(paramTab);
  }, [paramTab]);
  const [people, setPeople] = useState<Person[]>([]);
  const [rels, setRels] = useState<RelationshipRow[]>([]);
  const [businesses, setBusinesses] = useState<BusinessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [byBirthday, setByBirthday] = useState(false);
  const [category, setCategory] = useState("ALL");
  const [showInactive, setShowInactive] = useState(false);
  const [contactModal, setContactModal] = useState(false);
  const [editingBiz, setEditingBiz] = useState<BusinessRow | null>(null);
  const [bizModal, setBizModal] = useState(false);
  const today = todayIso();

  const load = useCallback(async () => {
    const client = getClient();
    try {
      const [rows, relRows, biz] = await Promise.all([
        listAllPages<Person>(client.models.homePerson),
        listAllPages<RelationshipRow>(client.models.homePersonRelationship).catch(() => []),
        callOp("list_businesses", { includeInactive: true }),
      ]);
      setPeople(rows);
      setRels(relRows);
      if ("error" in biz) Alert.alert("Couldn't load businesses", biz.error);
      else setBusinesses(biz.result.businesses as BusinessRow[]);
    } catch (err: any) {
      Alert.alert("Couldn't load contacts", err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload on focus so edits made on the detail screen show up.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const contactCount = useMemo(() => people.filter((p) => !inHousehold(p)).length, [people]);

  const peopleSections = useMemo(() => {
    if (!byBirthday) {
      return contactSections(people, query).map((s) => ({
        key: s.key,
        title: `${s.label} · ${s.people.length}`,
        data: s.people,
      }));
    }
    const rows = people
      .filter((p) => !inHousehold(p) && contactMatches(p, query) && p.birthday)
      .sort(
        (a, b) =>
          (daysToBirthday(a.birthday, today) ?? 9999) - (daysToBirthday(b.birthday, today) ?? 9999) ||
          a.name.localeCompare(b.name)
      );
    return rows.length ? [{ key: "BDAY", title: "Next birthday", data: rows }] : [];
  }, [people, query, byBirthday, today]);

  const usedCategories = useMemo(() => {
    const used = new Set(businesses.map((b) => b.category ?? "OTHER"));
    return [...BUSINESS_CATEGORIES, "HEALTH" as const].filter((c) => used.has(c));
  }, [businesses]);

  const shownBusinesses = useMemo(
    () =>
      businesses.filter(
        (b) =>
          (showInactive || b.active) &&
          (category === "ALL" || b.category === category) &&
          (!query.trim() || businessMatches(b, query))
      ),
    [businesses, showInactive, category, query]
  );

  function onAdd() {
    if (tab === "people") setContactModal(true);
    else {
      setEditingBiz(null);
      setBizModal(true);
    }
  }

  function onBusinessPress(b: BusinessRow) {
    if (b.source === "health") {
      Alert.alert(b.name, "Health providers are edited in Health on the web, where visits point at them.");
      return;
    }
    setEditingBiz(b);
    setBizModal(true);
  }

  const refresh = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color={ACCENT} />
        </Pressable>
        <Text style={styles.heading}>Contacts</Text>
        <Pressable onPress={onAdd} hitSlop={12} style={styles.addBtn}>
          <Ionicons name="add" size={28} color={ACCENT} />
        </Pressable>
      </View>

      <View style={styles.tabs}>
        {(["people", "businesses"] as const).map((t) => {
          const on = tab === t;
          return (
            <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, on && styles.tabOn]}>
              <Text style={[styles.tabText, on && styles.tabTextOn]}>
                {t === "people" ? `People${contactCount ? ` (${contactCount})` : ""}` : "Businesses"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color="#999" />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={tab === "people" ? "Search name, email, phone, notes" : "Search name, service, phone, notes"}
          placeholderTextColor="#999"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      {tab === "people" ? (
        <View style={styles.filterRow}>
          <Pressable onPress={() => setByBirthday((v) => !v)} style={[styles.chip, byBirthday && styles.chipOn]}>
            <Text style={[styles.chipText, byBirthday && styles.chipTextOn]}>
              {byBirthday ? "🎂 Next birthday" : "By circle"}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View>
          <ScrollView horizontal style={{ flexGrow: 0, flexShrink: 0 }} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
            {["ALL", ...usedCategories].map((c) => {
              const on = category === c;
              return (
                <Pressable key={c} onPress={() => setCategory(c)} style={[styles.chip, on && styles.chipOn]}>
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {c === "ALL" ? "All" : businessCategoryLabel(c)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.inactiveRow}>
            <Text style={styles.inactiveText}>Show inactive</Text>
            <Switch value={showInactive} onValueChange={setShowInactive} />
          </View>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : tab === "people" ? (
        <SectionList
          sections={peopleSections}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.listBody}
          refreshControl={refresh}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {contactCount
                ? byBirthday
                  ? "No birthdays match."
                  : "No contacts match."
                : "No contacts yet. Tap + to add one."}
            </Text>
          }
          renderItem={({ item }) => (
            <ContactRow
              person={item}
              meta={[
                birthdayLabel(item.birthday, today) && `🎂 ${birthdayLabel(item.birthday, today)}`,
                item.phoneNumber,
                item.email,
              ]
                .filter(Boolean)
                .join(" · ")}
              relations={relationsLine(item.id, rels, byId)}
              onPress={() => router.push(`/more/contacts/${item.id}` as any)}
            />
          )}
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.listBody}
          refreshControl={refresh}
          keyboardShouldPersistTaps="handled"
        >
          {shownBusinesses.map((b) => (
            <BusinessItem key={`${b.source}:${b.id}`} business={b} onPress={() => onBusinessPress(b)} />
          ))}
          {shownBusinesses.length === 0 && (
            <Text style={styles.empty}>
              {businesses.length ? "No businesses match." : "No businesses yet. Tap + to add one."}
            </Text>
          )}
        </ScrollView>
      )}

      <ContactFormModal
        visible={contactModal}
        contact={null}
        onClose={() => setContactModal(false)}
        onSaved={(id) => {
          void load();
          router.push(`/more/contacts/${id}` as any);
        }}
      />
      <BusinessFormModal
        visible={bizModal}
        business={editingBiz}
        onClose={() => setBizModal(false)}
        onSaved={() => void load()}
      />
    </SafeAreaView>
  );
}

function ContactRow({
  person,
  meta,
  relations,
  onPress,
}: {
  person: Person;
  meta: string;
  relations: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <PersonAvatar person={person} size={40} />
      <View style={styles.rowMain}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {person.name}
          </Text>
          {!!person.cognitoUsername && (
            <View style={styles.loginTag}>
              <Text style={styles.loginTagText}>login</Text>
            </View>
          )}
        </View>
        {!!meta && (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {meta}
          </Text>
        )}
        {!!relations && (
          <Text style={styles.rowSub} numberOfLines={1}>
            {relations}
          </Text>
        )}
        {!!person.notes && (
          <Text style={styles.rowSub} numberOfLines={1}>
            {person.notes}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color="#bbb" />
    </Pressable>
  );
}

function BusinessItem({ business: b, onPress }: { business: BusinessRow; onPress: () => void }) {
  const health = b.source === "health";
  const contact = [b.phone, b.email, b.lastUsedOn ? `last used ${shortDate(b.lastUsedOn)}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, !b.active && styles.inactive, pressed && styles.rowPressed]}
    >
      <View style={styles.rowMain}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {b.name}
          </Text>
          {!!b.category && (
            <View style={[styles.catTag, health && styles.healthTag]}>
              <Text style={[styles.catTagText, health && styles.healthTagText]}>
                {health ? "♥ " : ""}
                {businessCategoryLabel(b.category)}
              </Text>
            </View>
          )}
          {!b.active && <Text style={styles.rowMeta}>inactive</Text>}
        </View>
        {!!(b.service || b.contactName) && (
          <Text style={styles.rowSub} numberOfLines={1}>
            {[b.service, b.contactName].filter(Boolean).join(" · ")}
          </Text>
        )}
        {!!contact && (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {contact}
          </Text>
        )}
        {!!b.address && (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {b.address}
          </Text>
        )}
        {!!b.notes && (
          <Text style={styles.rowSub} numberOfLines={2}>
            {b.notes}
          </Text>
        )}
      </View>
      {health ? (
        <Text style={styles.inHealth}>In Health</Text>
      ) : (
        <Ionicons name="create-outline" size={18} color="#bbb" />
      )}
    </Pressable>
  );
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
  heading: { fontSize: 28, fontWeight: "600", flex: 1 },
  addBtn: { padding: 4, paddingRight: 8 },

  tabs: {
    flexDirection: "row",
    marginHorizontal: 20,
    backgroundColor: "#ececec",
    borderRadius: 10,
    padding: 3,
    marginBottom: 10,
  },
  tab: { flex: 1, paddingVertical: 7, alignItems: "center", borderRadius: 8 },
  tabOn: { backgroundColor: "#fff" },
  tabText: { fontSize: 14, color: "#666", fontWeight: "500" },
  tabTextOn: { color: "#222" },

  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  search: { flex: 1, paddingVertical: 10, fontSize: 15, color: "#222" },

  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingVertical: 10 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  chipOn: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipText: { color: "#444", fontSize: 13 },
  chipTextOn: { color: "#fff" },
  inactiveRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  inactiveText: { fontSize: 13, color: "#666" },

  listBody: { paddingHorizontal: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 4,
  },

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
  inactive: { opacity: 0.6 },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  rowTitle: { fontSize: 16, color: "#222", fontWeight: "500", flexShrink: 1 },
  rowMeta: { fontSize: 13, color: "#888", marginTop: 2 },
  rowSub: { fontSize: 13, color: "#666", marginTop: 2 },
  loginTag: { backgroundColor: "#fdf0d5", borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  loginTagText: { fontSize: 11, color: "#a06a00" },
  catTag: { backgroundColor: "#f0eeec", borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  catTagText: { fontSize: 11, color: "#666" },
  healthTag: { backgroundColor: "#fbe4e4" },
  healthTagText: { color: "#b33" },
  inHealth: { fontSize: 12, color: "#999" },
});
