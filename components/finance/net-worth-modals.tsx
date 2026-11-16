"use client";

// Editors for the net worth pages: an asset (with its value history), a
// loan's terms (on an existing LOAN account or a new manual one) and a loan
// payment. Each writes through its op (save_finance_asset,
// save_finance_loan, record_loan_payment) and calls onSaved.

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Switch } from "@heroui/switch";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast } from "@heroui/react";
import { FaTrash } from "react-icons/fa";

import { financeClient } from "@/components/finance/client";
import { Money } from "@/components/finance/ui";
import { callOp } from "@/lib/ops-client";
import { fmtCurrency, fmtDate, round2, todayIso } from "@/lib/finance/dates";
import { LOAN_TYPES, LOAN_TYPE_LABELS, contractualPayment, suggestSplit } from "@/lib/finance/loans";
import { ASSET_TYPES, ASSET_TYPE_LABELS } from "@/lib/finance/net-worth";

const $ = <span className="text-default-400 text-sm">$</span>;
const num = (s: string): number | null => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
const str = (n: number | null | undefined) => (n == null ? "" : String(n));

function toastError(title: string, description: string) {
  addToast({ title, description, color: "danger" });
}

// ── Asset ──────────────────────────────────────────────────────────────────

export function AssetModal({
  asset,
  valuations,
  loans,
  onClose,
  onSaved,
}: {
  asset: any | null | undefined; // undefined = closed, null = new
  valuations: any[];
  loans: Array<{ id: string; name: string; owed: number }>; // the loans it secures
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = asset === null;
  const [f, setF] = useState({ name: "", type: "REAL_ESTATE", purchaseValue: "", purchaseDate: "", value: "", valuedOn: todayIso(), valueSource: "ESTIMATE", valueNotes: "", sold: false, soldDate: "", soldValue: "", notes: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (asset === undefined) return;
    setF({
      name: asset?.name ?? "",
      type: asset?.type ?? "REAL_ESTATE",
      purchaseValue: str(asset?.purchaseValue),
      purchaseDate: asset?.purchaseDate ?? "",
      value: "",
      valuedOn: todayIso(),
      valueSource: "ESTIMATE",
      valueNotes: "",
      sold: !!asset?.soldDate,
      soldDate: asset?.soldDate ?? "",
      soldValue: str(asset?.soldValue),
      notes: asset?.notes ?? "",
    });
  }, [asset]);

  const history = useMemo(() => (asset ? valuations.filter((v) => v.assetId === asset.id).sort((a, b) => b.date.localeCompare(a.date)) : []), [asset, valuations]);

  async function run(input: any, done = true) {
    setSaving(true);
    const r = await callOp(financeClient, "save_finance_asset", input);
    setSaving(false);
    if ("error" in r) {
      toastError("Couldn't save", r.error);
      return false;
    }
    onSaved();
    if (done) onClose();
    return true;
  }

  async function save() {
    if (!f.name.trim()) return toastError("Missing name", "Give it a name");
    const value = num(f.value);
    const input: any = {
      ...(isNew ? {} : { assetId: asset.id }),
      name: f.name.trim(),
      type: f.type,
      purchaseValue: num(f.purchaseValue),
      purchaseDate: f.purchaseDate || null,
      notes: f.notes.trim() || null,
      ...(value != null ? { value, valuedOn: f.valuedOn || todayIso(), valueSource: f.valueSource, valueNotes: f.valueNotes.trim() || undefined } : {}),
    };
    if (isNew && value == null && input.purchaseValue == null) return toastError("Missing value", "Give today's value or what it cost");
    if (f.sold) {
      if (!f.soldDate) return toastError("Missing date", "When was it sold?");
      Object.assign(input, { soldDate: f.soldDate, soldValue: num(f.soldValue) });
    } else if (asset?.soldDate) Object.assign(input, { soldDate: null, soldValue: null });
    await run(input);
  }

  return (
    <Modal isOpen={asset !== undefined} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{isNew ? "New asset" : `Edit ${asset?.name ?? "asset"}`}</ModalHeader>
        <ModalBody>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Name" placeholder="Home, 2023 BMW m850i" value={f.name} onValueChange={(v) => setF({ ...f, name: v })} isRequired />
            <Select label="Type" selectedKeys={[f.type]} onSelectionChange={(k) => setF({ ...f, type: String(Array.from(k as Set<string>)[0] ?? "OTHER") })}>
              {ASSET_TYPES.map((t) => (
                <SelectItem key={t}>{ASSET_TYPE_LABELS[t]}</SelectItem>
              ))}
            </Select>
            <Input label="Purchase price" type="number" min={0} startContent={$} value={f.purchaseValue} onValueChange={(v) => setF({ ...f, purchaseValue: v })} />
            <Input label="Purchase date" type="date" placeholder=" " value={f.purchaseDate} onValueChange={(v) => setF({ ...f, purchaseDate: v })} />

            <div className="sm:col-span-2 text-sm font-medium mt-2">
              {isNew ? "Value today" : "New value"}
              {!isNew && asset && (
                <span className="text-default-500 font-normal">
                  {" "}
                  · now <Money value={asset.currentValue} cents={false} /> as of {fmtDate(asset.valuedOn, { month: "short", day: "numeric", year: "numeric" })}
                </span>
              )}
            </div>
            <Input label="Value" type="number" min={0} startContent={$} value={f.value} onValueChange={(v) => setF({ ...f, value: v })} description={isNew ? "Empty = the purchase price" : "Leave empty to keep the current value"} />
            <Input label="As of" type="date" placeholder=" " value={f.valuedOn} onValueChange={(v) => setF({ ...f, valuedOn: v })} />
            <Select label="Source" selectedKeys={[f.valueSource]} onSelectionChange={(k) => setF({ ...f, valueSource: String(Array.from(k as Set<string>)[0] ?? "ESTIMATE") })}>
              <SelectItem key="ESTIMATE">Estimate</SelectItem>
              <SelectItem key="APPRAISAL">Appraisal</SelectItem>
            </Select>
            <Input label="Where from (optional)" placeholder="Zillow, KBB private party" value={f.valueNotes} onValueChange={(v) => setF({ ...f, valueNotes: v })} />

            {!isNew && (
              <>
                <Switch className="sm:col-span-2 mt-2" isSelected={f.sold} onValueChange={(v) => setF({ ...f, sold: v, soldDate: v && !f.soldDate ? todayIso() : f.soldDate })}>
                  Sold / no longer owned
                </Switch>
                {f.sold && (
                  <>
                    <Input label="Sold on" type="date" placeholder=" " value={f.soldDate} onValueChange={(v) => setF({ ...f, soldDate: v })} />
                    <Input label="Sold for" type="number" min={0} startContent={$} value={f.soldValue} onValueChange={(v) => setF({ ...f, soldValue: v })} />
                  </>
                )}
              </>
            )}
            <Textarea label="Notes" className="sm:col-span-2" minRows={2} value={f.notes} onValueChange={(v) => setF({ ...f, notes: v })} />
          </div>

          {!isNew && loans.length > 0 && (
            <div className="text-sm">
              <div className="font-medium mb-1">Secured loans</div>
              {loans.map((l) => (
                <div key={l.id} className="flex justify-between text-default-600">
                  <span>{l.name}</span>
                  <Money value={-l.owed} cents={false} />
                </div>
              ))}
              <div className="text-xs text-default-500 mt-1">Link or unlink a loan from the loan&apos;s own editor.</div>
            </div>
          )}

          {history.length > 0 && (
            <div className="text-sm">
              <div className="font-medium mb-1">Value history</div>
              <ul className="divide-y divide-default-100">
                {history.map((v) => (
                  <li key={v.id} className="flex items-center gap-3 py-1">
                    <span className="w-24 text-default-500">{fmtDate(v.date, { month: "short", day: "numeric", year: "numeric" })}</span>
                    <Money value={v.value} cents={false} className="w-28" />
                    <span className="flex-1 truncate text-default-500 text-xs">
                      {(v.source ?? "").toLowerCase()}
                      {v.notes ? ` · ${v.notes}` : ""}
                    </span>
                    <Button size="sm" isIconOnly variant="light" aria-label="Remove valuation" isDisabled={saving} onPress={() => run({ assetId: asset.id, removeValuationId: v.id }, false)}>
                      <FaTrash className="text-default-400" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ModalBody>
        <ModalFooter className="justify-between">
          <div>
            {!isNew && (
              <Button
                variant="light"
                color="danger"
                isDisabled={saving}
                onPress={() => {
                  if (confirm(`Delete ${asset.name} and its value history? Loans pointing at it are unlinked. To keep the history, mark it sold instead.`)) run({ assetId: asset.id, remove: true });
                }}
              >
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="light" onPress={onClose}>
              Cancel
            </Button>
            <Button color="primary" isLoading={saving} onPress={save}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Loan ───────────────────────────────────────────────────────────────────

const NEW_ACCOUNT = "__new__";

export function LoanModal({
  loan,
  presetAccountId,
  accounts,
  loans,
  assets,
  onClose,
  onSaved,
}: {
  loan: any | null | undefined; // undefined = closed, null = new
  presetAccountId?: string | null;
  accounts: any[];
  loans: any[];
  assets: any[];
  onClose: () => void;
  onSaved: (loanId: string | null) => void;
}) {
  const isNew = loan === null;
  const account = loan ? accounts.find((a) => a.id === loan.accountId) : null;
  const synced = !!account?.simplefinAccountId;
  // LOAN accounts without terms yet, for attaching.
  const free = accounts.filter((a) => a.type === "LOAN" && a.active !== false && !loans.some((l) => l.accountId === a.id));
  const [f, setF] = useState({ accountId: "", newName: "", institution: "", owed: "", loanType: "MORTGAGE", lender: "", originalPrincipal: "", ratePct: "", termMonths: "360", startDate: "", firstPaymentDate: "", monthlyPayment: "", escrowMonthly: "", assetId: "", notes: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loan === undefined) return;
    const acct = loan ? accounts.find((a) => a.id === loan.accountId) : null;
    const preset = presetAccountId ?? free[0]?.id ?? NEW_ACCOUNT;
    setF({
      accountId: loan ? loan.accountId : preset,
      newName: "",
      institution: "",
      owed: acct && !acct.simplefinAccountId ? str(round2(-(acct.currentBalance ?? 0))) : "",
      loanType: loan?.loanType ?? "MORTGAGE",
      lender: loan?.lender ?? "",
      originalPrincipal: str(loan?.originalPrincipal),
      ratePct: loan ? str(round2(loan.interestRate * 100 * 1000) / 1000) : "",
      termMonths: str(loan?.termMonths ?? 360),
      startDate: loan?.startDate ?? "",
      firstPaymentDate: loan?.firstPaymentDate ?? "",
      monthlyPayment: str(loan?.monthlyPayment),
      escrowMonthly: str(loan?.escrowMonthly),
      assetId: loan?.assetId ?? "",
      notes: loan?.notes ?? "",
    });
  }, [loan, presetAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const computed = useMemo(() => {
    const p = num(f.originalPrincipal);
    const r = num(f.ratePct);
    const n = num(f.termMonths);
    if (!p || r == null || !n || !f.firstPaymentDate) return null;
    return contractualPayment({ originalPrincipal: p, interestRate: r / 100, termMonths: n, firstPaymentDate: f.firstPaymentDate });
  }, [f.originalPrincipal, f.ratePct, f.termMonths, f.firstPaymentDate]);

  async function save() {
    const rate = num(f.ratePct);
    const input: any = {
      ...(isNew ? {} : { loanId: loan.id }),
      loanType: f.loanType,
      lender: f.lender.trim() || null,
      originalPrincipal: num(f.originalPrincipal) ?? undefined,
      interestRate: rate == null ? undefined : round2(rate * 1000) / 100000,
      termMonths: num(f.termMonths) ?? undefined,
      startDate: f.startDate || null,
      firstPaymentDate: f.firstPaymentDate || undefined,
      monthlyPayment: num(f.monthlyPayment),
      escrowMonthly: num(f.escrowMonthly),
      assetId: f.assetId || null,
      notes: f.notes.trim() || null,
    };
    if (isNew) {
      if (f.accountId === NEW_ACCOUNT) {
        if (!f.newName.trim() || num(f.owed) == null) return toastError("Missing account", "Name the new loan account and say what's owed");
        Object.assign(input, { newAccountName: f.newName.trim(), owed: num(f.owed), institution: f.institution.trim() || undefined });
      } else input.accountId = f.accountId;
    } else if (!synced && num(f.owed) != null && Math.abs(num(f.owed)! + (account?.currentBalance ?? 0)) >= 0.005) {
      input.owed = num(f.owed);
    }
    setSaving(true);
    const r = await callOp(financeClient, "save_finance_loan", input);
    setSaving(false);
    if ("error" in r) return toastError("Couldn't save", r.error);
    onSaved(r.result.loan?.id ?? null);
    onClose();
  }

  async function remove() {
    if (!confirm("Remove this loan's terms and its payment history? The account and its balance stay.")) return;
    setSaving(true);
    const r = await callOp(financeClient, "save_finance_loan", { loanId: loan.id, remove: true });
    setSaving(false);
    if ("error" in r) return toastError("Couldn't remove", r.error);
    onSaved(null);
    onClose();
  }

  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  return (
    <Modal isOpen={loan !== undefined} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{isNew ? "New loan" : `Edit ${account?.name ?? "loan"}`}</ModalHeader>
        <ModalBody>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {isNew ? (
              <Select
                label="Balance comes from"
                className="sm:col-span-2"
                selectedKeys={[f.accountId]}
                onSelectionChange={(k) => setF({ ...f, accountId: String(Array.from(k as Set<string>)[0] ?? NEW_ACCOUNT) })}
                description="A synced loan account keeps its balance from the bank; a new manual one moves with the payments you record."
              >
                {[
                  ...free.map((a) => (
                    <SelectItem key={a.id} description={`${a.simplefinAccountId ? "Synced" : "Manual"} · owes ${fmtCurrency(-(a.currentBalance ?? 0), { cents: false })}`}>
                      {a.name}
                    </SelectItem>
                  )),
                  <SelectItem key={NEW_ACCOUNT}>New manual loan account</SelectItem>,
                ]}
              </Select>
            ) : (
              <div className="sm:col-span-2 text-sm text-default-500">
                Balance from <span className="text-foreground">{account?.name}</span> · {synced ? "synced from the bank" : "manual: moves with recorded payments"}
              </div>
            )}
            {isNew && f.accountId === NEW_ACCOUNT && (
              <>
                <Input label="Account name" placeholder="BMW loan" value={f.newName} onValueChange={set("newName")} isRequired />
                <Input label="Owed today" type="number" min={0} startContent={$} value={f.owed} onValueChange={set("owed")} isRequired />
              </>
            )}
            {!isNew && !synced && <Input label="Owed today" type="number" min={0} startContent={$} value={f.owed} onValueChange={set("owed")} description="Correct it to the lender's statement" />}

            <Select label="Kind" selectedKeys={[f.loanType]} onSelectionChange={(k) => setF({ ...f, loanType: String(Array.from(k as Set<string>)[0] ?? "OTHER") })}>
              {LOAN_TYPES.map((t) => (
                <SelectItem key={t}>{LOAN_TYPE_LABELS[t]}</SelectItem>
              ))}
            </Select>
            <Input label="Lender" value={f.lender} onValueChange={set("lender")} />
            <Input label="Original amount" type="number" min={0} startContent={$} value={f.originalPrincipal} onValueChange={set("originalPrincipal")} isRequired />
            <Input label="Interest rate" type="number" min={0} step="0.001" endContent={<span className="text-default-400 text-sm">%</span>} value={f.ratePct} onValueChange={set("ratePct")} isRequired />
            <Input
              label="Term (months)"
              type="number"
              min={1}
              value={f.termMonths}
              onValueChange={set("termMonths")}
              description={num(f.termMonths) ? `${round2(num(f.termMonths)! / 12)} years` : undefined}
              isRequired
            />
            <Input label="First payment" type="date" placeholder=" " value={f.firstPaymentDate} onValueChange={set("firstPaymentDate")} isRequired description="Payments fall on this day of the month" />
            <Input label="Taken out (optional)" type="date" placeholder=" " value={f.startDate} onValueChange={set("startDate")} />
            <Input
              label="Monthly principal + interest"
              type="number"
              min={0}
              startContent={$}
              value={f.monthlyPayment}
              onValueChange={set("monthlyPayment")}
              placeholder={computed ? String(computed) : ""}
              description={computed ? `Empty = ${fmtCurrency(computed)} from the terms` : "Empty = computed from the terms"}
            />
            <Input label="Escrow per month" type="number" min={0} startContent={$} value={f.escrowMonthly} onValueChange={set("escrowMonthly")} description="Taxes + insurance paid with it" />
            <Select
              label="Secured by"
              placeholder="Nothing"
              selectedKeys={f.assetId ? [f.assetId] : []}
              onSelectionChange={(k) => setF({ ...f, assetId: String(Array.from(k as Set<string>)[0] ?? "") })}
              description="For equity: the house for a mortgage, the car for an auto loan"
            >
              {assets
                .filter((a) => a.active !== false)
                .map((a) => (
                  <SelectItem key={a.id} description={fmtCurrency(a.currentValue, { cents: false })}>
                    {a.name}
                  </SelectItem>
                ))}
            </Select>
            <Textarea label="Notes" className="sm:col-span-2" minRows={2} value={f.notes} onValueChange={set("notes")} />
          </div>
        </ModalBody>
        <ModalFooter className="justify-between">
          <div>
            {!isNew && (
              <Button variant="light" color="danger" isDisabled={saving} onPress={remove}>
                Remove loan
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="light" onPress={onClose}>
              Cancel
            </Button>
            <Button color="primary" isLoading={saving} onPress={save}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Payment ────────────────────────────────────────────────────────────────

export function PaymentModal({
  payment,
  loan,
  owed,
  synced,
  onClose,
  onSaved,
}: {
  payment: any | null | undefined; // undefined = closed, null = new
  loan: any;
  owed: number;
  synced: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = payment === null;
  const [f, setF] = useState({ date: todayIso(), total: "", principal: "", interest: "", escrow: "", fees: "", isExtra: false, notes: "" });
  const [touchedSplit, setTouchedSplit] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (payment === undefined) return;
    if (payment) {
      setF({ date: payment.date, total: str(payment.totalAmount), principal: str(payment.principal), interest: str(payment.interest), escrow: str(payment.escrow), fees: str(payment.fees), isExtra: !!payment.isExtra, notes: payment.notes ?? "" });
      setTouchedSplit(true);
    } else {
      const pi = contractualPayment(loan);
      const escrow = loan.escrowMonthly ?? 0;
      const total = round2(pi + escrow);
      const s = suggestSplit(owed, loan.interestRate, total, escrow);
      setF({ date: todayIso(), total: str(total), principal: str(s.principal), interest: str(s.interest), escrow: escrow ? str(escrow) : "", fees: "", isExtra: false, notes: "" });
      setTouchedSplit(false);
    }
  }, [payment]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-estimate the split as the total changes, until it's typed by hand.
  function setTotal(v: string, extra = f.isExtra, escrowS = f.escrow, feesS = f.fees) {
    const total = num(v) ?? 0;
    const escrow = num(escrowS) ?? 0;
    const fees = num(feesS) ?? 0;
    if (touchedSplit) return setF((x) => ({ ...x, total: v, isExtra: extra, escrow: escrowS, fees: feesS }));
    const s = extra ? { principal: round2(total - escrow - fees), interest: 0 } : suggestSplit(owed + (payment?.principal ?? 0), loan.interestRate, total, escrow, fees);
    setF((x) => ({ ...x, total: v, isExtra: extra, escrow: escrowS, fees: feesS, principal: str(s.principal), interest: str(s.interest) }));
  }

  const sum = round2((num(f.principal) ?? 0) + (num(f.interest) ?? 0) + (num(f.escrow) ?? 0) + (num(f.fees) ?? 0));
  const total = num(f.total) ?? 0;
  const off = Math.abs(sum - total) > 0.01;

  async function save() {
    if (!(total > 0)) return toastError("Missing amount", "How much was paid?");
    if (off) return toastError("Split doesn't add up", `${fmtCurrency(sum)} vs ${fmtCurrency(total)}`);
    setSaving(true);
    const r = await callOp(financeClient, "record_loan_payment", {
      ...(isNew ? { loanId: loan.id } : { paymentId: payment.id }),
      date: f.date,
      totalAmount: total,
      principal: num(f.principal) ?? 0,
      interest: num(f.interest) ?? 0,
      escrow: num(f.escrow),
      fees: num(f.fees),
      isExtra: f.isExtra,
      notes: f.notes.trim() || null,
    });
    setSaving(false);
    if ("error" in r) return toastError("Couldn't save", r.error);
    onSaved();
    onClose();
  }

  async function remove() {
    if (!confirm(synced ? "Delete this payment record?" : "Delete this payment? The loan balance goes back up by its principal.")) return;
    setSaving(true);
    const r = await callOp(financeClient, "record_loan_payment", { paymentId: payment.id, remove: true });
    setSaving(false);
    if ("error" in r) return toastError("Couldn't delete", r.error);
    onSaved();
    onClose();
  }

  const splitInput = (k: "principal" | "interest") => (v: string) => {
    setTouchedSplit(true);
    setF((x) => ({ ...x, [k]: v }));
  };

  return (
    <Modal isOpen={payment !== undefined} onClose={onClose} size="lg">
      <ModalContent>
        <ModalHeader>{isNew ? "Record a payment" : "Edit payment"}</ModalHeader>
        <ModalBody>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Date" type="date" placeholder=" " value={f.date} onValueChange={(v) => setF({ ...f, date: v })} />
            <Input label="Total paid" type="number" min={0} startContent={$} value={f.total} onValueChange={(v) => setTotal(v)} />
            <Switch className="col-span-2" isSelected={f.isExtra} onValueChange={(v) => setTotal(f.total, v)}>
              Extra principal payment
            </Switch>
            <Input label="Principal" type="number" min={0} startContent={$} value={f.principal} onValueChange={splitInput("principal")} />
            <Input label="Interest" type="number" min={0} startContent={$} value={f.interest} onValueChange={splitInput("interest")} />
            <Input label="Escrow" type="number" min={0} startContent={$} value={f.escrow} onValueChange={(v) => setTotal(f.total, f.isExtra, v)} />
            <Input label="Fees" type="number" min={0} startContent={$} value={f.fees} onValueChange={(v) => setTotal(f.total, f.isExtra, f.escrow, v)} />
            <Input label="Notes" className="col-span-2" value={f.notes} onValueChange={(v) => setF({ ...f, notes: v })} />
          </div>
          <div className={`text-xs ${off ? "text-danger" : "text-default-500"}`}>
            {off ? `The split adds up to ${fmtCurrency(sum)}, not ${fmtCurrency(total)}.` : touchedSplit ? "Split as entered." : "Interest estimated as a month on what's owed; use the statement's numbers when you have them."}
            {!synced && " Recording it lowers the balance by the principal."}
          </div>
        </ModalBody>
        <ModalFooter className="justify-between">
          <div>
            {!isNew && (
              <Button variant="light" color="danger" isDisabled={saving} onPress={remove}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="light" onPress={onClose}>
              Cancel
            </Button>
            <Button color="primary" isLoading={saving} onPress={save}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
