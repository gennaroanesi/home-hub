"use client";

// /finance/groups — spend groups: a trip, the nursery, a remodel. Tagged
// transactions (spendGroupId) count here instead of against the monthly
// budget. Groups are plain CRUD on homeFinanceSpendGroup; tagging goes
// through the update_finance_transaction op.

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody } from "@heroui/card";
import { Checkbox } from "@heroui/checkbox";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast, Spinner } from "@heroui/react";
import { FaMagic, FaPen, FaPlus, FaTimes, FaTrash } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { BudgetBar, EmptyState, Money } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { callOp } from "@/lib/ops-client";
import { listAllPages } from "@/lib/list-all";
import { effectiveCategory, isExcludedFromBudget } from "@/lib/finance/categories";
import { listSpendGroups, listTransactions, txIndexQuery } from "@/lib/finance/data";
import { fmtDate } from "@/lib/finance/dates";

const KINDS = ["TRIP", "PROJECT", "EVENT", "OTHER"] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABELS: Record<Kind, string> = { TRIP: "Trip", PROJECT: "Project", EVENT: "Event", OTHER: "Other" };
const NO_TRIP = "__none";

type Form = { id?: string; name: string; kind: Kind; budget: string; startDate: string; endDate: string; tripId: string; notes: string };

