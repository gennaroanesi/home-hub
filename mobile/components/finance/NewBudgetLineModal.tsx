// A new spending line from the phone: categories (typing a new one, or a
// sub-category "Baby: Furniture", is allowed), an amount, and how it repeats.
// "For these dates" is a one-off line with an end date: one amount for that
// stretch, no monthly pacing (lib/finance/budget.ts isSpanLine). Saves
// through save_finance_budget into the ledger being looked at. Contribution
// and savings lines stay on the web.

import { useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { callOp } from "../../lib/ops";
import { DateField, Field, FormSheet, Input, CategorySheet, cleanAmount, forgetFinanceCategories } from "./form";
import { ACCENT, Chip, fs } from "./ui";

type How = "MONTHLY" | "QUARTERLY" | "ANNUALLY" | "ONCE" | "SPAN";
const HOWS: Array<{ key: How; label: string }> = [
  { key: "SPAN", label: "For these dates" },
  { key: "MONTHLY", label: "Monthly" },
  { key: "QUARTERLY", label: "Quarterly" },
  { key: "ANNUALLY", label: "Yearly" },
  { key: "ONCE", label: "One-off (a month)" },
];

export function NewBudgetLineModal({
  visible,
  ledger,
  ledgerName,
  from,
  today,
  onClose,
  onSaved,
}: {
  visible: boolean;
  /** household or a person id; "all" saves into the household. */
  ledger: string;
  ledgerName: string;
  /** Default start for repeating lines (no earlier than this month). */
  from: string;
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [cats, setCats] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [how, setHow] = useState<How>("SPAN");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName("");
    setCats([]);
    setAmount("");
    setHow("SPAN");
    setStart(today);
    setEnd("");
  }, [visible, today]);

  const span = how === "SPAN";
  const n = Number(amount);
  const canSave = cats.length > 0 && (cats.length === 1 || !!name.trim()) && n > 0 && !!start && (!span || (!!end && end >= start));

  function pickHow(h: How) {
    setHow(h);
    // Repeating lines start on a month's 1st by default; a stretch from today.
    setStart(h === "SPAN" ? today : from);
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    const r = await callOp("save_finance_budget", {
      kind: "EXPENSE",
      name: name.trim() || (cats.length === 1 ? cats[0] : undefined),
      categories: cats,
      amount: n,
      period: span ? "ONCE" : how,
      effectiveFrom: start,
      ...(end ? { effectiveTo: end } : {}),
      ledger: ledger === "all" ? "household" : ledger,
    });
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't save", r.error);
    forgetFinanceCategories();
    onSaved();
  }

  return (
    <FormSheet visible={visible} title="New spending line" onClose={onClose} onSave={save} busy={busy} canSave={canSave}>
      <Text style={fs.muted}>In the {ledger === "all" ? "household" : ledgerName === "Household" ? "household" : `${ledgerName}'s`} budget.</Text>
      <Field label="Categories" hint='A sub-category is "Parent: Child" (Baby: Furniture); a line on the parent covers them all.'>
        <View style={fs.chipRow}>
          {cats.map((c) => (
            <Chip key={c} label={`${c} ✕`} on onPress={() => setCats(cats.filter((x) => x !== c))} />
          ))}
          <Pressable onPress={() => setPicking(true)} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6 }} hitSlop={6}>
            <Ionicons name="add" size={16} color={ACCENT} />
            <Text style={{ color: ACCENT }}>Add category</Text>
          </Pressable>
        </View>
      </Field>
      <Field label="Name">
        <Input value={name} onChangeText={setName} placeholder={cats.length === 1 ? cats[0] : "Baby furniture"} />
      </Field>
      <Field label={span ? "Amount for the whole stretch" : "Amount"}>
        <Input value={amount} onChangeText={(v) => setAmount(cleanAmount(v))} placeholder="0" keyboardType="decimal-pad" />
      </Field>
      <Field
        label="How"
        hint={
          span
            ? "One amount for these dates: everything spent between them counts, no monthly pacing."
            : how === "ONCE"
              ? "Counts only in the month it starts."
              : "Per period, from the start date on."
        }
      >
        <View style={fs.chipRow}>
          {HOWS.map((h) => (
            <Chip key={h.key} label={h.label} on={how === h.key} onPress={() => pickHow(h.key)} />
          ))}
        </View>
      </Field>
      <Field label="Starts on">
        <DateField value={start} onChange={setStart} />
      </Field>
      <Field label={span ? "Until" : "Until (optional)"} hint={span && end && end < start ? "The end is before the start." : undefined}>
        <DateField value={end} onChange={setEnd} placeholder={span ? "Pick the last day" : "Open-ended"} clearable />
      </Field>
      <CategorySheet
        visible={picking}
        value=""
        allowClear={false}
        onClose={() => setPicking(false)}
        onPick={(c) => {
          if (c && !cats.includes(c)) setCats([...cats, c]);
          setPicking(false);
        }}
      />
    </FormSheet>
  );
}
