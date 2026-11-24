// Accounts — the household's finance accounts, like the web's Finance →
// Accounts. Cash accounts (checking, savings, cards) from get_finance_summary
// (ledger "all", so personal accounts show too) with their buffer and projected low; invested ones (401k, IRA, brokerage)
// from list_finance_holdings with their positions as SimpleFIN last reported
// them; inactive ones listed last. Each card says whose SimpleFIN connection
// it syncs from and when (read from the homeFinanceAccount rows directly; the
// ops don't carry the link). Tap a card to edit it (AccountFormModal), + to
// add one; the chevron opens its transactions / positions.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../lib/ops";
import { getClient } from "../../../lib/amplify";
import { usePeople } from "../../../lib/use-people";
import { ACCENT, Card, openFinance, FinanceHeader, GOOD, HeaderButton, Money, WARN, ago, forgetFinanceAccounts, fs, type OpResultOf } from "../../../components/finance/ui";
import { AccountFormModal } from "../../../components/finance/AccountFormModal";
import { fmtCurrency, fmtDate } from "../../../../lib/finance/dates";
import { listAccounts } from "../../../../lib/finance/data";
import { accountTypeLabel } from "../../../../lib/finance/accounts";
import { simplefinConnectionLabel } from "../../../../lib/finance/simplefin-connections";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Summary = OpResultOf<"get_finance_summary">;
type Holdings = OpResultOf<"list_finance_holdings">;

/** Account sections, in display order: one per type (lib/finance/accounts.ts ACCOUNT_TYPES). */
const TYPE_SECTIONS: Array<{ type: string; label: string; invested?: boolean }> = [
  { type: "CHECKING", label: "Checking" },
  { type: "SAVINGS", label: "Savings" },
  { type: "CASH", label: "Cash" },
  { type: "CREDIT", label: "Credit cards" },
  { type: "LOAN", label: "Loans" },
  { type: "RETIREMENT", label: "Retirement", invested: true },
  { type: "BROKERAGE", label: "Brokerage", invested: true },
  { type: "OTHER", label: "Other" },
];
const sectionOf = (type: string | null | undefined) => (TYPE_SECTIONS.some((t) => t.type === type) ? type! : "OTHER");

function SectionHeader({ label, total }: { label: string; total: number }) {
  return (
    <View style={[fs.rowBetween, { paddingHorizontal: 4 }]}>
      <Text style={fs.label}>{label}</Text>
      <Money value={total} cents={false} style={{ fontWeight: "600" }} />
    </View>
  );
}

