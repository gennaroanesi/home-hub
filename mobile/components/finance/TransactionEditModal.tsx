// Edit one transaction: category, which budget it counts in, the contributor (money in only)
// (lib/finance/ledger.ts), notes, "remember for similar" (a rule,
// rememberPattern) and itemizing a charge across categories and budgets.
// Same op and rules as the web's transaction window
// (update_finance_transaction): only changed fields are sent, and saving a
// guessed (LLM) category as is confirms it.

import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { callOp } from "../../lib/ops";
import { usePeople } from "../../lib/use-people";
import { UNCATEGORIZED, suggestPattern } from "../../../lib/finance/categories";
import { fmtCurrency, fmtDate } from "../../../lib/finance/dates";
import { HOUSEHOLD, financePeople, ledgerPeople } from "../../../lib/finance/ledger";
import { CategoryField, Field, FormSheet, Input, PersonChips, cleanAmount, ff } from "./form";
import { ACCENT, Chip, Money, WARN, fs, type OpResultOf } from "./ui";

export type FinanceTx = OpResultOf<"list_finance_transactions">["transactions"][number];

type ItemDraft = { name: string; amount: string; category: string; ledger: string };

/** Whose budget: "" = the default (the account's, or for an item the charge's), household, or a person. */
function LedgerChips({ owners, value, onChange, defaultLabel }: { owners: Array<{ id: string; name: string }>; value: string; onChange: (v: string) => void; defaultLabel: string }) {
  return (
    <View style={fs.chipRow}>
      <Chip label={defaultLabel} on={!value} onPress={() => onChange("")} />
      <Chip label="Household" on={value === HOUSEHOLD} onPress={() => onChange(HOUSEHOLD)} />
      {owners.map((p) => (
        <Chip key={p.id} label={p.name} on={value === p.id} onPress={() => onChange(p.id)} />
      ))}
    </View>
  );
}

