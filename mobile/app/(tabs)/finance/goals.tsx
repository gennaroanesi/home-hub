// Goals — savings goals with progress and milestones (list_finance_goals).
// Progress follows the funding accounts' balances (filled in priority
// order) or a hand-tracked amount. Tap a goal to edit it, its milestones or
// archive it; + adds one (GoalFormModal → save_finance_goal).

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../lib/ops";
import { GoalFormModal, type FinanceGoal } from "../../../components/finance/GoalFormModal";
import { BudgetBar, Chip, DANGER, FinanceHeader, GOOD, HeaderButton, fs, useFinanceAccounts } from "../../../components/finance/ui";
import { fmtCurrency, fmtDate } from "../../../../lib/finance/dates";

const STATUS_ICON = { HIT: "checkmark-circle", MISSED: "close-circle", PENDING: "ellipse-outline" } as const;
const STATUS_COLOR = { HIT: GOOD, MISSED: DANGER, PENDING: "#999" } as const;

export default function FinanceGoals() {
  const accounts = useFinanceAccounts();
  const [goals, setGoals] = useState<FinanceGoal[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState<{ goal: FinanceGoal | null } | null>(null);

  const load = useCallback(async () => {
    const r = await callOp("list_finance_goals", { includeInactive: archived });
    if ("error" in r) return setError(r.error);
    setError(null);
    setGoals(r.result.goals);
  }, [archived]);

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

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Goals" right={<HeaderButton icon="add" onPress={() => setForm({ goal: null })} />} />
      {!goals ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <View style={fs.chipRow}>
            <Chip label="Show archived" on={archived} onPress={() => setArchived(!archived)} />
          </View>
          {goals.length === 0 && <Text style={fs.empty}>No goals yet. Tap + to add the emergency fund.</Text>}
          {goals.map((g) => (
            <Pressable key={g.id} onPress={() => setForm({ goal: g })} style={({ pressed }) => [fs.card, !g.active && { opacity: 0.55 }, pressed && fs.pressed]}>
              <View style={fs.rowBetween}>
                <Text style={[fs.cardTitle, { flex: 1 }]} numberOfLines={1}>
                  {g.name}
                  {!g.active ? <Text style={fs.muted}> · archived</Text> : null}
                </Text>
                <Text style={fs.muted}>{Math.round(g.pct * 100)}%</Text>
              </View>
              <BudgetBar spent={g.current} budgeted={g.target} income />
              <Text style={fs.text}>
                {fmtCurrency(g.current, { cents: false })} <Text style={fs.muted}>of</Text> {fmtCurrency(g.target, { cents: false })}
                {g.targetDate ? <Text style={fs.muted}> · by {fmtDate(g.targetDate, { month: "short", year: "numeric" })}</Text> : null}
              </Text>
              {g.monthlyNeeded != null && <Text style={fs.muted}>{fmtCurrency(g.monthlyNeeded, { cents: false })}/month to get there on time</Text>}
              <Text style={fs.muted}>{g.funded === "account" ? `Follows ${g.fundedBy.join(" + ")}` : "Tracked by hand"}</Text>
              {g.milestones.length > 0 && (
                <View style={{ gap: 4, marginTop: 4 }}>
                  {g.milestones.map((m) => (
                    <View key={m.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Ionicons name={STATUS_ICON[m.status]} size={16} color={STATUS_COLOR[m.status]} />
                      <Text style={fs.textFlex} numberOfLines={1}>
                        {m.label ? `${m.label} · ` : ""}
                        {fmtCurrency(m.targetAmount, { cents: false })} by {fmtDate(m.targetDate, { month: "short", year: "numeric" })}
                      </Text>
                      {m.monthlyNeeded != null && <Text style={fs.muted}>{fmtCurrency(m.monthlyNeeded, { cents: false })}/mo</Text>}
                    </View>
                  ))}
                </View>
              )}
              {g.notes ? <Text style={[fs.muted, { fontStyle: "italic" }]}>{g.notes}</Text> : null}
            </Pressable>
          ))}
        </ScrollView>
      )}
      <GoalFormModal
        visible={!!form}
        goal={form?.goal ?? null}
        accounts={accounts.filter((a) => a.active)}
        onClose={() => setForm(null)}
        onSaved={() => {
          setForm(null);
          void load();
        }}
      />
    </SafeAreaView>
  );
}
