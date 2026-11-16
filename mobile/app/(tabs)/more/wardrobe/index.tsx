// Wardrobe — the native twin of /wardrobe. Per-person closets (household
// members), with four tabs:
//   - Closet: items with photos, search and category / status / look chips;
//     tap to edit, + to add (photos via the camera or library).
//   - Looks: saved looks; Wore it today, Edit, + for a new one.
//   - Suggest: the outfit suggester; save a suggestion as a look.
//   - Trips: the person's trips → trip looks (trip/[tripId].tsx).
// The gear opens Closet settings (categories, style brief, fit, try-on
// reference photos). Try-on generation stays on the web; saved try-on
// images show on looks.

import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import type { ClosetFilter } from "../../../../../lib/wardrobe";
import {
  ACCENT,
  Chip,
  logWornToday,
  useToast,
  wardrobeStyles as ws,
  type WardrobeItem,
  type WardrobeLook,
} from "../../../../components/wardrobe/shared";
import { usePersonWardrobe, useWardrobe } from "../../../../components/wardrobe/use-wardrobe";
import { ClosetView } from "../../../../components/wardrobe/ClosetView";
import { LooksView } from "../../../../components/wardrobe/LooksView";
import { SuggestView } from "../../../../components/wardrobe/SuggestView";
import { TripsView } from "../../../../components/wardrobe/TripsView";
import { ItemFormModal } from "../../../../components/wardrobe/ItemFormModal";
import { LookFormModal, type LookDraft } from "../../../../components/wardrobe/LookFormModal";
import { ProfileFormModal } from "../../../../components/wardrobe/ProfileFormModal";

type Tab = "CLOSET" | "LOOKS" | "SUGGEST" | "TRIPS";

const EMPTY_FILTER: ClosetFilter = { category: "", status: "OWNED", inLook: "", search: "" };

