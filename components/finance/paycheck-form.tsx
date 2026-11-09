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

export const LINE_ITEM_TYPES = ["PRETAX", "POSTTAX", "IMPUTED", "EMPLOYER_PAID", "EARNING", "OTHER"] as const;
type LineItemType = (typeof LINE_ITEM_TYPES)[number];
type LineItem = { name: string; amount: string; ytd: string; type: LineItemType };

const NUM_GROUPS: Array<{ title: string; fields: Array<[string, string]> }> = [
  { title: "This period", fields: [["gross", "Gross (cash)"], ["taxableWage", "Federal taxable wage"], ["net", "Net (take-home)"], ["imputedGtl", "Imputed GTL"]] },
  { title: "Taxes", fields: [["fedWh", "Federal WH"], ["stateWh", "State WH"], ["oasdi", "Social Security"], ["medicare", "Medicare"]] },
  {
    title: "Retirement & benefits",
    fields: [["contrib401k", "401k pre-tax"], ["contribRoth401k", "401k Roth"], ["contribAfterTax401k", "401k after-tax"], ["hsa", "HSA"], ["fsa", "FSA"], ["medical", "Medical"], ["dental", "Dental"], ["vision", "Vision"]],
  },
  {
    title: "Year to date",
    fields: [["ytdGross", "Gross"], ["ytdTaxableWage", "Taxable wage"], ["ytdFedWh", "Federal WH"], ["ytdOasdi", "Social Security"], ["ytdMedicare", "Medicare"], ["ytd401k", "401k pre-tax"], ["ytdRoth401k", "401k Roth"], ["ytdAfterTax401k", "401k after-tax"], ["ytdNet", "Net"]],
  },
  {
    title: "Supplemental (bonus / RSU)",
    fields: [["bonusGross", "Bonus"], ["rsuGross", "RSU vest"], ["ytdBonusGross", "YTD bonus"], ["ytdRsuGross", "YTD RSU"], ["supplementalFedWh", "Supplemental fed WH"], ["ytdSupplementalFedWh", "YTD supplemental WH"]],
  },
  { title: "W-4", fields: [["w4ExtraWithholding", "Extra withholding / period"], ["w4Dependents", "Dependents amount"]] },
];
const NUM_FIELDS = NUM_GROUPS.flatMap((g) => g.fields.map(([k]) => k));

export type PaycheckFormInit = {
  id?: string;
  personId?: string | null;
  source: "EMAIL" | "UPLOAD" | "MANUAL" | "IMPORT";
  s3KeyPdf?: string | null;
  inboxId?: string | null;
  warning?: string | null;
  values?: Record<string, unknown>; // homePaycheck-shaped fields (draftToPaycheck output or a saved row)
};

function parseJsonLayers(v: unknown): unknown {
  let out = v;
  for (let i = 0; i < 3 && typeof out === "string"; i++) {
    try {
      out = JSON.parse(out);
    } catch {
      return null;
    }
  }
  return out;
}

function toStr(v: unknown): string {
  return v == null ? "" : String(v);
}

