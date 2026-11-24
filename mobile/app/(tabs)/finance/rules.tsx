// Rules — the category rules the sync classifies with, like the web's
// Finance → Rules (homeFinanceCategoryRule; first match wins, top to bottom).
// Each rule can set a category, a person (money in) and the budget its
// spending counts in. While the table is empty the bundled rules apply and
// can be copied here to edit. Tap a rule to edit it; ⋯ moves it, turns it
// off or deletes it. Below: a tester and "re-apply" over stored transactions,
// which never touches anything set by hand or by a bill (lib/finance/rule-tools.ts).

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../lib/amplify";
import { ACCENT, Card, Chip, DANGER, FinanceHeader, HeaderButton, fs, openFinance } from "../../../components/finance/ui";
import { CategoryField, Field, FormSheet, Input, ff, forgetFinanceCategories } from "../../../components/finance/form";
import { CATEGORY_RULES, rulesFromDbRows } from "../../../../lib/finance/categories";
import { addDays, todayIso } from "../../../../lib/finance/dates";
import { listAccounts, listCategoryRules, listHouseholdPeople, listTransactions, type HouseholdPerson } from "../../../../lib/finance/data";
import { HOUSEHOLD, accountLedger, financePeople, ledgerLabel, ledgerPeople } from "../../../../lib/finance/ledger";
import {
  moveRuleUpdates,
  newRuleSortOrder,
  planRuleChange,
  reapplyDays,
  ruleChangePatch,
  rulePatternError,
  ruleSaveError,
  testRules,
  type RuleChange,
} from "../../../../lib/finance/rule-tools";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

function errorText(e: any): string {
  return e?.errors?.[0]?.message ?? e?.message ?? String(e);
}

function check(r: any) {
  if (r?.errors?.length) throw new Error(r.errors[0].message);
}

