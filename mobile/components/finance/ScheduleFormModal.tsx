// Add or edit a scheduled transaction (mortgage, a utility, a person's
// contribution): save_finance_schedule, same fields as the web's form.

import { useEffect, useState } from "react";
import { Alert, Switch, Text, View } from "react-native";

import { callOp } from "../../lib/ops";
import { usePeople } from "../../lib/use-people";
import { CADENCE_LABELS, CADENCES, todayIso, type Cadence } from "../../../lib/finance/dates";
import { CategoryField, DateField, Field, FormSheet, Input, PersonChips, cleanAmount, ff } from "./form";
import { Chip, fs, type OpResultOf } from "./ui";

export type FinanceSchedule = OpResultOf<"list_finance_schedules">["schedules"][number];
export type AccountRef = { id: string; name: string; type: string | null };

const TYPES = [
  { key: "EXPENSE", label: "Money out" },
  { key: "INCOME", label: "Money in" },
  { key: "TRANSFER", label: "Transfer" },
] as const;
type ScheduleType = (typeof TYPES)[number]["key"];

export function ScheduleFormModal({
  visible,
  schedule,
  accounts,
  onClose,
  onSaved,
}: {
  visible: boolean;
  schedule: FinanceSchedule | null;
  accounts: AccountRef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { people } = usePeople();
  const [description, setDescription] = useState("");
  const [type, setType] = useState<ScheduleType>("EXPENSE");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Cadence>("MONTHLY");
  const [nextDate, setNextDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [category, setCategory] = useState("");
  const [personId, setPersonId] = useState("");
  const [matchPattern, setMatchPattern] = useState("");
  const [autopay, setAutopay] = useState(true);
  const [active, setActive] = useState(true);
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const s = schedule;
    const checking = accounts.find((a) => a.type === "CHECKING") ?? accounts[0];
    setDescription(s?.description ?? "");
    setType(((s?.type as ScheduleType) ?? "EXPENSE") || "EXPENSE");
    setAmount(s ? String(Math.abs(s.amount ?? 0)) : "");
    setCadence(((s?.cadence as Cadence) ?? "MONTHLY") || "MONTHLY");
    setNextDate(s?.nextDate ?? s?.startDate ?? todayIso());
    setEndDate(s?.endDate ?? "");
    setAccountId(s?.accountId ?? checking?.id ?? "");
    setToAccountId(s?.toAccountId ?? "");
    setCategory(s?.category ?? "");
    setPersonId(s?.personId ?? "");
    setMatchPattern(s?.matchPattern ?? "");
    setAutopay(s ? s.autopay : true);
    setActive(s ? s.active : true);
    setUrl(s?.url ?? "");
    setNotes(s?.notes ?? "");
  }, [visible, schedule, accounts]);

  const n = Number(amount);
  const canSave = !!description.trim() && Number.isFinite(n) && n > 0 && !!nextDate;

  async function save() {
    if (!canSave) return Alert.alert("Description, a positive amount and the next date are required");
    setBusy(true);
    const r = await callOp("save_finance_schedule", {
      ...(schedule ? { recurringId: schedule.id } : {}),
      description: description.trim(),
      type,
      amount: n,
      cadence,
      nextDate,
      endDate: endDate || null,
      category: category.trim() || null,
      ...(accountId ? { accountId } : {}),
      toAccountId: type === "TRANSFER" ? toAccountId || null : null,
      personId: type === "INCOME" ? personId || null : null,
      matchPattern: matchPattern.trim() || null,
      autopay,
      active,
      url: url.trim() || null,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't save", r.error);
    onSaved();
  }

  return (
    <FormSheet visible={visible} title={schedule ? "Edit scheduled" : "New scheduled"} onClose={onClose} onSave={save} busy={busy} canSave={canSave}>
      <Field label="Description">
        <Input value={description} onChangeText={setDescription} placeholder="Mortgage" autoFocus={!schedule} />
      </Field>
      <Field label="Type">
        <View style={fs.chipRow}>
          {TYPES.map((t) => (
            <Chip key={t.key} label={t.label} on={type === t.key} onPress={() => setType(t.key)} />
          ))}
        </View>
      </Field>
      <Field label="Amount">
        <Input value={amount} onChangeText={(v) => setAmount(cleanAmount(v))} placeholder="0.00" keyboardType="decimal-pad" />
      </Field>
      <Field label="How often">
        <View style={fs.chipRow}>
          {CADENCES.map((c) => (
            <Chip key={c} label={CADENCE_LABELS[c]} on={cadence === c} onPress={() => setCadence(c)} />
          ))}
        </View>
      </Field>
      <Field label="Next due">
        <DateField value={nextDate} onChange={setNextDate} />
      </Field>
      <Field label="Ends">
        <DateField value={endDate} onChange={setEndDate} placeholder="Never" clearable />
      </Field>
      {accounts.length > 1 && (
        <Field label={type === "TRANSFER" ? "From account" : "Account"}>
          <View style={fs.chipRow}>
            {accounts.map((a) => (
              <Chip key={a.id} label={a.name} on={accountId === a.id} onPress={() => setAccountId(a.id)} />
            ))}
          </View>
        </Field>
      )}
      {type === "TRANSFER" && (
        <Field label="To account">
          <View style={fs.chipRow}>
            {accounts
              .filter((a) => a.id !== accountId)
              .map((a) => (
                <Chip key={a.id} label={a.name} on={toAccountId === a.id} onPress={() => setToAccountId(a.id)} />
              ))}
          </View>
        </Field>
      )}
      {type === "INCOME" && (
        <Field label="Contributor">
          <PersonChips people={people} value={personId} onChange={setPersonId} noneLabel="None" />
        </Field>
      )}
      <Field label="Category">
        <CategoryField value={category} onChange={setCategory} placeholder="None" />
      </Field>
      <Field label="Match pattern" hint="A word from the bank description (e.g. ROCKET MORTGAGE), so the sync links the posted transaction and rolls the date on.">
        <Input value={matchPattern} onChangeText={setMatchPattern} autoCapitalize="characters" autoCorrect={false} />
      </Field>
      <View style={ff.box}>
        <View style={ff.switchRow}>
          <Text style={fs.textFlex}>Autopay</Text>
          <Switch value={autopay} onValueChange={setAutopay} />
        </View>
        <View style={ff.switchRow}>
          <Text style={fs.textFlex}>Active</Text>
          <Switch value={active} onValueChange={setActive} />
        </View>
      </View>
      <Field label="Link">
        <Input value={url} onChangeText={setUrl} placeholder="https://…" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      </Field>
      <Field label="Notes">
        <Input value={notes} onChangeText={setNotes} multiline />
      </Field>
    </FormSheet>
  );
}