async function taggedTxs(groupId: string): Promise<any[]> {
  const out: any[] = [];
  let nextToken: string | null | undefined;
  do {
    const r = await txIndexQuery(financeClient, "SpendGroupId")({ spendGroupId: groupId }, { limit: 500, nextToken });
    out.push(...(r.data ?? []));
    nextToken = r.nextToken;
  } while (nextToken);
  return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** Net spend of tagged rows: money out minus refunds, pending excluded. */
function netSpend(txs: any[]): number {
  return -txs.filter((t) => t.status !== "PENDING").reduce((s, t) => s + (t.amount ?? 0), 0);
}

export default function GroupsPage() {
  const refs = useFinanceRefs();
  const [groups, setGroups] = useState<any[]>([]);
  const [txsByGroup, setTxsByGroup] = useState<Map<string, any[]>>(new Map());
  const [trips, setTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, tripRows] = await Promise.all([listSpendGroups(financeClient), listAllPages<any>(financeClient.models.homeTrip)]);
      rows.sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? "") || a.name.localeCompare(b.name));
      setGroups(rows);
      setTrips(tripRows.sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? "")));
      const pairs = await Promise.all(rows.map(async (g) => [g.id, await taggedTxs(g.id)] as const));
      setTxsByGroup(new Map(pairs));
    } catch (e) {
      addToast({ title: "Couldn't load groups", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tripName = useCallback((id: string | null | undefined) => (id ? trips.find((t) => t.id === id)?.name ?? null : null), [trips]);

  async function save() {
    if (!form) return;
    if (!form.name.trim()) {
      addToast({ title: "A name is required", color: "warning" });
      return;
    }
    const budget = form.budget.trim() === "" ? null : Number(form.budget);
    if (budget != null && (!Number.isFinite(budget) || budget < 0)) {
      addToast({ title: "Budget must be a positive number", color: "warning" });
      return;
    }
    setSaving(true);
    const fields = {
      name: form.name.trim(),
      kind: form.kind,
      budget,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      tripId: form.tripId === NO_TRIP ? null : form.tripId,
      notes: form.notes.trim() || null,
    };
    const r = form.id
      ? await financeClient.models.homeFinanceSpendGroup.update({ id: form.id, ...fields })
      : await financeClient.models.homeFinanceSpendGroup.create(fields);
    setSaving(false);
    if (r.errors?.length) {
      addToast({ title: "Couldn't save", description: r.errors[0].message, color: "danger" });
      return;
    }
    setForm(null);
    load();
  }

  async function remove(g: any) {
    const tagged = txsByGroup.get(g.id) ?? [];
    if (!window.confirm(`Delete "${g.name}"?${tagged.length ? ` Its ${tagged.length} transaction(s) will be untagged.` : ""}`)) return;
    for (const t of tagged) {
      const r = await callOp(financeClient, "update_finance_transaction", { transactionId: t.id, spendGroupId: null });
      if ("error" in r) {
        addToast({ title: "Couldn't untag a transaction", description: r.error, color: "danger" });
        return;
      }
    }
    const r = await financeClient.models.homeFinanceSpendGroup.delete({ id: g.id });
    if (r.errors?.length) addToast({ title: "Couldn't delete", description: r.errors[0].message, color: "danger" });
    setDetailId(null);
    load();
  }

  function pickTrip(tripId: string) {
    if (!form) return;
    const trip = trips.find((t) => t.id === tripId);
    setForm({
      ...form,
      tripId,
      ...(trip
        ? {
            name: form.name || trip.name,
            kind: "TRIP" as Kind,
            startDate: form.startDate || trip.startDate || "",
            endDate: form.endDate || trip.endDate || "",
          }
        : {}),
    });
  }

  const detail = groups.find((g) => g.id === detailId) ?? null;

  return (
    <FinanceShell
      title="Spend groups"
      subtitle="Trips and projects, budgeted on their own instead of against the month"
      onSynced={load}
      actions={
        <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => setForm({ name: "", kind: "PROJECT", budget: "", startDate: "", endDate: "", tripId: NO_TRIP, notes: "" })}>
          New group
        </Button>
      }
    >
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState title="No spend groups yet">Create one for a trip or a project like the nursery, then tag its transactions.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groups.map((g) => {
            const txs = txsByGroup.get(g.id) ?? [];
            const spent = netSpend(txs);
            const trip = tripName(g.tripId);
            return (
              <Card key={g.id} isPressable onPress={() => setDetailId(g.id)}>
                <CardBody className="gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">{g.name}</h3>
                      <div className="text-xs text-default-500">
                        {g.startDate ? `${fmtDate(g.startDate, { month: "short", day: "numeric", year: "numeric" })}${g.endDate ? ` – ${fmtDate(g.endDate, { month: "short", day: "numeric", year: "numeric" })}` : ""}` : "No dates"}
                        {trip ? ` · ✈ ${trip}` : ""}
                      </div>
                    </div>
                    <Chip size="sm" variant="flat">
                      {KIND_LABELS[(g.kind ?? "OTHER") as Kind]}
                    </Chip>
                  </div>
                  <div className="flex items-baseline justify-between text-sm">
                    <span>
                      <Money value={spent} cents={false} className="font-semibold" />
                      {g.budget != null && (
                        <>
                          {" "}
                          <span className="text-default-500">of</span> <Money value={g.budget} cents={false} />
                        </>
                      )}
                    </span>
                    <span className="text-xs text-default-500">{txs.length} transaction(s)</span>
                  </div>
                  {g.budget != null && <BudgetBar spent={spent} budgeted={g.budget} />}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <Modal isOpen={!!form} onClose={() => setForm(null)} size="lg">
        <ModalContent>
          {form && (
            <>
              <ModalHeader>{form.id ? "Edit group" : "New group"}</ModalHeader>
              <ModalBody>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select label="Linked trip (optional)" selectedKeys={[form.tripId]} onChange={(e) => e.target.value && pickTrip(e.target.value)} className="sm:col-span-2">
                    {[<SelectItem key={NO_TRIP}>None</SelectItem>, ...trips.map((t) => <SelectItem key={t.id}>{`${t.name} (${t.startDate})`}</SelectItem>)]}
                  </Select>
                  <Input label="Name" value={form.name} onValueChange={(v) => setForm({ ...form, name: v })} isRequired />
                  <Select label="Kind" selectedKeys={[form.kind]} onChange={(e) => e.target.value && setForm({ ...form, kind: e.target.value as Kind })}>
                    {KINDS.map((k) => (
                      <SelectItem key={k}>{KIND_LABELS[k]}</SelectItem>
                    ))}
                  </Select>
                  <Input label="Start" type="date" value={form.startDate} onValueChange={(v) => setForm({ ...form, startDate: v })} />
                  <Input label="End" type="date" value={form.endDate} onValueChange={(v) => setForm({ ...form, endDate: v })} />
                  <Input
                    label="Budget (optional)"
                    type="number"
                    min={0}
                    startContent={<span className="text-default-400 text-sm">$</span>}
                    value={form.budget}
                    onValueChange={(v) => setForm({ ...form, budget: v })}
                  />
                  <Input label="Notes" value={form.notes} onValueChange={(v) => setForm({ ...form, notes: v })} />
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={() => setForm(null)}>
                  Cancel
                </Button>
                <Button color="primary" isLoading={saving} onPress={save}>
                  Save
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {detail && (
        <GroupDetail
          group={detail}
          txs={txsByGroup.get(detail.id) ?? []}
          accountName={(id) => refs.accounts.find((a) => a.id === id)?.name ?? ""}
          tripName={tripName(detail.tripId)}
          onClose={() => setDetailId(null)}
          onEdit={() => {
            setDetailId(null);
            setForm({
              id: detail.id,
              name: detail.name,
              kind: (detail.kind ?? "OTHER") as Kind,
              budget: detail.budget != null ? String(detail.budget) : "",
              startDate: detail.startDate ?? "",
              endDate: detail.endDate ?? "",
              tripId: detail.tripId ?? NO_TRIP,
              notes: detail.notes ?? "",
            });
          }}
          onDelete={() => remove(detail)}
          onChanged={load}
        />
      )}
    </FinanceShell>
  );
}

function GroupDetail({
  group,
  txs,
  accountName,
  tripName,
  onClose,
  onEdit,
  onDelete,
  onChanged,
}: {
  group: any;
  txs: any[];
  accountName: (id: string) => string;
  tripName: string | null;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const [candidates, setCandidates] = useState<any[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const spent = netSpend(txs);
  const canAutoAssign = !!group.startDate && !!group.endDate;

  async function loadCandidates() {
    setCandidates(null);
    try {
      const rows = await listTransactions(financeClient, { fromIso: group.startDate, toIso: group.endDate });
      const out = rows.filter((t) => (t.amount ?? 0) < 0 && !t.spendGroupId && !isExcludedFromBudget(effectiveCategory(t)));
      setCandidates(out);
      setPicked(new Set(out.map((t) => t.id)));
    } catch (e) {
      addToast({ title: "Couldn't load transactions", description: e instanceof Error ? e.message : String(e), color: "danger" });
      setCandidates([]);
    }
  }

  async function tag(ids: string[], spendGroupId: string | null) {
    setBusy(true);
    let failed = 0;
    for (const id of ids) {
      const r = await callOp(financeClient, "update_finance_transaction", { transactionId: id, spendGroupId });
      if ("error" in r) failed++;
    }
    setBusy(false);
    if (failed) addToast({ title: `${failed} transaction(s) couldn't be updated`, color: "danger" });
    setCandidates(null);
    onChanged();
  }

  const pickedTotal = useMemo(() => (candidates ?? []).filter((t) => picked.has(t.id)).reduce((s, t) => s + (t.amount ?? 0), 0), [candidates, picked]);

  return (
    <Modal isOpen onClose={onClose} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span>{group.name}</span>
          <span className="text-xs font-normal text-default-500">
            {group.startDate ? `${fmtDate(group.startDate)}${group.endDate ? ` – ${fmtDate(group.endDate)}` : ""}` : "No dates"}
            {tripName ? ` · trip: ${tripName}` : ""} · spent <Money value={spent} />
            {group.budget != null && (
              <>
                {" "}
                of <Money value={group.budget} />
              </>
            )}
          </span>
        </ModalHeader>
        <ModalBody>
          {candidates ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold">Untagged spending in the date range</h4>
                <span className="text-xs text-default-500">
                  {picked.size} selected · <Money value={pickedTotal} />
                </span>
              </div>
              {candidates.length === 0 ? (
                <p className="text-sm text-default-500">Nothing untagged between those dates.</p>
              ) : (
                <div className="divide-y divide-default-100">
                  {candidates.map((t) => (
                    <label key={t.id} className="flex items-center gap-3 py-1.5 cursor-pointer">
                      <Checkbox
                        isSelected={picked.has(t.id)}
                        onValueChange={(v) => {
                          const next = new Set(picked);
                          if (v) next.add(t.id);
                          else next.delete(t.id);
                          setPicked(next);
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate">{t.description}</div>
                        <div className="text-xs text-default-500">
                          {fmtDate(t.date)} · {effectiveCategory(t)} · {accountName(t.accountId)}
                        </div>
                      </div>
                      <Money value={t.amount} />
                    </label>
                  ))}
                </div>
              )}
            </div>
          ) : txs.length === 0 ? (
            <EmptyState title="No tagged transactions">Tag them from Transactions, or auto-assign by date range.</EmptyState>
          ) : (
            <div className="divide-y divide-default-100">
              {txs.map((t) => (
                <div key={t.id} className="flex items-center gap-3 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{t.description}</div>
                    <div className="text-xs text-default-500">
                      {fmtDate(t.date)} · {effectiveCategory(t)} · {accountName(t.accountId)}
                      {t.status === "PENDING" ? " · pending" : ""}
                    </div>
                  </div>
                  <Money value={t.amount} sign />
                  <Button size="sm" variant="light" isIconOnly aria-label="Untag" title="Remove from group" isDisabled={busy} onPress={() => tag([t.id], null)}>
                    <FaTimes />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ModalBody>
        <ModalFooter className="flex-wrap">
          <Button variant="light" color="danger" startContent={<FaTrash />} onPress={onDelete} className="mr-auto">
            Delete
          </Button>
          {candidates ? (
            <>
              <Button variant="light" onPress={() => setCandidates(null)}>
                Back
              </Button>
              <Button color="primary" isLoading={busy} isDisabled={!picked.size} onPress={() => tag([...picked], group.id)}>
                Tag {picked.size}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="flat"
                startContent={<FaMagic />}
                isDisabled={!canAutoAssign}
                title={canAutoAssign ? undefined : "Set a start and end date first"}
                onPress={loadCandidates}
              >
                Auto-assign by dates
              </Button>
              <Button variant="flat" startContent={<FaPen />} onPress={onEdit}>
                Edit
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
