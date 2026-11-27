// Trip looks for one trip — the native twin of the Trip looks tab on
// /wardrobe (components/wardrobe/trip-panel.tsx). Route:
// /more/wardrobe/trip/<tripId>?personId=<id> (person defaults to the
// signed-in member when they're on the trip).
//
// Luggage + activities + "Anything else" (an instruction) → planTripOutfits
// → packing list and a look per day/activity, from the destination's
// weather and the trip's reservations. Then: tick pieces while packing,
// Replace / Remove / Add a piece (no model call), add the list to a trip
// checklist, tweak with a note, undo, move a look to another day, save a
// look (pinned through re-plans), unpin, delete the plan. Polling and
// backgrounding: components/wardrobe/use-trip-plan.ts.
// Or "I'll pick": tap the pieces yourself (TripPicker); the looks use only
// those and a review says whether they work, with pieces to add or leave
// home. "A look for each day" off gives mix-and-match looks.

import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../../lib/amplify";
import { formatTripRange, type Trip } from "../../../../../../lib/trip";
import { isWearable } from "../../../../../../lib/wardrobe";
import {
  TRIP_CAPACITIES,
  TRIP_CAPACITY_LABELS,
  TRIP_REVIEW_LABELS,
  addTripPlanItem,
  categoryCounts,
  categoryCountsLabel,
  packCount,
  parseJsonField,
  picksOf,
  removeTripPlanItem,
  swapTripPlanItem,
  tripDates,
  type TripCapacity,
  type TripDayWeather,
  type TripLook,
  type TripPlan,
  type TripReview,
} from "../../../../../../lib/wardrobe-trip";
import {
  editTripPlanPatch,
  forgetFeedbackPatch,
  groupByCategory,
  moveTripLookPatch,
  packEditSummary,
  pinTripLookPatch,
  shownTripPlan,
  togglePackedPatch,
  tripDayLabel,
  tripPlanOf,
  undoTripPlanPatch,
} from "../../../../../../lib/wardrobe-trip-edits";
import {
  ACCENT,
  Chip,
  ItemThumb,
  OptionSheet,
  useToast,
  wardrobeStyles as ws,
  type WardrobeItem,
  type WardrobeLook,
} from "../../../../../components/wardrobe/shared";
import { usePersonWardrobe, useWardrobe } from "../../../../../components/wardrobe/use-wardrobe";
import { useTripPlan } from "../../../../../components/wardrobe/use-trip-plan";
import { LookCard } from "../../../../../components/wardrobe/LookCard";
import { LookFormModal, type LookDraft } from "../../../../../components/wardrobe/LookFormModal";
import { ItemFormModal } from "../../../../../components/wardrobe/ItemFormModal";
import { PackPieceModal, type PackPickerMode } from "../../../../../components/wardrobe/PackPieceModal";
import { PackChecklistModal } from "../../../../../components/wardrobe/PackChecklistModal";
import { TripPicker } from "../../../../../components/wardrobe/TripPicker";

type DaySheet = { kind: "activity"; n: number } | { kind: "look"; n: number };

