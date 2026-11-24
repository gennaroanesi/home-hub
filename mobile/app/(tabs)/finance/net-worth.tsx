// Net worth — the phone's /finance/net-worth: the total with cash /
// invested / property / debt, each asset's equity against its loans, and
// each loan's payoff (tap one for its loan screen, an account for its detail). Reads get_net_worth and list_finance_loans (the same
// Janet uses); editing assets and loans is on the web.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { callOp } from "../../../lib/ops";
import { BudgetBar, Card, FinanceHeader, GOOD, Money, WARN, fs, openFinance, type OpResultOf } from "../../../components/finance/ui";
import { fmtCurrency, fmtDate } from "../../../../lib/finance/dates";
import { fmtDuration } from "../../../../lib/finance/loans";

type Worth = OpResultOf<"get_net_worth">;
type Loans = OpResultOf<"list_finance_loans">["loans"];

const GROUPS = [
  ["cash", "Cash"],
  ["invested", "Invested"],
  ["property", "Property"],
  ["debt", "Debt"],
] as const;

export default function NetWorth() {
  const [w, setW] = useState<Worth | null>(null);
  const [loans, setLoans] = useState<Loans>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([callOp("get_net_worth", {}), callOp("list_finance_loans", {})]);
    if ("error" in a) return setError(a.error);
    setError(null);
    setW(a.result);
    if (!("error" in b)) setLoans(b.result.loans);
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

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Net worth" />
      {!w ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <Card>
            <Text style={fs.label}>Net worth</Text>
            <Money value={w.totals.total} cents={false} style={{ fontSize: 30, fontWeight: "700" }} />
            {w.change30d && (
              <Text style={fs.muted}>
                {fmtCurrency(w.change30d.amount, { sign: true, cents: false })} in 30 days
              </Text>
            )}
            <Text style={fs.muted}>
              Own {fmtCurrency(w.totals.assets, { cents: false })} · owe {fmtCurrency(w.totals.liabilities, { cents: false })}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, marginTop: 6 }}>
              {GROUPS.map(([k, label]) => (
                <View key={k}>
                  <Text style={fs.muted}>{label}</Text>
                  <Money value={w.totals[k]} cents={false} style={{ fontWeight: "600" }} />
                </View>
              ))}
            </View>
          </Card>

          {w.assets.length > 0 && (
            <Card title="Property">
              {w.assets.map((a) => (
                <View key={a.id} style={{ gap: 3 }}>
                  <View style={fs.rowBetween}>
                    <Text style={fs.textFlex} numberOfLines={1}>
                      {a.name}
                    </Text>
                    <Money value={a.value} cents={false} style={{ fontWeight: "600" }} />
                  </View>
                  {a.loans.length > 0 ? (
                    <>
                      <BudgetBar spent={a.owed} budgeted={a.value} income />
                      <Text style={fs.muted}>
                        Owe {fmtCurrency(a.owed, { cents: false })} · {Math.round((a.ltv ?? 0) * 100)}% LTV · equity{" "}
                        <Text style={{ color: GOOD, fontWeight: "600" }}>{fmtCurrency(a.equity, { cents: false })}</Text>
                      </Text>
                    </>
                  ) : null}
                  <Text style={fs.muted}>valued {a.valuedOn ? fmtDate(a.valuedOn, { month: "short", day: "numeric", year: "numeric" }) : "—"}</Text>
                </View>
              ))}
            </Card>
          )}

          {loans.length > 0 && (
            <Card title="Loans">
              {loans.map((l) => (
                <Pressable key={l.id} onPress={() => openFinance("loan", { id: l.id })} style={({ pressed }) => [{ gap: 3 }, pressed && fs.pressed]}>
                  <View style={fs.rowBetween}>
                    <Text style={fs.textFlex} numberOfLines={1}>
                      {l.name}
                    </Text>
                    <Money value={-l.owed} cents={false} style={{ fontWeight: "600" }} />
                    <Ionicons name="chevron-forward" size={16} color="#bbb" />
                  </View>
                  <BudgetBar spent={l.paidOffPct * 100} budgeted={100} income />
                  <Text style={fs.muted}>
                    {Math.round(l.paidOffPct * 100)}% paid · {(l.interestRate * 100).toFixed(2)}% · {fmtCurrency(l.payment + (l.escrowMonthly ?? 0), { cents: false })}/mo · next {fmtDate(l.nextPaymentDate)}
                  </Text>
                  <Text style={fs.muted}>
                    {l.projectedPayoff ? `Paid off ${fmtDate(l.projectedPayoff, { month: "short", year: "numeric" })} (${fmtDuration(l.monthsLeft ?? 0)})` : "No payoff at this payment"}
                    {l.monthsAhead ? <Text style={{ color: l.monthsAhead > 0 ? GOOD : WARN }}> · {l.monthsAhead > 0 ? `${l.monthsAhead} mo ahead` : `${-l.monthsAhead} mo behind`}</Text> : null}
                  </Text>
                </Pressable>
              ))}
            </Card>
          )}

          <Card title="Accounts">
            {w.accounts.map((a) => (
              <Pressable key={a.id} onPress={() => openFinance("account", { id: a.id })} style={({ pressed }) => [fs.rowBetween, pressed && fs.pressed]}>
                <Text style={fs.textFlex} numberOfLines={1}>
                  {a.name} <Text style={fs.muted}>· {a.group}</Text>
                </Text>
                <Money value={a.balance} cents={false} />
              </Pressable>
            ))}
          </Card>
          <Text style={[fs.muted, { textAlign: "center" }]}>Add or update assets and loans on the web (Finance → Net worth).</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