export default function FinanceRules() {
  const db: any = getClient();
  const [rows, setRows] = useState<any[] | null>(null);
  const [people, setPeople] = useState<HouseholdPerson[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<any | null>(null); // {} = new

  const load = useCallback(async () => {
    try {
      const [r, household, accts] = await Promise.all([listCategoryRules(db), listHouseholdPeople(db), listAccounts(db)]);
      setRows(r);
      setAccounts(accts);
      setPeople(financePeople(household, accts.flatMap((a) => a.ownerPersonIds ?? [])));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const usingBundled = rows !== null && rows.length === 0;
  const personName = (id?: string | null) => people.find((p) => p.id === id)?.name ?? "someone";

  async function copyBundled() {
    setBusy(true);
    try {
      let order = 0;
      for (const r of CATEGORY_RULES) check(await db.models.homeFinanceCategoryRule.create({ pattern: r.pattern, category: r.category, sortOrder: (order += 100), active: true }));
      Alert.alert(`Copied ${CATEGORY_RULES.length} rules`);
    } catch (e) {
      Alert.alert("Copy failed", errorText(e));
    } finally {
      forgetFinanceCategories();
      await load();
      setBusy(false);
    }
  }

  async function run(title: string, fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      Alert.alert(title, errorText(e));
    } finally {
      await load();
      setBusy(false);
    }
  }

  const move = (i: number, dir: -1 | 1) =>
    run("Couldn't reorder", async () => {
      for (const u of moveRuleUpdates(rows ?? [], i, dir)) check(await db.models.homeFinanceCategoryRule.update(u));
    });

  const toggle = (rule: any) =>
    run("Couldn't save", async () => {
      check(await db.models.homeFinanceCategoryRule.update({ id: rule.id, active: rule.active === false }));
    });

  function remove(rule: any) {
    Alert.alert("Delete rule?", rule.pattern, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void run("Couldn't delete", async () => {
            check(await db.models.homeFinanceCategoryRule.delete({ id: rule.id }));
          }),
      },
    ]);
  }

  function menu(rule: any, i: number) {
    const n = rows?.length ?? 0;
    const actions: Array<{ label: string; run: () => void; destructive?: boolean }> = [{ label: "Edit", run: () => setEditing(rule) }];
    if (i > 0) actions.push({ label: "Move up", run: () => void move(i, -1) });
    if (i < n - 1) actions.push({ label: "Move down", run: () => void move(i, 1) });
    actions.push({ label: rule.active === false ? "Turn on" : "Turn off", run: () => void toggle(rule) });
    actions.push({ label: "Delete", destructive: true, run: () => remove(rule) });
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: rule.pattern, options: [...actions.map((a) => a.label), "Cancel"], cancelButtonIndex: actions.length, destructiveButtonIndex: actions.findIndex((a) => a.destructive) },
        (k) => actions[k]?.run(),
      );
    } else {
      Alert.alert(rule.pattern, undefined, [...actions.map((a) => ({ text: a.label, onPress: a.run, style: a.destructive ? ("destructive" as const) : undefined })), { text: "Cancel", style: "cancel" as const }]);
    }
  }

  const shown = usingBundled ? CATEGORY_RULES.map((r, i) => ({ id: String(i), ...r, active: true })) : (rows ?? []);

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader
        title="Rules"
        right={
          <View style={{ flexDirection: "row" }}>
            {busy && <ActivityIndicator style={{ marginRight: 6 }} />}
            {rows && !usingBundled ? <HeaderButton icon="add" onPress={() => setEditing({})} disabled={busy} /> : null}
          </View>
        }
      />
      {!rows ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} keyboardShouldPersistTaps="handled">
          <View style={[fs.rowBetween, { paddingHorizontal: 4 }]}>
            <Text style={[fs.muted, { flex: 1 }]}>How transactions get a category, a person and a budget. First match wins, top to bottom.</Text>
            <Pressable onPress={() => openFinance("categories")} hitSlop={8}>
              <Text style={fs.link}>Categories ›</Text>
            </Pressable>
          </View>

          {usingBundled && (
            <Card>
              <Text style={fs.text}>No editable rules yet, so the {CATEGORY_RULES.length} built-in rules below are in use. Copy them to reorder, edit or add your own.</Text>
              <Pressable onPress={copyBundled} disabled={busy} style={({ pressed }) => [ff.smallBtn, (pressed || busy) && fs.pressed]}>
                <Ionicons name="copy-outline" size={14} color={ACCENT} />
                <Text style={ff.smallBtnText}>Copy to editable rules</Text>
              </Pressable>
            </Card>
          )}

          <Card>
            {shown.length === 0 && <Text style={fs.muted}>No rules.</Text>}
            {shown.map((r, i) => (
              <Pressable
                key={r.id}
                disabled={usingBundled}
                onPress={() => setEditing(r)}
                onLongPress={() => !usingBundled && menu(r, i)}
                style={({ pressed }) => [s.rule, i > 0 && s.ruleDivider, r.active === false && { opacity: 0.45 }, pressed && fs.pressed]}
              >
                <Text style={s.num}>{i + 1}</Text>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.pattern}>{r.pattern}</Text>
                  <View style={s.tags}>
                    {r.category ? <Tag label={r.category} /> : null}
                    {r.personId ? <Tag label={personName(r.personId)} /> : null}
                    {r.ledger ? <Tag label={`${ledgerLabel(r.ledger, people)}'s budget`} color="#efe9f5" /> : null}
                    {r.active === false ? <Tag label="off" /> : null}
                  </View>
                  {r.notes ? (
                    <Text style={[fs.muted, { fontStyle: "italic" }]} numberOfLines={2}>
                      {r.notes}
                    </Text>
                  ) : null}
                </View>
                {!usingBundled && (
                  <Pressable onPress={() => menu(r, i)} hitSlop={12} disabled={busy} accessibilityLabel="Rule actions">
                    <Ionicons name="ellipsis-horizontal" size={18} color="#999" />
                  </Pressable>
                )}
              </Pressable>
            ))}
          </Card>

          <Tester dbRows={rows} people={people} />
          <Reapply dbRows={rows} people={people} accounts={accounts} personName={personName} />
        </ScrollView>
      )}

      <RuleSheet
        rule={editing}
        people={people}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          forgetFinanceCategories();
          void load();
        }}
      />
    </SafeAreaView>
  );
}

