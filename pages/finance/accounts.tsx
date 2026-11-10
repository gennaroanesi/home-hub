"use client";

// /finance/accounts — the household's finance accounts: create/edit, order,
// deactivate, and link each to its SimpleFIN account so finance-sync pulls it.

import React, { useState } from "react";
import NextLink from "next/link";
import { Button } from "@heroui/button";
import { Card, CardBody } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Input, Textarea } from "@heroui/input";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { Select, SelectItem } from "@heroui/select";
import { Checkbox, Spinner, Switch, addToast } from "@heroui/react";
import { FaLink, FaPen, FaPlus, FaTrash, FaUnlink } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money, ago } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, RETIREMENT_TYPES, RETIREMENT_TYPE_LABELS, accountTypeLabel, isInvested } from "@/lib/finance/accounts";
import { listHoldings, txIndexQuery } from "@/lib/finance/data";

/* eslint-disable @typescript-eslint/no-explicit-any */

type SfAccount = { id: string; institution: string; name: string; mappedTo: { id: string; name: string } | null };

type Form = {
  id?: string;
  name: string;
  type: string;
  retirementType: string;
  institution: string;
  last4: string;
  currentBalance: string;
  ownerPersonIds: string[];
  active: boolean;
  sortOrder: string;
  minBalance: string;
  creditLimit: string;
  statementDueDay: string;
  apr: string;
  apy: string;
  simplefinAccountId: string;
  notes: string;
};

const EMPTY: Form = {
  name: "",
  type: "CHECKING",
  retirementType: "_401K",
  institution: "",
  last4: "",
  currentBalance: "0",
  ownerPersonIds: [],
  active: true,
  sortOrder: "",
  minBalance: "",
  creditLimit: "",
  statementDueDay: "",
  apr: "",
  apy: "",
  simplefinAccountId: "",
  notes: "",
};

const str = (n: number | null | undefined) => (n == null ? "" : String(n));
const num = (s: string): number | null => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
/** Percent typed by the user (6.25) ↔ stored decimal (0.0625). */
const pctIn = (n: number | null | undefined) => (n == null ? "" : String(Math.round(n * 10000) / 100));
const pctOut = (s: string) => {
  const n = num(s);
  return n == null ? null : n / 100;
};

function parseJsonLayers(v: unknown): any {
  let d: any = v;
  while (typeof d === "string") d = JSON.parse(d);
  return d;
}

