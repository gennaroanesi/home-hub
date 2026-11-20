// Shared bits for the phone's finance screens (app/(tabs)/more/finance):
// header, cards, money text, the budget bar, and "Sync now". Numbers and
// formatting come from root lib/finance; data comes from the finance ops
// (lib/ops/finance.ts) through callOp.

import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { getClient } from "../../lib/amplify";
import type { OpCallResult } from "../../lib/ops";
import type { OpName } from "../../../lib/ops/registry";
import { fmtCurrency } from "../../../lib/finance/dates";
import { describeSyncResult } from "../../../lib/finance/sync-result";
import { listAccounts } from "../../../lib/finance/data";
import { isInvested } from "../../../lib/finance/accounts";

export const ACCENT = "#735f55";
export const DANGER = "#c0392b";
export const WARN = "#b7791f";
export const GOOD = "#2a5a45";

/** The `result` of an op call, typed. */
export type OpResultOf<N extends OpName> = Extract<OpCallResult<N>, { result: unknown }>["result"];

export function FinanceHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <View style={fs.header}>
      <Pressable onPress={() => router.back()} style={fs.backBtn} hitSlop={10}>
        <Ionicons name="chevron-back" size={26} color={ACCENT} />
      </Pressable>
      <Text style={fs.heading} numberOfLines={1}>
        {title}
      </Text>
      {right}
    </View>
  );
}

export function HeaderButton({ icon, onPress, disabled, busy }: { icon: keyof typeof Ionicons.glyphMap; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} hitSlop={10} style={({ pressed }) => [fs.headerBtn, (pressed || disabled) && fs.pressed]}>
      {busy ? <ActivityIndicator color={ACCENT} /> : <Ionicons name={icon} size={24} color={ACCENT} />}
    </Pressable>
  );
}

export function Card({ title, link, onLink, children, style }: { title?: string; link?: string; onLink?: () => void; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[fs.card, style]}>
      {(title || link) && (
        <View style={fs.rowBetween}>
          {title ? <Text style={fs.cardTitle}>{title}</Text> : <View />}
          {link && onLink && (
            <Pressable onPress={onLink} hitSlop={8} style={({ pressed }) => pressed && fs.pressed}>
              <Text style={fs.link}>{link} ›</Text>
            </Pressable>
          )}
        </View>
      )}
      {children}
    </View>
  );
}

export function Money({ value, cents = true, sign = false, style }: { value: number | null | undefined; cents?: boolean; sign?: boolean; style?: StyleProp<TextStyle> }) {
  const color = sign && value != null && value > 0 ? GOOD : undefined;
  return <Text style={[fs.money, color ? { color } : null, style]}>{fmtCurrency(value, { cents, sign })}</Text>;
}

/**
 * Spent of budgeted, with a tick where the elapsed part of the period puts
 * the pace. Income/savings bars fill green; spending turns red when over.
 */
export function BudgetBar({ spent, budgeted, elapsed, income = false }: { spent: number; budgeted: number; elapsed?: number | null; income?: boolean }) {
  const pct = budgeted > 0 ? Math.max(0, Math.min(1, spent / budgeted)) : spent > 0 ? 1 : 0;
  const over = !income && spent > budgeted && budgeted >= 0 && spent > 0;
  const color = income ? GOOD : over ? DANGER : elapsed != null && budgeted > 0 && spent / budgeted > elapsed + 0.05 ? WARN : ACCENT;
  return (
    <View style={fs.bar}>
      <View style={[fs.barFill, { width: `${pct * 100}%`, backgroundColor: color }]} />
      {elapsed != null && elapsed > 0 && elapsed < 1 && <View style={[fs.barTick, { left: `${elapsed * 100}%` }]} />}
    </View>
  );
}

