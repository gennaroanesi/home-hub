// Transactions — search, filter and sort household transactions
// (list_finance_transactions) for a month or custom dates. The filter
// button opens TransactionFiltersSheet (accounts, categories, contributors,
// budget, direction, needs-a-category, sort); what's on shows as chips
// under the search, each removable. Pull to refresh, tap one to edit its category, person,
// spend group, notes, itemization or add a rule (TransactionEditModal). Opened from the
// overview (?uncategorized=1), a budget line (?categories=A,B&month=…&title=…)
// or an account (?accountId=…). Invested accounts' rows only show when that
// account is picked, like the web.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../lib/ops";
import { NO_FILTERS, SORT_LABELS, TransactionFiltersSheet, activeFilterCount, type TxFilters } from "../../../components/finance/TransactionFiltersSheet";
import { usePeople } from "../../../lib/use-people";
import { financePeople, ledgerPeople } from "../../../../lib/finance/ledger";
import { TransactionEditModal, type FinanceTx } from "../../../components/finance/TransactionEditModal";
import { useSpendGroups } from "../../../components/finance/SpendGroupField";
import { ACCENT, Chip, FinanceHeader, Money, WARN, fs, useFinanceAccounts, type OpResultOf } from "../../../components/finance/ui";
import { fmtCurrency, fmtDate, monthRange, shiftMonth, todayIso } from "../../../../lib/finance/dates";
import { UNCATEGORIZED } from "../../../../lib/finance/categories";

type Result = OpResultOf<"list_finance_transactions">;

const LIMIT = 300;

