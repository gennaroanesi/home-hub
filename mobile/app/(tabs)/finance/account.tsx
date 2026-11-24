// One account — the phone's /finance/accounts/[id]: balance and sync
// status, balance history from the daily snapshots (simple bars), positions
// for invested accounts, a month of its transactions (tap one to edit it)
// and the recent sync runs that touched it. Opened with
// openFinance("account", { id }). The ⋯ menu edits the account
// (AccountFormModal), syncs it (SimpleFIN-linked ones), opens all its
// transactions, or a LOAN account's loan page.
//
// Reads: the account rows, holdings, snapshots and sync log through the
// mobile data client (lib/finance/data.ts, lib/finance/account-detail.ts),
// like the web; the month's rows from list_finance_transactions.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../lib/ops";
import { getClient } from "../../../lib/amplify";
import { ACCENT, Card, Chip, DANGER, FinanceHeader, GOOD, HeaderButton, Money, WARN, ago, forgetFinanceAccounts, fs, openFinance, useFinanceSync, type OpResultOf } from "../../../components/finance/ui";
import { AccountFormModal } from "../../../components/finance/AccountFormModal";
import { TransactionEditModal, type FinanceTx } from "../../../components/finance/TransactionEditModal";
import { fmtCurrency, fmtDate, monthRange, shiftMonth, todayIso } from "../../../../lib/finance/dates";
import { accountTypeLabel, isInvested } from "../../../../lib/finance/accounts";
import { listAccounts, listHoldings, listLoans } from "../../../../lib/finance/data";
import { UNCATEGORIZED } from "../../../../lib/finance/categories";
import { simplefinConnectionLabel } from "../../../../lib/finance/simplefin-connections";
import {
  HISTORY_WINDOWS,
  balanceHistory,
  historyStats,
  holdingsSummary,
  lastSyncSummary,
  listAccountSnapshots,
  listAccountSyncRuns,
  monthFlow,
  parseJsonOr,
  samplePoints,
  syncEntrySummary,
  type AccountSyncRun,
  type SyncEntry,
} from "../../../../lib/finance/account-detail";

/* eslint-disable @typescript-eslint/no-explicit-any */

type TxResult = OpResultOf<"list_finance_transactions">;

const MAX_BARS = 40;

