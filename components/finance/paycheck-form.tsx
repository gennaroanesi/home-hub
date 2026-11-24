"use client";

// Create / edit / review form for a homePaycheck. Used by
// /finance/paychecks for manual entry, uploaded stubs (prefilled from the
// parsePaycheckPdf draft) and emailed stubs waiting in homePaycheckInbox
// (saving marks the inbox row IMPORTED).

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast } from "@heroui/react";
import { FaExternalLinkAlt, FaPlus, FaTrash } from "react-icons/fa";

import { financeClient } from "@/components/finance/client";
import type { PersonLite } from "@/components/finance/ui";
import { fmtCurrency } from "@/lib/finance/dates";
import {
  PAYCHECK_FILING_STATUSES,
  PAYCHECK_LINE_ITEM_TYPES,
  PAYCHECK_NUM_GROUPS,
  paycheckFormProblem,
  paycheckFormState,
  paycheckRow,
  paycheckSanityGap,
  type PaycheckFormState,
  type PaycheckLineItemDraft,
  type PaycheckLineItemType,
} from "@/lib/finance/paycheck-screen";

export type PaycheckFormInit = {
  id?: string;
  personId?: string | null;
  source: "EMAIL" | "UPLOAD" | "MANUAL" | "IMPORT";
  s3KeyPdf?: string | null;
  inboxId?: string | null;
  warning?: string | null;
  values?: Record<string, unknown>; // homePaycheck-shaped fields (draftToPaycheck output or a saved row)
};

