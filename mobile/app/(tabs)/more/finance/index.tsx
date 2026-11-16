// Finance overview — the phone's /finance: account balances, this month's
// contributions and spending against the budget, scheduled money in the
// next 14 days with the projected low, goals, and "Sync now". One read,
// get_finance_summary (lib/ops/finance.ts), the same Janet uses.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../../lib/ops";
import { ACCENT, BudgetBar, openFinance, Card, FinanceHeader, HeaderButton, Money, WARN, ago, fs, useFinanceSync, type OpResultOf } from "../../../../components/finance/ui";
import { fmtCurrency, fmtDate } from "../../../../../lib/finance/dates";

type Summary = OpResultOf<"get_finance_summary">;

const SECTIONS = [
  { label: "Transactions", icon: "list-outline", route: "transactions" },
  { label: "Budget", icon: "pie-chart-outline", route: "budget" },
  { label: "Scheduled", icon: "calendar-outline", route: "scheduled" },
  { label: "Goals", icon: "flag-outline", route: "goals" },
  { label: "Accounts", icon: "wallet-outline", route: "accounts" },
] as const;

export default function FinanceOverview() {
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const r = await callOp("get_finance_summary", {});
    if ("error" in r) setError(r.error);
    else {
      setError(null);
      setS(r.result);
    }
  }, []);
  const { syncing, sync } = useFinanceSync(() => void load());

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

  const header = <FinanceHeader title="Finance" right={<HeaderButton icon="sync-outline" onPress={sync} busy={syncing} />} />;

  if (!s) {
    return (
      <SafeAreaView style={fs.screen} edges={["top"]}>
        {header}
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      </SafeAreaView>
    );
  }

  const b = s.budget;
  const over = b.lines.filter((l) => l.budgeted > 0 && l.spent > l.budgeted).sort((x, y) => y.spent - y.budgeted - (x.spent - x.budgeted));
  const hasBudget = s.contributions.length > 0 || b.lines.length > 0;
  const cash = s.accounts.filter((a) => !a.invested);
  const invested = s.accounts.filter((a) => a.invested);

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      {header}
      <Text style={[fs.muted, { paddingHorizontal: 20, paddingBottom: 8 }]}>
        {s.lastSync ? `Last sync ${ago(s.lastSync.at)} · ${s.lastSync.status ?? "?"}${s.lastSync.txInserted ? ` · ${s.lastSync.txInserted} new` : ""}` : "Never synced"}
      </Text>
      <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {s.accounts.length === 0 ? (
          <Card>
            <Text style={fs.text}>No accounts yet. Add the joint account on the web (Finance → Accounts) and link it to SimpleFIN.</Text>
          </Card>
        ) : (
          <Card title="Accounts" link="All" onLink={() => openFinance("accounts")}>
            {cash.map((a) => {
              const belowNow = a.minBalance != null && a.balance < a.minBalance;
              const dips = !belowNow && a.lowPoint && a.minBalance != null && a.lowPoint.balance < a.minBalance;
              return (
                <View key={a.id} style={{ gap: 2 }}>
                  <View style={fs.rowBetween}>
                    <Text style={fs.textFlex} numberOfLines={1}>
                      {a.name}
                    </Text>
                    <Money value={a.balance} style={{ fontSize: 17, fontWeight: "600" }} />
                  </View>
                  <Text style={fs.muted}>
                    updated {ago(a.updatedAt)}
                    {a.institution ? ` · ${a.institution}` : ""}
                  </Text>
                  {(belowNow || dips) && (
                    <Text style={[fs.muted, { color: WARN }]}>
                      ⚠︎ {belowNow ? `Below the ${fmtCurrency(a.minBalance, { cents: false })} buffer` : `Dips to ${fmtCurrency(a.lowPoint!.balance, { cents: false })} on ${fmtDate(a.lowPoint!.date)}`}
                    </Text>
                  )}
                </View>
              );
            })}
            {invested.length > 0 && (
              <View style={fs.rowBetween}>
                <Text style={fs.muted}>Invested ({invested.length} account{invested.length === 1 ? "" : "s"})</Text>
                <Money value={invested.reduce((t, a) => t + a.balance, 0)} cents={false} style={fs.muted} />
              </View>
            )}
          </Card>
        )}

        <Card title={s.month} link="Budget" onLink={() => openFinance("budget")}>
          {hasBudget ? (
            <>
              <Text style={fs.label}>Contributions</Text>
              {s.contributions.length === 0 && <Text style={fs.muted}>No contribution lines in the budget.</Text>}
              {s.contributions.map((c, i) => (
                <View key={`${c.name}-${i}`} style={{ gap: 4 }}>
                  <View style={fs.rowBetween}>
                    <Text style={fs.textFlex} numberOfLines={1}>
                      {c.person ?? c.name}
                      {c.period !== "MONTHLY" ? <Text style={fs.muted}> · {c.period.toLowerCase()}</Text> : null}
                    </Text>
                    <Text style={fs.money}>
                      {fmtCurrency(c.received)} <Text style={fs.muted}>of</Text> {fmtCurrency(c.planned, { cents: false })}
                    </Text>
                  </View>
                  <BudgetBar spent={Math.max(0, c.received)} budgeted={c.planned} income />
                </View>
              ))}
              <Text style={fs.muted}>
                Received {fmtCurrency(b.received)} of {fmtCurrency(b.planned, { cents: false })} planned
              </Text>

              <View style={[fs.rowBetween, { marginTop: 6 }]}>
                <Text style={fs.label}>Spending</Text>
                <Text style={fs.money}>
                  {fmtCurrency(b.spentBudgeted)} <Text style={fs.muted}>of</Text> {fmtCurrency(b.allocated, { cents: false })}
                </Text>
              </View>
              <BudgetBar spent={b.spentBudgeted} budgeted={b.allocated} elapsed={b.elapsed} />
              <Text style={fs.muted}>All money out this month: {fmtCurrency(b.spentTotal)}</Text>

              {over.length > 0 && (
                <>
                  <Text style={[fs.label, { marginTop: 6 }]}>Over budget</Text>
                  {over.slice(0, 4).map((l) => (
                    <View key={l.seriesId} style={fs.rowBetween}>
                      <Text style={fs.textFlex}>{l.name}</Text>
                      <Text style={[fs.money, fs.danger]}>+{fmtCurrency(l.spent - l.budgeted)}</Text>
                    </View>
                  ))}
                </>
              )}
            </>
          ) : (
            <Text style={fs.muted}>No budget yet. Set one up on the web (Finance → Budget).</Text>
          )}
          {s.uncategorizedCount > 0 && (
            <Pressable onPress={() => openFinance("transactions", { uncategorized: "1" })} style={({ pressed }) => pressed && fs.pressed}>
              <Text style={[fs.text, { color: WARN, marginTop: 4 }]}>
                {s.uncategorizedCount} transaction{s.uncategorizedCount === 1 ? "" : "s"} need a category ›
              </Text>
            </Pressable>
          )}
        </Card>

        <Card title="Next 14 days" link="Scheduled" onLink={() => openFinance("scheduled")}>
          {s.lowPoint && (
            <Text style={[fs.muted, s.lowPoint.belowBuffer && { color: WARN }]}>
              {s.lowPoint.account} low {fmtCurrency(s.lowPoint.balance, { cents: false })} on {fmtDate(s.lowPoint.date)}
              {s.lowPoint.belowBuffer ? " · below the buffer" : ""}
            </Text>
          )}
          {s.upcoming.length === 0 ? (
            <Text style={fs.muted}>Nothing scheduled in the next two weeks.</Text>
          ) : (
            s.upcoming.map((e, i) => (
              <View key={`${e.date}-${i}`} style={fs.rowBetween}>
                <Text style={[fs.muted, { width: 52 }]}>{fmtDate(e.date)}</Text>
                <Text style={fs.textFlex} numberOfLines={1}>
                  {e.description}
                  {cash.length > 1 ? <Text style={fs.muted}> · {e.account}</Text> : null}
                </Text>
                <Money value={e.amount} sign />
              </View>
            ))
          )}
        </Card>

        {s.goals.length > 0 && (
          <Card title="Goals" link="Goals" onLink={() => openFinance("goals")}>
            {s.goals.map((g) => (
              <View key={g.id} style={{ gap: 4 }}>
                <View style={fs.rowBetween}>
                  <Text style={fs.textFlex} numberOfLines={1}>
                    {g.name}
                  </Text>
                  <Text style={fs.muted}>{Math.round(g.pct * 100)}%</Text>
                </View>
                <BudgetBar spent={g.current} budgeted={g.target} income />
                <Text style={fs.muted}>
                  {fmtCurrency(g.current, { cents: false })} of {fmtCurrency(g.target, { cents: false })}
                  {g.targetDate ? ` · by ${fmtDate(g.targetDate, { month: "short", year: "numeric" })}` : ""}
                  {g.monthlyNeeded != null ? ` · ${fmtCurrency(g.monthlyNeeded, { cents: false })}/mo` : ""}
                </Text>
              </View>
            ))}
          </Card>
        )}

        <View style={[fs.card, { paddingVertical: 4, gap: 0 }]}>
          {SECTIONS.map((sec, i) => (
            <Pressable
              key={sec.route}
              onPress={() => openFinance(sec.route)}
              style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderTopWidth: i ? 1 : 0, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}
            >
              <Ionicons name={sec.icon} size={20} color={ACCENT} />
              <Text style={[fs.textFlex, { fontSize: 16 }]}>{sec.label}</Text>
              <Ionicons name="chevron-forward" size={18} color="#bbb" />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
