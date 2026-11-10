// Week planner — the Sunday review on the phone. Same data and writes as
// the web page (/week): get_week_plan, set_day_status, assign_event_people,
// set_pet_day, mark_week_reviewed (lib/ops/week.ts). Tap a person's day to
// set office/home/PTO, tap an event to say who it's for, tap the pet's day
// to mark daycare.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp, type OpCallResult } from "../../../lib/ops";
import { usePerson } from "../../../lib/use-person";
import { usePeople } from "../../../lib/use-people";
import { EventFormModal } from "../../../components/EventFormModal";
import { TaskFormModal } from "../../../components/TaskFormModal";
import type { OpName } from "../../../../lib/ops/registry";

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
  const [notes, setNotes] = useState("");
  // Day a new event starts on (null = closed), and the new-task form.
  const [eventDate, setEventDate] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await callOp("get_week_plan", weekStart ? { weekStart } : {});
    if ("error" in r) setError(r.error);
    else {
      setError(null);
      setPlan(r.result);
      setNotes(r.result.review?.notes ?? "");
    }
  }, [weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function write<N extends OpName>(name: N, input: Parameters<typeof callOp<N>>[1]) {
    const r = await callOp(name, input);
    if ("error" in r) Alert.alert("Couldn't save", r.error);
    await load();
  }

  function pickStatus(personId: string, name: string, date: string) {
    Alert.alert(`${name} · ${fmt(date, { weekday: "long" })}`, undefined, [
      ...Object.entries(STATUS_LABELS).map(([k, label]) => ({ text: label, onPress: () => write("set_day_status", { personId, dates: [date], status: k as any }) })),
      { text: "Clear", style: "destructive" as const, onPress: () => write("set_day_status", { personId, dates: [date], status: null }) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  function pickPet(petId: string, name: string, date: string) {
    Alert.alert(`${name} · ${fmt(date, { weekday: "long" })}`, undefined, [
      ...Object.entries(PET_LABELS).map(([k, label]) => ({ text: label, onPress: () => write("set_pet_day", { petId, dates: [date], status: k as any }) })),
      { text: "Clear", style: "destructive" as const, onPress: () => write("set_pet_day", { petId, dates: [date], status: null }) },
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

      <ScrollView contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {/* The review itself first: notes for the week and "reviewed". */}
        <View style={styles.card}>
          <TextInput
            style={styles.notesInput}
            placeholder="Notes for the week (Cris drives Thursday…)"
            placeholderTextColor="#aaa"
            value={notes}
            onChangeText={setNotes}
            onEndEditing={() => {
              if (notes !== (plan.review?.notes ?? "")) void write("mark_week_reviewed", { weekStart: plan.weekStart, reviewed, notes, ...(me ? { personName: me } : {}) });
            }}
            multiline
          />
          <Pressable
            onPress={() => write("mark_week_reviewed", { weekStart: plan.weekStart, reviewed: !reviewed, notes, ...(me ? { personName: me } : {}) })}
            style={({ pressed }) => [styles.reviewBtn, reviewed && styles.reviewBtnDone, pressed && styles.pressed]}
          >
            <Ionicons name={reviewed ? "checkmark-circle" : "checkmark-circle-outline"} size={20} color={reviewed ? "#735f55" : "#fff"} />
            <Text style={[styles.reviewText, reviewed && styles.reviewTextDone]}>
              {reviewed ? `Reviewed${plan.review?.reviewedBy ? ` by ${plan.review.reviewedBy}` : ""} · tap to undo` : "Mark week reviewed"}
            </Text>
          </Pressable>
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
                <Ionicons name={a.kind === "overlap" ? "warning-outline" : a.kind === "unassigned" ? "person-add-outline" : "business-outline"} size={16} color={a.kind === "overlap" ? "#c0392b" : "#b7791f"} />
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
      rows: [
        ...s.travel.trips.map((t) => ({ left: `✈️ ${t.name}`, right: `${dayShort(t.startDate)}–${dayShort(t.endDate)}${t.checklist ? ` · ${t.checklist.done}/${t.checklist.total}` : ""}` })),
        ...s.travel.legs.map((l) => ({ left: `   ${l.label}`, right: `${dayShort(l.date)} ${fmtTime(l.time)}` })),
      ],
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
      <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={10}>
        <Ionicons name="chevron-back" size={26} color="#735f55" />
      </Pressable>
      <Text style={styles.heading}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, gap: 4 },
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
  reviewBtnDone: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#735f55" },
  reviewText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  reviewTextDone: { color: "#735f55" },
  notes: { color: "#666", fontSize: 13, paddingHorizontal: 4 },
  notesInput: { fontSize: 14, color: "#333", minHeight: 40, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ddd", borderRadius: 8, padding: 8 },
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
