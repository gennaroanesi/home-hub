"use client";

// /finance/goals — household savings goals. Progress is either manual
// (currentAmount) or follows one or more accounts' balances (the joint
// savings; both 401ks for retirement), allocated across the goals drawing
// on them in priority order (lib/finance/goals.ts). Writes go
// through the save_finance_goal op. Transactions tagged with a goal (goalId)
// are totalled on the card as "tagged". Milestones ("$20k by June 2027")
// show as markers on the bar and a list, HIT / MISSED / PENDING.

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Switch } from "@heroui/switch";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast, Progress, Spinner } from "@heroui/react";
import { FaArchive, FaCheck, FaPen, FaPlus, FaRegCircle, FaTimes, FaTrash, FaUndo } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { callOp } from "@/lib/ops-client";
import { listGoalMilestones, listGoals, listTransactions } from "@/lib/finance/data";
import { fmtCurrency, fmtDate, todayIso } from "@/lib/finance/dates";
import { accountTypeLabel } from "@/lib/finance/accounts";
import { goalAccountIds, goalProgress, milestoneViews, type MilestoneLike, type MilestoneStatus } from "@/lib/finance/goals";

type MilestoneDraft = { id?: string; targetAmount: string; targetDate: string; label: string };

const STATUS_ICON: Record<MilestoneStatus, React.ReactNode> = {
  HIT: <FaCheck className="text-success" />,
  MISSED: <FaTimes className="text-danger" />,
  PENDING: <FaRegCircle className="text-default-400" />,
};

type Form = {
  id?: string;
  name: string;
  targetAmount: string;
  currentAmount: string;
  fundingAccountIds: string[]; // empty = tracked by hand
  priority: string;
  targetDate: string;
  notes: string;
  milestones: MilestoneDraft[];
};

function emptyForm(): Form {
  return { name: "", targetAmount: "", currentAmount: "0", fundingAccountIds: [], priority: "100", targetDate: "", notes: "", milestones: [] };
}

