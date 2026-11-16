// Add or edit a savings goal: name, target, date, how progress is tracked
// (by hand, or the balance of one or more accounts, drawn on in the order
// picked), priority, notes and milestones. One save_finance_goal call;
// milestones are sent as the full list (ids keep rows in place).

import { useEffect, useState } from "react";
import { Alert, Pressable, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { callOp } from "../../lib/ops";
import { DateField, Field, FormSheet, Input, cleanAmount, ff } from "./form";
import { ACCENT, Chip, fs, type OpResultOf } from "./ui";
import type { AccountRef } from "./ScheduleFormModal";

export type FinanceGoal = OpResultOf<"list_finance_goals">["goals"][number];

type MilestoneDraft = { id?: string; amount: string; date: string; label: string };

export function GoalFormModal({ visible, goal, accounts, onClose, onSaved }: { visible: boolean; goal: FinanceGoal | null; accounts: AccountRef[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [funding, setFunding] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [priority, setPriority] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName(goal?.name ?? "");
    setTarget(goal ? String(goal.target) : "");
    setTargetDate(goal?.targetDate ?? "");
    setFunding(goal?.fundingAccountIds ?? []);
    setCurrent(goal?.currentAmount != null ? String(goal.currentAmount) : "");
    setPriority(goal?.priority != null ? String(goal.priority) : "");
    setNotes(goal?.notes ?? "");
    setActive(goal ? goal.active : true);
    setMilestones((goal?.milestones ?? []).map((m) => ({ id: m.id, amount: String(m.targetAmount), date: m.targetDate, label: m.label ?? "" })));
  }, [visible, goal]);

  const targetN = Number(target);
  const canSave = !!name.trim() && targetN > 0;

  function toggleAccount(id: string) {
    setFunding((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  }

  async function save() {
    if (!canSave) return Alert.alert("A name and a target amount are required");
    const ms = milestones.filter((m) => m.amount.trim() || m.date || m.label.trim());
    if (ms.some((m) => !(Number(m.amount) > 0) || !m.date)) return Alert.alert("Each milestone needs an amount and a date");
    const input: Record<string, unknown> = {
      ...(goal ? { goalId: goal.id } : {}),
      name: name.trim(),
      targetAmount: targetN,
      targetDate: targetDate || null,
      fundingAccountIds: funding,
      notes: notes.trim() || null,
      active,
      milestones: ms.map((m) => ({ ...(m.id ? { id: m.id } : {}), targetAmount: Number(m.amount), targetDate: m.date, label: m.label.trim() || null })),
    };
    if (!funding.length && current.trim()) input.currentAmount = Number(current) || 0;
    if (priority.trim() && Number.isFinite(Number(priority))) input.priority = Math.round(Number(priority));
    setBusy(true);
    const r = await callOp("save_finance_goal", input as any);
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't save", r.error);
    onSaved();
  }

  const update = (i: number, patch: Partial<MilestoneDraft>) => setMilestones(milestones.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  return (
    <FormSheet visible={visible} title={goal ? "Edit goal" : "New goal"} onClose={onClose} onSave={save} busy={busy} canSave={canSave}>
      <Field label="Name">
        <Input value={name} onChangeText={setName} placeholder="Emergency fund" autoFocus={!goal} />
      </Field>
      <Field label="Target">
        <Input value={target} onChangeText={(v) => setTarget(cleanAmount(v))} placeholder="0" keyboardType="decimal-pad" />
      </Field>
      <Field label="By">
        <DateField value={targetDate} onChange={setTargetDate} placeholder="No date" clearable />
      </Field>
      <Field label="Funded by" hint={funding.length ? "Progress follows these accounts' balances, drawn on in the order picked." : "None picked: progress is tracked by hand."}>
        <View style={fs.chipRow}>
          {accounts.map((a) => {
            const i = funding.indexOf(a.id);
            return <Chip key={a.id} label={i >= 0 && funding.length > 1 ? `${i + 1}. ${a.name}` : a.name} on={i >= 0} onPress={() => toggleAccount(a.id)} />;
          })}
        </View>
      </Field>
      {!funding.length && (
        <Field label="Saved so far">
          <Input value={current} onChangeText={(v) => setCurrent(cleanAmount(v))} placeholder="0" keyboardType="decimal-pad" />
        </Field>
      )}
      <Field label="Priority" hint="Lower fills first when goals share an account.">
        <Input value={priority} onChangeText={(v) => setPriority(v.replace(/[^0-9-]/g, ""))} placeholder="100" keyboardType="number-pad" />
      </Field>

      <View style={ff.box}>
        <Text style={ff.label}>Milestones</Text>
        {milestones.map((m, i) => (
          <View key={m.id ?? `new-${i}`} style={{ gap: 6, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: "#eee" }}>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Input style={{ flex: 1 }} value={m.label} onChangeText={(v) => update(i, { label: v })} placeholder="Label (optional)" />
              <Input style={{ width: 110 }} value={m.amount} onChangeText={(v) => update(i, { amount: cleanAmount(v) })} placeholder="$ amount" keyboardType="decimal-pad" />
              <Pressable onPress={() => setMilestones(milestones.filter((_, j) => j !== i))} hitSlop={8}>
                <Ionicons name="trash-outline" size={18} color="#c44" />
              </Pressable>
            </View>
            <DateField value={m.date} onChange={(v) => update(i, { date: v })} placeholder="By when" />
          </View>
        ))}
        <Pressable style={ff.smallBtn} onPress={() => setMilestones([...milestones, { amount: "", date: "", label: "" }])}>
          <Ionicons name="add" size={14} color={ACCENT} />
          <Text style={ff.smallBtnText}>Add milestone</Text>
        </Pressable>
      </View>

      <Field label="Notes">
        <Input value={notes} onChangeText={setNotes} multiline />
      </Field>
      {goal && (
        <View style={ff.box}>
          <View style={ff.switchRow}>
            <Text style={fs.textFlex}>Active (off = archived)</Text>
            <Switch value={active} onValueChange={setActive} />
          </View>
        </View>
      )}
    </FormSheet>
  );
}