export default function TripLooksScreen() {
  const params = useLocalSearchParams<{ tripId: string; personId?: string }>();
  const tripId = params.tripId ?? "";
  const data = useWardrobe();
  const [toastNode, toast] = useToast();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [tripLoaded, setTripLoaded] = useState(false);
  const [personId, setPersonId] = useState(params.personId ?? "");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!tripId) return;
    getClient()
      .models.homeTrip.get({ id: tripId })
      .then((r) => setTrip(r.data ?? null))
      .catch(() => setTrip(null))
      .finally(() => setTripLoaded(true));
  }, [tripId]);

  // Household members on this trip (no participants = everyone).
  const onTrip = useMemo(() => {
    const ids = (trip?.participantIds ?? []).filter((x): x is string => !!x);
    return data.people.filter((p) => !ids.length || ids.includes(p.id));
  }, [trip, data.people]);

  useEffect(() => {
    if (personId || !tripLoaded || data.loading) return;
    const me = data.meId && onTrip.some((p) => p.id === data.meId) ? data.meId : null;
    setPersonId(me ?? onTrip[0]?.id ?? data.meId ?? "");
  }, [personId, tripLoaded, data.loading, data.meId, onTrip]);

  const person = data.people.find((p) => p.id === personId) ?? null;
  const { mine, myLooks, categories } = usePersonWardrobe(data, personId);
  const tp = useTripPlan(tripId, personId, toast);
  const { plan, working, tweaking, form } = tp;

  const dates = useMemo(() => (trip ? tripDates(trip.startDate, trip.endDate) : []), [trip]);
  const ready = shownTripPlan(plan);
  const weather = parseJsonField<TripDayWeather[]>(ready?.weather, []);
  const looks = parseJsonField<TripLook[]>(ready?.looks, []);
  const pack = (ready?.packItemIds ?? []).map((id) => (id ? data.byId.get(id) : undefined)).filter((x): x is WardrobeItem => !!x);
  const packIds = pack.map((p) => p.id);
  const packed = new Set((ready?.packedItemIds ?? []).filter((x): x is string => !!x));
  const packGroups = groupByCategory(pack);
  const feedback = (plan?.feedback ?? []).filter((x): x is string => !!x);
  const canUndo = !!plan?.previousPlan && !working;
  const closet = useMemo(() => mine.filter((i) => isWearable(i)), [mine]);
  // Copies come from the picks on a PICKED plan, else from the looks.
  const planPicks = ready?.mode === "PICKED" ? picksOf(ready) : null;
  const copiesOf = (p: WardrobeItem) => packCount(p, looks, planPicks);
  const review = ready?.mode === "PICKED" ? parseJsonField<TripReview | null>(ready.review, null) : null;
  const savedLook = (id?: string | null) => (id ? data.looks.find((l) => l.id === id) : undefined);

  // Sheets and modals.
  const [daySheet, setDaySheet] = useState<DaySheet | null>(null);
  const [picker, setPicker] = useState<PackPickerMode | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [itemOpen, setItemOpen] = useState<WardrobeItem | null>(null);
  const [lookModal, setLookModal] = useState<{ editing: WardrobeLook | null; draft: LookDraft | null; n: number } | null>(null);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([data.reload(), tp.reload()]);
    } finally {
      setRefreshing(false);
    }
  }

  // ── Direct edits ────────────────────────────────────────────────────────

  async function editPack(edit: (c: TripPlan) => { plan: TripPlan; changedLooks?: number; pinnedKept?: number }, title: string, keptName?: string) {
    if (!plan) return;
    const current = tripPlanOf(plan);
    const { plan: next, changedLooks = 0, pinnedKept = 0 } = edit(current);
    if (next === current) return;
    setEditBusy(true);
    try {
      const patch = editTripPlanPatch(plan, next);
      if (!(await tp.savePlan(patch))) return;
      // A PICKED plan's picks follow the packing list.
      if (patch.pickedItemIds) form.setPicks({ itemIds: patch.pickedItemIds, copies: parseJsonField<Record<string, number>>(patch.pickedCopies, {}) });
      setPicker(null);
      toast({ title, detail: packEditSummary(changedLooks, pinnedKept, keptName) });
    } finally {
      setEditBusy(false);
    }
  }
  const replaceItem = (from: WardrobeItem, to: WardrobeItem) => editPack((c) => swapTripPlanItem(c, from, to), `${to.name} replaces ${from.name}`, from.name);
  const addItem = (it: WardrobeItem) => editPack((c) => ({ plan: addTripPlanItem(c, it.id) }), `${it.name} added to the packing list`);
  function removeItem(it: WardrobeItem) {
    Alert.alert(`Remove ${it.name}?`, "It comes off the packing list and out of every look (saved looks keep it).", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void editPack((c) => removeTripPlanItem(c, it.id), `${it.name} removed`, it.name) },
    ]);
  }

  async function moveLook(n: number, date: string | null) {
    const m = plan && moveTripLookPatch(plan, n, date);
    if (!m || !(await tp.savePlan(m.patch))) return;
    toast({
      title: `${m.moved.title} moved to ${date ? tripDayLabel(date) : "any day"}`,
      detail: m.swappedWith ? `${m.swappedWith.title} takes ${m.moved.date ? tripDayLabel(m.moved.date) : "no day"}` : undefined,
    });
  }

  async function pinLook(n: number, saved: Pick<WardrobeLook, "id" | "title" | "occasion" | "note" | "itemIds"> | null) {
    const patch = plan && pinTripLookPatch(plan, n, saved);
    if (patch && (await tp.savePlan(patch))) toast({ title: saved ? "Saved, kept on re-plan" : "Unpinned" });
  }

  async function undo() {
    const patch = plan && undoTripPlanPatch(plan);
    if (patch && (await tp.savePlan(patch))) toast({ title: "Undone" });
  }

  function openLook(l: TripLook, n: number) {
    if (l.lookId) {
      const saved = savedLook(l.lookId);
      if (!saved) {
        toast({ title: "That saved look was deleted", detail: "Unpin it to let the planner change it.", tone: "warn" });
        return;
      }
      setLookModal({ editing: saved, draft: null, n });
    } else {
      setLookModal({ editing: null, draft: { title: l.title, occasion: l.occasion, note: l.why, itemIds: l.itemIds, source: "SUGGESTED" }, n });
    }
  }

  function confirmDelete() {
    if (!trip) return;
    Alert.alert(`Delete the plan for ${trip.name}?`, "The looks, packing list and earlier changes go; the form keeps what's typed in it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete plan", style: "destructive", onPress: () => void tp.deletePlan().then((ok) => ok && toast({ title: "Plan deleted" })) },
    ]);
  }

  const setActivity = (n: number, patch: { date?: string | null; text?: string }) =>
    form.setActivities((list) => list.map((a, i) => (i === n ? { ...a, ...patch } : a)));

  const dayOptions = [{ value: "", label: "Any day" }, ...dates.map((d) => ({ value: d, label: tripDayLabel(d) }))];
  const sheetSelected =
    daySheet?.kind === "activity" ? (form.activities[daySheet.n]?.date ?? "") : daySheet?.kind === "look" ? (looks[daySheet.n]?.date ?? "") : "";

  // ── Render ──────────────────────────────────────────────────────────────

  const loading = !tripLoaded || data.loading || (!!personId && !tp.loaded);

  return (
    <SafeAreaView style={ws.screen} edges={["top"]}>
      <View style={ws.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={ws.backBtn}>
          <Ionicons name="chevron-back" size={28} color={ACCENT} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={ws.headingSmall} numberOfLines={1}>
            Trip looks
          </Text>
          {trip && (
            <Text style={ws.subheading} numberOfLines={1}>
              {trip.name} · {formatTripRange(trip.startDate, trip.endDate)}
            </Text>
          )}
        </View>
      </View>
      {toastNode}

      {loading ? (
        <View style={ws.center}>
          <ActivityIndicator />
        </View>
      ) : !trip ? (
        <Text style={ws.empty}>Trip not found.</Text>
      ) : !person ? (
        <Text style={ws.empty}>No household members on this trip.</Text>
      ) : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          >
            {onTrip.length > 1 && (
              <View style={ws.chipWrap}>
                {onTrip.map((p) => (
                  <Chip key={p.id} on={p.id === personId} onPress={() => setPersonId(p.id)} label={`${p.emoji ? `${p.emoji} ` : ""}${p.name}`} />
                ))}
              </View>
            )}

            {/* Form */}
            <View style={ws.card}>
              <Text style={ws.body}>
                Plans what {person.name} should pack and wear each day, from the destination&apos;s weather (the forecast within 16 days, otherwise
                past years for those dates), the trip&apos;s reservations and the activities below.
              </Text>
              <Text style={ws.meta}>
                {trip.destination?.city ?? "No destination set"} · {dates.length} day{dates.length === 1 ? "" : "s"}
                {trip.destination?.latitude == null ? " · add a destination to the trip for weather" : ""}
              </Text>

              <Text style={ws.sectionLabel}>Luggage</Text>
              <View style={ws.chipWrap}>
                {TRIP_CAPACITIES.map((c) => (
                  <Chip key={c} on={form.capacity === c} onPress={() => form.setCapacity(c)} label={TRIP_CAPACITY_LABELS[c]} />
                ))}
              </View>
              {form.capacity === "PIECES" && (
                <View style={styles.inline}>
                  <TextInput style={[ws.input, { width: 80 }]} value={form.maxPieces} onChangeText={form.setMaxPieces} keyboardType="number-pad" />
                  <Text style={ws.meta}>pieces</Text>
                </View>
              )}

              <Text style={ws.sectionLabel}>What to pack</Text>
              <View style={ws.chipWrap}>
                <Chip on={form.mode === "SUGGEST"} onPress={() => form.setMode("SUGGEST")} label="Stylist picks" />
                <Chip
                  on={form.mode === "PICKED"}
                  onPress={() => {
                    form.setMode("PICKED");
                    // Picking yourself after a stylist plan: start from what it packed.
                    if (!form.picks.itemIds.length && packIds.length) form.setPicks({ itemIds: packIds, copies: {} });
                  }}
                  label="I'll pick"
                />
              </View>
              <View style={[styles.inline, { justifyContent: "space-between" }]}>
                <Text style={ws.body}>A look for each day</Text>
                <Switch value={form.perDay} onValueChange={form.setPerDay} />
              </View>
              {!form.perDay && <Text style={ws.meta}>Mix-and-match looks instead, plus one per activity.</Text>}
              {form.mode === "PICKED" && (
                <View style={{ gap: 6 }}>
                  <Text style={ws.meta}>Tap what you&apos;d pack. The looks use only these, and you get an opinion on whether they suit the weather, the days and the luggage.</Text>
                  <TripPicker closet={closet} picks={form.picks} onChange={form.setPicks} />
                </View>
              )}

              <Text style={ws.sectionLabel}>Activities</Text>
              {form.activities.map((a, n) => (
                <View key={n} style={styles.activityRow}>
                  <Pressable onPress={() => setDaySheet({ kind: "activity", n })} style={styles.dayBtn}>
                    <Text style={styles.dayBtnText} numberOfLines={1}>
                      {a.date ? tripDayLabel(a.date) : "Any day"}
                    </Text>
                    <Ionicons name="chevron-down" size={12} color="#888" />
                  </Pressable>
                  <TextInput
                    style={[ws.input, { flex: 1, paddingVertical: 8 }]}
                    value={a.text}
                    onChangeText={(v) => setActivity(n, { text: v })}
                    placeholder="Golf, wedding, hike…"
                    placeholderTextColor="#999"
                  />
                  <Pressable onPress={() => form.setActivities((l) => l.filter((_, i) => i !== n))} hitSlop={8}>
                    <Ionicons name="close" size={18} color="#999" />
                  </Pressable>
                </View>
              ))}
              <Pressable onPress={() => form.setActivities((l) => [...l, { date: null, text: "" }])} style={[ws.btn, ws.btnFlat, ws.btnSmall, { alignSelf: "flex-start" }]}>
                <Ionicons name="add" size={14} color={ACCENT} />
                <Text style={[ws.btnFlatText, ws.btnSmallText]}>Add activity</Text>
              </Pressable>
              <Text style={ws.meta}>Dinners, tours and tickets already on the trip are included automatically.</Text>

              <Text style={ws.sectionLabel}>Anything else</Text>
              <TextInput
                style={[ws.input, ws.multiline]}
                value={form.request}
                onChangeText={form.setRequest}
                multiline
                placeholder="Want to wear the new boots; one smart dinner; hotel has laundry…"
                placeholderTextColor="#999"
              />

              <View style={styles.inline}>
                <Pressable onPress={() => void tp.generate()} disabled={working} style={[ws.btn, ws.btnPrimary, working && ws.disabled]}>
                  {working && !tweaking ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="sparkles" size={14} color="#fff" />}
                  <Text style={ws.btnPrimaryText}>
                    {working && !tweaking
                      ? form.mode === "PICKED"
                        ? "Checking…"
                        : "Planning…"
                      : form.mode === "PICKED"
                        ? ready?.mode === "PICKED"
                          ? "Check my picks again"
                          : "Check my picks & build looks"
                        : ready
                          ? "Plan again from scratch"
                          : "Plan trip looks"}
                  </Text>
                </Pressable>
                {plan && !working && (
                  <Pressable onPress={confirmDelete} hitSlop={8}>
                    <Text style={{ color: "#c44", fontWeight: "500" }}>Delete plan</Text>
                  </Pressable>
                )}
              </View>
              {working && <Text style={ws.meta}>Takes a minute or two (longer for long trips). You can leave this screen or the app; the plan is saved when it&apos;s done.</Text>}
            </View>

            {plan?.status === "FAILED" && !working && <Text style={styles.error}>{plan.error ?? "Planning failed. Try again."}</Text>}

            {ready && (
              <View style={working ? { opacity: 0.5 } : undefined} pointerEvents={working ? "none" : "auto"}>
                {!!ready.context && <Text style={[ws.meta, { marginBottom: 8 }]}>Based on: {ready.context}</Text>}

                {weather.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 12 }}>
                    {weather.map((w) => (
                      <View key={w.date} style={styles.weather}>
                        <Text style={styles.weatherDay}>{tripDayLabel(w.date)}</Text>
                        <Text style={styles.weatherTemp}>
                          {w.highF}° / {w.lowF}°
                        </Text>
                        <Text style={ws.meta}>
                          {w.summary}
                          {w.precipChance != null && w.precipChance >= 25 ? ` · ${w.precipChance}%` : ""}
                        </Text>
                        {w.source === "TYPICAL" && <Text style={styles.typical}>Typical</Text>}
                      </View>
                    ))}
                  </ScrollView>
                )}

                {review && (
                  <View style={[ws.card, review.verdict === "GOOD" ? styles.reviewGood : review.verdict === "PROBLEMS" ? styles.reviewBad : styles.reviewGaps]}>
                    <Text style={ws.sectionTitle}>Your picks: {TRIP_REVIEW_LABELS[review.verdict]}</Text>
                    <Text style={ws.body}>{review.summary}</Text>
                    {review.concerns.map((c, i) => (
                      <Text key={i} style={ws.body}>
                        • {c}
                      </Text>
                    ))}
                    {[
                      { list: review.add, label: "Worth adding", act: "Add", has: false },
                      { list: review.leaveHome, label: "Could leave at home", act: "Leave home", has: true },
                    ].map(({ list, label, act, has }) => {
                      const rows = list.map((r) => ({ ...r, item: data.byId.get(r.itemId) })).filter((r) => r.item && packIds.includes(r.itemId) === has);
                      if (!rows.length) return null;
                      return (
                        <View key={label} style={{ gap: 6, marginTop: 4 }}>
                          <Text style={ws.sectionLabel}>{label}</Text>
                          {rows.map((r) => (
                            <View key={r.itemId} style={styles.reviewRow}>
                              <Pressable onPress={() => setItemOpen(r.item!)} style={{ flex: 1 }}>
                                <Text style={[ws.body, { fontWeight: "600" }]}>
                                  {r.item!.name}
                                  <Text style={{ color: "#888", fontWeight: "400" }}> · {r.item!.category}</Text>
                                </Text>
                                {!!r.why && <Text style={ws.meta}>{r.why}</Text>}
                              </Pressable>
                              <Pressable
                                onPress={() => (has ? void editPack((c) => removeTripPlanItem(c, r.itemId), `${r.item!.name} stays home`, r.item!.name) : void addItem(r.item!))}
                                disabled={editBusy}
                                style={[ws.btn, ws.btnFlat, ws.btnSmall]}
                              >
                                <Text style={[ws.btnFlatText, ws.btnSmallText]}>{act}</Text>
                              </Pressable>
                            </View>
                          ))}
                        </View>
                      );
                    })}
                    <Pressable onPress={() => void tp.generate()} disabled={working} style={[ws.btn, ws.btnFlat, ws.btnSmall, { alignSelf: "flex-start", marginTop: 6 }]}>
                      <Text style={[ws.btnFlatText, ws.btnSmallText]}>Check again</Text>
                    </Pressable>
                  </View>
                )}

                {/* Packing list */}
                <View style={ws.card}>
                  <Text style={ws.sectionTitle}>Packing list</Text>
                  <Text style={ws.meta}>
                    {pack.reduce((n, p) => n + copiesOf(p), 0)} pieces · {pack.reduce((n, p) => n + (packed.has(p.id) ? copiesOf(p) : 0), 0)} packed
                    {ready.capacity === "PIECES" && ready.maxPieces
                      ? ` · limit ${ready.maxPieces}`
                      : ready.capacity
                        ? ` · ${TRIP_CAPACITY_LABELS[ready.capacity as TripCapacity]}`
                        : ""}
                  </Text>
                  {pack.length > 0 && <Text style={ws.body}>{categoryCountsLabel(categoryCounts(pack, copiesOf))}</Text>}
                  <View style={styles.inline}>
                    <Pressable onPress={() => setPicker({ kind: "add" })} style={[ws.btn, ws.btnFlat, ws.btnSmall]} disabled={editBusy}>
                      <Ionicons name="add" size={14} color={ACCENT} />
                      <Text style={[ws.btnFlatText, ws.btnSmallText]}>Add piece</Text>
                    </Pressable>
                    {pack.length > 0 && (
                      <Pressable onPress={() => setChecklistOpen(true)} style={[ws.btn, ws.btnFlat, ws.btnSmall]}>
                        <Ionicons name="list" size={14} color={ACCENT} />
                        <Text style={[ws.btnFlatText, ws.btnSmallText]}>Add to checklist</Text>
                      </Pressable>
                    )}
                  </View>
                  {packGroups.map(([cat, list]) => (
                    <View key={cat}>
                      <Text style={[ws.sectionLabel, { marginTop: 6, marginBottom: 6 }]}>{cat}</Text>
                      <View style={styles.packGrid}>
                        {list.map((p) => {
                          const on = packed.has(p.id);
                          return (
                            <View key={p.id} style={styles.packItem}>
                              <Pressable onPress={() => setItemOpen(p)}>
                                <ItemThumb item={p} style={[styles.packImg, on && styles.packImgOn]} />
                              </Pressable>
                              <Pressable onPress={() => void tp.savePlan(togglePackedPatch(plan!, p.id))} style={styles.tickRow} hitSlop={4}>
                                <Ionicons name={on ? "checkbox" : "square-outline"} size={18} color={on ? "#2e7d43" : "#999"} />
                                <Text style={[styles.packName, on && styles.packNameOn]} numberOfLines={2}>
                                  {p.name}
                                  {(p.quantity ?? 1) > 1 && <Text style={{ color: "#888" }}> · pack {copiesOf(p)} of {p.quantity}</Text>}
                                </Text>
                              </Pressable>
                              <View style={styles.packActions}>
                                <Pressable onPress={() => setPicker({ kind: "replace", item: p })} disabled={editBusy} hitSlop={6}>
                                  <Text style={styles.packAction}>Replace</Text>
                                </Pressable>
                                <Pressable onPress={() => removeItem(p)} disabled={editBusy} hitSlop={6}>
                                  <Text style={[styles.packAction, { color: "#999" }]}>Remove</Text>
                                </Pressable>
                              </View>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  ))}
                  {pack.length > 0 && pack.every((p) => packed.has(p.id)) && (
                    <Text style={{ color: "#2e7d43", fontWeight: "500" }}>✓ All packed</Text>
                  )}
                </View>

                {!!ready.tips && (
                  <View style={styles.tips}>
                    <Text style={ws.body}>{ready.tips}</Text>
                  </View>
                )}

                {/* Tweak */}
                <View style={ws.card}>
                  <Text style={ws.sectionTitle}>Tweak the plan</Text>
                  <Text style={ws.meta}>
                    Say what to change; everything else stays as it is. Changes are remembered, so planning again from scratch still follows them.
                    Saved looks stay fixed either way (Unpin to let them change).
                  </Text>
                  <TextInput
                    style={[ws.input, ws.multiline]}
                    value={tp.change}
                    onChangeText={tp.setChange}
                    multiline
                    placeholder="The field jacket is too specific, pack something more low-profile…"
                    placeholderTextColor="#999"
                  />
                  <View style={styles.inline}>
                    <Pressable
                      onPress={() => void tp.generate(tp.change.trim())}
                      disabled={!tp.change.trim() || working}
                      style={[ws.btn, ws.btnFlat, (!tp.change.trim() || working) && ws.disabled]}
                    >
                      {working && tweaking && <ActivityIndicator size="small" />}
                      <Text style={ws.btnFlatText}>{working && tweaking ? "Changing…" : "Apply change"}</Text>
                    </Pressable>
                    {canUndo && (
                      <Pressable onPress={() => void undo()} style={[ws.btn, ws.btnSmall]}>
                        <Ionicons name="arrow-undo" size={14} color={ACCENT} />
                        <Text style={ws.link}>Undo last change</Text>
                      </Pressable>
                    )}
                  </View>
                  {feedback.length > 0 && (
                    <View style={{ gap: 6 }}>
                      <Text style={ws.sectionLabel}>Changes so far</Text>
                      {feedback.map((f, n) => (
                        <View key={n} style={styles.feedbackRow}>
                          <Text style={[ws.body, { flex: 1 }]}>{f}</Text>
                          <Pressable
                            onPress={() =>
                              Alert.alert("Forget this change?", "The next plan won't follow it.", [
                                { text: "Cancel", style: "cancel" },
                                { text: "Forget", style: "destructive", onPress: () => void tp.savePlan(forgetFeedbackPatch(plan!, n)) },
                              ])
                            }
                            hitSlop={8}
                          >
                            <Ionicons name="close" size={16} color="#999" />
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  )}
                </View>

                {/* Looks */}
                {looks.map((l, n) => (
                  <LookCard
                    key={`${ready.generatedAt}-${n}`}
                    title={l.date ? `${tripDayLabel(l.date)} · ${l.title}` : l.title}
                    occasion={l.occasion}
                    note={l.why}
                    itemIds={l.itemIds}
                    previewImageKey={l.lookId ? (savedLook(l.lookId)?.previewImageKey ?? null) : null}
                    byId={data.byId}
                    onOpenItem={setItemOpen}
                    badge={
                      l.lookId ? (
                        <View style={styles.pinned}>
                          <Ionicons name="pin" size={12} color="#2e7d43" />
                          <Text style={styles.pinnedText}>Saved, kept on re-plan</Text>
                        </View>
                      ) : undefined
                    }
                    actions={
                      <>
                        {l.lookId ? (
                          <>
                            <Pressable onPress={() => openLook(l, n)} style={[ws.btn, ws.btnFlat, ws.btnSmall]}>
                              <Text style={[ws.btnFlatText, ws.btnSmallText]}>Open</Text>
                            </Pressable>
                            <Pressable onPress={() => void pinLook(n, null)} style={[ws.btn, ws.btnSmall]}>
                              <Text style={[ws.link, ws.btnSmallText]}>Unpin</Text>
                            </Pressable>
                          </>
                        ) : (
                          <Pressable onPress={() => openLook(l, n)} style={[ws.btn, ws.btnFlat, ws.btnSmall]}>
                            <Text style={[ws.btnFlatText, ws.btnSmallText]}>Save as look</Text>
                          </Pressable>
                        )}
                        <Pressable onPress={() => setDaySheet({ kind: "look", n })} style={[styles.dayBtn, { marginLeft: "auto" }]}>
                          <Text style={styles.dayBtnText}>Day: {l.date ? tripDayLabel(l.date) : "Any"}</Text>
                          <Ionicons name="chevron-down" size={12} color="#888" />
                        </Pressable>
                      </>
                    }
                  />
                ))}
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      <OptionSheet
        visible={!!daySheet}
        title={daySheet?.kind === "look" ? "Move this look to" : "Day"}
        options={dayOptions}
        selected={sheetSelected}
        onClose={() => setDaySheet(null)}
        onPick={(v) => {
          if (!daySheet) return;
          if (daySheet.kind === "activity") setActivity(daySheet.n, { date: v || null });
          else void moveLook(daySheet.n, v || null);
        }}
      />

      {person && (
        <>
          <PackPieceModal
            mode={picker}
            items={closet}
            packIds={packIds}
            busy={editBusy}
            onClose={() => setPicker(null)}
            onPick={(to) => void (picker?.kind === "replace" ? replaceItem(picker.item, to) : addItem(to))}
          />
          {trip && (
            <PackChecklistModal
              visible={checklistOpen}
              tripId={trip.id}
              tripName={trip.name}
              personId={person.id}
              personName={person.name}
              groups={packGroups}
              copies={copiesOf}
              onClose={() => setChecklistOpen(false)}
              onDone={(title, detail) => toast({ title, detail })}
            />
          )}
          <ItemFormModal
            visible={!!itemOpen}
            editing={itemOpen}
            ownerPersonId={person.id}
            categories={categories}
            onClose={() => setItemOpen(null)}
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
            scope={{ label: "Packed for the trip", itemIds: packIds }}
            onClose={() => setLookModal(null)}
            onSaved={(saved) => {
              const n = lookModal?.n;
              const wasPinned = !!lookModal?.editing;
              void data.reload();
              if (n == null) return;
              // Saving pins (or refreshes) the trip look; deleting a pinned one unpins it.
              if (saved) void pinLook(n, saved);
              else if (wasPinned) void pinLook(n, null);
            }}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, paddingBottom: 60 },
  reviewGood: { backgroundColor: "#eef8f0", borderColor: "#bfe3c8" },
  reviewGaps: { backgroundColor: "#fff8e8", borderColor: "#f0dca8" },
  reviewBad: { backgroundColor: "#fdeeee", borderColor: "#f0c4c4" },
  reviewRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  inline: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 },
  activityRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dayBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
    maxWidth: 140,
  },
  dayBtnText: { fontSize: 13, color: "#333" },
  error: { color: "#c44", marginBottom: 12 },
  weather: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 112,
  },
  weatherDay: { fontSize: 12, fontWeight: "600", color: "#222" },
  weatherTemp: { fontSize: 13, color: "#444" },
  typical: { fontSize: 9, color: "#aaa", textTransform: "uppercase", letterSpacing: 0.5 },
  packGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  packItem: { width: "30%" },
  packImg: { aspectRatio: 3 / 4, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ddd" },
  packImgOn: { borderColor: "#2e7d43", borderWidth: 1.5, opacity: 0.6 },
  tickRow: { flexDirection: "row", alignItems: "flex-start", gap: 4, marginTop: 4 },
  packName: { fontSize: 12, color: "#333", lineHeight: 15, flexShrink: 1 },
  packNameOn: { textDecorationLine: "line-through", color: "#999" },
  packActions: { flexDirection: "row", gap: 12, marginTop: 4 },
  packAction: { fontSize: 12, color: ACCENT, fontWeight: "500" },
  tips: { backgroundColor: "#efeae7", borderRadius: 10, padding: 12, marginBottom: 12 },
  feedbackRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  pinned: { flexDirection: "row", alignItems: "center", gap: 4 },
  pinnedText: { fontSize: 12, color: "#2e7d43", fontWeight: "500" },
});