function Tag({ label, color }: { label: string; color?: string }) {
  return (
    <View style={[fs.pill, color ? { backgroundColor: color } : null]}>
      <Text style={fs.pillText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// ── Add / edit ───────────────────────────────────────────────────────────────

/** "" = its account's budget (no ledger on the rule). */
const ACCOUNT_LEDGER = "";

function RuleSheet({ rule, people, onClose, onSaved }: { rule: any | null; people: HouseholdPerson[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !rule?.id;
  const [pattern, setPattern] = useState("");
  const [category, setCategory] = useState("");
  const [person, setPerson] = useState("");
  const [ledger, setLedger] = useState(ACCOUNT_LEDGER);
  const [notes, setNotes] = useState("");
  const [position, setPosition] = useState<"top" | "bottom">("top");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!rule) return;
    setPattern(rule.pattern ?? "");
    setCategory(rule.category ?? "");
    setPerson(rule.personId ?? "");
    setLedger(rule.ledger ?? ACCOUNT_LEDGER);
    setNotes(rule.notes ?? "");
    setPosition("top");
  }, [rule]);

  const regexError = useMemo(() => rulePatternError(pattern), [pattern]);

  async function save() {
    const problem = ruleSaveError({ pattern, category, personId: person, ledger });
    if (problem) return Alert.alert(problem);
    const db: any = getClient();
    setSaving(true);
    try {
      const fields = { pattern: pattern.trim(), category: category.trim() || null, personId: person || null, ledger: ledger || null, notes: notes.trim() || null };
      if (isNew) {
        // Fresh list: the top / bottom position is relative to what's saved now.
        const sortOrder = newRuleSortOrder(await listCategoryRules(db), position);
        check(await db.models.homeFinanceCategoryRule.create({ ...fields, active: true, sortOrder }));
      } else {
        check(await db.models.homeFinanceCategoryRule.update({ id: rule.id, ...fields }));
      }
      onSaved();
    } catch (e) {
      Alert.alert("Couldn't save", errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormSheet visible={!!rule} title={isNew ? "Add rule" : "Edit rule"} onClose={onClose} onSave={save} busy={saving} canSave={!regexError && !!pattern.trim()}>
      <Field label="When the description contains" hint={regexError ?? "Plain text (any case), or /regex/flags such as /costco(?! gas)/i"}>
        <Input value={pattern} onChangeText={setPattern} autoCapitalize="none" autoCorrect={false} placeholder="COSTCO" style={[{ fontFamily: MONO }, regexError ? { borderColor: DANGER } : null]} />
      </Field>
      <Field label="Category">
        <CategoryField value={category} onChange={setCategory} placeholder="None (only the person or budget)" />
      </Field>
      <Field label="Counts in" hint="Whose budget matching spending counts in. A budget picked by hand on a transaction, or its bill's, still wins.">
        <View style={fs.chipRow}>
          <Chip label="Its account's" on={ledger === ACCOUNT_LEDGER} onPress={() => setLedger(ACCOUNT_LEDGER)} />
          <Chip label="Household" on={ledger === HOUSEHOLD} onPress={() => setLedger(HOUSEHOLD)} />
          {ledgerPeople(people).map((p) => (
            <Chip key={p.id} label={p.name} on={ledger === p.id} onPress={() => setLedger(p.id)} />
          ))}
        </View>
      </Field>
      <Field label="Person" hint="Who put money in, e.g. 'transfer from … 1234' → whoever owns that account.">
        <View style={fs.chipRow}>
          <Chip label="Don't set" on={!person} onPress={() => setPerson("")} />
          {people.map((p) => (
            <Chip key={p.id} label={p.name} on={person === p.id} onPress={() => setPerson(p.id)} />
          ))}
        </View>
      </Field>
      <Field label="Notes">
        <Input value={notes} onChangeText={setNotes} placeholder="Optional" />
      </Field>
      {isNew && (
        <Field label="Position">
          <View style={fs.chipRow}>
            <Chip label="Top (wins over everything)" on={position === "top"} onPress={() => setPosition("top")} />
            <Chip label="Bottom (if nothing else matches)" on={position === "bottom"} onPress={() => setPosition("bottom")} />
          </View>
        </Field>
      )}
    </FormSheet>
  );
}

// ── Tester ───────────────────────────────────────────────────────────────────

function Tester({ dbRows, people }: { dbRows: any[]; people: HouseholdPerson[] }) {
  const [description, setDescription] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const rules = useMemo(() => rulesFromDbRows(dbRows), [dbRows]);
  const result = useMemo(() => testRules(description, direction, rules), [description, direction, rules]);
  const ruleLine = (r: { n: number; pattern: string } | null) =>
    r ? (
      <Text style={fs.muted}>
        Rule #{r.n} <Text style={{ fontFamily: MONO }}>{r.pattern}</Text>
      </Text>
    ) : null;

  return (
    <Card title="Test a description">
      <Input value={description} onChangeText={setDescription} placeholder="SQ *BLUE BOTTLE COFFEE" autoCapitalize="characters" autoCorrect={false} />
      <View style={fs.chipRow}>
        <Chip label="Money out" on={direction === "out"} onPress={() => setDirection("out")} />
        <Chip label="Money in" on={direction === "in"} onPress={() => setDirection("in")} />
      </View>
      {result && (
        <View style={{ gap: 4 }}>
          <View style={s.testRow}>
            <Text style={s.testLabel}>Category</Text>
            <Text style={[fs.text, !result.category && fs.warn]}>{result.category ?? "Uncategorized (the classifier would guess)"}</Text>
          </View>
          {ruleLine(result.catRule)}
          {result.catRule && result.category !== result.catRule.category && (
            <Text style={fs.muted}>
              {result.catRule.category} rewritten to {result.category} for money in
            </Text>
          )}
          <View style={s.testRow}>
            <Text style={s.testLabel}>Person</Text>
            <Text style={fs.text}>{result.personId ? (people.find((p) => p.id === result.personId)?.name ?? "someone") : "none"}</Text>
          </View>
          {ruleLine(result.personRule)}
          <View style={s.testRow}>
            <Text style={s.testLabel}>Budget</Text>
            <Text style={fs.text}>{result.ledger ? `${ledgerLabel(result.ledger, people)}'s` : "its account's"}</Text>
          </View>
          {ruleLine(result.ledgerRule)}
        </View>
      )}
    </Card>
  );
}

// ── Re-apply ─────────────────────────────────────────────────────────────────

function Reapply({ dbRows, people, accounts, personName }: { dbRows: any[]; people: HouseholdPerson[]; accounts: any[]; personName: (id?: string | null) => string }) {
  const [days, setDays] = useState("90");
  const [plan, setPlan] = useState<RuleChange[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(0);

  useEffect(() => setPlan(null), [dbRows, days]);

  async function preview() {
    setChecking(true);
    try {
      const today = todayIso();
      const txs = await listTransactions(getClient(), { fromIso: addDays(today, -reapplyDays(days)), toIso: today });
      const rules = rulesFromDbRows(dbRows);
      const ledgerOfAccount = (id: string) => accountLedger(accounts.find((a) => a.id === id));
      setPlan(txs.map((t) => planRuleChange(t, rules, ledgerOfAccount)).filter((c): c is RuleChange => !!c));
    } catch (e) {
      Alert.alert("Couldn't check", errorText(e));
    } finally {
      setChecking(false);
    }
  }

  async function apply() {
    if (!plan?.length) return;
    const db: any = getClient();
    setApplying(true);
    setDone(0);
    let failed = 0;
    for (const c of plan) {
      try {
        const r = await db.models.homeFinanceTransaction.update({ id: c.tx.id, ...ruleChangePatch(c) });
        if (r.errors?.length) failed++;
      } catch {
        failed++;
      }
      setDone((d) => d + 1);
    }
    setApplying(false);
    Alert.alert(failed ? `${failed} of ${plan.length} failed` : `Updated ${plan.length} transactions`);
    setPlan(null);
  }

  return (
    <Card title="Re-apply rules">
      <Text style={fs.muted}>Recategorize recent transactions with the current rules. Anything set by hand is left alone.</Text>
      <View style={[fs.rowBetween, { justifyContent: "flex-start" }]}>
        <Text style={fs.text}>Last</Text>
        <Input value={days} onChangeText={(v) => setDays(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" style={{ width: 70, textAlign: "center" }} />
        <Text style={[fs.text, { flex: 1 }]}>days</Text>
        <Pressable onPress={preview} disabled={checking || applying} style={({ pressed }) => [ff.smallBtn, (pressed || checking) && fs.pressed]}>
          {checking ? <ActivityIndicator size="small" /> : <Ionicons name="refresh" size={14} color={ACCENT} />}
          <Text style={ff.smallBtnText}>Preview</Text>
        </Pressable>
      </View>
      {plan && (
        <View style={{ gap: 8 }}>
          <Text style={fs.text}>{plan.length === 0 ? "Nothing would change." : `${plan.length} transaction${plan.length === 1 ? "" : "s"} would change:`}</Text>
          {plan.slice(0, 100).map((c, i) => (
            <View key={c.tx.id} style={[{ gap: 2, paddingTop: i ? 6 : 0 }, i > 0 && s.ruleDivider]}>
              <Text style={fs.text} numberOfLines={1}>
                {c.tx.description}
              </Text>
              <Text style={fs.muted}>
                {[
                  c.category !== undefined ? `${c.tx.category ?? "Uncategorized"} → ${c.category}` : null,
                  c.personId !== undefined ? `person → ${personName(c.personId)}` : null,
                  c.ledger !== undefined ? `budget → ${ledgerLabel(c.ledger, people)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          ))}
          {plan.length > 100 && <Text style={fs.muted}>…and {plan.length - 100} more</Text>}
          {plan.length > 0 && (
            <Pressable onPress={apply} disabled={applying} style={({ pressed }) => [s.primaryBtn, (pressed || applying) && fs.pressed]}>
              {applying ? <ActivityIndicator color="#fff" size="small" /> : null}
              <Text style={s.primaryText}>{applying ? `${done} / ${plan.length}` : `Apply to ${plan.length}`}</Text>
            </Pressable>
          )}
        </View>
      )}
    </Card>
  );
}

const s = StyleSheet.create({
  rule: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 8 },
  ruleDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#eee" },
  num: { width: 22, fontSize: 12, color: "#aaa", fontVariant: ["tabular-nums"], paddingTop: 1 },
  pattern: { fontFamily: MONO, fontSize: 12, color: "#333" },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  testRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  testLabel: { width: 70, fontSize: 13, color: "#888" },
  primaryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 10 },
  primaryText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
