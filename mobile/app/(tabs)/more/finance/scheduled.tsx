// Scheduled — bills and contributions (homeFinanceRecurring) through
// list_finance_schedules: due in the next 30 days, later, and stopped ones.
// Tap one to edit it or mark it paid by hand (save_finance_schedule
// markPaid rolls the due date one step); + adds one (ScheduleFormModal).

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../../lib/ops";
import { ScheduleFormModal, type FinanceSchedule } from "../../../../components/finance/ScheduleFormModal";
import { Card, DANGER, FinanceHeader, HeaderButton, Money, WARN, fs, useFinanceAccounts, type OpResultOf } from "../../../../components/finance/ui";
import { addDays, CADENCE_LABELS, fmtCurrency, fmtDate, todayIso, type Cadence } from "../../../../../lib/finance/dates";
import { isScheduleLive, nextDueAfterPaid } from "../../../../../lib/finance/recurring";

type Result = OpResultOf<"list_finance_schedules">;

export default function FinanceScheduled() {
  const accounts = useFinanceAccounts();
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState<{ schedule: FinanceSchedule | null } | null>(null);
  const today = todayIso();

  const load = useCallback(async () => {
    const r = await callOp("list_finance_schedules", { includeInactive: true });
    if ("error" in r) return setError(r.error);
    setError(null);
    setData(r.result);
  }, []);

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

  const groups = useMemo(() => {
    const rows = data?.schedules ?? [];
    const horizon = addDays(today, 30);
    // Same split as the web page: a past-due active one stays "live" until paid.
    const live = rows.filter((s) => isScheduleLive(s as any, today) || (s.active && s.nextDate && s.nextDate < today));
    const liveIds = new Set(live.map((s) => s.id));
    return {
      upcoming: live.filter((s) => s.nextDate && s.nextDate <= horizon),
      later: live.filter((s) => !s.nextDate || s.nextDate > horizon),
      inactive: rows.filter((s) => !liveIds.has(s.id)),
    };
  }, [data, today]);

  function act(s: FinanceSchedule) {
    const next = s.active ? nextDueAfterPaid(s) : null;
    Alert.alert(s.description, `${fmtCurrency(s.amount, { sign: true })} · ${CADENCE_LABELS[(s.cadence ?? "MONTHLY") as Cadence] ?? s.cadence}`, [
      { text: "Edit", onPress: () => setForm({ schedule: s }) },
      ...(s.active
        ? [
            {
              text: next ? `Mark paid (next ${fmtDate(next)})` : "Mark paid",
              onPress: async () => {
                const r = await callOp("save_finance_schedule", { recurringId: s.id, markPaid: true });
                if ("error" in r) Alert.alert("Couldn't mark paid", r.error);
                void load();
              },
            },
          ]
        : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  const cashAccounts = accounts.filter((a) => a.active && !a.invested);

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Scheduled" right={<HeaderButton icon="add" onPress={() => setForm({ schedule: null })} />} />
      {!data ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <Text style={[fs.muted, { paddingHorizontal: 4 }]}>
            ≈ {fmtCurrency(data.monthlyOut, { cents: false })}/month out
            {data.monthlyIn > 0 ? ` · ${fmtCurrency(data.monthlyIn, { cents: false })}/month in` : ""}
          </Text>
          {data.schedules.length === 0 && <Text style={fs.empty}>Nothing scheduled yet. Tap + to add the mortgage, a utility or a contribution.</Text>}
          {groups.upcoming.length > 0 && <Group title="Next 30 days" rows={groups.upcoming} today={today} onPress={act} />}
          {groups.later.length > 0 && <Group title="Later" rows={groups.later} today={today} onPress={act} />}
          {groups.inactive.length > 0 && <Group title="Stopped" rows={groups.inactive} today={today} onPress={act} muted />}
        </ScrollView>
      )}
      <ScheduleFormModal
        visible={!!form}
        schedule={form?.schedule ?? null}
        accounts={cashAccounts}
        onClose={() => setForm(null)}
        onSaved={() => {
          setForm(null);
          void load();
        }}
      />
    </SafeAreaView>
  );
}

function Group({ title, rows, today, onPress, muted }: { title: string; rows: FinanceSchedule[]; today: string; onPress: (s: FinanceSchedule) => void; muted?: boolean }) {
  return (
    <Card title={title}>
      {rows.map((s, i) => {
        const pastDue = !!s.nextDate && s.nextDate < today && s.active;
        const meta = [
          CADENCE_LABELS[(s.cadence ?? "MONTHLY") as Cadence] ?? s.cadence,
          s.category,
          s.person,
          s.account,
          s.autopay ? "autopay" : "pay by hand",
        ].filter(Boolean);
        return (
          <Pressable
            key={s.id}
            onPress={() => onPress(s)}
            style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: i ? 10 : 0 }, i > 0 && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }, muted && { opacity: 0.55 }, pressed && fs.pressed]}
          >
            <View style={{ width: 54 }}>
              <Text style={[fs.text, { fontWeight: "600" }, pastDue && { color: DANGER }]}>{s.nextDate ? fmtDate(s.nextDate) : "—"}</Text>
              {pastDue && <Text style={[fs.muted, { color: DANGER }]}>past due</Text>}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={fs.text} numberOfLines={1}>
                {s.description}
              </Text>
              <Text style={[fs.muted, !s.autopay && s.active && { color: WARN }]} numberOfLines={1}>
                {meta.join(" · ")}
              </Text>
            </View>
            <Money value={s.amount} sign />
          </Pressable>
        );
      })}
    </Card>
  );
}
