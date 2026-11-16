// Accounts — read-only balances. Cash accounts (checking, savings) from
// get_finance_summary with their buffer and projected low; invested ones
// (401k, IRA, brokerage) from list_finance_holdings with their positions as
// SimpleFIN last reported them. Tap an account for its transactions.
// Adding / linking accounts stays on the web.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../../lib/ops";
import { ACCENT, Card, openFinance, FinanceHeader, GOOD, Money, WARN, ago, fs, type OpResultOf } from "../../../../components/finance/ui";
import { fmtCurrency, fmtDate } from "../../../../../lib/finance/dates";

type Summary = OpResultOf<"get_finance_summary">;
type Holdings = OpResultOf<"list_finance_holdings">;

export default function FinanceAccounts() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [s, h] = await Promise.all([callOp("get_finance_summary", {}), callOp("list_finance_holdings", {})]);
    if ("error" in s) return setError(s.error);
    setError(null);
    setSummary(s.result);
    setHoldings("error" in h ? null : h.result);
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

  const openTx = (id: string, name: string) => openFinance("transactions", { accountId: id, title: name });
  const cash = (summary?.accounts ?? []).filter((a) => !a.invested);

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Accounts" />
      {!summary ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          {summary.accounts.length === 0 && <Text style={fs.empty}>No accounts yet. Add and link them on the web (Finance → Accounts).</Text>}
          {cash.length > 0 && (
            <Card title="Cash">
              {cash.map((a, i) => {
                const belowNow = a.minBalance != null && a.balance < a.minBalance;
                const dips = !belowNow && a.lowPoint && a.minBalance != null && a.lowPoint.balance < a.minBalance;
                return (
                  <Pressable key={a.id} onPress={() => openTx(a.id, a.name)} style={({ pressed }) => [{ gap: 2, paddingTop: i ? 10 : 0 }, i > 0 && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}>
                    <View style={fs.rowBetween}>
                      <Text style={[fs.textFlex, { fontWeight: "500" }]} numberOfLines={1}>
                        {a.name}
                      </Text>
                      <Money value={a.balance} style={{ fontSize: 17, fontWeight: "600" }} />
                      <Ionicons name="chevron-forward" size={16} color="#bbb" />
                    </View>
                    <Text style={fs.muted}>
                      {(a.type ?? "other").toLowerCase()} · updated {ago(a.updatedAt)}
                      {a.institution ? ` · ${a.institution}` : ""}
                      {a.minBalance != null ? ` · buffer ${fmtCurrency(a.minBalance, { cents: false })}` : ""}
                    </Text>
                    {a.lowPoint && (
                      <Text style={[fs.muted, (belowNow || dips) && { color: WARN }]}>
                        {belowNow ? "Below the buffer now · " : ""}low {fmtCurrency(a.lowPoint.balance, { cents: false })} on {fmtDate(a.lowPoint.date)} (next 14 days)
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </Card>
          )}

          {holdings && holdings.accounts.length > 0 && (
            <>
              <View style={[fs.rowBetween, { paddingHorizontal: 4 }]}>
                <Text style={fs.label}>Invested</Text>
                <Money value={holdings.total} cents={false} style={{ fontWeight: "600" }} />
              </View>
              {holdings.accounts.map((a) => {
                const expanded = open.has(a.id);
                return (
                  <Card key={a.id}>
                    <Pressable
                      onPress={() => setOpen((o) => (o.has(a.id) ? new Set([...o].filter((x) => x !== a.id)) : new Set([...o, a.id])))}
                      style={({ pressed }) => [{ gap: 2 }, pressed && fs.pressed]}
                    >
                      <View style={fs.rowBetween}>
                        <Text style={[fs.textFlex, { fontWeight: "600" }]} numberOfLines={1}>
                          {a.name}
                        </Text>
                        <Money value={a.balance} style={{ fontSize: 17, fontWeight: "600" }} />
                        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color="#bbb" />
                      </View>
                      <Text style={fs.muted}>
                        {a.type}
                        {a.owners.length ? ` · ${a.owners.join(", ")}` : " · joint"} · updated {ago(a.updatedAt)}
                        {a.holdings.length ? ` · ${a.holdings.length} position${a.holdings.length === 1 ? "" : "s"}` : ""}
                      </Text>
                    </Pressable>
                    {expanded && (
                      <View style={{ gap: 8, marginTop: 4 }}>
                        {a.holdings.map((h, i) => (
                          <View key={`${h.ticker ?? h.description}-${i}`} style={fs.rowBetween}>
                            <View style={{ flex: 1 }}>
                              <Text style={fs.text} numberOfLines={1}>
                                {h.ticker ?? h.description ?? "—"}
                              </Text>
                              <Text style={fs.muted} numberOfLines={1}>
                                {h.ticker && h.description ? `${h.description} · ` : ""}
                                {h.quantity.toLocaleString("en-US", { maximumFractionDigits: 3 })} sh
                              </Text>
                            </View>
                            <View style={{ alignItems: "flex-end" }}>
                              <Money value={h.marketValue} cents={false} />
                              {h.gain != null && <Text style={[fs.muted, { color: h.gain >= 0 ? GOOD : "#c0392b" }]}>{fmtCurrency(h.gain, { cents: false, sign: true })}</Text>}
                            </View>
                          </View>
                        ))}
                        {Math.abs(a.cash) >= 1 && (
                          <View style={fs.rowBetween}>
                            <Text style={fs.textFlex}>Cash</Text>
                            <Money value={a.cash} cents={false} />
                          </View>
                        )}
                        <Pressable onPress={() => openTx(a.id, a.name)} style={({ pressed }) => pressed && fs.pressed}>
                          <Text style={{ color: ACCENT, fontWeight: "600", fontSize: 13 }}>Transactions ›</Text>
                        </Pressable>
                      </View>
                    )}
                  </Card>
                );
              })}
              <Text style={[fs.muted, { paddingHorizontal: 4 }]}>Values as SimpleFIN last reported them. Invested accounts feed goals, not the budget.</Text>
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
