// Add / edit / review a paycheck (homePaycheck), the phone's version of the
// web's PaycheckForm: manual entry, editing a saved stub, and reviewing an
// emailed one from homePaycheckInbox (saving marks that row IMPORTED). The
// field spec, checks and the row written come from
// lib/finance/paycheck-screen.ts. No PDF upload here (see the screen).

import { useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { getClient } from "../../lib/amplify";
import { fmtCurrency } from "../../../lib/finance/dates";
import {
  PAYCHECK_FILING_STATUSES,
  PAYCHECK_LINE_ITEM_TYPES,
  PAYCHECK_NUM_GROUPS,
  paycheckFormProblem,
  paycheckFormState,
  paycheckRow,
  paycheckSanityGap,
  type PaycheckFormState,
  type PaycheckLineItemType,
} from "../../../lib/finance/paycheck-screen";
import { DateField, Field, FormSheet, Input, ff } from "./form";
import { ACCENT, Chip, WARN, fs } from "./ui";
import { openFinancePdf } from "./paycheck-screen-pdf";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type PaycheckFormInit = {
  id?: string;
  personId?: string | null;
  source: "EMAIL" | "UPLOAD" | "MANUAL" | "IMPORT";
  s3KeyPdf?: string | null;
  inboxId?: string | null;
  warning?: string | null;
  /** homePaycheck-shaped fields (a saved row or an inbox draft). */
  values?: Record<string, unknown>;
};

const errText = (e: any) => e?.errors?.[0]?.message ?? e?.message ?? String(e);

export function PaycheckFormSheet({
  init,
  people,
  onClose,
  onSaved,
}: {
  init: PaycheckFormInit | null;
  people: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<PaycheckFormState>(() => paycheckFormState(init?.values, init?.personId));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (init) setF(paycheckFormState(init.values, init.personId));
  }, [init]);

  const set = <K extends keyof PaycheckFormState>(k: K, v: PaycheckFormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const setNum = (k: string, v: string) => setF((s) => ({ ...s, nums: { ...s.nums, [k]: v } }));
  const setItem = (i: number, patch: Partial<PaycheckFormState["items"][number]>) => setF((s) => ({ ...s, items: s.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));

  const gap = paycheckSanityGap(f);

  async function save() {
    if (!init) return;
    const problem = paycheckFormProblem(f);
    if (problem) return Alert.alert(problem);
    const row = paycheckRow(f);
    const client = getClient();
    setBusy(true);
    try {
      let savedId = init.id;
      if (init.id) {
        const r = await client.models.homePaycheck.update({ id: init.id, ...(row as any) });
        if (r.errors?.length) throw new Error(r.errors[0].message);
      } else {
        const r = await client.models.homePaycheck.create({ ...(row as any), source: init.source, s3KeyPdf: init.s3KeyPdf ?? null });
        if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
        savedId = r.data.id;
      }
      if (init.inboxId && savedId) {
        const r = await client.models.homePaycheckInbox.update({ id: init.inboxId, status: "IMPORTED", paycheckId: savedId, personId: f.personId } as any);
        if (r.errors?.length) Alert.alert("Saved, but couldn't mark the email imported", r.errors[0].message);
      }
      onSaved();
    } catch (e) {
      Alert.alert("Couldn't save", errText(e));
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    if (!init?.id) return;
    Alert.alert("Delete this paycheck?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const r = await getClient().models.homePaycheck.delete({ id: init.id! });
          if (r.errors?.length) return Alert.alert("Couldn't delete", r.errors[0].message);
          onSaved();
        },
      },
    ]);
  }

  const title = init?.id ? "Edit paycheck" : init?.inboxId ? "Review emailed stub" : "Add paycheck";

  return (
    <FormSheet visible={!!init} title={title} onClose={onClose} onSave={save} busy={busy}>
      {init?.s3KeyPdf ? (
        <Pressable onPress={() => void openFinancePdf(init.s3KeyPdf)} style={ff.smallBtn}>
          <Ionicons name="document-text-outline" size={16} color={ACCENT} />
          <Text style={ff.smallBtnText}>Open the PDF</Text>
        </Pressable>
      ) : null}
      {init?.warning ? <Text style={[fs.text, { color: WARN }]}>{init.warning}</Text> : null}

      <Field label="Person">
        <View style={fs.chipRow}>
          {people.map((p) => (
            <Chip key={p.id} label={p.name} on={f.personId === p.id} onPress={() => set("personId", p.id)} />
          ))}
        </View>
      </Field>
      <Field label="Pay date">
        <DateField value={f.payDate} onChange={(v) => set("payDate", v)} />
      </Field>
      <Field label="Period start">
        <DateField value={f.periodStart} onChange={(v) => set("periodStart", v)} placeholder="Optional" clearable />
      </Field>
      <Field label="Period end">
        <DateField value={f.periodEnd} onChange={(v) => set("periodEnd", v)} placeholder="Optional" clearable />
      </Field>
      <Field label="Employer">
        <Input value={f.employer} onChangeText={(v) => set("employer", v)} placeholder="Optional" />
      </Field>

      {PAYCHECK_NUM_GROUPS.map((g) => (
        <View key={g.title} style={ff.box}>
          <Text style={ff.label}>{g.title}</Text>
          {g.title === "W-4" && (
            <Field label="Filing status">
              <View style={fs.chipRow}>
                {PAYCHECK_FILING_STATUSES.map((s) => (
                  <Chip key={s} label={s} on={f.filing === s} onPress={() => set("filing", f.filing === s ? "" : s)} />
                ))}
              </View>
            </Field>
          )}
          {g.fields.map(([k, label]) => (
            <View key={k} style={[fs.rowBetween, { gap: 12 }]}>
              <Text style={fs.textFlex}>
                {label}
                {k === "gross" || k === "net" ? <Text style={{ color: WARN }}> *</Text> : null}
              </Text>
              <Input value={f.nums[k] ?? ""} onChangeText={(v) => setNum(k, v)} keyboardType="decimal-pad" placeholder="$" style={{ width: 130, textAlign: "right" }} />
            </View>
          ))}
        </View>
      ))}

      {gap != null && (
        <Text style={[fs.muted, { color: WARN }]}>
          Gross differs from taxes + deductions + net by {fmtCurrency(gap)}. Fine if the stub has deductions not entered here (add them as line items).
        </Text>
      )}

      <View style={ff.box}>
        <View style={fs.rowBetween}>
          <Text style={ff.label}>Other line items</Text>
          <Pressable onPress={() => set("items", [...f.items, { name: "", amount: "", ytd: "", type: "PRETAX" }])} hitSlop={8}>
            <Text style={fs.link}>+ Add line</Text>
          </Pressable>
        </View>
        {f.items.length === 0 && <Text style={fs.muted}>Parking, ESPP, employer match, life insurance…</Text>}
        {f.items.map((it, i) => (
          <View key={i} style={{ gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#f0f0f0" }}>
            <View style={[fs.rowBetween, { gap: 8 }]}>
              <Input value={it.name} onChangeText={(v) => setItem(i, { name: v })} placeholder="Name" style={{ flex: 1 }} />
              <Pressable onPress={() => set("items", f.items.filter((_, j) => j !== i))} hitSlop={8} accessibilityLabel="Remove line">
                <Ionicons name="trash-outline" size={18} color="#999" />
              </Pressable>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Input value={it.amount} onChangeText={(v) => setItem(i, { amount: v })} placeholder="Amount" keyboardType="decimal-pad" style={{ flex: 1 }} />
              <Input value={it.ytd} onChangeText={(v) => setItem(i, { ytd: v })} placeholder="YTD" keyboardType="decimal-pad" style={{ flex: 1 }} />
            </View>
            <View style={fs.chipRow}>
              {PAYCHECK_LINE_ITEM_TYPES.map((t) => (
                <Chip key={t} label={t.replace("_", " ").toLowerCase()} on={it.type === t} onPress={() => setItem(i, { type: t as PaycheckLineItemType })} />
              ))}
            </View>
          </View>
        ))}
      </View>

      <Field label="Notes">
        <Input value={f.notes} onChangeText={(v) => set("notes", v)} multiline placeholder="Optional" />
      </Field>

      {init?.id ? (
        <Pressable onPress={remove} style={ff.dangerBtn}>
          <Text style={ff.dangerText}>Delete paycheck</Text>
        </Pressable>
      ) : null}
    </FormSheet>
  );
}
