// Budget — the household budget for a month, quarter or year
// (get_finance_budget): contributions per person, savings, each spending
// line's spent / remaining / pace, what isn't budgeted, and problems in the
// budget's history. The cadence chips pick which lines show (monthly,
// quarterly, yearly, one-time), defaulting per period like the web. Tap a
// line to see its transactions; the pencil changes its name or amount from
// this month on, or ends it (BudgetLineModal). New lines and version
// history stay on the web.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../../lib/ops";
import { BudgetLineModal, type BudgetLineRef } from "../../../../components/finance/BudgetLineModal";
import { ACCENT, BudgetBar, Card, Chip, DANGER, FinanceHeader, WARN, fs, openFinance, type OpResultOf } from "../../../../components/finance/ui";
import { BUDGET_PERIODS, type BudgetPeriod } from "../../../../../lib/finance/budget";
import { fmtCurrency, monthStart, todayIso } from "../../../../../lib/finance/dates";
import { periodContaining, periodRange, periodToParam, shiftPeriod, switchKind, type Period, type PeriodKind } from "../../../../../lib/finance/periods";

type Budget = OpResultOf<"get_finance_budget">;

const KINDS: Array<{ kind: PeriodKind; label: string }> = [
  { kind: "month", label: "Month" },
  { kind: "quarter", label: "Quarter" },
  { kind: "year", label: "Year" },
];
const CADENCE_LABELS: Record<BudgetPeriod, string> = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", ANNUALLY: "Yearly", ONCE: "One-time" };

