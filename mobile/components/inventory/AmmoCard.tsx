// Ammo on the phone's Inventory screen (owner-only): rounds per caliber
// against each minimum, "Log use" (oldest purchases first), minimums, and
// recent uses with undo. get_ammo_summary / log_ammo_use /
// save_ammo_threshold, like the web's AmmoPanel.

import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";

import { callOp } from "../../lib/ops";
import { DateField, Field, FormSheet, Input } from "../finance/form";
import { ACCENT, Card, WARN, fs, type OpResultOf } from "../finance/ui";
import { ChipRow } from "./DetailInputs";

type Summary = OpResultOf<"get_ammo_summary">;

export function AmmoCard({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [s, setS] = useState<Summary | null>(null);
  const [mode, setMode] = useState<null | "use" | "min">(null);

  const load = useCallback(async () => {
    const r = await callOp("get_ammo_summary", {});
    setS("error" in r ? null : r.result);
  }, []);
  useEffect(() => {
    void load();
  }, [load, version]);

  if (!s || s.calibers.length === 0) return null;

  async function undo(id: string) {
    const r = await callOp("log_ammo_use", { undoUseId: id });
    if ("error" in r) return Alert.alert("Couldn't undo", r.error);
    await load();
    onChanged();
  }

  return (
    <Card title="Ammo · only you see this">
      {s.calibers.map((c) => (
        <View key={c.caliber} style={fs.rowBetween}>
          <Text style={fs.textFlex}>{c.caliber}</Text>
          <Text style={[fs.money, c.below && { color: WARN, fontWeight: "600" }]}>
            {c.rounds.toLocaleString()} rds
            {c.minRounds != null ? <Text style={fs.muted}> / min {c.minRounds.toLocaleString()}</Text> : null}
          </Text>
        </View>
      ))}
      {s.recentUses.slice(0, 2).map((u) => (
        <View key={u.id} style={fs.rowBetween}>
          <Text style={[fs.muted, { flex: 1 }]} numberOfLines={1}>
            {u.date} · {u.rounds} × {u.caliber}
            {u.note ? ` · ${u.note}` : ""}
          </Text>
          <Pressable onPress={() => void undo(u.id)} hitSlop={8}>
            <Text style={[fs.muted, { color: ACCENT }]}>undo</Text>
          </Pressable>
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
        <Btn label="Log use" primary onPress={() => setMode("use")} />
        <Btn label="Minimums" onPress={() => setMode("min")} />
      </View>
      <AmmoSheet
        mode={mode}
        calibers={s.calibers}
        onClose={() => setMode(null)}
        onDone={async () => {
          setMode(null);
          await load();
          onChanged();
        }}
      />
    </Card>
  );
}

function Btn({ label, primary, onPress }: { label: string; primary?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [{ flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: "center", backgroundColor: primary ? ACCENT : "#f1ece9" }, pressed && fs.pressed]}
    >
      <Text style={{ color: primary ? "#fff" : ACCENT, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function AmmoSheet({ mode, calibers, onClose, onDone }: { mode: null | "use" | "min"; calibers: Summary["calibers"]; onClose: () => void; onDone: () => void }) {
  const [caliber, setCaliber] = useState("");
  const [rounds, setRounds] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mode) return;
    const first = calibers[0];
    setCaliber(first?.caliber ?? "");
    setRounds(mode === "min" && first?.minRounds != null ? String(first.minRounds) : "");
    setDate("");
    setNote("");
  }, [mode, calibers]);

  async function save() {
    const n = Number(rounds);
    if (!caliber || !Number.isInteger(n) || n < 0) return Alert.alert("Pick a caliber and a whole number of rounds");
    setBusy(true);
    try {
      if (mode === "use") {
        const r = await callOp("log_ammo_use", { caliber, rounds: n, ...(date ? { date } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
        if ("error" in r) throw new Error(r.error);
        if (r.result.shortfall) Alert.alert("Logged", `${r.result.shortfall} more rounds than you had on record; ${r.result.remaining} left.`);
      } else {
        const r = await callOp("save_ammo_threshold", { caliber, minRounds: n });
        if ("error" in r) throw new Error(r.error);
      }
      onDone();
    } catch (err) {
      Alert.alert("Couldn't save", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormSheet visible={!!mode} title={mode === "use" ? "Log ammo use" : "Minimum rounds"} onClose={onClose} onSave={save} busy={busy} canSave={!!caliber && rounds !== ""}>
      <Field label="Caliber">
        <ChipRow
          options={calibers.map((c) => ({ value: c.caliber, label: `${c.caliber} · ${c.rounds.toLocaleString()}` }))}
          value={caliber}
          onChange={(v) => {
            setCaliber(v);
            const c = calibers.find((x) => x.caliber === v);
            if (mode === "min") setRounds(c?.minRounds != null ? String(c.minRounds) : "");
          }}
        />
      </Field>
      <Field label={mode === "use" ? "Rounds used" : "Keep at least"} hint={mode === "use" ? "Taken from the oldest purchases first" : "0 removes it. Below it you get a WhatsApp message."}>
        <Input value={rounds} onChangeText={(t) => setRounds(t.replace(/[^0-9]/g, ""))} keyboardType="number-pad" autoFocus />
      </Field>
      {mode === "use" && (
        <>
          <Field label="Date" hint="Default today">
            <DateField value={date} onChange={setDate} clearable />
          </Field>
          <Field label="Note">
            <Input value={note} onChangeText={setNote} placeholder="Range day" />
          </Field>
        </>
      )}
    </FormSheet>
  );
}