export default function FinanceAccounts() {
  const { people } = usePeople();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ account: any | null } | null>(null);

  const load = useCallback(async () => {
    const [s, h, r] = await Promise.all([
      // "all": every account, not just the household's (personal checking / cards too).
      callOp("get_finance_summary", { ledger: "all" }),
      callOp("list_finance_holdings", {}),
      listAccounts(getClient()).catch((e: any) => ({ error: e?.errors?.[0]?.message ?? e?.message ?? String(e) })),
    ]);
    if ("error" in s) return setError(s.error);
    if (!Array.isArray(r)) return setError(r.error);
    setError(null);
    setSummary(s.result);
    setHoldings("error" in h ? null : h.result);
    setRows(r);
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

  const byId = useMemo(() => new Map((rows ?? []).map((a) => [a.id, a])), [rows]);
  const owners = (a: any) => {
    const ids: string[] = (a?.ownerPersonIds ?? []).filter(Boolean);
    return ids.length ? ids.map((id) => people.find((p) => p.id === id)?.name ?? "?").join(", ") : "joint";
  };

  const openTx = (id: string, name: string) => openFinance("transactions", { accountId: id, title: name });
  const edit = (id: string) => {
    const row = byId.get(id);
    if (row) setEditing({ account: row });
  };
  // One section per account type, in this order (invested types get the positions view).
  const cashGroups = TYPE_SECTIONS.filter((t) => !t.invested)
    .map((t) => ({ ...t, accounts: (summary?.accounts ?? []).filter((a) => !a.invested && sectionOf(a.type) === t.type) }))
    .filter((g) => g.accounts.length > 0);
  const investedGroups = TYPE_SECTIONS.filter((t) => t.invested)
    .map((t) => ({ ...t, accounts: (holdings?.accounts ?? []).filter((a) => sectionOf(byId.get(a.id)?.type) === t.type) }))
    .filter((g) => g.accounts.length > 0);
  const inactive = (rows ?? []).filter((a) => a.active === false);

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Accounts" right={rows ? <HeaderButton icon="add" onPress={() => setEditing({ account: null })} /> : undefined} />
      {!summary || !rows ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          {rows.length === 0 && <Text style={fs.empty}>No accounts yet. Tap + to add the joint checking account, then link it to SimpleFIN so transactions sync three times a day.</Text>}
          {cashGroups.map((g) => (
            <View key={g.type} style={{ gap: 8 }}>
              <SectionHeader label={g.label} total={g.accounts.reduce((s, a) => s + a.balance, 0)} />
              <Card>
              {g.accounts.map((a, i) => {
                const row = byId.get(a.id);
                const belowNow = a.minBalance != null && a.balance < a.minBalance;
                const dips = !belowNow && a.lowPoint && a.minBalance != null && a.lowPoint.balance < a.minBalance;
                return (
                  <Pressable key={a.id} onPress={() => edit(a.id)} style={({ pressed }) => [{ gap: 2, paddingTop: i ? 10 : 0 }, i > 0 && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}>
                    <View style={fs.rowBetween}>
                      <Text style={[fs.textFlex, { fontWeight: "500" }]} numberOfLines={1}>
                        {a.name}
                      </Text>
                      <Money value={a.balance} style={{ fontSize: 17, fontWeight: "600" }} />
                      <Pressable onPress={() => openTx(a.id, a.name)} hitSlop={12} accessibilityLabel={`${a.name} transactions`}>
                        <Ionicons name="chevron-forward" size={18} color="#bbb" />
                      </Pressable>
                    </View>
                    <Text style={fs.muted}>
                      {accountTypeLabel(row ?? a)} · {owners(row)}
                      {a.institution ? ` · ${a.institution}` : ""}
                      {row?.last4 ? ` ••${row.last4}` : ""}
                      {a.minBalance != null ? ` · buffer ${fmtCurrency(a.minBalance, { cents: false })}` : ""}
                    </Text>
                    <SyncLine row={row} updatedAt={a.updatedAt} />
                    {a.lowPoint && (
                      <Text style={[fs.muted, (belowNow || dips) && { color: WARN }]}>
                        {belowNow ? "Below the buffer now · " : ""}low {fmtCurrency(a.lowPoint.balance, { cents: false })} on {fmtDate(a.lowPoint.date)} (next 14 days)
                      </Text>
                    )}
                  </Pressable>
                );
              })}
              </Card>
            </View>
          ))}

          {investedGroups.map((g, gi) => (
            <View key={g.type} style={{ gap: 8 }}>
              <SectionHeader label={g.label} total={g.accounts.reduce((s, a) => s + a.balance, 0)} />
              {g.accounts.map((a) => {
                const row = byId.get(a.id);
                const expanded = open.has(a.id);
                const toggle = () => setOpen((o) => (o.has(a.id) ? new Set([...o].filter((x) => x !== a.id)) : new Set([...o, a.id])));
                return (
                  <Card key={a.id}>
                    <Pressable onPress={() => edit(a.id)} style={({ pressed }) => [{ gap: 2 }, pressed && fs.pressed]}>
                      <View style={fs.rowBetween}>
                        <Text style={[fs.textFlex, { fontWeight: "600" }]} numberOfLines={1}>
                          {a.name}
                        </Text>
                        <Money value={a.balance} style={{ fontSize: 17, fontWeight: "600" }} />
                        <Pressable onPress={toggle} hitSlop={12} accessibilityLabel={expanded ? "Hide positions" : "Show positions"}>
                          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color="#bbb" />
                        </Pressable>
                      </View>
                      <Text style={fs.muted}>
                        {a.type}
                        {a.owners.length ? ` · ${a.owners.join(", ")}` : " · joint"}
                        {row?.institution ? ` · ${row.institution}` : ""}
                        {a.holdings.length ? ` · ${a.holdings.length} position${a.holdings.length === 1 ? "" : "s"}` : ""}
                      </Text>
                      <SyncLine row={row} updatedAt={a.updatedAt} />
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
              {gi === investedGroups.length - 1 && (
                <Text style={[fs.muted, { paddingHorizontal: 4 }]}>Values as SimpleFIN last reported them. Invested accounts feed goals, not the budget.</Text>
              )}
            </View>
          ))}

          {inactive.length > 0 && (
            <Card title="Inactive">
              {inactive.map((a, i) => (
                <Pressable key={a.id} onPress={() => setEditing({ account: a })} style={({ pressed }) => [{ gap: 2, opacity: 0.6, paddingTop: i ? 10 : 0 }, i > 0 && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}>
                  <View style={fs.rowBetween}>
                    <Text style={[fs.textFlex, { fontWeight: "500" }]} numberOfLines={1}>
                      {a.name}
                    </Text>
                    <Money value={a.currentBalance ?? 0} />
                  </View>
                  <Text style={fs.muted}>
                    {accountTypeLabel(a)} · {owners(a)}
                    {a.institution ? ` · ${a.institution}` : ""}
                    {a.last4 ? ` ••${a.last4}` : ""}
                  </Text>
                  <SyncLine row={a} updatedAt={a.balanceUpdatedAt} />
                </Pressable>
              ))}
            </Card>
          )}
          <Text style={[fs.muted, { paddingHorizontal: 4 }]}>Tap an account to edit it or link it to SimpleFIN.</Text>
        </ScrollView>
      )}

      <AccountFormModal
        visible={!!editing}
        account={editing?.account ?? null}
        accounts={rows ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          forgetFinanceAccounts();
          void load();
        }}
      />
    </SafeAreaView>
  );
}

/** "SimpleFIN (Cristine) · synced 3h ago", or "manual · updated …" — the web card's link line. */
function SyncLine({ row, updatedAt }: { row: any; updatedAt: string | null | undefined }) {
  if (row?.simplefinAccountId) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Ionicons name="link" size={12} color={GOOD} />
        <Text style={[fs.muted, { color: GOOD }]} numberOfLines={1}>
          SimpleFIN ({simplefinConnectionLabel(row.simplefinConnection)}) · synced {ago(row.lastSyncAt)}
        </Text>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Ionicons name="unlink" size={12} color="#888" />
      <Text style={fs.muted} numberOfLines={1}>
        manual · updated {ago(updatedAt)}
      </Text>
    </View>
  );
}