export default function FinanceBudget() {
  const today = todayIso();
  const [period, setPeriod] = useState<Period>(() => periodContaining("month", today));
  // null = the period kind's default lines (the op decides, like the web).
  const [include, setInclude] = useState<BudgetPeriod[] | null>(null);
  const [b, setB] = useState<Budget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<BudgetLineRef | null>(null);

  const load = useCallback(async () => {
    const r = await callOp("get_finance_budget", { period: periodToParam(period), ...(include ? { include } : {}) });
    setLoading(false);
    if ("error" in r) return setError(r.error);
    setError(null);
    setB(r.result);
  }, [period, include]);

  useEffect(() => {
    setLoading(true);
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

  const range = useMemo(() => periodRange(period, today), [period, today]);
  // Changes start no earlier than this month: past months keep their budget.
  const newFrom = range.fromIso > monthStart(today) ? range.fromIso : monthStart(today);
  const shown = new Set<string>(b?.include ?? []);

  function toggleCadence(c: BudgetPeriod) {
    const next = new Set(shown);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setInclude(BUDGET_PERIODS.filter((p) => next.has(p)));
  }

  /** The month to open Transactions on: this period's month, or today's / its first for a longer period. */
  function txMonth(): string {
    if (period.kind === "month") return range.fromIso.slice(0, 7);
    return today >= range.fromIso && today <= range.toIso ? today.slice(0, 7) : range.fromIso.slice(0, 7);
  }
  function openTransactions(title: string, categories: string[]) {
    openFinance("transactions", { categories: categories.join(","), month: txMonth(), title });
  }

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Budget" />
      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 8 }}>
        <View style={fs.chipRow}>
          {KINDS.map((k) => (
            <Chip
              key={k.kind}
              label={k.label}
              on={period.kind === k.kind}
              onPress={() => {
                if (period.kind === k.kind) return;
                setPeriod(switchKind(period, k.kind, today));
                setInclude(null);
              }}
            />
          ))}
        </View>
        <View style={[fs.rowBetween, { paddingHorizontal: 4 }]}>
          <Pressable onPress={() => setPeriod(shiftPeriod(period, -1))} hitSlop={10}>
            <Ionicons name="chevron-back" size={22} color={ACCENT} />
          </Pressable>
          <Pressable onPress={() => setPeriod(periodContaining(period.kind, today))}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: "#333" }}>{range.label}</Text>
          </Pressable>
          <Pressable onPress={() => setPeriod(shiftPeriod(period, 1))} hitSlop={10}>
            <Ionicons name="chevron-forward" size={22} color={ACCENT} />
          </Pressable>
        </View>
        <View style={fs.chipRow}>
          {BUDGET_PERIODS.map((c) => (
            <Chip key={c} label={CADENCE_LABELS[c]} on={shown.has(c)} onPress={() => toggleCadence(c)} />
          ))}
        </View>
      </View>

      {!b ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          {loading && <ActivityIndicator style={{ marginTop: -4 }} />}
          {b.issues.length > 0 && (
            <Card style={{ borderWidth: 1, borderColor: "#e0a030" }}>
              <Text style={[fs.text, { fontWeight: "600", color: WARN }]}>
                The budget has {b.issues.length} problem{b.issues.length === 1 ? "" : "s"}
              </Text>
              {b.issues.map((i, n) => (
                <Text key={n} style={fs.muted}>
                  <Text style={{ fontWeight: "600" }}>{i.name}:</Text> {i.detail}
                </Text>
              ))}
            </Card>
          )}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            <Stat label="Planned in" value={b.planned} sub={`received ${fmtCurrency(b.received)}`} />
            <Stat
              label="Budgeted to spend"
              value={b.allocated}
              sub={b.unallocated < 0 ? `${fmtCurrency(-b.unallocated)} more than comes in` : `${fmtCurrency(b.unallocated)} not allocated`}
              danger={b.unallocated < 0}
            />
            <Stat label="Spent on lines" value={b.spentBudgeted} sub={`of ${fmtCurrency(b.allocated)}`} />
            <Stat label="Spent in total" value={b.spentTotal} sub={b.overspend > 0 ? `${fmtCurrency(b.overspend)} over on some lines` : "no line over"} danger={b.overspend > 0} />
          </View>

          <Card title="Contributions">
            {b.contributions.length === 0 ? (
              <Text style={fs.muted}>No contribution lines for this period.</Text>
            ) : (
              b.contributions.map((c) => (
                <PlanRow key={c.id} name={c.name} tag={c.person} period={c.period} spent={c.spent} budgeted={c.budgeted} onEdit={() => setEditing(c)} />
              ))
            )}
          </Card>

          {(b.savings.length > 0 || b.savingsPlanned > 0) && (
            <Card title="Savings">
              {b.savings.map((v) => (
                <PlanRow key={v.id} name={v.name} tag={v.account} period={v.period} spent={v.spent} budgeted={v.budgeted} onEdit={() => setEditing(v)} />
              ))}
            </Card>
          )}

          <Card title="Spending">
            {b.elapsed > 0 && b.elapsed < 1 && <Text style={fs.muted}>{Math.round(b.elapsed * 100)}% of the period gone</Text>}
            {b.lines.length === 0 ? (
              <Text style={fs.muted}>No spending lines for this period.</Text>
            ) : (
              b.lines.map((l, i) => {
                const leftPct = l.budgeted > 0 ? Math.round((Math.abs(l.remaining) / l.budgeted) * 100) : null;
                const showCats = l.categories.length > 1 || l.categories[0] !== l.name;
                return (
                  <View key={l.id} style={[{ gap: 4, paddingTop: i ? 10 : 0 }, i > 0 && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }]}>
                    <View style={fs.rowBetween}>
                      <Pressable style={{ flex: 1 }} onPress={() => openTransactions(l.name, l.categories)}>
                        <Text style={[fs.text, { fontWeight: "500" }]} numberOfLines={1}>
                          {l.name}
                          {l.period !== "MONTHLY" ? <Text style={fs.muted}> · {CADENCE_LABELS[l.period as BudgetPeriod]?.toLowerCase() ?? l.period}</Text> : null}
                          {l.status === "over" ? <Text style={[fs.muted, { color: DANGER }]}> · ahead of pace</Text> : null}
                        </Text>
                        {showCats && (
                          <Text style={fs.muted} numberOfLines={1}>
                            {l.categories.join(", ")}
                          </Text>
                        )}
                      </Pressable>
                      <Pressable onPress={() => setEditing(l)} hitSlop={10}>
                        <Ionicons name="pencil" size={16} color={ACCENT} />
                      </Pressable>
                    </View>
                    <View style={fs.rowBetween}>
                      <Text style={fs.money}>
                        {fmtCurrency(l.spent)} <Text style={fs.muted}>of</Text> {fmtCurrency(l.budgeted, { cents: false })}
                      </Text>
                      <Text style={[fs.money, l.remaining < 0 && fs.danger]}>
                        {fmtCurrency(l.remaining, { cents: false })}
                        {leftPct != null ? <Text style={[fs.muted, l.remaining < 0 && fs.danger]}> {leftPct}% {l.remaining < 0 ? "over" : "left"}</Text> : null}
                      </Text>
                    </View>
                    <Pressable onPress={() => openTransactions(l.name, l.categories)}>
                      <BudgetBar spent={l.spent} budgeted={l.budgeted} elapsed={b.elapsed} />
                    </Pressable>
                    <Text style={fs.muted}>
                      {[
                        l.pace != null && b.elapsed < 1 ? `${l.pace.toFixed(1)}× pace` : null,
                        l.share != null ? `${l.share > 0 && l.share < 0.01 ? "<1" : Math.round(l.share * 100)}% of total` : null,
                        l.scheduled > 0 ? `${fmtCurrency(l.scheduled, { cents: false })} scheduled` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                );
              })
            )}
          </Card>

          {b.unbudgeted.length > 0 && (
            <Card title="Not budgeted">
              <Text style={fs.muted}>Spending in categories no line covers.</Text>
              {b.unbudgeted.map((u) => (
                <Pressable key={u.category} onPress={() => openTransactions(u.category, [u.category])} style={({ pressed }) => [fs.rowBetween, pressed && fs.pressed]}>
                  <Text style={fs.textFlex}>{u.category}</Text>
                  <Text style={fs.money}>{fmtCurrency(u.spent)}</Text>
                  <Ionicons name="chevron-forward" size={14} color="#bbb" />
                </Pressable>
              ))}
            </Card>
          )}
        </ScrollView>
      )}

      <BudgetLineModal
        line={editing}
        from={newFrom}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </SafeAreaView>
  );
}