export function Chip({ label, on, onPress, color }: { label: string; on?: boolean; onPress?: () => void; color?: string }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={[fs.chip, on && { backgroundColor: color ?? ACCENT, borderColor: color ?? ACCENT }]}>
      <Text style={[fs.chipText, on && fs.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export type FinanceRoute = "transactions" | "budget" | "scheduled" | "goals" | "accounts" | "net-worth";

/**
 * Push a finance sub-screen. The cast: expo-router's generated route types
 * (.expo/types) only learn about new files on the next `expo start`.
 */
export function openFinance(route: FinanceRoute, params?: Record<string, string>) {
  router.push({ pathname: `/more/finance/${route}`, params } as any);
}

/** "3h ago" from an ISO timestamp. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return "—";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export type FinanceAccount = { id: string; name: string; type: string | null; invested: boolean; active: boolean; ownerPersonIds: string[] };

let accountsCache: FinanceAccount[] | null = null;

/** Drop the cached account list (after adding, editing or deleting an account). */
export function forgetFinanceAccounts() {
  accountsCache = null;
}

/** The finance accounts (reference data for filters and pickers), cached for the session. */
export function useFinanceAccounts(): FinanceAccount[] {
  const [accounts, setAccounts] = useState<FinanceAccount[]>(accountsCache ?? []);
  useEffect(() => {
    if (accountsCache) return;
    let live = true;
    listAccounts(getClient())
      .then((rows) => {
        accountsCache = rows.map((a) => ({ id: a.id, name: a.name, type: a.type ?? null, invested: isInvested(a.type), active: a.active !== false, ownerPersonIds: (a.ownerPersonIds ?? []).filter((x: string | null): x is string => !!x) }));
        if (live) setAccounts(accountsCache);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return accounts;
}

const SYNC_FINANCE = /* GraphQL */ `
  mutation SyncFinance {
    syncFinance
  }
`;

/** "Sync now": the syncFinance mutation (finance-sync Lambda), same as the web's button. */
export function useFinanceSync(onSynced: () => void) {
  const [syncing, setSyncing] = useState(false);
  async function sync() {
    setSyncing(true);
    let out;
    try {
      const r: any = await getClient().graphql({ query: SYNC_FINANCE });
      out = describeSyncResult(r.data?.syncFinance, r.errors?.[0]?.message);
    } catch (e: any) {
      out = describeSyncResult(null, e?.errors?.[0]?.message ?? e?.message ?? String(e));
    } finally {
      setSyncing(false);
    }
    Alert.alert(out.title, out.detail || undefined);
    if (out.ok) onSynced();
  }
  return { syncing, sync };
}

export const fs = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, gap: 4 },
  backBtn: { padding: 4 },
  heading: { fontSize: 28, fontWeight: "600", flex: 1 },
  headerBtn: { padding: 4, paddingRight: 8, minWidth: 36, alignItems: "center" },
  body: { paddingHorizontal: 16, paddingBottom: 40, gap: 12 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 14, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: "600" },
  link: { color: ACCENT, fontSize: 13, fontWeight: "600" },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  label: { fontSize: 11, color: "#999", letterSpacing: 0.5, textTransform: "uppercase" },
  muted: { fontSize: 12, color: "#888" },
  text: { fontSize: 14, color: "#333" },
  textFlex: { flex: 1, fontSize: 14, color: "#333" },
  money: { fontSize: 14, color: "#333", fontVariant: ["tabular-nums"] },
  big: { fontSize: 24, fontWeight: "600" },
  danger: { color: DANGER },
  warn: { color: WARN },
  good: { color: GOOD },
  pressed: { opacity: 0.6 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: "#e5e5e5" },
  bar: { height: 8, borderRadius: 4, backgroundColor: "#eee", overflow: "hidden", position: "relative" },
  barFill: { height: 8, borderRadius: 4 },
  barTick: { position: "absolute", top: 0, bottom: 0, width: 2, backgroundColor: "#555", opacity: 0.5 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ccc", backgroundColor: "#fff", maxWidth: 220 },
  chipText: { color: "#444", fontSize: 13 },
  chipTextOn: { color: "#fff" },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: "#f3f1ef" },
  pillText: { fontSize: 11, color: "#666" },
});