export function PaycheckForm({ init, people, onClose, onSaved }: { init: PaycheckFormInit; people: PersonLite[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<PaycheckFormState>(() => paycheckFormState(init.values, init.personId));
  const set = <K extends keyof PaycheckFormState>(k: K, val: PaycheckFormState[K]) => setF((s) => ({ ...s, [k]: val }));
  const setItems = (fn: (items: PaycheckLineItemDraft[]) => PaycheckLineItemDraft[]) => setF((s) => ({ ...s, items: fn(s.items) }));
  const { personId, payDate, periodStart, periodEnd, employer, filing, notes, nums, items } = f;
  const [saving, setSaving] = useState(false);

  // gross ≈ taxes + pre-tax + post-tax deductions + net (informational).
  const sanity = useMemo(() => paycheckSanityGap(f), [f]);

  async function save() {
    const problem = paycheckFormProblem(f);
    if (problem) return addToast({ title: problem, color: "warning" });
    const row = paycheckRow(f);
    setSaving(true);
    try {
      let savedId = init.id;
      if (init.id) {
        const r = await financeClient.models.homePaycheck.update({ id: init.id, ...(row as any) });
        if (r.errors?.length) throw new Error(r.errors[0].message);
      } else {
        const r = await financeClient.models.homePaycheck.create({ ...(row as any), source: init.source, s3KeyPdf: init.s3KeyPdf ?? null });
        if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
        savedId = r.data.id;
      }
      if (init.inboxId && savedId) {
        const r = await financeClient.models.homePaycheckInbox.update({ id: init.inboxId, status: "IMPORTED", paycheckId: savedId, personId });
        if (r.errors?.length) addToast({ title: "Saved, but couldn't mark the inbox row imported", description: r.errors[0].message, color: "warning" });
      }
      addToast({ title: init.id ? "Paycheck updated" : "Paycheck saved", color: "success" });
      onSaved();
    } catch (e) {
      addToast({ title: "Couldn't save", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!init.id || !confirm("Delete this paycheck?")) return;
    const r = await financeClient.models.homePaycheck.delete({ id: init.id });
    if (r.errors?.length) return addToast({ title: "Couldn't delete", description: r.errors[0].message, color: "danger" });
    onSaved();
  }

  const title = init.id ? "Edit paycheck" : init.inboxId ? "Review emailed stub" : init.source === "UPLOAD" ? "Review uploaded stub" : "Add paycheck";

  return (
    <Modal isOpen onClose={onClose} size="4xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <span>{title}</span>
          {init.s3KeyPdf && (
            <a href={`/api/finance/file?key=${encodeURIComponent(init.s3KeyPdf)}`} target="_blank" rel="noreferrer" className="text-xs text-primary font-normal flex items-center gap-1">
              <FaExternalLinkAlt /> Open the PDF
            </a>
          )}
        </ModalHeader>
        <ModalBody className="gap-4">
          {init.warning && <div className="text-sm rounded-medium bg-warning-50 text-warning-700 px-3 py-2">{init.warning}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Select label="Person" size="sm" isRequired selectedKeys={personId ? new Set([personId]) : new Set()} onSelectionChange={(k) => set("personId", String(Array.from(k as Set<string>)[0] ?? ""))}>
              {people.map((p) => (
                <SelectItem key={p.id}>{p.name}</SelectItem>
              ))}
            </Select>
            <Input label="Pay date" size="sm" type="date" isRequired value={payDate} onValueChange={(val) => set("payDate", val)} />
            <Input label="Period start" size="sm" type="date" value={periodStart} onValueChange={(val) => set("periodStart", val)} />
            <Input label="Period end" size="sm" type="date" value={periodEnd} onValueChange={(val) => set("periodEnd", val)} />
            <Input label="Employer" size="sm" className="sm:col-span-2" value={employer} onValueChange={(val) => set("employer", val)} />
          </div>

          {PAYCHECK_NUM_GROUPS.map((g) => (
            <div key={g.title}>
              <p className="text-xs uppercase tracking-wide text-default-500 mb-1">{g.title}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {g.title === "W-4" && (
                  <Select label="Filing status" size="sm" selectedKeys={filing ? new Set([filing]) : new Set()} onSelectionChange={(k) => set("filing", String(Array.from(k as Set<string>)[0] ?? ""))}>
                    {PAYCHECK_FILING_STATUSES.map((s) => (
                      <SelectItem key={s}>{s}</SelectItem>
                    ))}
                  </Select>
                )}
                {g.fields.map(([k, label]) => (
                  <Input
                    key={k}
                    label={label}
                    size="sm"
                    inputMode="decimal"
                    isRequired={k === "gross" || k === "net"}
                    startContent={<span className="text-default-400 text-xs">$</span>}
                    value={nums[k] ?? ""}
                    onValueChange={(val) => setF((s) => ({ ...s, nums: { ...s.nums, [k]: val } }))}
                  />
                ))}
              </div>
            </div>
          ))}

          {sanity != null && (
            <p className="text-xs text-warning-600">
              Gross differs from taxes + deductions + net by {fmtCurrency(sanity)}. Fine if the stub has deductions not entered here (add them as line items); otherwise check for imputed income in gross.
            </p>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs uppercase tracking-wide text-default-500">Other line items</p>
              <Button size="sm" variant="light" startContent={<FaPlus />} onPress={() => setItems((s) => [...s, { name: "", amount: "", ytd: "", type: "PRETAX" }])}>
                Add line
              </Button>
            </div>
            {items.length === 0 && <p className="text-xs text-default-400">Parking, ESPP, employer match, life insurance…</p>}
            <div className="flex flex-col gap-2">
              {items.map((it, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <Input aria-label="Name" size="sm" className="col-span-4" placeholder="Name" value={it.name} onValueChange={(val) => setItems((s) => s.map((x, j) => (j === i ? { ...x, name: val } : x)))} />
                  <Input aria-label="Amount" size="sm" className="col-span-2" placeholder="Amount" inputMode="decimal" value={it.amount} onValueChange={(val) => setItems((s) => s.map((x, j) => (j === i ? { ...x, amount: val } : x)))} />
                  <Input aria-label="YTD" size="sm" className="col-span-2" placeholder="YTD" inputMode="decimal" value={it.ytd} onValueChange={(val) => setItems((s) => s.map((x, j) => (j === i ? { ...x, ytd: val } : x)))} />
                  <Select aria-label="Type" size="sm" className="col-span-3" selectedKeys={new Set([it.type])} onSelectionChange={(k) => setItems((s) => s.map((x, j) => (j === i ? { ...x, type: (Array.from(k as Set<string>)[0] as PaycheckLineItemType) ?? "OTHER" } : x)))}>
                    {PAYCHECK_LINE_ITEM_TYPES.map((t) => (
                      <SelectItem key={t}>{t.replace("_", " ").toLowerCase()}</SelectItem>
                    ))}
                  </Select>
                  <Button size="sm" isIconOnly variant="light" aria-label="Remove line" className="col-span-1" onPress={() => setItems((s) => s.filter((_, j) => j !== i))}>
                    <FaTrash />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <Textarea label="Notes" size="sm" minRows={1} value={notes} onValueChange={(val) => set("notes", val)} />
        </ModalBody>
        <ModalFooter>
          {init.id && (
            <Button color="danger" variant="light" className="mr-auto" onPress={remove}>
              Delete
            </Button>
          )}
          <Button variant="light" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" isLoading={saving} onPress={save}>
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

