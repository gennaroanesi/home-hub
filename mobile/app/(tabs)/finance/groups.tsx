// Spend groups — a trip, the nursery, a remodel: tagged transactions add up
// here (against the group's own budget, if set), like the web's Finance →
// Groups. Without params it lists the groups with their totals; + adds one.
// Tapping one pushes this screen again with ?id=… for that group: its
// transactions (tap to edit, ✕ to untag) and a ⋯ menu to edit it (name, trip,
// dates, budget, notes, "Keep out of the monthly budget"), tag untagged
// spending in its dates, or delete it. Saves go through
// save_finance_spend_group (it copies keepOutOfBudget onto the tagged rows);
// deleting untags its rows and deletes the row, like the web.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, FlatList, Modal, Platform, Pressable, RefreshControl, ScrollView, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { callOp } from "../../../lib/ops";
import { getClient } from "../../../lib/amplify";
import { ACCENT, BudgetBar, Card, Chip, FinanceHeader, HeaderButton, Money, WARN, fs, openFinance, useFinanceAccounts, type OpResultOf } from "../../../components/finance/ui";
import { DateField, Field, FormSheet, Input, cleanAmount, ff } from "../../../components/finance/form";
import { TransactionEditModal, type FinanceTx } from "../../../components/finance/TransactionEditModal";
import { fmtCurrency, fmtDate } from "../../../../lib/finance/dates";
import { listTransactions } from "../../../../lib/finance/data";
import { listAllPages } from "../../../../lib/list-all";
import { effectiveCategory, UNCATEGORIZED } from "../../../../lib/finance/categories";
import { SPEND_GROUP_KINDS, SPEND_GROUP_KIND_LABELS, spendGroupFields, type SpendGroupKind } from "../../../../lib/finance/spend-groups";
import { groupAutoAssignCandidates, groupNetSpend, listGroupTransactions } from "../../../../lib/finance/group-spend";

type Group = OpResultOf<"list_finance_spend_groups">["groups"][number];
type Trip = { id: string; name: string; startDate: string | null; endDate: string | null };

const errMsg = (e: any) => e?.errors?.[0]?.message ?? e?.message ?? String(e);

async function loadTrips(): Promise<Trip[]> {
  const rows = await listAllPages<any>(getClient().models.homeTrip);
  return rows
    .map((t) => ({ id: t.id, name: t.name ?? "Trip", startDate: t.startDate ?? null, endDate: t.endDate ?? null }))
    .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
}

function dateSpan(g: { startDate: string | null; endDate: string | null }): string {
  const f = (iso: string) => fmtDate(iso, { month: "short", day: "numeric", year: "numeric" });
  return g.startDate ? `${f(g.startDate)}${g.endDate ? ` – ${f(g.endDate)}` : ""}` : "No dates";
}

function showMenu(title: string, actions: Array<{ label: string; run: () => void; destructive?: boolean }>) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...actions.map((a) => a.label), "Cancel"], cancelButtonIndex: actions.length, destructiveButtonIndex: actions.findIndex((a) => a.destructive) },
      (i) => actions[i]?.run(),
    );
  } else {
    Alert.alert(title, undefined, [...actions.map((a) => ({ text: a.label, onPress: a.run, style: a.destructive ? ("destructive" as const) : undefined })), { text: "Cancel", style: "cancel" as const }]);
  }
}

export default function FinanceGroups() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return id ? <GroupDetail id={id} /> : <GroupList />;
}

// ── List ──────────────────────────────────────────────────────────────────────

