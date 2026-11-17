// Transactions — search and filter a month of household transactions
// (list_finance_transactions: by words, account, category or only the
// uncategorized), pull to refresh, tap one to edit its category, person,
// notes, itemization or add a rule (TransactionEditModal). Opened from the
// overview (?uncategorized=1), a budget line (?categories=A,B&month=…&title=…)
// or an account (?accountId=…). Invested accounts' rows only show when that
// account is picked, like the web.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../../lib/ops";
import { CategorySheet } from "../../../../components/finance/form";
import { TransactionEditModal, type FinanceTx } from "../../../../components/finance/TransactionEditModal";
import { ACCENT, Chip, FinanceHeader, Money, WARN, fs, useFinanceAccounts, type OpResultOf } from "../../../../components/finance/ui";
import { fmtCurrency, fmtDate, monthRange, shiftMonth, todayIso } from "../../../../../lib/finance/dates";
import { UNCATEGORIZED } from "../../../../../lib/finance/categories";

type Result = OpResultOf<"list_finance_transactions">;

const LIMIT = 300;

export default function FinanceTransactions() {
  const params = useLocalSearchParams<{ uncategorized?: string; categories?: string; accountId?: string; month?: string; title?: string }>();
  const accounts = useFinanceAccounts();
  const [month, setMonth] = useState(() => (params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : todayIso().slice(0, 7)));
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [accountId, setAccountId] = useState(params.accountId ?? "");
  const [categories, setCategories] = useState<string[]>(params.categories ? params.categories.split(",").filter(Boolean) : []);
  const [uncategorized, setUncategorized] = useState(params.uncategorized === "1");
  const [pickCategory, setPickCategory] = useState(false);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<FinanceTx | null>(null);

  // Search as you type, a beat after the last keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);

  const range = useMemo(() => monthRange(`${month}-01`), [month]);

  const load = useCallback(async () => {
    const r = await callOp("list_finance_transactions", {
      from: range.fromIso,
      to: range.toIso,
      limit: LIMIT,
      ...(query ? { query } : {}),
      ...(accountId ? { accountId } : {}),
      ...(categories.length ? { categories } : {}),
      ...(uncategorized ? { uncategorized: true } : {}),
    });
    setLoading(false);
    if ("error" in r) return setError(r.error);
    setError(null);
    setData(r.result);
  }, [range, query, accountId, categories, uncategorized]);

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
  const shownAccounts = accounts.filter((a) => a.active || a.id === accountId);

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title={params.title || "Transactions"} />

      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 8 }}>
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
          <Chip label="Needs category" on={uncategorized} color={WARN} onPress={() => setUncategorized(!uncategorized)} />
          <Chip label={categories.length ? `${categories.length === 1 ? categories[0] : `${categories.length} categories`} ✕` : "Category…"} on={categories.length > 0} onPress={() => (categories.length ? setCategories([]) : setPickCategory(true))} />
          <Chip label="All accounts" on={!accountId} onPress={() => setAccountId("")} />
          {shownAccounts.map((a) => (
            <Chip key={a.id} label={a.name} on={accountId === a.id} onPress={() => setAccountId(accountId === a.id ? "" : a.id)} />
          ))}
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
          renderItem={({ item }) => <TxRow tx={item} onPress={() => setEditing(item)} />}
        />
      )}

      <CategorySheet
        visible={pickCategory}
        value=""
        allowClear={false}
        onClose={() => setPickCategory(false)}
        onPick={(c) => {
          setPickCategory(false);
          if (c) setCategories([c]);
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

function TxRow({ tx, onPress }: { tx: FinanceTx; onPress: () => void }) {
  const uncat = tx.category === UNCATEGORIZED;
  const meta = [
    fmtDate(tx.date),
    tx.items?.length ? `Itemized · ${new Set(tx.items.map((i) => i.category)).size} categories` : tx.category,
    tx.categorySource === "LLM" ? "guessed" : null,
    tx.person,
    // Whose budget, when not the household's (an itemized charge may split).
    tx.items?.some((i) => i.ledger && i.ledger !== tx.ledger) ? "split budget" : tx.ledger !== "household" ? `${tx.ledgerName}'s` : null,
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