export default function FinanceAccountsPage() {
  const refs = useFinanceRefs();
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [sfOpen, setSfOpen] = useState(false);
  const [sfLoading, setSfLoading] = useState(false);
  const [sfAccounts, setSfAccounts] = useState<SfAccount[]>([]);
  const [sfError, setSfError] = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  function edit(a?: any) {
    if (!a) return setForm({ ...EMPTY, sortOrder: String((refs.accounts.length + 1) * 10) });
    setForm({
      id: a.id,
      name: a.name ?? "",
      type: a.type ?? "OTHER",
      retirementType: a.retirementType ?? "_401K",
      institution: a.institution ?? "",
      last4: a.last4 ?? "",
      currentBalance: str(a.currentBalance ?? 0),
      ownerPersonIds: (a.ownerPersonIds ?? []).filter(Boolean),
      active: a.active !== false,
      sortOrder: str(a.sortOrder),
      minBalance: str(a.minBalance),
      creditLimit: str(a.creditLimit),
      statementDueDay: str(a.statementDueDay),
      apr: pctIn(a.apr),
      apy: pctIn(a.apy),
      simplefinAccountId: a.simplefinAccountId ?? "",
      notes: a.notes ?? "",
    });
  }

  async function save() {
    if (!form) return;
    if (!form.name.trim()) return addToast({ title: "Name is required", color: "warning" });
    const due = num(form.statementDueDay);
    if (due != null && (due < 1 || due > 31)) return addToast({ title: "Statement due day must be 1–31", color: "warning" });
    const sfId = form.simplefinAccountId.trim() || null;
    const clash = sfId && refs.accounts.find((a) => a.simplefinAccountId === sfId && a.id !== form.id);
    if (clash) return addToast({ title: `That SimpleFIN account is already linked to ${clash.name}`, color: "warning" });

    const existing = form.id ? refs.accounts.find((a) => a.id === form.id) : null;
    const balance = num(form.currentBalance) ?? 0;
    const balanceChanged = !existing || Math.abs((existing.currentBalance ?? 0) - balance) >= 0.005;
    const row: any = {
      name: form.name.trim(),
      type: form.type as any,
      retirementType: form.type === "RETIREMENT" ? (form.retirementType as any) : null,
      institution: form.institution.trim() || null,
      last4: form.last4.trim() || null,
      currentBalance: balance,
      ownerPersonIds: form.ownerPersonIds,
      active: form.active,
      sortOrder: num(form.sortOrder),
      minBalance: form.type === "CHECKING" || form.type === "CASH" ? num(form.minBalance) : null,
      creditLimit: form.type === "CREDIT" ? num(form.creditLimit) : null,
      statementDueDay: form.type === "CREDIT" ? due : null,
      apr: form.type === "CREDIT" || form.type === "LOAN" ? pctOut(form.apr) : null,
      apy: form.type === "SAVINGS" ? pctOut(form.apy) : null,
      simplefinAccountId: sfId,
      notes: form.notes.trim() || null,
      ...(balanceChanged ? { balanceUpdatedAt: new Date().toISOString() } : {}),
    };
    setSaving(true);
    try {
      const r = form.id ? await financeClient.models.homeFinanceAccount.update({ id: form.id, ...row }) : await financeClient.models.homeFinanceAccount.create(row);
      if (r.errors?.length) throw new Error(r.errors[0].message);
      addToast({ title: form.id ? "Account saved" : "Account added", color: "success" });
      setForm(null);
      await refs.reload();
    } catch (e) {
      addToast({ title: "Couldn't save", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!form?.id) return;
    const { data, errors } = await txIndexQuery(financeClient, "AccountIdAndDate")({ accountId: form.id }, { limit: 1 });
    if (errors?.length) {
      addToast({ title: "Couldn't check for transactions", description: errors[0].message, color: "danger" });
      return;
    }
    if (data?.length) {
      addToast({ title: "This account has transactions", description: "Turn off Active instead, so its history stays in the reports.", color: "warning" });
      return;
    }
    if (!confirm(`Delete ${form.name}?`)) return;
    const r = await financeClient.models.homeFinanceAccount.delete({ id: form.id });
    if (r.errors?.length) return addToast({ title: "Couldn't delete", description: r.errors[0].message, color: "danger" });
    for (const h of await listHoldings(financeClient, form.id)) {
      await financeClient.models.homeFinanceHolding.delete({ accountId: h.accountId, holdingKey: h.holdingKey });
    }
    setForm(null);
    await refs.reload();
  }

  async function openSimplefin() {
    setSfOpen(true);
    setSfLoading(true);
    setSfError(null);
    try {
      const r = await financeClient.mutations.listSimplefinAccounts();
      if (r.errors?.length) throw new Error(r.errors[0].message);
      const data = parseJsonLayers(r.data) ?? {};
      if (data.error) setSfError(data.error);
      setSfAccounts(data.accounts ?? []);
    } catch (e) {
      setSfError(e instanceof Error ? e.message : String(e));
    } finally {
      setSfLoading(false);
    }
  }

  const people = refs.people;
  const sorted = refs.accounts;

  return (
    <FinanceShell
      title="Accounts"
      subtitle="The joint account, anything else that pays household bills, and the 401k / investment accounts goals draw on."
      onSynced={refs.reload}
      actions={
        <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => edit()}>
          Add account
        </Button>
      }
    >
      {refs.loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState title="No accounts yet">Add the joint checking account, then link it to SimpleFIN so transactions sync three times a day.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((a) => (
            <Card key={a.id} shadow="sm" className={a.active === false ? "opacity-60" : ""}>
              <CardBody className="flex flex-row items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <NextLink href={`/finance/accounts/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </NextLink>
                    <Chip size="sm" variant="flat">
                      {accountTypeLabel(a)}
                    </Chip>
                    {a.active === false && (
                      <Chip size="sm" variant="flat" color="default">
                        inactive
                      </Chip>
                    )}
                    {(a.ownerPersonIds ?? []).length === 0 ? (
                      <Chip size="sm" variant="flat" color="secondary">
                        joint
                      </Chip>
                    ) : (
                      <span className="text-xs text-default-500">{(a.ownerPersonIds ?? []).map((id: string) => people.find((p) => p.id === id)?.name ?? "?").join(", ")}</span>
                    )}
                  </div>
                  <div className="text-xs text-default-500 mt-0.5 flex flex-wrap gap-x-2">
                    {a.institution && <span>{a.institution}</span>}
                    {a.last4 && <span>••{a.last4}</span>}
                    {a.simplefinAccountId ? (
                      <span className="text-success-600 flex items-center gap-1">
                        <FaLink /> SimpleFIN · synced {ago(a.lastSyncAt)}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <FaUnlink /> manual
                      </span>
                    )}
                  </div>
                </div>
                <Money value={a.currentBalance ?? 0} className="font-semibold" />
                <Button size="sm" isIconOnly variant="light" aria-label="Edit" onPress={() => edit(a)}>
                  <FaPen />
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal isOpen={!!form} onOpenChange={(o) => !o && setForm(null)} size="2xl" scrollBehavior="inside">
        <ModalContent>
          {form && (
            <>
              <ModalHeader>{form.id ? "Edit account" : "New account"}</ModalHeader>
              <ModalBody className="gap-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Name" value={form.name} onValueChange={(v) => set("name", v)} isRequired autoFocus />
                  <Select label="Type" selectedKeys={[form.type]} onSelectionChange={(k) => set("type", String(Array.from(k)[0] ?? "OTHER"))}>
                    {ACCOUNT_TYPES.map((t) => (
                      <SelectItem key={t}>{ACCOUNT_TYPE_LABELS[t]}</SelectItem>
                    ))}
                  </Select>
                  {form.type === "RETIREMENT" && (
                    <Select label="Retirement account" selectedKeys={[form.retirementType]} onSelectionChange={(k) => set("retirementType", String(Array.from(k)[0] ?? "OTHER"))}>
                      {RETIREMENT_TYPES.map((t) => (
                        <SelectItem key={t}>{RETIREMENT_TYPE_LABELS[t]}</SelectItem>
                      ))}
                    </Select>
                  )}
                  <Input label="Institution" value={form.institution} onValueChange={(v) => set("institution", v)} />
                  <Input label="Last 4" value={form.last4} maxLength={4} onValueChange={(v) => set("last4", v.replace(/\D/g, ""))} />
                  <Input
                    label="Current balance"
                    type="number"
                    value={form.currentBalance}
                    onValueChange={(v) => set("currentBalance", v)}
                    description={form.simplefinAccountId ? "Overwritten by each sync" : isInvested(form.type) ? "Total value, positions included" : "Negative for money owed"}
                    startContent={<span className="text-default-400 text-sm">$</span>}
                  />
                  <Input label="Sort order" type="number" value={form.sortOrder} onValueChange={(v) => set("sortOrder", v)} />
                  {(form.type === "CHECKING" || form.type === "CASH") && (
                    <Input
                      label="Minimum balance (buffer)"
                      type="number"
                      value={form.minBalance}
                      onValueChange={(v) => set("minBalance", v)}
                      description="Warn when scheduled debits would take it below this"
                      startContent={<span className="text-default-400 text-sm">$</span>}
                    />
                  )}
                  {form.type === "CREDIT" && (
                    <>
                      <Input label="Credit limit" type="number" value={form.creditLimit} onValueChange={(v) => set("creditLimit", v)} startContent={<span className="text-default-400 text-sm">$</span>} />
                      <Input label="Statement due day" type="number" min={1} max={31} value={form.statementDueDay} onValueChange={(v) => set("statementDueDay", v)} />
                    </>
                  )}
                  {(form.type === "CREDIT" || form.type === "LOAN") && (
                    <Input label="APR" type="number" value={form.apr} onValueChange={(v) => set("apr", v)} endContent={<span className="text-default-400 text-sm">%</span>} />
                  )}
                  {form.type === "SAVINGS" && <Input label="APY" type="number" value={form.apy} onValueChange={(v) => set("apy", v)} endContent={<span className="text-default-400 text-sm">%</span>} />}
                </div>

                <div>
                  <div className="text-sm mb-1">Owners</div>
                  <div className="flex flex-wrap gap-3">
                    {people.map((p) => (
                      <Checkbox
                        key={p.id}
                        isSelected={form.ownerPersonIds.includes(p.id)}
                        onValueChange={(on) => set("ownerPersonIds", on ? [...form.ownerPersonIds, p.id] : form.ownerPersonIds.filter((x) => x !== p.id))}
                      >
                        {p.name}
                      </Checkbox>
                    ))}
                  </div>
                  <div className="text-xs text-default-500 mt-1">None checked = joint (household) account.</div>
                </div>

                <div className="flex items-end gap-2">
                  <Input
                    label="SimpleFIN account id"
                    value={form.simplefinAccountId}
                    onValueChange={(v) => set("simplefinAccountId", v)}
                    placeholder="ACT-…"
                    description={isInvested(form.type) ? "Syncs value, positions and transactions 3×/day; its transactions stay out of the budget" : "Linked accounts sync balance and transactions 3×/day"}
                    className="flex-1"
                  />
                  <Button variant="flat" startContent={<FaLink />} onPress={openSimplefin} className="mb-6">
                    Pick
                  </Button>
                </div>

                <Textarea label="Notes" value={form.notes} onValueChange={(v) => set("notes", v)} minRows={2} />
                <Switch isSelected={form.active} onValueChange={(v) => set("active", v)}>
                  Active
                </Switch>
              </ModalBody>
              <ModalFooter className="justify-between">
                <div>
                  {form.id && (
                    <Button color="danger" variant="light" startContent={<FaTrash />} onPress={remove}>
                      Delete
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="light" onPress={() => setForm(null)}>
                    Cancel
                  </Button>
                  <Button color="primary" isLoading={saving} onPress={save}>
                    Save
                  </Button>
                </div>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal isOpen={sfOpen} onOpenChange={setSfOpen} size="lg" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>Link a SimpleFIN account</ModalHeader>
          <ModalBody>
            <p className="text-xs text-default-500">Names only; balances and activity are pulled only for the accounts linked here.</p>
            {sfLoading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : sfError ? (
              <div className="text-sm text-danger">{sfError}</div>
            ) : sfAccounts.length === 0 ? (
              <div className="text-sm text-default-500">SimpleFIN returned no accounts.</div>
            ) : (
              <ul className="flex flex-col divide-y divide-default-100">
                {sfAccounts.map((s) => {
                  const mine = form?.id && s.mappedTo?.id === form.id;
                  const taken = s.mappedTo && !mine;
                  return (
                    <li key={s.id} className="flex items-center gap-2 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{s.name}</div>
                        <div className="text-xs text-default-500">
                          {s.institution}
                          {s.mappedTo && ` · linked to ${s.mappedTo.name}`}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={form?.simplefinAccountId === s.id ? "solid" : "flat"}
                        color={form?.simplefinAccountId === s.id ? "primary" : "default"}
                        isDisabled={!!taken}
                        onPress={() => {
                          set("simplefinAccountId", s.id);
                          if (form && !form.institution) set("institution", s.institution);
                          setSfOpen(false);
                        }}
                      >
                        {form?.simplefinAccountId === s.id ? "Selected" : taken ? "Taken" : "Use"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setSfOpen(false)}>
              Close
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </FinanceShell>
  );
}