function GroupList() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [txs, setTxs] = useState<Map<string, any[]>>(new Map());
  const [trips, setTrips] = useState<Trip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState<{ group: Group | null } | null>(null);

  const load = useCallback(async () => {
    const r = await callOp("list_finance_spend_groups", {});
    if ("error" in r) return setError(r.error);
    try {
      const [tripRows, pairs] = await Promise.all([loadTrips().catch(() => [] as Trip[]), Promise.all(r.result.groups.map(async (g) => [g.id, await listGroupTransactions(getClient(), g.id)] as const))]);
      setTrips(tripRows);
      setTxs(new Map(pairs));
      setGroups(r.result.groups);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  // Reload on coming back from a group (it may have been edited or deleted).
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const tripName = (id: string | null) => (id ? trips.find((t) => t.id === id)?.name ?? null : null);

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Spend groups" right={<HeaderButton icon="add" onPress={() => setForm({ group: null })} />} />
      {!groups ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          {groups.length === 0 && <Text style={fs.empty}>No spend groups yet. Tap + to add one for a trip or a project, then tag its transactions.</Text>}
          {groups.map((g) => {
            const rows = txs.get(g.id) ?? [];
            const spent = groupNetSpend(rows);
            const trip = tripName(g.tripId);
            return (
              <Pressable key={g.id} onPress={() => openFinance("groups", { id: g.id })} style={({ pressed }) => [fs.card, pressed && fs.pressed]}>
                <View style={fs.rowBetween}>
                  <Text style={[fs.cardTitle, { flex: 1 }]} numberOfLines={1}>
                    {g.name}
                  </Text>
                  <View style={fs.pill}>
                    <Text style={fs.pillText}>{SPEND_GROUP_KIND_LABELS[(g.kind ?? "OTHER") as SpendGroupKind] ?? g.kind}</Text>
                  </View>
                </View>
                <Text style={fs.muted} numberOfLines={1}>
                  {dateSpan(g)}
                  {trip ? ` · ✈ ${trip}` : ""}
                </Text>
                <View style={fs.rowBetween}>
                  <Text style={fs.text}>
                    {fmtCurrency(spent, { cents: false })}
                    {g.budget != null ? <Text style={fs.muted}> of </Text> : null}
                    {g.budget != null ? fmtCurrency(g.budget, { cents: false }) : null}
                  </Text>
                  <Text style={fs.muted}>
                    {rows.length} transaction{rows.length === 1 ? "" : "s"}
                  </Text>
                </View>
                {g.budget != null && <BudgetBar spent={spent} budgeted={g.budget} />}
                {g.keepOutOfBudget && <Text style={fs.muted}>Not in the monthly budget</Text>}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
      <GroupFormModal
        visible={!!form}
        group={form?.group ?? null}
        trips={trips}
        onClose={() => setForm(null)}
        onSaved={() => {
          setForm(null);
          void load();
        }}
      />
    </SafeAreaView>
  );
}

// ── One group ─────────────────────────────────────────────────────────────────

function GroupDetail({ id }: { id: string }) {
  const [group, setGroup] = useState<Group | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tagged, setTagged] = useState<any[]>([]);
  const [rows, setRows] = useState<FinanceTx[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState<FinanceTx | null>(null);
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(async () => {
    const r = await callOp("list_finance_spend_groups", {});
    if ("error" in r) return setError(r.error);
    const g = r.result.groups.find((x) => x.id === id);
    if (!g) return setError("This group was deleted.");
    try {
      const [tripRows, raw] = await Promise.all([loadTrips().catch(() => [] as Trip[]), listGroupTransactions(getClient(), id)]);
      // The editable rows (category with the saved rules, account name, …) come
      // from list_finance_transactions over the tagged rows' dates and accounts.
      let list: FinanceTx[] = [];
      if (raw.length) {
        const dates = raw.map((t) => t.date).filter(Boolean).sort();
        const t = await callOp("list_finance_transactions", {
          spendGroupId: id,
          from: dates[0],
          to: dates[dates.length - 1],
          accountIds: [...new Set(raw.map((x) => x.accountId as string))],
          limit: 500,
        });
        if ("error" in t) throw new Error(t.error);
        list = t.result.transactions;
      }
      setGroup(g);
      setTrips(tripRows);
      setTagged(raw);
      setRows(list);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [id]);

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

  async function untag(ids: string[]): Promise<number> {
    let failed = 0;
    for (const txId of ids) {
      const r = await callOp("update_finance_transaction", { transactionId: txId, spendGroupId: null });
      if ("error" in r) failed++;
    }
    return failed;
  }

  function removeOne(tx: FinanceTx) {
    Alert.alert("Remove from group?", tx.description ?? undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const failed = await untag([tx.id]);
          setBusy(false);
          if (failed) Alert.alert("Couldn't update the transaction");
          void load();
        },
      },
    ]);
  }

  function remove() {
    if (!group) return;
    Alert.alert(`Delete "${group.name}"?`, tagged.length ? `Its ${tagged.length} transaction${tagged.length === 1 ? "" : "s"} will be untagged.` : undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const failed = await untag(tagged.map((t) => t.id));
          if (failed) {
            setBusy(false);
            return Alert.alert(`${failed} transaction${failed === 1 ? "" : "s"} couldn't be untagged`, "The group wasn't deleted.");
          }
          try {
            const r: any = await getClient().models.homeFinanceSpendGroup.delete({ id: group.id });
            if (r.errors?.length) throw new Error(r.errors[0].message);
          } catch (e) {
            setBusy(false);
            return Alert.alert("Couldn't delete", errMsg(e));
          }
          setBusy(false);
          router.back();
        },
      },
    ]);
  }

  const canAutoAssign = !!group?.startDate && !!group?.endDate;
  const menu = () => {
    if (!group) return;
    showMenu(group.name, [
      { label: "Edit", run: () => setForm(true) },
      ...(canAutoAssign ? [{ label: "Tag spending in its dates", run: () => setAssigning(true) }] : []),
      { label: "Delete", destructive: true, run: remove },
    ]);
  };

  const spent = groupNetSpend(tagged);
  const trip = group?.tripId ? trips.find((t) => t.id === group.tripId)?.name : null;

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title={group?.name ?? "Group"} right={group ? <HeaderButton icon="ellipsis-horizontal" onPress={menu} busy={busy} /> : undefined} />
      {!group || !rows ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListHeaderComponent={
            <View style={{ gap: 8, paddingBottom: 8 }}>
              <Card>
                <View style={fs.rowBetween}>
                  <Text style={fs.muted} numberOfLines={1}>
                    {SPEND_GROUP_KIND_LABELS[(group.kind ?? "OTHER") as SpendGroupKind] ?? group.kind} · {dateSpan(group)}
                    {trip ? ` · ✈ ${trip}` : ""}
                  </Text>
                </View>
                <Text style={fs.big}>
                  {fmtCurrency(spent)}
                  {group.budget != null ? <Text style={[fs.muted, { fontSize: 15 }]}> of {fmtCurrency(group.budget, { cents: false })}</Text> : null}
                </Text>
                {group.budget != null && <BudgetBar spent={spent} budgeted={group.budget} />}
                <Text style={fs.muted}>{group.keepOutOfBudget ? "Not in the monthly budget: its transactions only count here." : "Its transactions also count in the monthly budget, under their category."}</Text>
                {group.notes ? <Text style={[fs.muted, { fontStyle: "italic" }]}>{group.notes}</Text> : null}
              </Card>
              <Text style={[fs.label, { paddingHorizontal: 4 }]}>
                {tagged.length} transaction{tagged.length === 1 ? "" : "s"}
              </Text>
            </View>
          }
          ListEmptyComponent={
            <Text style={fs.empty}>
              No tagged transactions. Tag them from Transactions{canAutoAssign ? ", or ⋯ → Tag spending in its dates" : ""}.
            </Text>
          }
          renderItem={({ item }) => <GroupTxRow tx={item} onPress={() => setEditing(item)} onRemove={() => removeOne(item)} disabled={busy} />}
        />
      )}

      {group && (
        <GroupFormModal
          visible={form}
          group={group}
          trips={trips}
          onClose={() => setForm(false)}
          onSaved={() => {
            setForm(false);
            void load();
          }}
        />
      )}
      {group && canAutoAssign && (
        <AutoAssignSheet
          visible={assigning}
          group={group}
          onClose={() => setAssigning(false)}
          onTagged={() => {
            setAssigning(false);
            void load();
          }}
        />
      )}
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

function GroupTxRow({ tx, onPress, onRemove, disabled }: { tx: FinanceTx; onPress: () => void; onRemove: () => void; disabled?: boolean }) {
  const meta = [fmtDate(tx.date), tx.category, tx.account, tx.status === "PENDING" ? "pending" : null].filter(Boolean);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#fff", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, marginVertical: 3 }, pressed && fs.pressed]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={fs.text} numberOfLines={1}>
          {tx.description || "(no description)"}
        </Text>
        <Text style={[fs.muted, tx.category === UNCATEGORIZED && { color: WARN }]} numberOfLines={1}>
          {meta.join(" · ")}
        </Text>
      </View>
      <Money value={tx.amount} sign style={{ fontSize: 15 }} />
      <Pressable onPress={onRemove} disabled={disabled} hitSlop={10} accessibilityLabel="Remove from group">
        <Ionicons name="close" size={18} color="#bbb" />
      </Pressable>
    </Pressable>
  );
}

// ── Tag spending in the group's dates ─────────────────────────────────────────

function AutoAssignSheet({ visible, group, onClose, onTagged }: { visible: boolean; group: Group; onClose: () => void; onTagged: () => void }) {
  const accounts = useFinanceAccounts();
  const [candidates, setCandidates] = useState<any[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || !group.startDate || !group.endDate) return;
    let live = true;
    setCandidates(null);
    listTransactions(getClient(), { fromIso: group.startDate, toIso: group.endDate })
      .then((rows) => {
        const out = groupAutoAssignCandidates(rows);
        if (!live) return;
        setCandidates(out);
        setPicked(new Set(out.map((t) => t.id)));
      })
      .catch((e) => {
        if (!live) return;
        Alert.alert("Couldn't load transactions", errMsg(e));
        setCandidates([]);
      });
    return () => {
      live = false;
    };
  }, [visible, group.startDate, group.endDate]);

  const total = useMemo(() => (candidates ?? []).filter((t) => picked.has(t.id)).reduce((s, t) => s + (t.amount ?? 0), 0), [candidates, picked]);
  const accountName = (accId: string) => accounts.find((a) => a.id === accId)?.name ?? "";

  async function tag() {
    setBusy(true);
    let failed = 0;
    for (const txId of picked) {
      const r = await callOp("update_finance_transaction", { transactionId: txId, spendGroupId: group.id });
      if ("error" in r) failed++;
    }
    setBusy(false);
    if (failed) Alert.alert(`${failed} transaction${failed === 1 ? "" : "s"} couldn't be updated`);
    onTagged();
  }

  const toggle = (txId: string) => setPicked((p) => (p.has(txId) ? new Set([...p].filter((x) => x !== txId)) : new Set([...p, txId])));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ff.screen}>
        <View style={ff.header}>
          <Pressable onPress={onClose} disabled={busy} hitSlop={8}>
            <Text style={ff.cancel}>Cancel</Text>
          </Pressable>
          <Text style={ff.headerTitle} numberOfLines={1}>
            Untagged spending
          </Text>
          <Pressable onPress={tag} disabled={busy || !picked.size} hitSlop={8}>
            {busy ? <ActivityIndicator /> : <Text style={[ff.save, !picked.size && ff.disabled]}>Tag {picked.size}</Text>}
          </Pressable>
        </View>
        {!candidates ? (
          <View style={fs.center}>
            <ActivityIndicator />
          </View>
        ) : (
          <FlatList
            data={candidates}
            keyExtractor={(t) => t.id}
            ListHeaderComponent={
              <Text style={[fs.muted, { padding: 16 }]}>
                {dateSpan(group)} · {picked.size} selected · {fmtCurrency(total)}
              </Text>
            }
            ListEmptyComponent={<Text style={fs.empty}>Nothing untagged between those dates.</Text>}
            renderItem={({ item }) => {
              const on = picked.has(item.id);
              return (
                <Pressable onPress={() => toggle(item.id)} style={({ pressed }) => [ff.option, pressed && fs.pressed]}>
                  <Ionicons name={on ? "checkmark-circle" : "ellipse-outline"} size={22} color={on ? ACCENT : "#bbb"} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={fs.text} numberOfLines={1}>
                      {item.description || "(no description)"}
                    </Text>
                    <Text style={fs.muted} numberOfLines={1}>
                      {fmtDate(item.date)} · {effectiveCategory(item)} · {accountName(item.accountId)}
                    </Text>
                  </View>
                  <Money value={item.amount} />
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

// ── Create / edit ─────────────────────────────────────────────────────────────

type Draft = { name: string; kind: SpendGroupKind; budget: string; startDate: string; endDate: string; tripId: string; notes: string; keepOutOfBudget: boolean };

function GroupFormModal({ visible, group, trips, onClose, onSaved }: { visible: boolean; group: Group | null; trips: Trip[]; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>({ name: "", kind: "PROJECT", budget: "", startDate: "", endDate: "", tripId: "", notes: "", keepOutOfBudget: false });
  const [tripsOpen, setTripsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setTripsOpen(false);
    setD({
      name: group?.name ?? "",
      kind: ((group?.kind ?? "PROJECT") as SpendGroupKind) ?? "PROJECT",
      budget: group?.budget != null ? String(group.budget) : "",
      startDate: group?.startDate ?? "",
      endDate: group?.endDate ?? "",
      tripId: group?.tripId ?? "",
      notes: group?.notes ?? "",
      keepOutOfBudget: group?.keepOutOfBudget === true,
    });
  }, [visible, group]);

  /** Linking a trip fills in what's still empty from it, like the web. */
  function pickTrip(tripId: string) {
    const trip = trips.find((t) => t.id === tripId);
    setTripsOpen(false);
    setD((x) => ({
      ...x,
      tripId,
      ...(trip ? { name: x.name || trip.name, kind: "TRIP" as SpendGroupKind, startDate: x.startDate || trip.startDate || "", endDate: x.endDate || trip.endDate || "" } : {}),
    }));
  }

  async function save() {
    const checked = spendGroupFields(d);
    if ("error" in checked) return Alert.alert(checked.error);
    setBusy(true);
    const r = await callOp("save_finance_spend_group", {
      ...(group ? { id: group.id } : {}),
      ...checked.fields,
      tripId: d.tripId || null,
      notes: d.notes.trim() || null,
      keepOutOfBudget: d.keepOutOfBudget,
    });
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't save", r.error);
    onSaved();
  }

  const trip = trips.find((t) => t.id === d.tripId);

  return (
    <FormSheet visible={visible} title={group ? "Edit group" : "New group"} onClose={onClose} onSave={save} busy={busy} canSave={!!d.name.trim()}>
      <Field label="Linked trip">
        <Pressable onPress={() => setTripsOpen((v) => !v)} style={ff.dateBtn}>
          <Text style={[ff.dateText, !trip && ff.placeholder]} numberOfLines={1}>
            {trip ? trip.name : d.tripId ? "A trip" : "None"}
          </Text>
          <Ionicons name={tripsOpen ? "chevron-up" : "chevron-down"} size={16} color="#999" />
        </Pressable>
        {tripsOpen && (
          <View style={[ff.box, { padding: 0, gap: 0, overflow: "hidden" }]}>
            {[{ id: "", name: "None", startDate: null, endDate: null } as Trip, ...trips].map((t) => (
              <Pressable key={t.id || "none"} onPress={() => pickTrip(t.id)} style={({ pressed }) => [ff.option, { paddingHorizontal: 12, paddingVertical: 11 }, pressed && fs.pressed]}>
                <Text style={ff.optionText} numberOfLines={1}>
                  {t.name}
                  {t.startDate ? <Text style={fs.muted}> · {fmtDate(t.startDate, { month: "short", day: "numeric", year: "numeric" })}</Text> : null}
                </Text>
                {d.tripId === t.id && <Ionicons name="checkmark" size={18} color={ACCENT} />}
              </Pressable>
            ))}
          </View>
        )}
      </Field>
      <Field label="Name">
        <Input value={d.name} onChangeText={(v) => setD({ ...d, name: v })} placeholder="Lake Travis weekend, Nursery…" autoFocus={!group} />
      </Field>
      <Field label="Kind">
        <View style={fs.chipRow}>
          {SPEND_GROUP_KINDS.map((k) => (
            <Chip key={k} label={SPEND_GROUP_KIND_LABELS[k]} on={d.kind === k} onPress={() => setD({ ...d, kind: k })} />
          ))}
        </View>
      </Field>
      <Field label="Start">
        <DateField value={d.startDate} onChange={(v) => setD({ ...d, startDate: v })} placeholder="No start date" clearable />
      </Field>
      <Field label="End">
        <DateField value={d.endDate} onChange={(v) => setD({ ...d, endDate: v })} placeholder="No end date" clearable />
      </Field>
      <Field label="Budget" hint="What the whole group may cost (optional)">
        <Input value={d.budget} onChangeText={(v) => setD({ ...d, budget: cleanAmount(v) })} placeholder="$0" keyboardType="decimal-pad" />
      </Field>
      <Field label="Notes">
        <Input value={d.notes} onChangeText={(v) => setD({ ...d, notes: v })} multiline />
      </Field>
      <View style={ff.box}>
        <View style={ff.switchRow}>
          <Text style={fs.textFlex}>Keep out of the monthly budget</Text>
          <Switch value={d.keepOutOfBudget} onValueChange={(v) => setD({ ...d, keepOutOfBudget: v })} />
        </View>
        <Text style={ff.hint}>
          {d.keepOutOfBudget ? "Its transactions only count here (e.g. a remodel paid from savings)." : "Its transactions also count in the monthly budget, under their category."}
        </Text>
      </View>
    </FormSheet>
  );
}
