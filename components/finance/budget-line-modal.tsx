"use client";

// Create / change a budget line (EXPENSE bucket of categories, a member's
// INCOME contribution, or SAVINGS into an account). Saves through
// save_finance_budget, which versions the line. Opened on a version, it
// either corrects that version in place, or sets the line from a date
// (optionally until a date); the versions around the range are trimmed or
// split so the rest of the history keeps its amounts.

import React, { useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast } from "@heroui/react";

import { financeClient } from "@/components/finance/client";
import type { PersonLite } from "@/components/finance/ui";
import { callOp } from "@/lib/ops-client";
import { BUDGET_PERIODS, BUDGET_PERIOD_LABELS, bucketCategories, budgetKind, type BudgetLine, type BudgetPeriod } from "@/lib/finance/budget";
import { isInvested } from "@/lib/finance/accounts";
import { fmtDate } from "@/lib/finance/dates";

export type BudgetDraft = {
  seriesId?: string;
  /** The version this was opened on (an existing line only). */
  version?: { id: string; from: string | null; to: string | null };
  /** correct: edit that version in place. range: set the line from effectiveFrom to effectiveTo. */
  mode: "correct" | "range";
  kind: "INCOME" | "SAVINGS" | "EXPENSE";
  name: string;
  categories: string[];
  personId: string;
  accountId: string;
  amount: string;
  period: BudgetPeriod;
  effectiveFrom: string;
  /** "" = until the next version starts (later versions keep theirs). */
  effectiveTo: string;
  label: string;
  notes: string;
};

/**
 * A draft opened on a version. `mode` defaults to correcting it when it
 * starts on or after `effectiveFrom` (nothing before it to keep), else to a
 * change from `effectiveFrom`.
 */
export function draftFromLine(line: BudgetLine, effectiveFrom: string, mode?: BudgetDraft["mode"]): BudgetDraft {
  return {
    seriesId: line.seriesId,
    version: { id: line.id, from: line.effectiveFrom ?? null, to: line.effectiveTo ?? null },
    mode: mode ?? ((line.effectiveFrom ?? "") >= effectiveFrom ? "correct" : "range"),
    kind: budgetKind(line),
    name: line.name,
    categories: bucketCategories(line),
    personId: line.personId ?? "",
    accountId: line.accountId ?? "",
    amount: String(line.amount ?? ""),
    period: (line.period ?? "MONTHLY") as BudgetPeriod,
    effectiveFrom,
    effectiveTo: "",
    label: "",
    notes: line.notes ?? "",
  };
}

export function emptyDraft(effectiveFrom: string, patch: Partial<BudgetDraft> = {}): BudgetDraft {
  return { mode: "range", effectiveTo: "", kind: "EXPENSE", name: "", categories: [], personId: "", accountId: "", amount: "", period: "MONTHLY", effectiveFrom, label: "", notes: "", ...patch };
}

function rangeText(from: string | null, to: string | null): string {
  const f = (iso: string | null) => (iso ? fmtDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "?");
  return `${f(from)} → ${to ? f(to) : "open"}`;
}

