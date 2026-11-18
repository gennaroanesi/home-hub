// Change a budget line's name or amount from a month on, or end it. Budget
// lines are versioned (save_finance_budget): the change starts on `from`
// (no earlier than this month, as on the web), earlier months keep theirs.
// New spending lines: NewBudgetLineModal. Categories of an existing line and
// version history stay on the web's Budget page.

import { useEffect, useState } from "react";
import { Alert, Pressable, Text } from "react-native";

import { callOp } from "../../lib/ops";
import { fmtDate, monthEnd, todayIso } from "../../../lib/finance/dates";
import { Field, FormSheet, Input, cleanAmount, ff } from "./form";
import { fs } from "./ui";

export type BudgetLineRef = {
  seriesId: string;
  /** The version shown; a line for a stretch of dates is corrected in place. */
  id?: string;
  name: string;
  amount: number;
  period: string;
  categories?: string[];
  /** One amount for these dates (a one-off line with an end): changes keep its dates. */
  span?: { from: string; to: string };
};

export function BudgetLineModal({ line, from, onClose, onSaved }: { line: BudgetLineRef | null; from: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!line) return;
    setName(line.name);
    setAmount("");
  }, [line]);

  if (!line) return null;
  const n = Number(amount);
  const changed = (amount.trim() && n > 0) || (name.trim() && name.trim() !== line.name);

  async function save() {
    if (!line || !changed) return onClose();
    setBusy(true);
    const r = await callOp("save_finance_budget", {
      seriesId: line.seriesId,
      ...(line.span && line.id ? { versionId: line.id } : { effectiveFrom: from }),
      ...(name.trim() && name.trim() !== line.name ? { name: name.trim() } : {}),
      ...(amount.trim() && n > 0 ? { amount: n } : {}),
    });
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't save", r.error);
    onSaved();
  }

  function end() {
    if (!line) return;
    const endOn = monthEnd(todayIso());
    Alert.alert(`End “${line.name}”?`, `It stops after ${fmtDate(endOn, { month: "short", day: "numeric", year: "numeric" })}. Past months keep it.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "End",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const r = await callOp("save_finance_budget", { seriesId: line.seriesId, endOn });
          setBusy(false);
          if ("error" in r) return Alert.alert("Couldn't end it", r.error);
          onSaved();
        },
      },
    ]);
  }

  const perLabel = line.period === "MONTHLY" ? "month" : line.period === "QUARTERLY" ? "quarter" : line.period === "ANNUALLY" ? "year" : "once";
  const d = (iso: string) => fmtDate(iso, { month: "short", day: "numeric", year: "numeric" });
  return (
    <FormSheet visible={!!line} title="Budget line" onClose={onClose} onSave={save} busy={busy}>
      {line.categories?.length ? <Text style={fs.muted}>Covers {line.categories.join(", ")}</Text> : null}
      <Field label="Name">
        <Input value={name} onChangeText={setName} />
      </Field>
      {line.span ? (
        <Field label="Amount" hint={`One amount for ${d(line.span.from)} – ${d(line.span.to)}. Change the dates on the web.`}>
          <Input value={amount} onChangeText={(v) => setAmount(cleanAmount(v))} placeholder={String(line.amount)} keyboardType="decimal-pad" />
        </Field>
      ) : (
        <>
          <Field label={`Amount per ${perLabel}`} hint={`From ${fmtDate(from, { month: "long", year: "numeric" })} on; earlier months keep their amount.`}>
            <Input value={amount} onChangeText={(v) => setAmount(cleanAmount(v))} placeholder={String(line.amount)} keyboardType="decimal-pad" />
          </Field>
          <Pressable style={ff.dangerBtn} onPress={end} disabled={busy}>
            <Text style={ff.dangerText}>End this budget line</Text>
          </Pressable>
        </>
      )}
    </FormSheet>
  );
}