export function PaycheckForm({ init, people, onClose, onSaved }: { init: PaycheckFormInit; people: PersonLite[]; onClose: () => void; onSaved: () => void }) {
  const v = init.values ?? {};
  const [personId, setPersonId] = useState<string>(init.personId ?? "");
  const [payDate, setPayDate] = useState(toStr(v.payDate));
  const [periodStart, setPeriodStart] = useState(toStr(v.periodStart));
  const [periodEnd, setPeriodEnd] = useState(toStr(v.periodEnd));
  const [employer, setEmployer] = useState(toStr(v.employer));
  const [filing, setFiling] = useState(toStr(v.w4FilingStatus));
  const [notes, setNotes] = useState(toStr(v.notes));
  const [nums, setNums] = useState<Record<string, string>>(() => Object.fromEntries(NUM_FIELDS.map((k) => [k, toStr(v[k])])));
  const [items, setItems] = useState<LineItem[]>(() => {
    const raw = parseJsonLayers(v.lineItems);
    if (!Array.isArray(raw)) return [];
    return raw.map((it: any) => ({
      name: toStr(it?.name),
      amount: toStr(it?.amount),
      ytd: toStr(it?.ytd),
      type: (LINE_ITEM_TYPES as readonly string[]).includes(it?.type) ? it.type : "OTHER",
    }));
  });
  const [saving, setSaving] = useState(false);

  const num = (k: string): number | null => {
    const s = (nums[k] ?? "").replace(/[$,\s]/g, "");
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  // gross ≈ taxes + pre-tax + post-tax deductions + net (informational).
  const sanity = useMemo(() => {
    const gross = num("gross");
    const net = num("net");
    if (gross == null || net == null || gross === 0) return null;
    const sum = (ks: string[]) => ks.reduce((s, k) => s + (num(k) ?? 0), 0);
    const itemSum = (t: LineItemType) => items.filter((i) => i.type === t).reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const parts = sum(["fedWh", "stateWh", "oasdi", "medicare", "contrib401k", "contribRoth401k", "contribAfterTax401k", "hsa", "fsa", "medical", "dental", "vision"]) + itemSum("PRETAX") + itemSum("POSTTAX") + net;
    const diff = gross - parts;
    return Math.abs(diff) > 1 ? diff : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nums, items]);

  async function save() {
    if (!personId) return addToast({ title: "Pick whose paycheck this is", color: "warning" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) return addToast({ title: "Pay date is required", color: "warning" });
    if (num("gross") == null || num("net") == null) return addToast({ title: "Gross and net are required", color: "warning" });
    const row: Record<string, unknown> = {
      personId,
      payDate,
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      employer: employer.trim() || null,
      w4FilingStatus: filing || null,
      notes: notes.trim() || null,
      lineItems: JSON.stringify(
        items
          .filter((i) => i.name.trim() || i.amount)
          .map((i) => ({ name: i.name.trim(), amount: Number(i.amount) || 0, ytd: i.ytd === "" ? null : Number(i.ytd), type: i.type })),
      ),
    };
    for (const k of NUM_FIELDS) row[k] = num(k);
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
            <Select label="Person" size="sm" isRequired selectedKeys={personId ? new Set([personId]) : new Set()} onSelectionChange={(k) => setPersonId(String(Array.from(k as Set<string>)[0] ?? ""))}>
              {people.map((p) => (
                <SelectItem key={p.id}>{p.name}</SelectItem>
              ))}
            </Select>
            <Input label="Pay date" size="sm" type="date" isRequired value={payDate} onValueChange={setPayDate} />
            <Input label="Period start" size="sm" type="date" value={periodStart} onValueChange={setPeriodStart} />
            <Input label="Period end" size="sm" type="date" value={periodEnd} onValueChange={setPeriodEnd} />
            <Input label="Employer" size="sm" className="sm:col-span-2" value={employer} onValueChange={setEmployer} />
          </div>

          {NUM_GROUPS.map((g) => (
            <div key={g.title}>
              <p className="text-xs uppercase tracking-wide text-default-500 mb-1">{g.title}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {g.title === "W-4" && (
                  <Select label="Filing status" size="sm" selectedKeys={filing ? new Set([filing]) : new Set()} onSelectionChange={(k) => setFiling(String(Array.from(k as Set<string>)[0] ?? ""))}>
                    {["SINGLE", "MFJ", "MFS", "HOH"].map((s) => (
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
                    onValueChange={(val) => setNums((s) => ({ ...s, [k]: val }))}
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
                  <Select aria-label="Type" size="sm" className="col-span-3" selectedKeys={new Set([it.type])} onSelectionChange={(k) => setItems((s) => s.map((x, j) => (j === i ? { ...x, type: (Array.from(k as Set<string>)[0] as LineItemType) ?? "OTHER" } : x)))}>
                    {LINE_ITEM_TYPES.map((t) => (
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

          <Textarea label="Notes" size="sm" minRows={1} value={notes} onValueChange={setNotes} />
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

export { parseJsonLayers };