export default function FinanceAccount() {
  const { id = "" } = useLocalSearchParams<{ id?: string }>();
  const today = todayIso();
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Array<{ date: string; balance: number }>>([]);
  const [holdings, setHoldings] = useState<any[] | null>(null);
  const [runs, setRuns] = useState<AccountSyncRun[]>([]);
  const [loanId, setLoanId] = useState<string | null>(null);
  const [historyDays, setHistoryDays] = useState<number | null>(90);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [txs, setTxs] = useState<TxResult | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editingAccount, setEditingAccount] = useState(false);
  const [editingTx, setEditingTx] = useState<FinanceTx | null>(null);

  const account = useMemo(() => rows?.find((a) => a.id === id) ?? null, [rows, id]);

  const load = useCallback(async () => {
    if (!id) return;
    const client = getClient();
    try {
      const all = await listAccounts(client);
      setRows(all);
      const acct = all.find((a) => a.id === id);
      if (!acct) return;
      const [snaps, held, synced, loans] = await Promise.all([
        listAccountSnapshots(client, id),
        isInvested(acct.type) ? listHoldings(client, id) : Promise.resolve(null),
        acct.simplefinAccountId ? listAccountSyncRuns(client, id) : Promise.resolve([]),
        acct.type === "LOAN" ? listLoans(client) : Promise.resolve([]),
      ]);
      setSnapshots(snaps);
      setHoldings(held);
      setRuns(synced);
      setLoanId(loans.find((l: any) => l.accountId === id)?.id ?? null);
      setError(null);
    } catch (e: any) {
      setError(e?.errors?.[0]?.message ?? e?.message ?? String(e));
    }
  }, [id]);

  const range = useMemo(() => monthRange(`${month}-01`), [month]);
  const loadTx = useCallback(async () => {
    if (!id) return;
    const r = await callOp("list_finance_transactions", { accountIds: [id], from: range.fromIso, to: range.toIso, limit: 500 });
    if ("error" in r) return setTxError(r.error);
    setTxError(null);
    setTxs(r.result);
  }, [id, range]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setTxs(null);
    void loadTx();
  }, [loadTx]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([load(), loadTx()]);
    } finally {
      setRefreshing(false);
    }
  }

  const { syncing, sync } = useFinanceSync(() => void Promise.all([load(), loadTx()]));

  const history = useMemo(() => balanceHistory(snapshots, historyDays, today), [snapshots, historyDays, today]);
  const flow = useMemo(() => monthFlow(txs?.transactions ?? []), [txs]);

  function menu() {
    if (!account) return;
    const actions: Array<{ label: string; run: () => void }> = [{ label: "Edit", run: () => setEditingAccount(true) }];
    if (account.simplefinAccountId && account.active !== false) actions.push({ label: "Sync now", run: () => void sync(account.id) });
    actions.push({ label: "All transactions", run: () => openFinance("transactions", { accountId: account.id, title: account.name }) });
    if (account.type === "LOAN") actions.push(loanId ? { label: "Loan details", run: () => openFinance("loan", { id: loanId }) } : { label: "Add loan terms (Net worth)", run: () => openFinance("net-worth") });
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title: account.name, options: [...actions.map((a) => a.label), "Cancel"], cancelButtonIndex: actions.length }, (i) => actions[i]?.run());
    } else {
      Alert.alert(account.name, undefined, [...actions.map((a) => ({ text: a.label, onPress: a.run })), { text: "Cancel", style: "cancel" as const }]);
    }
  }

  const thisMonth = today.slice(0, 7);
  const details = parseJsonOr<SyncEntry | null>(account?.lastSyncDetails, null);

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title={account?.name ?? "Account"} right={account ? <HeaderButton icon="ellipsis-horizontal" onPress={menu} busy={syncing} /> : undefined} />
      {!rows ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : !account ? (
        <Text style={fs.empty}>Account not found.</Text>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          {/* Balance + sync status */}
          <Card>
            <Text style={fs.muted}>
              {accountTypeLabel(account)}
              {account.institution ? ` · ${account.institution}` : ""}
              {account.last4 ? ` ••${account.last4}` : ""}
              {account.active === false ? " · inactive" : ""}
            </Text>
            <Money value={account.currentBalance ?? 0} style={{ fontSize: 30, fontWeight: "700" }} />
            <Text style={fs.muted}>updated {ago(account.balanceUpdatedAt)}</Text>
            {account.minBalance != null && (
              <Text style={[fs.muted, (account.currentBalance ?? 0) < account.minBalance && { color: WARN }]}>Buffer {fmtCurrency(account.minBalance, { cents: false })}</Text>
            )}
            {account.creditLimit != null && <Text style={fs.muted}>Limit {fmtCurrency(account.creditLimit, { cents: false })}</Text>}
            {account.simplefinAccountId ? (
              <View style={{ gap: 2, marginTop: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Ionicons name="link" size={12} color={GOOD} />
                  <Text style={[fs.muted, { color: GOOD }]}>
                    SimpleFIN ({simplefinConnectionLabel(account.simplefinConnection)}) · synced {ago(account.lastSyncAt)}
                  </Text>
                </View>
                {details && <Text style={fs.muted}>{lastSyncSummary(details)}</Text>}
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
                <Ionicons name="unlink" size={12} color="#888" />
                <Text style={fs.muted}>Not linked to SimpleFIN (manual balance)</Text>
              </View>
            )}
            {isInvested(account.type) && <Text style={fs.muted}>Investment account: its transactions stay out of the budget and overview.</Text>}
            {account.type === "LOAN" && <Text style={fs.muted}>Loan: its transactions stay out of the budget (the payment counts where it left checking).</Text>}
            {account.type === "LOAN" && loanId && (
              <Pressable onPress={() => openFinance("loan", { id: loanId })} style={({ pressed }) => pressed && fs.pressed}>
                <Text style={[fs.link, { marginTop: 4 }]}>Loan details ›</Text>
              </Pressable>
            )}
          </Card>

          {/* Balance history */}
          <Card title="Balance history">
            <View style={fs.chipRow}>
              {HISTORY_WINDOWS.map((h) => (
                <Chip key={h.label} label={h.label} on={historyDays === h.days} onPress={() => setHistoryDays(h.days)} />
              ))}
            </View>
            <HistoryBars points={history} minBalance={account.minBalance ?? null} />
          </Card>

          {holdings && <PositionsCard balance={account.currentBalance ?? 0} holdings={holdings} />}

          {/* A month of transactions */}
          <Card>
            <View style={fs.rowBetween}>
              <Pressable onPress={() => setMonth(shiftMonth(`${month}-01`, -1).slice(0, 7))} hitSlop={10}>
                <Ionicons name="chevron-back" size={22} color={ACCENT} />
              </Pressable>
              <Pressable onPress={() => setMonth(thisMonth)} disabled={month === thisMonth}>
                <Text style={fs.cardTitle}>{range.label}</Text>
              </Pressable>
              <Pressable onPress={() => setMonth(shiftMonth(`${month}-01`, 1).slice(0, 7))} disabled={month >= thisMonth} hitSlop={10} style={month >= thisMonth && { opacity: 0.3 }}>
                <Ionicons name="chevron-forward" size={22} color={ACCENT} />
              </Pressable>
            </View>
            <Text style={fs.muted}>
              In {fmtCurrency(flow.inflow)} · Out {fmtCurrency(flow.outflow)}
              {flow.pending ? ` · ${flow.pending} pending` : ""}
            </Text>
            {!txs ? (
              txError ? <Text style={fs.empty}>{txError}</Text> : <ActivityIndicator style={{ paddingVertical: 16 }} />
            ) : txs.transactions.length === 0 ? (
              <Text style={fs.empty}>No transactions this month.</Text>
            ) : (
              txs.transactions.map((t, i) => <TxLine key={t.id} tx={t} first={i === 0} onPress={() => setEditingTx(t)} />)
            )}
            {txs && txs.count > txs.transactions.length && <Text style={fs.muted}>Showing {txs.transactions.length} of {txs.count}.</Text>}
            <Pressable onPress={() => openFinance("transactions", { accountId: account.id, title: account.name, month })} style={({ pressed }) => [{ alignSelf: "flex-end" }, pressed && fs.pressed]}>
              <Text style={fs.link}>Search & filter in Transactions ›</Text>
            </Pressable>
          </Card>

          {account.simplefinAccountId && (
            <Card title="Recent syncs">
              {runs.length === 0 ? (
                <Text style={fs.muted}>No syncs yet.</Text>
              ) : (
                runs.map(({ log, entry }, i) => (
                  <View key={log.id} style={[{ gap: 2, paddingTop: i ? 8 : 0 }, i > 0 && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }]}>
                    <View style={fs.rowBetween}>
                      <Text style={fs.text}>{new Date(log.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Text>
                      <Text style={[fs.muted, { fontWeight: "600", color: log.status === "OK" ? GOOD : log.status === "ERROR" ? DANGER : WARN }]}>
                        {log.status}
                        {log.trigger ? ` · ${String(log.trigger).toLowerCase()}` : ""}
                      </Text>
                    </View>
                    <Text style={fs.muted}>
                      {syncEntrySummary(entry)}
                      {entry.balanceAfter !== entry.balanceBefore ? ` · ${fmtCurrency(entry.balanceBefore)} → ${fmtCurrency(entry.balanceAfter)}` : ""}
                    </Text>
                    {(log.errorCount ?? 0) > 0 && <Text style={[fs.muted, { color: DANGER }]}>{log.errorCount} error(s)</Text>}
                  </View>
                ))
              )}
            </Card>
          )}
        </ScrollView>
      )}

      <AccountFormModal
        visible={editingAccount}
        account={account}
        accounts={rows ?? []}
        onClose={() => setEditingAccount(false)}
        onSaved={() => {
          setEditingAccount(false);
          forgetFinanceAccounts();
          void load();
        }}
      />
      <TransactionEditModal
        tx={editingTx}
        onClose={() => setEditingTx(null)}
        onSaved={() => {
          setEditingTx(null);
          void loadTx();
        }}
      />
    </SafeAreaView>
  );
}

/** The balance over the window as bars (one per sampled snapshot), with low / high and the change. */
function HistoryBars({ points, minBalance }: { points: Array<{ date: string; balance: number }>; minBalance: number | null }) {
  const stats = historyStats(points);
  if (!stats || points.length < 2) return <Text style={[fs.muted, { textAlign: "center", paddingVertical: 12 }]}>Daily snapshots build up with each sync.</Text>;
  const bars = samplePoints(points, MAX_BARS);
  const span = stats.max - stats.min || 1;
  const long = { month: "short", day: "numeric", year: "numeric" } as const;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", height: 72, gap: 2 }}>
        {bars.map((p) => (
          <View
            key={p.date}
            style={{
              flex: 1,
              height: `${8 + (92 * (p.balance - stats.min)) / span}%`,
              borderTopLeftRadius: 2,
              borderTopRightRadius: 2,
              backgroundColor: minBalance != null && p.balance < minBalance ? WARN : ACCENT,
              opacity: 0.85,
            }}
          />
        ))}
      </View>
      <View style={fs.rowBetween}>
        <Text style={fs.muted}>{fmtDate(stats.first.date, long)}</Text>
        <Text style={fs.muted}>{fmtDate(stats.last.date, long)}</Text>
      </View>
      <Text style={fs.muted}>
        {fmtCurrency(stats.first.balance)} → {fmtCurrency(stats.last.balance)} (<Text style={{ color: stats.change >= 0 ? GOOD : DANGER }}>{fmtCurrency(stats.change, { sign: true })}</Text>) · low {fmtCurrency(stats.min, { cents: false })} · high{" "}
        {fmtCurrency(stats.max, { cents: false })}
      </Text>
    </View>
  );
}

