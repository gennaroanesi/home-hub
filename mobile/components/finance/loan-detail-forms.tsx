// The loan screen's sheets (app/(tabs)/finance/loan.tsx): edit a loan's
// terms (save_finance_loan, incl. what secures it and the scheduled
// transaction that pays it, or remove it) and record / fix / delete a
// payment (record_loan_payment). Form ⇄ op input and the suggested split
// come from lib/finance/loan-detail.ts, like the web's modals.

import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, Switch, Text, View } from "react-native";

import { callOp } from "../../lib/ops";
import { DateField, Field, FormSheet, Input, ff } from "./form";
import { Chip, fs } from "./ui";
import { fmtCurrency, fmtDate, round2, todayIso } from "../../../lib/finance/dates";
import { INTEREST_ACCRUALS, LOAN_TYPES, LOAN_TYPE_LABELS } from "../../../lib/finance/loans";
import {
  NEW_SCHEDULE,
  NO_SCHEDULE,
  estimatePaymentSplit,
  formContractualPayment,
  loanTermsFormFrom,
  loanTermsOf,
  loanTermsSaveInput,
  newPaymentDraft,
  numOrNull,
  type LoanTermsForm,
} from "../../../lib/finance/loan-detail";

/* eslint-disable @typescript-eslint/no-explicit-any */

const ACCRUAL_SHORT: Record<string, string> = { MONTHLY: "Monthly", DAILY: "Daily (simple interest)" };
const str = (n: number | null | undefined) => (n == null ? "" : String(n));
/** A non-negative number as typed: digits and one dot. */
const cleanNum = (v: string) => {
  const c = v.replace(/[^0-9.]/g, "");
  const [a, ...rest] = c.split(".");
  return rest.length ? `${a}.${rest.join("")}` : a;
};

// ── Terms ──────────────────────────────────────────────────────────────────