export function BudgetLineModal({
  draft,
  categories,
  people,
  accounts = [],
  onClose,
  onSaved,
}: {
  draft: BudgetDraft | null;
  categories: string[];
  people: PersonLite[];
  accounts?: { id: string; name: string; type?: string | null; active?: boolean | null }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<BudgetDraft | null>(draft);
  const [extraCat, setExtraCat] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setD(draft), [draft]);

  if (!d) return null;
  const set = (patch: Partial<BudgetDraft>) => setD({ ...d, ...patch });
  const catOptions = [...new Set([...categories, ...d.categories])].sort((a, b) => a.localeCompare(b));
  const editing = !!d.seriesId;

  async function save() {
    if (!d) return;
    const amount = Number(d.amount);
    if (!Number.isFinite(amount) || amount <= 0) return addToast({ title: "Enter an amount", color: "warning" });
    const correcting = d.mode === "correct" && !!d.version;
    if (!correcting && d.effectiveTo && d.effectiveTo < d.effectiveFrom) return addToast({ title: "The end date is before the start", color: "warning" });
    setSaving(true);
    const r = await callOp(financeClient, "save_finance_budget", {
      ...(d.seriesId ? { seriesId: d.seriesId } : {}),
      kind: d.kind,
      name: d.name.trim() || undefined,
      ...(d.kind === "EXPENSE"
        ? { categories: d.categories }
        : d.kind === "SAVINGS"
          ? { accountId: d.accountId || undefined }
          : { personId: d.personId || undefined }),
      amount,
      period: d.period,
      ...(correcting
        ? { versionId: d.version!.id }
        : { effectiveFrom: d.effectiveFrom, ...(d.effectiveTo ? { effectiveTo: d.effectiveTo } : {}) }),
      ...(d.label.trim() ? { label: d.label.trim() } : {}),
      ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
    });
    setSaving(false);
    if ("error" in r) return addToast({ title: "Couldn't save the budget", description: r.error, color: "danger" });
    addToast({ title: `Budget ${r.result.action}`, color: "success" });
    onSaved();
  }

  return (
    <Modal isOpen onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{editing ? `Change “${d.name}”` : "New budget line"}</ModalHeader>
        <ModalBody className="gap-3">
          <Select
            label="Kind"
            selectedKeys={new Set([d.kind])}
            isDisabled={editing}
            onSelectionChange={(k) => set({ kind: (Array.from(k as Set<string>)[0] as BudgetDraft["kind"]) ?? "EXPENSE" })}
          >
            <SelectItem key="EXPENSE">Spending (categories)</SelectItem>
            <SelectItem key="INCOME">Contribution (a person puts in)</SelectItem>
            <SelectItem key="SAVINGS">Savings (moved into an account)</SelectItem>
          </Select>
          <Input
            label="Name"
            placeholder={d.kind === "INCOME" ? "Gennaro's contribution" : d.kind === "SAVINGS" ? "Joint savings" : "Groceries & dining"}
            value={d.name}
            onValueChange={(name) => set({ name })}
          />
          {d.kind === "EXPENSE" ? (
            <>
              <Select
                label="Categories"
                selectionMode="multiple"
                selectedKeys={new Set(d.categories)}
                onSelectionChange={(k) => set({ categories: Array.from(k as Set<string>) })}
                description="A category can be in only one spending line at a time."
              >
                {catOptions.map((c) => (
                  <SelectItem key={c} textValue={c}>
                    {c}
                  </SelectItem>
                ))}
              </Select>
              <div className="flex gap-2 items-end">
                <Input size="sm" label="Add a category not in the list" value={extraCat} onValueChange={setExtraCat} />
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={!extraCat.trim()}
                  onPress={() => {
                    const c = extraCat.trim();
                    if (c && !d.categories.includes(c)) set({ categories: [...d.categories, c] });
                    setExtraCat("");
                  }}
                >
                  Add
                </Button>
              </div>
            </>
          ) : d.kind === "SAVINGS" ? (
            <Select
              label="Savings account"
              selectedKeys={d.accountId ? new Set([d.accountId]) : new Set()}
              onSelectionChange={(k) => set({ accountId: (Array.from(k as Set<string>)[0] as string) ?? "" })}
              description="Counts what lands in this account (minus withdrawals, not interest)."
            >
              {accounts
                // Inside an invested account, fund buys and dividends would count; goals track those.
                .filter((a) => (a.active !== false && !isInvested(a.type)) || a.id === d.accountId)
                .map((a) => (
                  <SelectItem key={a.id} textValue={a.name}>
                    {a.name}
                  </SelectItem>
                ))}
            </Select>
          ) : (
            <Select label="Contributor" selectedKeys={d.personId ? new Set([d.personId]) : new Set()} onSelectionChange={(k) => set({ personId: (Array.from(k as Set<string>)[0] as string) ?? "" })}>
              {people.map((p) => (
                <SelectItem key={p.id} textValue={p.name}>
                  {p.name}
                </SelectItem>
              ))}
            </Select>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Amount" type="number" startContent={<span className="text-default-400 text-sm">$</span>} value={d.amount} onValueChange={(amount) => set({ amount })} />
            <Select label="Per" selectedKeys={new Set([d.period])} onSelectionChange={(k) => set({ period: (Array.from(k as Set<string>)[0] as BudgetPeriod) ?? "MONTHLY" })}>
              {BUDGET_PERIODS.map((p) => (
                <SelectItem key={p}>{BUDGET_PERIOD_LABELS[p]}</SelectItem>
              ))}
            </Select>
          </div>
          {d.version && (
            <div className="flex flex-col gap-1">
              <div className="flex gap-2">
                <Button size="sm" variant={d.mode === "correct" ? "solid" : "flat"} color={d.mode === "correct" ? "primary" : "default"} onPress={() => set({ mode: "correct" })}>
                  Correct this version
                </Button>
                <Button size="sm" variant={d.mode === "range" ? "solid" : "flat"} color={d.mode === "range" ? "primary" : "default"} onPress={() => set({ mode: "range" })}>
                  Change from a date
                </Button>
              </div>
              <span className="text-xs text-default-500">
                {d.mode === "correct"
                  ? `Edits the version for ${rangeText(d.version.from, d.version.to)} in place; nothing else changes.`
                  : "Sets these values for the dates below. Versions around them are trimmed or split, so other months keep their amounts."}
              </span>
            </div>
          )}
          {(!d.version || d.mode === "range") && (
            <div className="grid grid-cols-2 gap-3">
              <Input label={editing ? "From" : "Starts on"} type="date" placeholder=" " value={d.effectiveFrom} onValueChange={(effectiveFrom) => set({ effectiveFrom })} />
              <Input
                label="Until (optional)"
                type="date"
                placeholder=" "
                value={d.effectiveTo}
                onValueChange={(effectiveTo) => set({ effectiveTo })}
                description={editing ? "Blank: until the next version starts" : "Blank: open-ended"}
              />
            </div>
          )}
          {editing && <Input label="Why it changed (optional)" placeholder="baby arrives" value={d.label} onValueChange={(label) => set({ label })} />}
          <Input label="Notes" value={d.notes} onValueChange={(notes) => set({ notes })} />
        </ModalBody>
        <ModalFooter>
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
