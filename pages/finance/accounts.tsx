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
import {
  ACCOUNT_HAS_TRANSACTIONS,
  accountFormFrom,
  accountHasTransactions,
  deleteAccountWithHoldings,
  newAccountForm,
  parseSimplefinListing,
  pickSimplefinAccount,
  saveAccountForm,
  simplefinInstitutions,
  simplefinPickerGroups,
  EMPTY_SF_FILTER,
  type SfPickerFilter,
  type AccountForm as Form,
  type SfAccount,
  type SfConnection,
} from "@/lib/finance/account-form";
import { DEFAULT_SIMPLEFIN_CONNECTION, SIMPLEFIN_CONNECTIONS, simplefinConnectionLabel } from "@/lib/finance/simplefin-connections";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function FinanceAccountsPage() {
  const refs = useFinanceRefs();
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [sfOpen, setSfOpen] = useState(false);
  const [sfLoading, setSfLoading] = useState(false);
  const [sfAccounts, setSfAccounts] = useState<SfAccount[]>([]);
  const [sfConnections, setSfConnections] = useState<SfConnection[]>([]);
  const [sfError, setSfError] = useState<string | null>(null);
  const [sfFilter, setSfFilter] = useState<SfPickerFilter>(EMPTY_SF_FILTER);

  const set =<K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  function edit(a?: any) {
    setForm(a ? accountFormFrom(a) : newAccountForm(refs.accounts.length));
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const invalid = await saveAccountForm(financeClient, form, refs.accounts);
      if (invalid) return addToast({ title: invalid, color: "warning" });
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
    try {
      if (await accountHasTransactions(financeClient, form.id)) {
        addToast({ title: ACCOUNT_HAS_TRANSACTIONS.title, description: ACCOUNT_HAS_TRANSACTIONS.detail, color: "warning" });
        return;
      }
    } catch (e) {
      addToast({ title: "Couldn't check for transactions", description: e instanceof Error ? e.message : String(e), color: "danger" });
      return;
    }
    if (!confirm(`Delete ${form.name}?`)) return;
    try {
      await deleteAccountWithHoldings(financeClient, form.id);
    } catch (e) {
      return addToast({ title: "Couldn't delete", description: e instanceof Error ? e.message : String(e), color: "danger" });
    }
    setForm(null);
    await refs.reload();
  }

  async function openSimplefin() {
    setSfOpen(true);
    setSfLoading(true);
    setSfError(null);
    setSfFilter(EMPTY_SF_FILTER);
    try {
      const r = await financeClient.mutations.listSimplefinAccounts();
      if (r.errors?.length) throw new Error(r.errors[0].message);
      const data = parseSimplefinListing(r.data);
      if (data.error) setSfError(data.error);
      setSfAccounts(data.accounts);
      setSfConnections(data.connections);
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
                        <FaLink /> SimpleFIN ({simplefinConnectionLabel(a.simplefinConnection)}) · synced {ago(a.lastSyncAt)}
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
                  <Select
                    label="Connection"
                    aria-label="Whose SimpleFIN connection"
                    selectedKeys={[form.simplefinConnection]}
                    onSelectionChange={(k) => set("simplefinConnection", String(Array.from(k)[0] ?? DEFAULT_SIMPLEFIN_CONNECTION))}
                    className="w-36 mb-6"
                    description=" "
                  >
                    {SIMPLEFIN_CONNECTIONS.map((c) => (
                      <SelectItem key={c.key}>{c.label}</SelectItem>
                    ))}
                  </Select>
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
            <p className="text-xs text-default-500">Names only; balances and activity are pulled only for the accounts linked here. One list per person&apos;s SimpleFIN connection.</p>
            {sfLoading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : sfError ? (
              <div className="text-sm text-danger">{sfError}</div>
            ) : (
              <div className="flex flex-col gap-4">
                {/* Search and filters: whose connection, institution, linked or not */}
                <div className="flex flex-col gap-2 sticky top-0 bg-content1 z-10 pb-1">
                  <Input
                    size="sm"
                    autoFocus
                    isClearable
                    placeholder="Search name, bank or id"
                    value={sfFilter.query ?? ""}
                    onValueChange={(v) => setSfFilter((f) => ({ ...f, query: v }))}
                    onClear={() => setSfFilter((f) => ({ ...f, query: "" }))}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex gap-1">
                      {[{ key: null as string | null, label: "Both" }, ...SIMPLEFIN_CONNECTIONS.map((c) => ({ key: c.key as string | null, label: c.label }))].map((c) => (
                        <Button
                          key={c.key ?? "all"}
                          size="sm"
                          variant={(sfFilter.connection ?? null) === c.key ? "solid" : "flat"}
                          color={(sfFilter.connection ?? null) === c.key ? "primary" : "default"}
                          className="h-7 min-w-0 px-2 text-xs"
                          onPress={() => setSfFilter((f) => ({ ...f, connection: c.key }))}
                        >
                          {c.label}
                        </Button>
                      ))}
                    </div>
                    <Select
                      size="sm"
                      aria-label="Institution"
                      placeholder="Any bank"
                      className="w-44"
                      selectedKeys={sfFilter.institution ? [sfFilter.institution] : []}
                      onSelectionChange={(k) => setSfFilter((f) => ({ ...f, institution: (Array.from(k)[0] as string | undefined) ?? null }))}
                    >
                      {simplefinInstitutions(sfAccounts).map((i) => (
                        <SelectItem key={i}>{i}</SelectItem>
                      ))}
                    </Select>
                    <Checkbox size="sm" isSelected={!!sfFilter.hideLinked} onValueChange={(v) => setSfFilter((f) => ({ ...f, hideLinked: v }))}>
                      Hide linked
                    </Checkbox>
                  </div>
                </div>
                {simplefinPickerGroups({ accounts: sfAccounts, connections: sfConnections }, form, sfFilter).map((conn) => {
                  const rows = conn.rows;
                  return (
                    <div key={conn.key}>
                      <div className="text-sm font-semibold mb-1 flex items-baseline gap-2">
                        {conn.label}&apos;s SimpleFIN
                        {conn.ok && conn.total > 0 && (
                          <span className="text-xs font-normal text-default-400">
                            {rows.length === conn.total ? conn.total : `${rows.length} of ${conn.total}`}
                          </span>
                        )}
                      </div>
                      {!conn.ok ? (
                        <div className="text-xs text-warning-600">{conn.error}</div>
                      ) : conn.total === 0 ? (
                        <div className="text-xs text-default-500">No accounts on this connection yet.</div>
                      ) : rows.length === 0 ? (
                        <div className="text-xs text-default-500">Nothing matches here.</div>
                      ) : (
                        <ul className="flex flex-col divide-y divide-default-100">
                          {rows.map((s) => {
                            const { selected, taken } = s;
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
                                  variant={selected ? "solid" : "flat"}
                                  color={selected ? "primary" : "default"}
                                  isDisabled={taken}
                                  onPress={() => {
                                    setForm((f) => (f ? pickSimplefinAccount(f, s) : f));
                                    setSfOpen(false);
                                  }}
                                >
                                  {selected ? "Selected" : taken ? "Taken" : "Use"}
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
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