export function TransactionEditModal({ tx, onClose, onSaved }: { tx: FinanceTx | null; onClose: () => void; onSaved: () => void }) {
  const { people } = usePeople();
  const owners = useMemo(() => ledgerPeople(people as any[]) as Array<{ id: string; name: string }>, [people]);
  const [ledger, setLedger] = useState("");
  const startCategory = tx && tx.category !== UNCATEGORIZED ? tx.category : "";
  const [category, setCategory] = useState("");
  const [person, setPerson] = useState("");
  const [notes, setNotes] = useState("");
  const [remember, setRemember] = useState(false);
  const [pattern, setPattern] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [busy, setBusy] = useState(false);

  const storedItems = useMemo(() => (tx?.items ?? []).map((i) => ({ name: i.name ?? null, amount: i.amount, category: i.category, ...(i.ledger ? { ledger: i.ledger } : {}) })), [tx]);

  useEffect(() => {
    if (!tx) return;
    setCategory(startCategory);
    setPerson(tx.personId ?? "");
    setLedger(tx.ledgerSet ? tx.ledger : "");
    setNotes(tx.notes ?? "");
    setRemember(false);
    setPattern(suggestPattern(tx.description));
    setItems(storedItems.map((i) => ({ name: i.name ?? "", amount: String(i.amount), category: i.category, ledger: (i as { ledger?: string }).ledger ?? "" })));
  }, [tx]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tx) return null;
  const charge = Math.abs(tx.amount ?? 0);
  const itemSum = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);

  async function save() {
    if (!tx) return;
    const input: Record<string, unknown> = { transactionId: tx.id };
    const cat = category.trim();
    if (cat !== startCategory || (tx.categorySource === "LLM" && cat)) input.category = cat || null;
    if (person !== (tx.personId ?? "")) input.personId = person || null;
    if (ledger !== (tx.ledgerSet ? tx.ledger : "")) input.ledger = ledger || null;
    if (notes !== (tx.notes ?? "")) input.notes = notes.trim() || null;
    const rows = items.filter((i) => i.name.trim() || i.amount.trim() || i.category.trim());
    if (rows.some((i) => !(Number(i.amount) > 0) || !i.category.trim())) return Alert.alert("Each item needs an amount and a category");
    const next = rows.map((i) => ({ name: i.name.trim() || null, amount: Number(i.amount), category: i.category.trim(), ...(i.ledger ? { ledger: i.ledger } : {}) }));
    if (JSON.stringify(next) !== JSON.stringify(storedItems)) input.lineItems = next.length ? next : null;
    if (remember && pattern.trim()) input.rememberPattern = pattern.trim();
    if (Object.keys(input).length === 1) return onClose();
    setBusy(true);
    const r = await callOp("update_finance_transaction", input as any);
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't save", r.error);
    if (r.result.ruleCreated) Alert.alert("Saved", "A rule was added for similar transactions.");
    onSaved();
  }

  const update = (i: number, patch: Partial<ItemDraft>) => setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  return (
    <FormSheet visible={!!tx} title="Transaction" onClose={onClose} onSave={save} busy={busy}>
      <View style={ff.box}>
        <Text style={[fs.text, { fontWeight: "600" }]}>{tx.description || "(no description)"}</Text>
        <View style={fs.rowBetween}>
          <Text style={fs.muted}>
            {fmtDate(tx.date, { month: "short", day: "numeric", year: "numeric" })}
            {tx.account ? ` · ${tx.account}` : ""}
            {tx.status === "PENDING" ? " · pending" : ""}
          </Text>
          <Money value={tx.amount} sign style={{ fontSize: 16, fontWeight: "600" }} />
        </View>
      </View>

      <Field
        label="Category"
        hint={
          items.length
            ? "Itemized: spending counts under the items' categories below."
            : tx.categorySource === "LLM" && category === startCategory && category
              ? "Guessed by the classifier. Saving confirms it, so the sync won't change it."
              : undefined
        }
      >
        <CategoryField value={category} onChange={setCategory} />
      </Field>

      {owners.length > 0 && (
        <Field
          label="Counts in"
          hint={tx.ledgerSet ? undefined : `Now: ${tx.ledgerName === "Household" ? "the household budget" : `${tx.ledgerName}'s own budget`}, from the account.`}
        >
          <LedgerChips owners={owners} value={ledger} onChange={setLedger} defaultLabel="Account's" />
        </Field>
      )}

      {(tx.amount ?? 0) > 0 && (
        <Field label="Contributor" hint="Who put this money in.">
          <PersonChips people={financePeople(people, [person])} value={person} onChange={setPerson} noneLabel="No one" />
        </Field>
      )}

      <Field label="Notes">
        <Input value={notes} onChangeText={setNotes} placeholder="Notes" multiline />
      </Field>

      {(tx.amount ?? 0) < 0 &&
        (items.length === 0 ? (
          <Pressable
            style={ff.smallBtn}
            onPress={() =>
              setItems([
                { name: "", amount: String(charge), category: category.trim(), ledger: "" },
                { name: "", amount: "", category: "", ledger: "" },
              ])
            }
          >
            <Ionicons name="git-branch-outline" size={14} color={ACCENT} />
            <Text style={ff.smallBtnText}>Itemize (split across categories)</Text>
          </Pressable>
        ) : (
          <View style={ff.box}>
            <View style={fs.rowBetween}>
              <Text style={ff.label}>Items</Text>
              <Pressable onPress={() => setItems([])} hitSlop={8}>
                <Text style={[fs.muted, fs.danger]}>Remove itemization</Text>
              </Pressable>
            </View>
            {items.map((it, i) => (
              <View key={i} style={{ gap: 6, paddingBottom: 8, borderBottomWidth: i < items.length - 1 ? 1 : 0, borderBottomColor: "#eee" }}>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  <Input style={{ flex: 1 }} value={it.name} onChangeText={(v) => update(i, { name: v })} placeholder="Item" />
                  <Input style={{ width: 100 }} value={it.amount} onChangeText={(v) => update(i, { amount: cleanAmount(v) })} placeholder="$0.00" keyboardType="decimal-pad" />
                  <Pressable onPress={() => setItems(items.filter((_, j) => j !== i))} hitSlop={8}>
                    <Ionicons name="trash-outline" size={18} color="#c44" />
                  </Pressable>
                </View>
                <CategoryField value={it.category} onChange={(v) => update(i, { category: v })} placeholder="Category" />
                {owners.length > 0 && <LedgerChips owners={owners} value={it.ledger} onChange={(v) => update(i, { ledger: v })} defaultLabel="Charge's" />}
              </View>
            ))}
            <View style={fs.rowBetween}>
              <Pressable style={ff.smallBtn} onPress={() => setItems([...items, { name: "", amount: "", category: "", ledger: "" }])}>
                <Ionicons name="add" size={14} color={ACCENT} />
                <Text style={ff.smallBtnText}>Add item</Text>
              </Pressable>
              <Text style={[fs.muted, Math.abs(itemSum - charge) >= 0.01 && { color: WARN }]}>
                {fmtCurrency(itemSum)} of {fmtCurrency(charge)}
                {Math.abs(itemSum - charge) >= 0.01 ? " · scaled" : ""}
              </Text>
            </View>
          </View>
        ))}

      <View style={ff.box}>
        <View style={ff.switchRow}>
          <Text style={fs.textFlex}>Remember for similar transactions</Text>
          <Switch value={remember} onValueChange={setRemember} />
        </View>
        {remember && (
          <Field label="When the description contains" hint="Plain text (any case) or /regex/flags. Applies the category (and contributor, on money in) above to future transactions.">
            <Input value={pattern} onChangeText={setPattern} autoCapitalize="characters" autoCorrect={false} />
          </Field>
        )}
      </View>
    </FormSheet>
  );
}