export default function GoalsPage() {
  const refs = useFinanceRefs();
  const [goals, setGoals] = useState<any[]>([]);
  const [milestones, setMilestones] = useState<MilestoneLike[]>([]);
  const [tagged, setTagged] = useState<Map<string, { total: number; count: number }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, txs, ms] = await Promise.all([listGoals(financeClient), listTransactions(financeClient), listGoalMilestones(financeClient)]);
      setGoals(rows);
      setMilestones(ms);
      const m = new Map<string, { total: number; count: number }>();
      for (const t of txs) {
        if (!t.goalId || t.status === "PENDING") continue;
        const cur = m.get(t.goalId) ?? { total: 0, count: 0 };
        m.set(t.goalId, { total: cur.total + (t.amount ?? 0), count: cur.count + 1 });
      }
      setTagged(m);
    } catch (e) {
      addToast({ title: "Couldn't load goals", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const progress = useMemo(() => goalProgress(goals, refs.accounts, todayIso()), [goals, refs.accounts]);
  const shown = progress
    .filter((p) => (showArchived ? p.goal.active === false : p.goal.active !== false))
    .sort((a, b) => (a.goal.priority ?? 100) - (b.goal.priority ?? 100) || a.goal.name.localeCompare(b.goal.name));
  const activeTotals = progress
    .filter((p) => p.goal.active !== false)
    .reduce((acc, p) => ({ current: acc.current + p.current, target: acc.target + p.target }), { current: 0, target: 0 });

  async function save() {
    if (!form) return;
    const target = Number(form.targetAmount);
    if (!form.name.trim() || !Number.isFinite(target) || target <= 0) {
      addToast({ title: "A name and a positive target are required", color: "warning" });
      return;
    }
    const manual = form.fundingAccountIds.length === 0;
    // Untouched blank rows are dropped; half-filled ones are an error.
    const rows = form.milestones.filter((m) => m.targetAmount.trim() || m.targetDate || m.label.trim());
    if (rows.some((m) => !(Number(m.targetAmount) > 0) || !m.targetDate)) {
      addToast({ title: "Each milestone needs an amount and a date", color: "warning" });
      return;
    }
    setSaving(true);
    const r = await callOp(financeClient, "save_finance_goal", {
      ...(form.id ? { goalId: form.id } : {}),
      name: form.name.trim(),
      targetAmount: target,
      ...(manual ? { currentAmount: Math.max(0, Number(form.currentAmount) || 0) } : {}),
      fundingAccountIds: form.fundingAccountIds,
      priority: Number.parseInt(form.priority, 10) || 100,
      targetDate: form.targetDate || null,
      notes: form.notes.trim() || null,
      milestones: rows.map((m) => ({ ...(m.id ? { id: m.id } : {}), targetAmount: Number(m.targetAmount), targetDate: m.targetDate, label: m.label.trim() || null })),
    });
    setSaving(false);
    if ("error" in r) {
      addToast({ title: "Couldn't save", description: r.error, color: "danger" });
      return;
    }
    setForm(null);
    load();
  }

  async function setActive(goalId: string, active: boolean) {
    const r = await callOp(financeClient, "save_finance_goal", { goalId, active });
    if ("error" in r) addToast({ title: "Couldn't update", description: r.error, color: "danger" });
    else load();
  }

  return (
    <FinanceShell
      title="Goals"
      subtitle="What the household is saving toward"
      onSynced={() => {
        refs.reload();
        load();
      }}
      actions={
        <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => setForm(emptyForm())}>
          New goal
        </Button>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="text-sm text-default-600">
          {activeTotals.target > 0 && (
            <>
              <Money value={activeTotals.current} cents={false} /> of <Money value={activeTotals.target} cents={false} /> saved across active goals
            </>
          )}
        </div>
        <Switch size="sm" isSelected={showArchived} onValueChange={setShowArchived}>
          Archived
        </Switch>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState title={showArchived ? "No archived goals" : "No goals yet"}>
          {!showArchived && "An emergency fund, the baby, retirement — point one at the joint savings or the 401ks and it tracks itself."}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {shown.map((p) => {
            const g = p.goal as any;
            const t = tagged.get(g.id);
            const fundingName = goalAccountIds(g)
              .map((id) => refs.accounts.find((a) => a.id === id)?.name)
              .filter(Boolean)
              .join(" + ");
            const views = milestoneViews(
              milestones.filter((m) => m.goalId === g.id),
              p.current,
              todayIso(),
            );
            return (
              <Card key={g.id}>
                <CardBody className="gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">{g.name}</h3>
                      <div className="text-xs text-default-500 flex flex-wrap gap-x-2">
                        <span>{p.funded === "account" ? `From ${fundingName || "an account"}` : "Tracked by hand"}</span>
                        {g.targetDate && <span>· by {fmtDate(g.targetDate, { month: "short", day: "numeric", year: "numeric" })}</span>}
                        {p.funded === "account" && <span>· priority {g.priority ?? 100}</span>}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="light"
                        isIconOnly
                        aria-label="Edit"
                        onPress={() =>
                          setForm({
                            id: g.id,
                            name: g.name,
                            targetAmount: String(g.targetAmount ?? ""),
                            currentAmount: String(g.currentAmount ?? 0),
                            fundingAccountIds: goalAccountIds(g),
                            priority: String(g.priority ?? 100),
                            targetDate: g.targetDate ?? "",
                            notes: g.notes ?? "",
                            milestones: views.map((v) => ({ id: v.milestone.id, targetAmount: String(v.milestone.targetAmount), targetDate: v.milestone.targetDate, label: v.milestone.label ?? "" })),
                          })
                        }
                      >
                        <FaPen />
                      </Button>
                      <Button
                        size="sm"
                        variant="light"
                        isIconOnly
                        aria-label={g.active === false ? "Restore" : "Archive"}
                        title={g.active === false ? "Restore" : "Archive"}
                        onPress={() => setActive(g.id, g.active === false)}
                      >
                        {g.active === false ? <FaUndo /> : <FaArchive />}
                      </Button>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-baseline justify-between text-sm mb-1">
                      <span>
                        <Money value={p.current} cents={false} className="font-semibold" /> <span className="text-default-500">of</span> <Money value={p.target} cents={false} />
                      </span>
                      <span className="text-default-500">{Math.round(p.pct * 100)}%</span>
                    </div>
                    <div className="relative">
                      <Progress aria-label="Goal progress" size="md" value={p.pct * 100} color={p.pct >= 1 ? "success" : "primary"} />
                      {p.target > 0 &&
                        views.map((v) => (
                          <div
                            key={v.milestone.id}
                            className={`absolute inset-y-0 w-0.5 ${v.status === "HIT" ? "bg-success-700" : "bg-default-600"}`}
                            style={{ left: `${Math.min(100, (v.milestone.targetAmount / p.target) * 100)}%` }}
                            title={`${v.milestone.label ? `${v.milestone.label}: ` : ""}${fmtCurrency(v.milestone.targetAmount, { cents: false })} by ${fmtDate(v.milestone.targetDate, { month: "short", day: "numeric", year: "numeric" })}`}
                          />
                        ))}
                    </div>
                  </div>
                  {views.length > 0 && (
                    <ul className="flex flex-col gap-1 border-t border-default-100 pt-2 text-xs">
                      {views.map((v) => (
                        <li key={v.milestone.id} className="flex items-center gap-2">
                          <span title={v.status.toLowerCase()}>{STATUS_ICON[v.status]}</span>
                          <Money value={v.milestone.targetAmount} cents={false} className="font-semibold" />
                          <span className="text-default-500">by {fmtDate(v.milestone.targetDate, { month: "short", day: "numeric", year: "numeric" })}</span>
                          {v.milestone.label && <span className="text-default-500 truncate">· {v.milestone.label}</span>}
                          {v.monthlyNeeded != null && (
                            <span className="ml-auto text-default-500 whitespace-nowrap">
                              <Money value={v.monthlyNeeded} cents={false} />
                              /mo
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2 text-xs">
                    {p.pct >= 1 ? (
                      <Chip size="sm" color="success" variant="flat">
                        Reached
                      </Chip>
                    ) : p.monthlyNeeded != null ? (
                      <Chip size="sm" variant="flat">
                        Needs <Money value={p.monthlyNeeded} cents={false} />/month
                      </Chip>
                    ) : null}
                    {t && (
                      <Chip size="sm" variant="flat">
                        {t.count} tagged · <Money value={t.total} cents={false} sign />
                      </Chip>
                    )}
                  </div>
                  {g.notes && <p className="text-xs text-default-500">{g.notes}</p>}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <Modal isOpen={!!form} onClose={() => setForm(null)} size="2xl" scrollBehavior="inside">
        <ModalContent>
          {form && (
            <>
              <ModalHeader>{form.id ? "Edit goal" : "New goal"}</ModalHeader>
              <ModalBody>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Name" value={form.name} onValueChange={(v) => setForm({ ...form, name: v })} className="sm:col-span-2" isRequired />
                  <Input
                    label="Target"
                    type="number"
                    min={0}
                    startContent={<span className="text-default-400 text-sm">$</span>}
                    value={form.targetAmount}
                    onValueChange={(v) => setForm({ ...form, targetAmount: v })}
                    isRequired
                  />
                  <Input label="Target date (optional)" type="date" placeholder=" " value={form.targetDate} onValueChange={(v) => setForm({ ...form, targetDate: v })} />
                  <Select
                    label="Progress comes from"
                    placeholder="Tracked by hand"
                    selectionMode="multiple"
                    selectedKeys={new Set(form.fundingAccountIds)}
                    onSelectionChange={(keys) => {
                      const picked = new Set(Array.from(keys as Set<string>).map(String));
                      // Keep the order already chosen; new picks go last (drawn on in this order).
                      const kept = form.fundingAccountIds.filter((id) => picked.has(id));
                      setForm({ ...form, fundingAccountIds: [...kept, ...[...picked].filter((id) => !kept.includes(id))] });
                    }}
                    className="sm:col-span-2"
                    description="None = tracked by hand. Pick several for a goal like retirement (both 401ks); an account's balance is shared among its goals in priority order."
                  >
                    {refs.accounts.map((a) => (
                      <SelectItem key={a.id} description={accountTypeLabel(a)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </Select>
                  {form.fundingAccountIds.length === 0 ? (
                    <Input
                      label="Saved so far"
                      type="number"
                      min={0}
                      startContent={<span className="text-default-400 text-sm">$</span>}
                      value={form.currentAmount}
                      onValueChange={(v) => setForm({ ...form, currentAmount: v })}
                    />
                  ) : (
                    <Input label="Priority" type="number" value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v })} description="Lower is funded first" />
                  )}
                  <Input label="Notes" value={form.notes} onValueChange={(v) => setForm({ ...form, notes: v })} className="sm:col-span-2" />
                </div>
                <MilestoneEditor rows={form.milestones} onChange={(milestones) => setForm({ ...form, milestones })} />
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
    </FinanceShell>
  );
}

function MilestoneEditor({ rows, onChange }: { rows: MilestoneDraft[]; onChange: (rows: MilestoneDraft[]) => void }) {
  const update = (i: number, patch: Partial<MilestoneDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Milestones</span>
        <Button size="sm" variant="flat" startContent={<FaPlus />} onPress={() => onChange([...rows, { targetAmount: "", targetDate: "", label: "" }])}>
          Add
        </Button>
      </div>
      {rows.length === 0 && <div className="text-xs text-default-500">Checkpoints on the way, like $20k by next June.</div>}
      {rows.map((m, i) => (
        <div key={m.id ?? `new-${i}`} className="grid grid-cols-[1fr_1fr_auto] sm:grid-cols-[1fr_1fr_1.5fr_auto] gap-2 items-center">
          <Input
            size="sm"
            label="Amount"
            type="number"
            min={0}
            startContent={<span className="text-default-400 text-sm">$</span>}
            value={m.targetAmount}
            onValueChange={(v) => update(i, { targetAmount: v })}
          />
          <Input size="sm" label="By" type="date" placeholder=" " value={m.targetDate} onValueChange={(v) => update(i, { targetDate: v })} />
          <Input size="sm" label="Label (optional)" value={m.label} onValueChange={(v) => update(i, { label: v })} className="col-span-2 sm:col-span-1 row-start-2 sm:row-start-auto" />
          <Button size="sm" isIconOnly variant="light" aria-label="Remove milestone" className="row-start-1 col-start-3 sm:col-start-auto" onPress={() => onChange(rows.filter((_, j) => j !== i))}>
            <FaTrash />
          </Button>
        </div>
      ))}
    </div>
  );
}