export function LoanTermsSheet({
  visible,
  loan,
  account,
  accounts,
  assets,
  schedules,
  onClose,
  onSaved,
}: {
  visible: boolean;
  loan: any;
  account: any | null;
  accounts: any[];
  assets: any[];
  schedules: any[];
  onClose: () => void;
  /** removed: the loan's terms were deleted. */
  onSaved: (removed: boolean) => void;
}) {
  const [f, setF] = useState<LoanTermsForm | null>(null);
  const [busy, setBusy] = useState(false);
  const synced = !!account?.simplefinAccountId;

  useEffect(() => {
    if (visible && loan) setF(loanTermsFormFrom(loan, account, accounts));
    // Only when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const computed = useMemo(() => (f ? formContractualPayment(f) : null), [f]);
  const payable = schedules.filter((s) => s.active !== false && s.type !== "INCOME").sort((a, b) => (a.description ?? "").localeCompare(b.description ?? ""));
  const payFrom = accounts.filter((a) => a.active !== false && (a.type === "CHECKING" || a.type === "SAVINGS"));
  if (!f) return null;
  const set = <K extends keyof LoanTermsForm>(k: K) => (v: LoanTermsForm[K]) => setF((x) => (x ? { ...x, [k]: v } : x));
  const linked = schedules.find((s) => s.id === f.recurringId);

  async function save() {
    if (!f) return;
    const r = loanTermsSaveInput(f, loan, account);
    if ("error" in r) return Alert.alert(r.error);
    setBusy(true);
    const out = await callOp("save_finance_loan", r.input as any);
    setBusy(false);
    if ("error" in out) return Alert.alert("Couldn't save", out.error);
    onSaved(false);
  }

  function remove() {
    Alert.alert("Remove this loan?", "Its terms and payment history go; the account and its balance stay.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const out = await callOp("save_finance_loan", { loanId: loan.id, remove: true });
          setBusy(false);
          if ("error" in out) return Alert.alert("Couldn't remove", out.error);
          onSaved(true);
        },
      },
    ]);
  }

  return (
    <FormSheet visible={visible} title={`Edit ${account?.name ?? "loan"}`} onClose={onClose} onSave={save} busy={busy}>
      <Text style={fs.muted}>
        Balance from {account?.name ?? "its account"} · {synced ? "synced from the bank" : "manual: moves with recorded payments"}
      </Text>
      {!synced && (
        <Field label="Owed today" hint="Correct it to the lender's statement">
          <Input value={f.owed} onChangeText={(v) => set("owed")(cleanNum(v))} keyboardType="decimal-pad" placeholder="0" />
        </Field>
      )}
      <Field label="Kind">
        <View style={fs.chipRow}>
          {LOAN_TYPES.map((t) => (
            <Chip key={t} label={LOAN_TYPE_LABELS[t]} on={f.loanType === t} onPress={() => set("loanType")(t)} />
          ))}
        </View>
      </Field>
      <Field label="Lender">
        <Input value={f.lender} onChangeText={set("lender")} placeholder="BMW Financial" />
      </Field>
      <Field label="Original amount">
        <Input value={f.originalPrincipal} onChangeText={(v) => set("originalPrincipal")(cleanNum(v))} keyboardType="decimal-pad" />
      </Field>
      <Field label="Interest rate (%)">
        <Input value={f.ratePct} onChangeText={(v) => set("ratePct")(cleanNum(v))} keyboardType="decimal-pad" placeholder="4.5" />
      </Field>
      <Field label="Term (months)" hint={numOrNull(f.termMonths) ? `${round2(numOrNull(f.termMonths)! / 12)} years` : undefined}>
        <Input value={f.termMonths} onChangeText={(v) => set("termMonths")(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" />
      </Field>
      <Field label="First payment" hint="Payments fall on this day of the month">
        <DateField value={f.firstPaymentDate} onChange={set("firstPaymentDate")} />
      </Field>
      <Field label="Taken out (optional)">
        <DateField value={f.startDate} onChange={set("startDate")} clearable placeholder="—" />
      </Field>
      <Field label="Monthly principal + interest" hint={computed ? `Empty = ${fmtCurrency(computed)} from the terms` : "Empty = computed from the terms"}>
        <Input value={f.monthlyPayment} onChangeText={(v) => set("monthlyPayment")(cleanNum(v))} keyboardType="decimal-pad" placeholder={computed ? String(computed) : ""} />
      </Field>
      <Field label="Escrow per month" hint="Taxes + insurance paid with it">
        <Input value={f.escrowMonthly} onChangeText={(v) => set("escrowMonthly")(cleanNum(v))} keyboardType="decimal-pad" placeholder="0" />
      </Field>
      <Field label="Interest accrues" hint="Daily for simple-interest loans (most auto loans): estimated splits use the days since the last payment">
        <View style={fs.chipRow}>
          {INTEREST_ACCRUALS.map((t) => (
            <Chip key={t} label={ACCRUAL_SHORT[t] ?? t} on={f.interestAccrual === t} onPress={() => set("interestAccrual")(t)} />
          ))}
        </View>
      </Field>
      <Field label="Secured by" hint="For equity: the house for a mortgage, the car for an auto loan">
        <View style={fs.chipRow}>
          <Chip label="Nothing" on={!f.assetId} onPress={() => set("assetId")("")} />
          {assets
            .filter((a) => a.active !== false)
            .map((a) => (
              <Chip key={a.id} label={a.name} on={f.assetId === a.id} onPress={() => set("assetId")(a.id)} />
            ))}
        </View>
      </Field>
      <Field label="Paid by" hint="When the sync links a bank transaction to this scheduled transaction, the payment is recorded here automatically.">
        <View style={fs.chipRow}>
          <Chip label="None" on={f.recurringId === NO_SCHEDULE} onPress={() => set("recurringId")(NO_SCHEDULE)} />
          <Chip label="New from these terms" on={f.recurringId === NEW_SCHEDULE} onPress={() => set("recurringId")(NEW_SCHEDULE)} />
          {payable.map((s) => (
            <Chip key={s.id} label={s.description} on={f.recurringId === s.id} onPress={() => set("recurringId")(s.id)} />
          ))}
        </View>
        {linked && (
          <Text style={ff.hint}>
            {fmtCurrency(linked.amount)} · next {fmtDate(linked.nextDate)}
          </Text>
        )}
      </Field>
      {f.recurringId === NEW_SCHEDULE && (
        <View style={ff.box}>
          <Field label="Paid from">
            <View style={fs.chipRow}>
              {payFrom.map((a) => (
                <Chip key={a.id} label={a.name} on={f.payFromId === a.id} onPress={() => set("payFromId")(a.id)} />
              ))}
            </View>
          </Field>
          <Field label="Bank description contains" hint="So the sync links the bank's rows to it">
            <Input value={f.matchPattern} onChangeText={set("matchPattern")} placeholder="BMW FINANCIAL" autoCapitalize="characters" />
          </Field>
          <Field label="Amount paid each month" hint="Empty = the contractual payment + escrow">
            <Input
              value={f.payAmount}
              onChangeText={(v) => set("payAmount")(cleanNum(v))}
              keyboardType="decimal-pad"
              placeholder={computed ? String(round2(computed + (numOrNull(f.escrowMonthly) ?? 0))) : ""}
            />
          </Field>
          <View style={ff.switchRow}>
            <Text style={fs.text}>Due on the last day of the month</Text>
            <Switch value={f.payLastDay} onValueChange={set("payLastDay")} />
          </View>
        </View>
      )}
      <Field label="Notes">
        <Input value={f.notes} onChangeText={set("notes")} multiline />
      </Field>
      <Pressable onPress={remove} disabled={busy} style={ff.dangerBtn}>
        <Text style={ff.dangerText}>Remove loan</Text>
      </Pressable>
    </FormSheet>
  );
}

// ── Payment ────────────────────────────────────────────────────────────────

type PaymentDraft = { date: string; total: string; principal: string; interest: string; escrow: string; fees: string; isExtra: boolean; paymentNumber: string; notes: string };

export function LoanPaymentSheet({
  payment,
  loan,
  owed,
  synced,
  payments,
  onClose,
  onSaved,
}: {
  /** undefined = closed, null = new. */
  payment: any | null | undefined;
  loan: any;
  owed: number;
  synced: boolean;
  /** The loan's recorded payments (for daily-interest days). */
  payments: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = payment === null;
  const [f, setF] = useState<PaymentDraft>({ date: todayIso(), total: "", principal: "", interest: "", escrow: "", fees: "", isExtra: false, paymentNumber: "", notes: "" });
  const [touchedSplit, setTouchedSplit] = useState(false);
  const [busy, setBusy] = useState(false);
  const terms = useMemo(() => loanTermsOf(loan), [loan]);

  useEffect(() => {
    if (payment === undefined) return;
    if (payment) {
      setF({ date: payment.date, total: str(payment.totalAmount), principal: str(payment.principal), interest: str(payment.interest), escrow: str(payment.escrow), fees: str(payment.fees), isExtra: !!payment.isExtra, paymentNumber: str(payment.paymentNumber), notes: payment.notes ?? "" });
      setTouchedSplit(true);
    } else {
      const d = newPaymentDraft(terms, owed, payments, todayIso());
      setF({ date: d.date, total: str(d.total), principal: str(d.principal), interest: str(d.interest), escrow: d.escrow ? str(d.escrow) : "", fees: "", isExtra: false, paymentNumber: "", notes: "" });
      setTouchedSplit(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment]);

  const estimate = (x: PaymentDraft) =>
    estimatePaymentSplit({ loan: terms, owed, payments, editing: payment ? { id: payment.id, principal: payment.principal } : null, total: numOrNull(x.total) ?? 0, escrow: numOrNull(x.escrow) ?? 0, fees: numOrNull(x.fees) ?? 0, isExtra: x.isExtra, date: x.date });

  /** Change a field that drives the estimate; re-split until the split is typed by hand. */
  function change(patch: Partial<PaymentDraft>) {
    setF((x) => {
      const next = { ...x, ...patch };
      if (touchedSplit) return next;
      const s = estimate(next);
      return { ...next, principal: str(s.principal), interest: str(s.interest) };
    });
  }
  function splitInput(k: "principal" | "interest", v: string) {
    setTouchedSplit(true);
    setF((x) => ({ ...x, [k]: cleanNum(v) }));
  }

  const days = estimate(f).days;
  const sum = round2((numOrNull(f.principal) ?? 0) + (numOrNull(f.interest) ?? 0) + (numOrNull(f.escrow) ?? 0) + (numOrNull(f.fees) ?? 0));
  const total = numOrNull(f.total) ?? 0;
  const off = Math.abs(sum - total) > 0.01;

  async function save() {
    if (!(total > 0)) return Alert.alert("How much was paid?");
    if (off) return Alert.alert("The split doesn't add up", `${fmtCurrency(sum)} vs ${fmtCurrency(total)}`);
    setBusy(true);
    const r = await callOp("record_loan_payment", {
      ...(isNew ? { loanId: loan.id } : { paymentId: payment.id }),
      date: f.date,
      totalAmount: total,
      principal: numOrNull(f.principal) ?? 0,
      interest: numOrNull(f.interest) ?? 0,
      escrow: numOrNull(f.escrow),
      fees: numOrNull(f.fees),
      isExtra: f.isExtra,
      paymentNumber: numOrNull(f.paymentNumber) == null ? null : Math.round(numOrNull(f.paymentNumber)!),
      notes: f.notes.trim() || null,
    });
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't save", r.error);
    onSaved();
  }

  function remove() {
    Alert.alert("Delete this payment?", synced ? undefined : "The loan balance goes back up by its principal.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const r = await callOp("record_loan_payment", { paymentId: payment.id, remove: true });
          setBusy(false);
          if ("error" in r) return Alert.alert("Couldn't delete", r.error);
          onSaved();
        },
      },
    ]);
  }

  const note = off
    ? `The split adds up to ${fmtCurrency(sum)}, not ${fmtCurrency(total)}.`
    : touchedSplit
      ? payment?.estimated
        ? "This split was estimated; typing the statement's numbers makes it exact."
        : "Split as entered."
      : days != null
        ? `Interest estimated as ${days} days on what's owed; use the statement's numbers when you have them.`
        : "Interest estimated as a month on what's owed; use the statement's numbers when you have them.";

  return (
    <FormSheet visible={payment !== undefined} title={isNew ? "Record a payment" : "Edit payment"} onClose={onClose} onSave={save} busy={busy}>
      <Field label="Date">
        <DateField value={f.date} onChange={(v) => change({ date: v })} />
      </Field>
      <Field label="Total paid">
        <Input value={f.total} onChangeText={(v) => change({ total: cleanNum(v) })} keyboardType="decimal-pad" placeholder="0" />
      </Field>
      <View style={ff.switchRow}>
        <Text style={fs.text}>Extra principal payment</Text>
        <Switch value={f.isExtra} onValueChange={(v) => change({ isExtra: v })} />
      </View>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Field label="Principal">
            <Input value={f.principal} onChangeText={(v) => splitInput("principal", v)} keyboardType="decimal-pad" placeholder="0" />
          </Field>
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Interest">
            <Input value={f.interest} onChangeText={(v) => splitInput("interest", v)} keyboardType="decimal-pad" placeholder="0" />
          </Field>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Field label="Escrow">
            <Input value={f.escrow} onChangeText={(v) => change({ escrow: cleanNum(v) })} keyboardType="decimal-pad" placeholder="0" />
          </Field>
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Fees">
            <Input value={f.fees} onChangeText={(v) => change({ fees: cleanNum(v) })} keyboardType="decimal-pad" placeholder="0" />
          </Field>
        </View>
      </View>
      <Text style={[ff.hint, off && { color: "#c0392b" }]}>
        {note}
        {!synced ? " Recording it lowers the balance by the principal." : ""}
      </Text>
      <Field label="Payment #" hint="The lender's number, optional">
        <Input value={f.paymentNumber} onChangeText={(v) => setF((x) => ({ ...x, paymentNumber: v.replace(/[^0-9]/g, "") }))} keyboardType="number-pad" />
      </Field>
      <Field label="Notes">
        <Input value={f.notes} onChangeText={(v) => setF((x) => ({ ...x, notes: v }))} />
      </Field>
      {!isNew && (
        <Pressable onPress={remove} disabled={busy} style={ff.dangerBtn}>
          <Text style={ff.dangerText}>Delete payment</Text>
        </Pressable>
      )}
    </FormSheet>
  );
}
