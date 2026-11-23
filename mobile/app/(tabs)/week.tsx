// Week planner — the Sunday review on the phone. Same data and writes as
// the web page (/week): get_week_plan, set_day_status, assign_event_people,
// set_pet_day, mark_week_reviewed, set_week_notes (lib/ops/week.ts). Tap a person's day to
// set office/home/PTO, tap an event to say who it's for, tap the pet's day
// to mark daycare. The week's notes are markdown, rendered in place; Edit
// opens a text box with its own Save (set_week_notes), separate from the
// review mark, which can be undone.

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp, type OpCallResult } from "../../lib/ops";
import { usePerson } from "../../lib/use-person";
import { usePeople } from "../../lib/use-people";
import { EventFormModal } from "../../components/EventFormModal";
import { TaskFormModal } from "../../components/TaskFormModal";
import { Markdown } from "../../components/Markdown";
import type { OpName } from "../../../lib/ops/registry";

type Plan = Extract<OpCallResult<"get_week_plan">, { result: unknown }>["result"];
type WeekEvent = Plan["events"][number];

// Kept here rather than imported from lib/week-plan.ts, which pulls in rrule.
const STATUS_LABELS: Record<string, string> = {
  WORKING_OFFICE: "Office",
  WORKING_HOME: "Home",
  PTO: "PTO",
  TRAVEL: "Travel",
  VACATION: "Vacation",
  CHOICE_DAY: "Choice day",
  WEEKEND_HOLIDAY: "Holiday",
};
const STATUS_COLORS: Record<string, string> = {
  WORKING_OFFICE: "#2a5a45",
  WORKING_HOME: "#3b6ea5",
  PTO: "#b7791f",
  TRAVEL: "#7b4fa0",
  VACATION: "#c05621",
  CHOICE_DAY: "#5a6b7b",
  WEEKEND_HOLIDAY: "#8a8a8a",
};
const PET_LABELS: Record<string, string> = { DAYCARE: "Daycare", BOARDING: "Boarding", SITTER: "Sitter", WITH_US: "With us" };

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
function fmtTime(hhmm: string | null): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