export default function FinanceTransactions() {
  const params = useLocalSearchParams<{ uncategorized?: string; categories?: string; accountId?: string; month?: string; title?: string; ledger?: string }>();
  const accounts = useFinanceAccounts();
  const [month, setMonth] = useState(() => (params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : todayIso().slice(0, 7)));
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const { people } = usePeople();
  const [filters, setFilters] = useState<TxFilters>(() => ({
    ...NO_FILTERS,
    accountIds: params.accountId ? [params.accountId] : [],
    categories: params.categories ? params.categories.split(",").filter(Boolean) : [],
    uncategorized: params.uncategorized === "1",
    ...(params.ledger ? { ledger: params.ledger } : {}),
  }));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<FinanceTx | null>(null);
  const [groups] = useSpendGroups();
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  // Search as you type, a beat after the last keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);

  const monthWindow = useMemo(() => monthRange(`${month}-01`), [month]);
  const range = useMemo(() => {
    const c = filters.custom;
    if (!c) return monthWindow;
    const [fromIso, toIso] = c.from <= c.to ? [c.from, c.to] : [c.to, c.from];
    const f = (iso: string) => fmtDate(iso, { month: "short", day: "numeric", year: "numeric" });
    return { fromIso, toIso, label: `${f(fromIso)} – ${f(toIso)}` };
  }, [monthWindow, filters.custom]);

  const load = useCallback(async () => {
    const r = await callOp("list_finance_transactions", {
      from: range.fromIso,
      to: range.toIso,
      limit: LIMIT,
      sort: filters.sort,
      ...(query ? { query } : {}),
      ...(filters.accountIds.length ? { accountIds: filters.accountIds } : {}),
      ...(filters.categories.length ? { categories: filters.categories } : {}),
      ...(filters.personIds.length ? { personIds: filters.personIds } : {}),
      ...(filters.uncategorized ? { uncategorized: true } : {}),
      ...(filters.direction ? { direction: filters.direction } : {}),
      ...(filters.ledger ? { ledger: filters.ledger } : {}),
    });
    setLoading(false);
    if ("error" in r) return setError(r.error);
    setError(null);
    setData(r.result);
  }, [range, query, filters]);

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

  const thisMonth = todayIso().slice(0, 7);
  const shownAccounts = accounts.filter((a) => a.active || filters.accountIds.includes(a.id));
  const owners = useMemo(() => ledgerPeople(people as any[]), [people]); // eslint-disable-line @typescript-eslint/no-explicit-any
  const ledgers = useMemo(() => [{ key: "household", name: "Household" }, ...owners.map((p) => ({ key: p.id, name: p.name }))], [owners]);
  const nameOf = (list: Array<{ id: string; name: string }>, id: string) => list.find((x) => x.id === id)?.name ?? "?";
  const count = activeFilterCount(filters);
  // What's on, each removable.
  const onChips: Array<{ key: string; label: string; remove: () => void; color?: string }> = [
    ...(filters.uncategorized ? [{ key: "uncat", label: "Needs category", color: WARN, remove: () => setFilters({ ...filters, uncategorized: false }) }] : []),
    ...(filters.direction ? [{ key: "dir", label: filters.direction === "in" ? "Money in" : filters.direction === "spending" ? "Spending" : "Money out", remove: () => setFilters({ ...filters, direction: "" as const }) }] : []),
    ...(filters.ledger ? [{ key: "ledger", label: `Counts in ${ledgers.find((l) => l.key === filters.ledger)?.name ?? "?"}`, remove: () => setFilters({ ...filters, ledger: "" }) }] : []),
    ...filters.accountIds.map((id) => ({ key: `a-${id}`, label: nameOf(accounts, id), remove: () => setFilters({ ...filters, accountIds: filters.accountIds.filter((x) => x !== id) }) })),
    ...filters.categories.map((c) => ({ key: `c-${c}`, label: c, remove: () => setFilters({ ...filters, categories: filters.categories.filter((x) => x !== c) }) })),
    ...filters.personIds.map((id) => ({ key: `p-${id}`, label: `from ${nameOf(people as any[], id)}`, remove: () => setFilters({ ...filters, personIds: filters.personIds.filter((x) => x !== id) }) })), // eslint-disable-line @typescript-eslint/no-explicit-any
  ];

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader
        title={params.title || "Transactions"}
        right={
          <Pressable onPress={() => setFiltersOpen(true)} hitSlop={10} style={{ padding: 4, flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Ionicons name={count ? "funnel" : "funnel-outline"} size={22} color={ACCENT} />
            {count > 0 && (
              <View style={{ backgroundColor: ACCENT, borderRadius: 9, minWidth: 18, height: 18, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
                <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{count}</Text>
              </View>
            )}
          </Pressable>
        }
      />

      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 8 }}>
        {filters.custom ? (
          <View style={[fs.rowBetween, { paddingHorizontal: 4 }]}>
            <Pressable onPress={() => setFiltersOpen(true)} style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: "#333", textAlign: "center" }}>{range.label}</Text>
            </Pressable>
            <Pressable onPress={() => setFilters({ ...filters, custom: null })} hitSlop={10}>
              <Ionicons name="close-circle" size={20} color="#bbb" />
            </Pressable>
          </View>
        ) : (
        <View style={[fs.rowBetween, { paddingHorizontal: 4 }]}>
          <Pressable onPress={() => setMonth(shiftMonth(`${month}-01`, -1).slice(0, 7))} hitSlop={10}>
            <Ionicons name="chevron-back" size={22} color={ACCENT} />
          </Pressable>
          <Pressable onPress={() => setMonth(thisMonth)} disabled={month === thisMonth}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: "#333" }}>{range.label}</Text>
          </Pressable>
          <Pressable onPress={() => setMonth(shiftMonth(`${month}-01`, 1).slice(0, 7))} disabled={month >= thisMonth} hitSlop={10} style={month >= thisMonth && { opacity: 0.3 }}>
            <Ionicons name="chevron-forward" size={22} color={ACCENT} />
          </Pressable>
        </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 10, paddingHorizontal: 10, gap: 6 }}>
          <Ionicons name="search" size={16} color="#999" />
          <TextInput
            style={{ flex: 1, paddingVertical: 9, fontSize: 15, color: "#222" }}
            value={typed}
            onChangeText={setTyped}
            placeholder="Search description or notes"
            placeholderTextColor="#999"
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
          />
        </View>
        <ScrollView horizontal style={{ flexGrow: 0, flexShrink: 0 }} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label={`↕ ${SORT_LABELS[filters.sort]}`} on={filters.sort !== "newest"} onPress={() => setFiltersOpen(true)} />
          {onChips.length === 0 ? (
            <>
              <Chip label="Needs category" color={WARN} onPress={() => setFilters({ ...filters, uncategorized: true })} />
              <Chip label="Filters…" onPress={() => setFiltersOpen(true)} />
            </>
          ) : (
            onChips.map((c) => <Chip key={c.key} label={`${c.label} ✕`} on color={c.color} onPress={c.remove} />)
          )}
        </ScrollView>
      </View>

      {loading && !data ? (
        <View style={fs.center}>
          <ActivityIndicator />
        </View>
      ) : error && !data ? (
        <Text style={fs.empty}>{error}</Text>
      ) : (
        <FlatList
          data={data?.transactions ?? []}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListHeaderComponent={
            data ? (
              <View style={[fs.rowBetween, { paddingVertical: 6, paddingHorizontal: 4 }]}>
                <Text style={fs.muted}>
                  {data.count} transaction{data.count === 1 ? "" : "s"}
                  {data.count > data.transactions.length ? ` · showing ${data.transactions.length}` : ""}
                  {loading ? " · loading…" : ""}
                </Text>
                <Text style={fs.muted}>Net {fmtCurrency(data.total, { sign: true })}</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={<Text style={fs.empty}>No transactions match.</Text>}
          renderItem={({ item }) => <TxRow tx={item} group={item.spendGroupId ? groupName.get(item.spendGroupId) : undefined} onPress={() => setEditing(item)} />}
        />
      )}

      <TransactionFiltersSheet
        visible={filtersOpen}
        value={filters}
        accounts={shownAccounts}
        people={financePeople(people, filters.personIds).map((p) => ({ id: p.id, name: p.name }))}
        ledgers={owners.length ? ledgers : []}
        defaultRange={{ from: monthWindow.fromIso, to: monthWindow.toIso > todayIso() ? todayIso() : monthWindow.toIso }}
        onClose={() => setFiltersOpen(false)}
        onApply={(f) => {
          setFiltersOpen(false);
          setFilters(f);
        }}
      />
      <TransactionEditModal
        tx={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </SafeAreaView>
  );
}

function TxRow({ tx, group, onPress }: { tx: FinanceTx; group?: string; onPress: () => void }) {
  const uncat = tx.category === UNCATEGORIZED;
  const meta = [
    fmtDate(tx.date),
    tx.items?.length ? `Itemized · ${new Set(tx.items.map((i) => i.category)).size} categories` : tx.category,
    tx.categorySource === "LLM" ? "guessed" : null,
    tx.person && (tx.amount ?? 0) > 0 ? `from ${tx.person}` : null,
    // Whose budget, when not the household's (an itemized charge may split).
    tx.items?.some((i) => i.ledger && i.ledger !== tx.ledger) ? "split budget" : tx.ledger !== "household" ? `${tx.ledgerName}'s` : null,
    tx.spendGroupId ? (group ?? "group") : null,
    tx.status === "PENDING" ? "pending" : null,
  ].filter(Boolean);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#fff", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, marginVertical: 3 }, pressed && fs.pressed]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={fs.text} numberOfLines={1}>
          {tx.description || "(no description)"}
        </Text>
        <Text style={[fs.muted, uncat && { color: WARN }]} numberOfLines={1}>
          {meta.join(" · ")}
        </Text>
        {tx.notes ? (
          <Text style={[fs.muted, { fontStyle: "italic" }]} numberOfLines={1}>
            {tx.notes}
          </Text>
        ) : null}
      </View>
      <Money value={tx.amount} sign style={{ fontSize: 15 }} />
    </Pressable>
  );
}