/** Positions in an invested account, as SimpleFIN last reported them. */
function PositionsCard({ balance, holdings }: { balance: number; holdings: any[] }) {
  const s = holdingsSummary(balance, holdings);
  return (
    <Card title="Positions">
      {s.asOf && <Text style={fs.muted}>as of {fmtDate(s.asOf, { month: "short", day: "numeric", year: "numeric" })}</Text>}
      {s.rows.length === 0 ? (
        <Text style={fs.muted}>No positions yet. They arrive with the next sync of a linked account.</Text>
      ) : (
        <>
          {s.rows.map((h, i) => (
            <View key={h.holdingKey ?? `${h.ticker}-${i}`} style={fs.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text style={fs.text} numberOfLines={1}>
                  {h.ticker ?? h.description ?? "—"}
                </Text>
                <Text style={fs.muted} numberOfLines={1}>
                  {h.ticker && h.description ? `${h.description} · ` : ""}
                  {h.quantity ? `${Number(h.quantity).toLocaleString("en-US", { maximumFractionDigits: 4 })} sh` : "value only"}
                  {h.source === "MANUAL" ? " · manual" : ""}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Money value={h.marketValue ?? 0} />
                {h.gain != null && <Text style={[fs.muted, { color: h.gain >= 0 ? GOOD : DANGER }]}>{fmtCurrency(h.gain, { sign: true })}</Text>}
              </View>
            </View>
          ))}
          {Math.abs(s.cash) >= 0.01 && (
            <View style={fs.rowBetween}>
              <Text style={[fs.textFlex, { color: "#888" }]}>Cash</Text>
              <Money value={s.cash} />
            </View>
          )}
        </>
      )}
    </Card>
  );
}

function TxLine({ tx, first, onPress }: { tx: FinanceTx; first: boolean; onPress: () => void }) {
  const uncat = tx.category === UNCATEGORIZED;
  const meta = [fmtDate(tx.date), tx.category, tx.person && (tx.amount ?? 0) > 0 ? `from ${tx.person}` : null, tx.status === "PENDING" ? "pending" : null].filter(Boolean);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: first ? 0 : 8 }, !first && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={fs.text} numberOfLines={1}>
          {tx.description || "(no description)"}
        </Text>
        <Text style={[fs.muted, uncat && { color: WARN }]} numberOfLines={1}>
          {meta.join(" · ")}
        </Text>
      </View>
      <Money value={tx.amount} sign />
    </Pressable>
  );
}