export default function WeekPlanner() {
  const personState = usePerson();
  const me = personState.status === "found" ? personState.person.name : undefined;
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { people } = usePeople();
  // Notes being edited (null = showing the rendered notes).
  const [draft, setDraft] = useState<string | null>(null);
  const [savingNotes, setSavingNotes] = useState(false);
  // Day a new event starts on (null = closed), and the new-task form.
  const [eventDate, setEventDate] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);

  // Bumped by every save: a reload that started before a later save would
  // bring back the old value over the one just picked, so it's dropped.
  const saves = useRef(0);
  const load = useCallback(async () => {
    const at = saves.current;
    const r = await callOp("get_week_plan", weekStart ? { weekStart } : {});
    if ("error" in r) setError(r.error);
    else if (at === saves.current) {
      setError(null);
      setPlan(r.result);
    }
  }, [weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  // A half-typed draft belongs to its week: drop it when the week changes
  // (reloads of the same week, e.g. after setting a status, keep it).
  useEffect(() => {
    setDraft(null);
  }, [plan?.weekStart]);

  async function saveNotes() {
    if (!plan || draft === null) return;
    if (draft === (plan.review?.notes ?? "")) return setDraft(null);
    setSavingNotes(true);
    const r = await callOp("set_week_notes", { weekStart: plan.weekStart, notes: draft });
    setSavingNotes(false);
    if ("error" in r) return Alert.alert("Couldn't save notes", r.error);
    setDraft(null);
    await load();
  }

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function write<N extends OpName>(name: N, input: Parameters<typeof callOp<N>>[1]) {
    const mine = ++saves.current;
    const r = await callOp(name, input);
    if ("error" in r) {
      Alert.alert("Couldn't save", r.error);
      return load(); // put back what's really saved
    }
    // Only the last of several quick saves reloads; the screen already shows them.
    if (mine === saves.current) await load();
  }

  // Show a status as soon as it's picked; the reload confirms.
  function showPerson(personId: string, date: string, status: string | null) {
    setPlan((p) => p && { ...p, people: p.people.map((x) => (x.id !== personId ? x : { ...x, days: x.days.map((d) => (d.date === date ? { ...d, status: status as any, source: status ? ("set" as const) : null } : d)) })) }); // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  function showPet(petId: string, date: string, status: string | null) {
    setPlan((p) => p && { ...p, pets: p.pets.map((x) => (x.id !== petId ? x : { ...x, days: x.days.map((d) => (d.date === date ? { ...d, status: status as any } : d)) })) }); // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const setPersonDay = (personId: string, date: string, status: string | null) => {
    showPerson(personId, date, status);
    void write("set_day_status", { personId, dates: [date], status: status as any }); // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const setPetDay = (petId: string, date: string, status: string | null) => {
    showPet(petId, date, status);
    void write("set_pet_day", { petId, dates: [date], status: status as any }); // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  function pickStatus(personId: string, name: string, date: string) {
    Alert.alert(`${name} · ${fmt(date, { weekday: "long" })}`, undefined, [
      ...Object.entries(STATUS_LABELS).map(([k, label]) => ({ text: label, onPress: () => setPersonDay(personId, date, k) })),
      { text: "Clear", style: "destructive" as const, onPress: () => setPersonDay(personId, date, null) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  function pickPet(petId: string, name: string, date: string) {
    Alert.alert(`${name} · ${fmt(date, { weekday: "long" })}`, undefined, [
      ...Object.entries(PET_LABELS).map(([k, label]) => ({ text: label, onPress: () => setPetDay(petId, date, k) })),
      { text: "Clear", style: "destructive" as const, onPress: () => setPetDay(petId, date, null) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  function pickPeople(e: WeekEvent) {
    if (!plan) return;
    Alert.alert(e.title, "Who is it for?", [
      ...plan.people.map((p) => ({ text: p.name, onPress: () => write("assign_event_people", { eventId: e.id, personIds: [p.id] }) })),
      { text: "Both", onPress: () => write("assign_event_people", { eventId: e.id, personIds: plan.people.map((p) => p.id) }) },
      { text: "Household", onPress: () => write("assign_event_people", { eventId: e.id, personIds: [] }) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  if (!plan) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <Header title="Week planner" />
        <View style={styles.center}>{error ? <Text style={styles.empty}>{error}</Text> : <ActivityIndicator />}</View>
      </SafeAreaView>
    );
  }

  const flagged = new Set(plan.attention.flatMap((a) => a.eventKeys ?? []));
  const reviewed = !!plan.review?.reviewedAt;
  const savedNotes = plan.review?.notes ?? "";

  const eventRow = (e: WeekEvent) => (
    <Pressable key={e.key} onPress={() => pickPeople(e)} style={({ pressed }) => [styles.event, flagged.has(e.key) && styles.eventFlagged, pressed && styles.pressed]}>
      <Text style={styles.eventTime}>{e.allDay ? "All day" : fmtTime(e.start)}</Text>
      <Text style={styles.eventTitle} numberOfLines={2}>
        {e.title}
      </Text>
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Header title="Week planner" />
      <View style={styles.weekNav}>
        <Pressable onPress={() => setWeekStart(addDays(plan.weekStart, -7))} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color="#735f55" />
        </Pressable>
        <Text style={styles.weekLabel}>
          {fmt(plan.weekStart, { month: "short", day: "numeric" })} – {fmt(plan.weekEnd, { month: "short", day: "numeric" })}
        </Text>
        <Pressable onPress={() => setWeekStart(addDays(plan.weekStart, 7))} hitSlop={10}>
          <Ionicons name="chevron-forward" size={22} color="#735f55" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {/* The review itself first: notes for the week (markdown, saved on their own) and "reviewed". */}
        <View style={styles.card}>
          <View style={styles.personRow}>
            <Text style={styles.notesLabel}>Notes for the week</Text>
            {draft === null && (
              <Pressable onPress={() => setDraft(savedNotes)} hitSlop={8} style={({ pressed }) => [styles.addEvent, pressed && styles.pressed]}>
                <Ionicons name="pencil" size={13} color="#735f55" />
                <Text style={styles.quickText}>{savedNotes ? "Edit" : "Add notes"}</Text>
              </Pressable>
            )}
          </View>
          {draft !== null ? (
            <>
              <TextInput
                style={styles.notesInput}
                placeholder="Cris drives Thursday; book Dolce for Wednesday…"
                placeholderTextColor="#aaa"
                value={draft}
                onChangeText={setDraft}
                editable={!savingNotes}
                autoFocus
                multiline
                textAlignVertical="top"
              />
              <View style={styles.personRow}>
                <Text style={styles.notesHint}>Markdown: **bold**, - list, - [ ] to-do</Text>
                <View style={styles.notesActions}>
                  <Pressable onPress={() => setDraft(null)} disabled={savingNotes} hitSlop={6} style={({ pressed }) => [styles.notesCancel, pressed && styles.pressed]}>
                    <Text style={styles.quickText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={saveNotes}
                    disabled={savingNotes || draft === savedNotes}
                    style={({ pressed }) => [styles.notesSave, (savingNotes || draft === savedNotes) && styles.disabled, pressed && styles.pressed]}
                  >
                    {savingNotes ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.notesSaveText}>Save notes</Text>}
                  </Pressable>
                </View>
              </View>
            </>
          ) : savedNotes ? (
            <Pressable onPress={() => setDraft(savedNotes)} accessibilityHint="Edit the notes">
              <Markdown content={savedNotes} />
            </Pressable>
          ) : (
            <Pressable onPress={() => setDraft("")}>
              <Text style={styles.notesPlaceholder}>Cris drives Thursday; book Dolce for Wednesday…</Text>
            </Pressable>
          )}
          {reviewed ? (
            <View style={styles.personRow}>
              <View style={styles.reviewedLine}>
                <Ionicons name="checkmark-circle" size={18} color="#2a5a45" />
                <Text style={styles.reviewedText}>
                  Reviewed{plan.review?.reviewedBy ? ` by ${plan.review.reviewedBy}` : ""}{" "}
                  {new Date(plan.review!.reviewedAt!).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                </Text>
              </View>
              <Pressable onPress={() => write("mark_week_reviewed", { weekStart: plan.weekStart, reviewed: false })} hitSlop={8} style={({ pressed }) => pressed && styles.pressed}>
                <Text style={styles.quickText}>Undo</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => write("mark_week_reviewed", { weekStart: plan.weekStart, ...(me ? { personName: me } : {}) })}
              style={({ pressed }) => [styles.reviewBtn, pressed && styles.pressed]}
            >
              <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
              <Text style={styles.reviewText}>Mark week reviewed</Text>
            </Pressable>
          )}
          <View style={styles.quickRow}>
            <Pressable onPress={() => setEventDate(plan.weekStart)} style={({ pressed }) => [styles.quickBtn, pressed && styles.pressed]}>
              <Ionicons name="add" size={16} color="#735f55" />
              <Text style={styles.quickText}>Event</Text>
            </Pressable>
            <Pressable onPress={() => setTaskOpen(true)} style={({ pressed }) => [styles.quickBtn, pressed && styles.pressed]}>
              <Ionicons name="add" size={16} color="#735f55" />
              <Text style={styles.quickText}>Task</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{plan.attention.length ? `Needs attention (${plan.attention.length})` : "Nothing needs attention ✓"}</Text>
          {plan.attention.map((a, i) => {
            const e = a.kind === "unassigned" ? plan.events.find((x) => x.key === a.eventKeys?.[0]) : undefined;
            return (
              <Pressable key={i} disabled={!e} onPress={() => e && pickPeople(e)} style={styles.attention}>
                <Ionicons name={a.kind === "unassigned" ? "person-add-outline" : "business-outline"} size={16} color="#b7791f" />
                <Text style={styles.attentionText}>{a.detail}</Text>
              </Pressable>
            );
          })}
        </View>

        {plan.dates.map((date) => {
          const household = plan.events.filter((e) => e.date === date && e.personIds.length === 0 && e.petIds.length === 0);
          return (
            <View key={date} style={styles.card}>
              <View style={styles.personRow}>
                <Text style={styles.cardTitle}>
                  {fmt(date, { weekday: "long" })} <Text style={styles.muted}>{fmt(date, { month: "short", day: "numeric" })}</Text>
                </Text>
                <Pressable onPress={() => setEventDate(date)} hitSlop={8} style={styles.addEvent}>
                  <Ionicons name="add" size={16} color="#735f55" />
                  <Text style={styles.quickText}>Event</Text>
                </Pressable>
              </View>
              {plan.people.map((p) => {
                const day = p.days.find((d) => d.date === date)!;
                const mine = plan.events.filter((e) => e.date === date && e.personIds.includes(p.id));
                const color = day.status ? STATUS_COLORS[day.status] : "#bbb";
                return (
                  <View key={p.id} style={styles.personBlock}>
                    <Text style={styles.personName}>{p.name}</Text>
                    {/* Appointments first: they decide office vs home. */}
                    {mine.map(eventRow)}
                    <View style={styles.personRow}>
                      <Text style={[styles.hint, day.status === "WORKING_OFFICE" && styles.hintWarn]} numberOfLines={2}>
                        {hintFor(mine, date, day.status)}
                      </Text>
                      <Pressable onPress={() => pickStatus(p.id, p.name, date)} style={[styles.status, { borderColor: color }]}>
                        <Text style={[styles.statusText, { color }]}>
                          {day.status ? `${STATUS_LABELS[day.status]}${day.source === "trip" ? ` (${day.tripName})` : ""}` : "Set…"}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
              {plan.pets.map((pet) => {
                const day = pet.days.find((d) => d.date === date)!;
                const its = plan.events.filter((e) => e.date === date && e.petIds.includes(pet.id));
                return (
                  <View key={pet.id} style={styles.personBlock}>
                    <View style={styles.personRow}>
                      <Text style={styles.personName}>🐾 {pet.name}</Text>
                      <Pressable onPress={() => pickPet(pet.id, pet.name, date)} style={[styles.status, { borderColor: day.status ? "#735f55" : "#bbb" }]}>
                        <Text style={[styles.statusText, { color: day.status ? "#735f55" : "#999" }]}>{day.status ? PET_LABELS[day.status] : "—"}</Text>
                      </Pressable>
                    </View>
                    {its.map(eventRow)}
                  </View>
                );
              })}
              {household.length > 0 && (
                <View style={styles.personBlock}>
                  <Text style={styles.householdLabel}>HOUSEHOLD</Text>
                  {household.map(eventRow)}
                </View>
              )}
            </View>
          );
        })}

        <Sections plan={plan} />
      </ScrollView>

      <EventFormModal
        visible={eventDate !== null}
        event={null}
        defaultDate={eventDate ?? undefined}
        people={people}
        onClose={() => setEventDate(null)}
        onSaved={() => {
          setEventDate(null);
          void load();
        }}
      />
      <TaskFormModal
        visible={taskOpen}
        task={null}
        people={people}
        onClose={() => setTaskOpen(false)}
        onSaved={() => {
          setTaskOpen(false);
          void load();
        }}
      />
    </SafeAreaView>
  );
}

/**
 * Timed appointments during working hours (7am–6pm) on a weekday are the
 * reason a day might be a home day: hint it next to the status.
 */
function hintFor(events: WeekEvent[], date: string, status: string | null): string {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() % 6 !== 0;
  if (!weekday || (status && status !== "WORKING_OFFICE")) return "";
  const appts = events.filter((e) => !e.allDay && (e.start ?? "") >= "07:00" && (e.start ?? "") < "18:00");
  if (!appts.length) return "";
  const what = appts.map((e) => `${e.title} ${fmtTime(e.start)}`).join(", ");
  return status === "WORKING_OFFICE" ? `${what}: still the office?` : `${what}: home?`;
}

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const dayShort = (iso: string) => fmt(iso, { weekday: "short" });

/** Money, to-do, travel, care, birthdays and errands for the week (get_week_plan sections). */
function Sections({ plan }: { plan: Plan }) {
  const s = plan.sections;
  const nameOf = (id: string) => plan.people.find((p) => p.id === id)?.name ?? "?";
  const cards: Array<{ title: string; rows: Array<{ left: string; right?: string; danger?: boolean }> }> = [
    {
      title: "Money",
      rows: [
        ...s.finance.paydays.map((p) => ({ left: `💵 ${nameOf(p.personId)} paid`, right: `${dayShort(p.date)} ~${money(p.usualNet)}` })),
        ...s.finance.scheduled.map((x) => ({ left: x.description, right: `${dayShort(x.date)} ${money(x.amount)}` })),
      ],
    },
    {
      title: "To do",
      rows: [
        ...s.todo.tasks.map((t) => ({ left: t.title, right: t.overdue ? "overdue" : dayShort(t.date), danger: t.overdue })),
        ...s.todo.reminders.map((r) => ({
          left: `⏰ ${r.name}`,
          right: r.count > 1 ? `${r.count}×` : new Date(r.times[0]).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }),
        })),
      ],
    },
    {
      title: "Travel",
      // Each trip with its legs and reservations under it, like the web card.
      // Times are the wall clock at that place, as entered (lib/week-sections.ts).
      rows: s.travel.trips.flatMap((t) => [
        { left: `✈️ ${t.name}`, right: `${dayShort(t.startDate)}–${dayShort(t.endDate)}${t.checklist ? ` · ${t.checklist.done}/${t.checklist.total}` : ""}` },
        ...s.travel.legs.filter((l) => l.tripName === t.name).map((l) => ({ left: `   ${l.label}`, right: `${dayShort(l.date)} ${fmtTime(l.time)}` })),
        ...s.travel.reservations.filter((r) => r.tripName === t.name).map((r) => ({ left: `   ${r.name}`, right: `${dayShort(r.date)} ${fmtTime(r.time)}` })),
      ]),
    },
    {
      title: "Care",
      rows: [
        ...s.care.visits.map((v) => ({ left: `${nameOf(v.personId)} · ${v.title}`, right: `${dayShort(v.date)} ${fmtTime(v.time)}` })),
        ...s.care.pregnancy.flatMap((p) =>
          p.items.map((i) => ({ left: i.title, right: i.urgency === "OVERDUE" ? "overdue" : i.urgency.toLowerCase().replace("_", " "), danger: i.urgency === "OVERDUE" })),
        ),
        ...s.care.pets.map((p) => ({ left: `🐾 ${p.title}`, right: p.date ? (p.overdue ? p.date : dayShort(p.date)) : undefined, danger: p.overdue })),
      ],
    },
    { title: "Birthdays", rows: s.occasions.map((o) => ({ left: `🎂 ${o.name}${o.age ? ` turns ${o.age}` : ""}`, right: dayShort(o.date) })) },
    {
      title: "Errands",
      rows: [
        ...s.errands.shopping.map((l) => ({ left: `${l.emoji ?? "🛒"} ${l.name}: ${l.items.join(", ")}`, right: String(l.open) })),
        ...s.errands.checklists.map((c) => ({ left: `☑️ ${c.name}${c.forName ? ` · ${c.forName}` : ""}`, right: `${c.done}/${c.total}` })),
      ],
    },
  ];
  return (
    <>
      {cards
        .filter((c) => c.rows.length > 0)
        .map((c) => (
          <View key={c.title} style={styles.card}>
            <Text style={styles.cardTitle}>{c.title}</Text>
            {c.rows.map((r, i) => (
              <View key={i} style={styles.sectionRow}>
                <Text style={[styles.sectionLeft, r.danger && styles.danger]} numberOfLines={2}>
                  {r.left}
                </Text>
                {r.right ? <Text style={[styles.sectionRight, r.danger && styles.danger]}>{r.right}</Text> : null}
              </View>
            ))}
          </View>
        ))}
    </>
  );
}

function Header({ title }: { title: string }) {
  return (
    <View style={styles.header}>
      <Text style={styles.heading}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4, gap: 4 },
  backBtn: { padding: 4 },
  heading: { fontSize: 28, fontWeight: "600" },
  weekNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 8 },
  weekLabel: { fontSize: 16, fontWeight: "600", color: "#333" },
  body: { paddingHorizontal: 16, paddingBottom: 40, gap: 12 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 14, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: "600" },
  muted: { color: "#888", fontWeight: "400" },
  attention: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  attentionText: { flex: 1, fontSize: 13, color: "#444", lineHeight: 18 },
  personBlock: { gap: 4 },
  personRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  personName: { fontSize: 14, fontWeight: "500", color: "#333" },
  status: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, minWidth: 80, alignItems: "center" },
  statusText: { fontSize: 13, fontWeight: "600" },
  event: { flexDirection: "row", gap: 8, backgroundColor: "#f3f1ef", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginLeft: 8 },
  eventFlagged: { borderWidth: 1, borderColor: "#e0a030" },
  eventTime: { fontSize: 12, color: "#888", width: 52 },
  eventTitle: { flex: 1, fontSize: 13, color: "#333" },
  householdLabel: { fontSize: 11, color: "#999", letterSpacing: 0.5 },
  pressed: { opacity: 0.6 },
  reviewBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#735f55", borderRadius: 12, paddingVertical: 14 },
  reviewText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  reviewedLine: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  reviewedText: { flex: 1, fontSize: 13, color: "#555" },
  notesLabel: { fontSize: 12, color: "#888" },
  notesPlaceholder: { fontSize: 14, color: "#aaa", paddingVertical: 2 },
  notesInput: { fontSize: 14, color: "#333", minHeight: 120, maxHeight: 320, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ddd", borderRadius: 8, padding: 8 },
  notesHint: { flex: 1, fontSize: 11, color: "#999" },
  notesActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  notesCancel: { paddingVertical: 6 },
  notesSave: { backgroundColor: "#735f55", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, minWidth: 96, alignItems: "center" },
  notesSaveText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  quickRow: { flexDirection: "row", gap: 8 },
  quickBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, borderWidth: 1, borderColor: "#735f55", borderRadius: 10, paddingVertical: 8 },
  quickText: { color: "#735f55", fontSize: 13, fontWeight: "600" },
  addEvent: { flexDirection: "row", alignItems: "center", gap: 2 },
  hint: { flex: 1, fontSize: 12, color: "#888" },
  hintWarn: { color: "#b7791f" },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  sectionLeft: { flex: 1, fontSize: 13, color: "#333" },
  sectionRight: { fontSize: 13, color: "#888" },
  danger: { color: "#c0392b" },
});
