"use client";

// /finance/goals — household savings goals. Progress is either manual
// (currentAmount) or follows a funding account's balance, allocated across
// that account's goals in priority order (lib/finance/goals.ts). Writes go
// through the save_finance_goal op. Transactions tagged with a goal (goalId)
// are totalled on the card as "tagged".

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
import { FaArchive, FaPen, FaPlus, FaUndo } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { callOp } from "@/lib/ops-client";
import { listGoals, listTransactions } from "@/lib/finance/data";
import { fmtDate, todayIso } from "@/lib/finance/dates";
import { goalProgress } from "@/lib/finance/goals";

const MANUAL = "__manual";

type Form = {
  id?: string;
  name: string;
  targetAmount: string;
  currentAmount: string;
  fundingAccountId: string;
  priority: string;
  targetDate: string;
  notes: string;
};

function emptyForm(): Form {
  return { name: "", targetAmount: "", currentAmount: "0", fundingAccountId: MANUAL, priority: "100", targetDate: "", notes: "" };
}

export default function GoalsPage() {
  const refs = useFinanceRefs();
  const [goals, setGoals] = useState<any[]>([]);
  const [tagged, setTagged] = useState<Map<string, { total: number; count: number }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, txs] = await Promise.all([listGoals(financeClient), listTransactions(financeClient)]);
      setGoals(rows);
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
    const manual = form.fundingAccountId === MANUAL;
    setSaving(true);
    const r = await callOp(financeClient, "save_finance_goal", {
      ...(form.id ? { goalId: form.id } : {}),
      name: form.name.trim(),
      targetAmount: target,
      ...(manual ? { currentAmount: Math.max(0, Number(form.currentAmount) || 0) } : {}),
      fundingAccountId: manual ? null : form.fundingAccountId,
      priority: Number.parseInt(form.priority, 10) || 100,
      targetDate: form.targetDate || null,
      notes: form.notes.trim() || null,
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
          {!showArchived && "An emergency fund, the baby, a trip — point one at the joint savings account and it tracks itself."}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {shown.map((p) => {
            const g = p.goal as any;
            const t = tagged.get(g.id);
            const fundingName = g.fundingAccountId ? refs.accounts.find((a) => a.id === g.fundingAccountId)?.name : null;
            return (
              <Card key={g.id}>
                <CardBody className="gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">{g.name}</h3>
                      <div className="text-xs text-default-500 flex flex-wrap gap-x-2">
                        <span>{p.funded === "account" ? `From ${fundingName ?? "an account"}` : "Tracked by hand"}</span>
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
                            fundingAccountId: g.fundingAccountId ?? MANUAL,
                            priority: String(g.priority ?? 100),
                            targetDate: g.targetDate ?? "",
                            notes: g.notes ?? "",
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
                    <Progress aria-label="Goal progress" size="md" value={p.pct * 100} color={p.pct >= 1 ? "success" : "primary"} />
                  </div>
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

      <Modal isOpen={!!form} onClose={() => setForm(null)} size="lg">
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
                  <Input label="Target date (optional)" type="date" value={form.targetDate} onValueChange={(v) => setForm({ ...form, targetDate: v })} />
                  <Select
                    label="Progress comes from"
                    selectedKeys={[form.fundingAccountId]}
                    onChange={(e) => e.target.value && setForm({ ...form, fundingAccountId: e.target.value })}
                    className="sm:col-span-2"
                    description="An account's balance is shared among its goals in priority order"
                  >
                    {[<SelectItem key={MANUAL}>Tracked by hand</SelectItem>, ...refs.accounts.map((a) => <SelectItem key={a.id}>{`${a.name} balance`}</SelectItem>)]}
                  </Select>
                  {form.fundingAccountId === MANUAL ? (
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