export default function Wardrobe() {
  const data = useWardrobe();
  const [toastNode, toast] = useToast();
  const [personId, setPersonId] = useState("");
  // ?tab=looks|suggest|trips opens that tab (the More menu links straight to it).
  const params = useLocalSearchParams<{ tab?: string }>();
  const paramTab = (["CLOSET", "LOOKS", "SUGGEST", "TRIPS"] as const).find((t) => t === params.tab?.toUpperCase());
  const [tab, setTab] = useState<Tab>(paramTab ?? "CLOSET");
  useEffect(() => {
    if (paramTab) setTab(paramTab);
  }, [paramTab]);
  const [filter, setFilter] = useState<ClosetFilter>(EMPTY_FILTER);
  const [refreshing, setRefreshing] = useState(false);

  const [itemModal, setItemModal] = useState<{ editing: WardrobeItem | null } | null>(null);
  const [lookModal, setLookModal] = useState<{ editing: WardrobeLook | null; draft: LookDraft | null } | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  // Start on the signed-in person, else the first member.
  useEffect(() => {
    if (personId || data.loading) return;
    const known = data.meId && data.people.some((p) => p.id === data.meId);
    setPersonId((known ? data.meId : data.people[0]?.id) ?? "");
  }, [personId, data.loading, data.meId, data.people]);

  const person = data.people.find((p) => p.id === personId) ?? null;
  const { profile, mine, myLooks, categories } = usePersonWardrobe(data, personId);

  function pickPerson(id: string) {
    setPersonId(id);
    setFilter((f) => ({ ...f, category: "", inLook: "" }));
  }

  async function onRefresh() {
    setRefreshing(true);
    try {
      await data.reload();
    } finally {
      setRefreshing(false);
    }
  }

  async function wear(itemIds: string[], lookId?: string | null) {
    try {
      await logWornToday(personId, itemIds, lookId);
      toast({ title: "Logged as worn today" });
      void data.reload();
    } catch (err: any) {
      Alert.alert("Couldn't log it", err?.message ?? String(err));
    }
  }

  const canAdd = !!person && (tab === "CLOSET" || tab === "LOOKS");

  return (
    <SafeAreaView style={ws.screen} edges={["top"]}>
      <View style={ws.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={ws.backBtn}>
          <Ionicons name="chevron-back" size={28} color={ACCENT} />
        </Pressable>
        <Text style={ws.heading}>Wardrobe</Text>
        {person && (
          <Pressable onPress={() => setProfileOpen(true)} hitSlop={10} style={ws.iconBtn} accessibilityLabel="Closet settings">
            <Ionicons name="settings-outline" size={22} color={ACCENT} />
          </Pressable>
        )}
        {canAdd && (
          <Pressable
            onPress={() => (tab === "LOOKS" ? setLookModal({ editing: null, draft: null }) : setItemModal({ editing: null }))}
            hitSlop={10}
            style={ws.iconBtn}
            accessibilityLabel={tab === "LOOKS" ? "New look" : "Add item"}
          >
            <Ionicons name="add" size={28} color={ACCENT} />
          </Pressable>
        )}
      </View>
      {toastNode}

      {data.people.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.peopleScroll} contentContainerStyle={styles.people}>
          {data.people.map((p) => (
            <Chip key={p.id} on={p.id === personId} onPress={() => pickPerson(p.id)} label={`${p.emoji ? `${p.emoji} ` : ""}${p.name}`} />
          ))}
        </ScrollView>
      )}

      <View style={ws.tabs}>
        {(
          [
            ["CLOSET", "Closet"],
            ["LOOKS", `Looks${myLooks.length ? ` ${myLooks.length}` : ""}`],
            ["SUGGEST", "Suggest"],
            ["TRIPS", "Trips"],
          ] as const
        ).map(([k, label]) => (
          <Pressable key={k} onPress={() => setTab(k)} style={[ws.tab, tab === k && ws.tabOn]}>
            <Text style={[ws.tabText, tab === k && ws.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {data.loading ? (
        <View style={ws.center}>
          <ActivityIndicator />
        </View>
      ) : !person ? (
        <Text style={ws.empty}>{data.error ? `Couldn't load the wardrobe: ${data.error}` : "No household members found."}</Text>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {tab === "CLOSET" ? (
            <ClosetView
              items={mine}
              looks={myLooks}
              categories={categories}
              filter={filter}
              onFilter={setFilter}
              onOpen={(it) => setItemModal({ editing: it })}
            />
          ) : tab === "LOOKS" ? (
            <LooksView
              looks={myLooks}
              byId={data.byId}
              onOpenItem={(it) => setItemModal({ editing: it })}
              onEdit={(l) => setLookModal({ editing: l, draft: null })}
              onWear={(l) => void wear((l.itemIds ?? []).filter((x): x is string => !!x), l.id)}
            />
          ) : tab === "SUGGEST" ? (
            <SuggestView
              key={personId}
              personId={personId}
              personName={person.name}
              byId={data.byId}
              onOpenItem={(it) => setItemModal({ editing: it })}
              onSave={(draft) => setLookModal({ editing: null, draft })}
              onWear={(ids) => void wear(ids)}
            />
          ) : (
            <TripsView personId={personId} personName={person.name} />
          )}
        </ScrollView>
      )}

      {person && (
        <>
          <ItemFormModal
            visible={!!itemModal}
            editing={itemModal?.editing ?? null}
            ownerPersonId={person.id}
            categories={categories}
            defaultCategory={filter.category || undefined}
            defaultStatus={filter.status && filter.status !== "OWNED" ? filter.status : undefined}
            onClose={() => setItemModal(null)}
            onSaved={(msg) => {
              toast({ title: msg });
              void data.reload();
            }}
          />
          <LookFormModal
            visible={!!lookModal}
            editing={lookModal?.editing ?? null}
            draft={lookModal?.draft ?? null}
            ownerPersonId={person.id}
            items={mine}
            categories={categories}
            nextSortOrder={(myLooks[myLooks.length - 1]?.sortOrder ?? myLooks.length) + 1}
            onClose={() => setLookModal(null)}
            onSaved={(saved) => {
              toast({ title: saved ? "Look saved" : "Look deleted" });
              void data.reload();
            }}
          />
          <ProfileFormModal
            visible={profileOpen}
            personId={person.id}
            personName={person.name}
            profile={profile}
            categories={categories}
            onClose={() => setProfileOpen(false)}
            onSaved={() => {
              toast({ title: "Closet settings saved" });
              void data.reload();
            }}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // flexGrow/flexShrink 0: otherwise the closet's ScrollView below squeezes this row and clips the chips.
  peopleScroll: { flexGrow: 0, flexShrink: 0 },
  people: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingBottom: 10 },
  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 60 },
});