function Stat({ label, value, sub, danger }: { label: string; value: number; sub: string; danger?: boolean }) {
  return (
    <View style={[fs.card, { flexBasis: "47%", flexGrow: 1, gap: 2 }]}>
      <Text style={fs.muted}>{label}</Text>
      <Text style={[fs.money, { fontSize: 19, fontWeight: "600" }]}>{fmtCurrency(value, { cents: false })}</Text>
      <Text style={[fs.muted, danger && fs.danger]}>{sub}</Text>
    </View>
  );
}

function PlanRow({ name, tag, period, spent, budgeted, onEdit }: { name: string; tag: string | null; period: string; spent: number; budgeted: number; onEdit: () => void }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={fs.rowBetween}>
        <Text style={fs.textFlex} numberOfLines={1}>
          {name}
          {tag && tag !== name ? <Text style={fs.muted}> · {tag}</Text> : null}
          {period !== "MONTHLY" ? <Text style={fs.muted}> · {CADENCE_LABELS[period as BudgetPeriod]?.toLowerCase() ?? period}</Text> : null}
        </Text>
        <Text style={fs.money}>
          {fmtCurrency(spent)} <Text style={fs.muted}>of</Text> {fmtCurrency(budgeted, { cents: false })}
        </Text>
        <Pressable onPress={onEdit} hitSlop={10}>
          <Ionicons name="pencil" size={16} color={ACCENT} />
        </Pressable>
      </View>
      <BudgetBar spent={Math.max(0, spent)} budgeted={budgeted} income />
    </View>
  );
}
