"use client";

// /finance/scheduled — the household's scheduled transactions
// (homeFinanceRecurring): mortgage, car, utilities, insurance and each
// member's contribution into the joint account. Replaces homeBill.
// Writes go through the save_finance_schedule op; the sync links posted
// transactions to a schedule by matchPattern/amount/date and rolls
// nextDate forward, and "Find matches" does the same by hand.

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Switch } from "@heroui/switch";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast, Spinner } from "@heroui/react";
import { FaCheck, FaExternalLinkAlt, FaLink, FaPen, FaPlus, FaSearch } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money, PersonChip } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { FreeCombobox } from "@/components/free-combobox";
import { callOp } from "@/lib/ops-client";
import { listSchedules, listTransactions, txIndexQuery } from "@/lib/finance/data";
import { addDays, advanceByCadence, CADENCE_LABELS, CADENCE_MONTHLY_FACTOR, CADENCES, fmtDate, todayIso, type Cadence } from "@/lib/finance/dates";
import { findScheduleMatches, isScheduleLive, nextDateAfter } from "@/lib/finance/recurring";

type Schedule = any;
type Tx = any;

const TYPES = [
  { key: "EXPENSE", label: "Expense (money out)" },
  { key: "INCOME", label: "Contribution / income (money in)" },
  { key: "TRANSFER", label: "Transfer between accounts" },
] as const;

type Form = {
  id?: string;
  description: string;
  type: "EXPENSE" | "INCOME" | "TRANSFER";
  amount: string;
  cadence: Cadence;
  nextDate: string;
  endDate: string;
  accountId: string;
  toAccountId: string;
  category: string;
  personId: string;
  matchPattern: string;
  autopay: boolean;
  active: boolean;
  url: string;
  notes: string;
};

function emptyForm(accountId: string): Form {
  return {
    description: "",
    type: "EXPENSE",
    amount: "",
    cadence: "MONTHLY",
    nextDate: todayIso(),
    endDate: "",
    accountId,
    toAccountId: "",
    category: "",
    personId: "",
    matchPattern: "",
    autopay: true,
    active: true,
    url: "",
    notes: "",
  };
}

function formFrom(s: Schedule): Form {
  return {
    id: s.id,
    description: s.description ?? "",
    type: (s.type ?? "EXPENSE") as Form["type"],
    amount: String(Math.abs(s.amount ?? 0)),
    cadence: (s.cadence ?? "MONTHLY") as Cadence,
    nextDate: s.nextDate ?? s.startDate ?? "",
    endDate: s.endDate ?? "",
    accountId: s.accountId ?? "",
    toAccountId: s.toAccountId ?? "",
    category: s.category ?? "",
    personId: s.personId ?? "",
    matchPattern: s.matchPattern ?? "",
    autopay: s.autopay !== false,
    active: s.active !== false,
    url: s.url ?? "",
    notes: s.notes ?? "",
  };
}

/** One step past the current due date (weekly cadences don't use a day-of-month anchor). */
function stepNext(s: Schedule): string | null {
  const cur = s.nextDate ?? s.startDate;
  if (!cur) return null;
  const cadence = (s.cadence ?? "MONTHLY") as Cadence;
  if (cadence === "ONCE") return null;
  const anchor = cadence === "WEEKLY" || cadence === "BIWEEKLY" ? null : s.startDate;
  return advanceByCadence(cur, cadence, anchor);
}

export default function ScheduledPage() {
  const refs = useFinanceRefs();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [lastTx, setLastTx] = useState<Map<string, Tx>>(new Map());
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [matchFor, setMatchFor] = useState<Schedule | null>(null);

  const today = todayIso();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listSchedules(financeClient);
      setSchedules(rows);
      // Last posted transaction each schedule realized (recurringId index).
      const pairs = await Promise.all(
        rows.map(async (s) => {
          const r = await txIndexQuery(financeClient, "RecurringId")({ recurringId: s.id }, { limit: 200 });
          const posted = (r.data ?? []).filter((t: Tx) => t.status !== "PENDING").sort((a: Tx, b: Tx) => (b.date ?? "").localeCompare(a.date ?? ""));
          return [s.id, posted[0]] as const;
        }),
      );
      setLastTx(new Map(pairs.filter(([, t]) => !!t) as Array<[string, Tx]>));
    } catch (e) {
      addToast({ title: "Couldn't load scheduled transactions", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const accountName = useCallback((id: string | null | undefined) => refs.accounts.find((a) => a.id === id)?.name ?? "—", [refs.accounts]);

  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    for (const s of schedules) {
      if (!isScheduleLive(s, today) || s.type === "TRANSFER") continue;
      const monthly = Math.abs(s.amount ?? 0) * (CADENCE_MONTHLY_FACTOR[(s.cadence ?? "MONTHLY") as Cadence] ?? 1);
      if ((s.amount ?? 0) >= 0) inflow += monthly;
      else outflow += monthly;
    }
    return { inflow, outflow };
  }, [schedules, today]);

  const groups = useMemo(() => {
    const horizon = addDays(today, 30);
    const sorted = [...schedules].sort((a, b) => (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999"));
    const live = sorted.filter((s) => isScheduleLive(s, today) || (s.active !== false && s.nextDate && s.nextDate < today));
    const liveIds = new Set(live.map((s) => s.id));
    return {
      upcoming: live.filter((s) => s.nextDate && s.nextDate <= horizon),
      later: live.filter((s) => !s.nextDate || s.nextDate > horizon),
      inactive: sorted.filter((s) => !liveIds.has(s.id)),
    };
  }, [schedules, today]);

  /** Overdue: due date passed and no posted transaction on or after it. */
  const isOverdue = useCallback(
    (s: Schedule) => {
      if (!s.nextDate || s.nextDate >= today || s.active === false) return false;
      const last = lastTx.get(s.id);
      return !last || (last.date ?? "") < s.nextDate;
    },
    [lastTx, today],
  );

  function openNew() {
    const checking = refs.accounts.find((a) => a.active !== false && a.type === "CHECKING") ?? refs.accounts[0];
    setForm(emptyForm(checking?.id ?? ""));
  }

  async function save() {
    if (!form) return;
    const amount = Number(form.amount);
    if (!form.description.trim() || !Number.isFinite(amount) || amount <= 0 || !form.nextDate) {
      addToast({ title: "Description, a positive amount and the next date are required", color: "warning" });
      return;
    }
    setSaving(true);
    const input = {
      ...(form.id ? { recurringId: form.id } : {}),
      description: form.description.trim(),
      type: form.type,
      amount,
      cadence: form.cadence,
      nextDate: form.nextDate,
      endDate: form.endDate || null,
      category: form.category.trim() || null,
      ...(form.accountId ? { accountId: form.accountId } : {}),
      toAccountId: form.type === "TRANSFER" ? form.toAccountId || null : null,
      personId: form.type === "INCOME" ? form.personId || null : null,
      matchPattern: form.matchPattern.trim() || null,
      autopay: form.autopay,
      active: form.active,
      url: form.url.trim() || null,
      notes: form.notes.trim() || null,
    };
    const r = await callOp(financeClient, "save_finance_schedule", input);
    setSaving(false);
    if ("error" in r) {
      addToast({ title: "Couldn't save", description: r.error, color: "danger" });
      return;
    }
    addToast({ title: r.result.action === "created" ? "Scheduled" : "Saved", color: "success" });
    setForm(null);
    load();
  }

  async function markPaid(s: Schedule) {
    const next = stepNext(s);
    const r = await callOp(financeClient, "save_finance_schedule", next ? { recurringId: s.id, nextDate: next } : { recurringId: s.id, active: false });
    if ("error" in r) addToast({ title: "Couldn't mark paid", description: r.error, color: "danger" });
    else {
      addToast({ title: next ? `Marked paid — next due ${fmtDate(next)}` : "Marked paid", color: "success" });
      load();
    }
  }

  function Row({ s }: { s: Schedule }) {
    const overdue = isOverdue(s);
    const last = lastTx.get(s.id);
    return (
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 border-b border-default-100 last:border-0 ${overdue ? "bg-danger-50" : ""}`}>
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{s.description}</span>
            {s.url && (
              <a href={s.url} target="_blank" rel="noreferrer" className="text-default-400 hover:text-primary" aria-label="Open link">
                <FaExternalLinkAlt size={11} />
              </a>
            )}
            {s.autopay === false ? (
              <Chip size="sm" color="warning" variant="flat">
                Pay by hand
              </Chip>
            ) : (
              <Chip size="sm" variant="flat">
                Autopay
              </Chip>
            )}
            {overdue && (
              <Chip size="sm" color="danger" variant="flat">
                Overdue
              </Chip>
            )}
            {s.type === "INCOME" && <PersonChip personId={s.personId} people={refs.people} />}
          </div>
          <div className="text-xs text-default-500 mt-0.5">
            {CADENCE_LABELS[(s.cadence ?? "MONTHLY") as Cadence]} · {accountName(s.accountId)}
            {s.type === "TRANSFER" && s.toAccountId ? ` → ${accountName(s.toAccountId)}` : ""}
            {s.category ? ` · ${s.category}` : ""}
            {last ? ` · last ${fmtDate(last.date)} (${last.amount < 0 ? "-" : ""}$${Math.abs(last.amount).toFixed(2)})` : " · no matched transaction yet"}
          </div>
        </div>
        <div className="text-right w-28">
          <div className="text-sm">{s.nextDate ? fmtDate(s.nextDate, { month: "short", day: "numeric", year: s.nextDate.slice(0, 4) !== today.slice(0, 4) ? "numeric" : undefined }) : "—"}</div>
        </div>
        <div className="text-right w-28 font-medium">
          <Money value={s.amount} sign />
        </div>
        <div className="flex gap-1">
          {s.autopay === false && s.active !== false && (
            <Button size="sm" variant="light" isIconOnly aria-label="Mark paid" title="Mark paid" onPress={() => markPaid(s)}>
              <FaCheck />
            </Button>
          )}
          <Button size="sm" variant="light" isIconOnly aria-label="Find matches" title="Find matching transactions" onPress={() => setMatchFor(s)}>
            <FaSearch />
          </Button>
          <Button size="sm" variant="light" isIconOnly aria-label="Edit" onPress={() => setForm(formFrom(s))}>
            <FaPen />
          </Button>
        </div>
      </div>
    );
  }

  function Section({ title, rows, hint }: { title: string; rows: Schedule[]; hint?: string }) {
    if (!rows.length) return null;
    return (
      <Card className="mb-4">
        <CardBody className="p-0">
          <div className="px-3 py-2 border-b border-default-200 flex items-baseline justify-between">
            <h2 className="font-semibold text-sm">{title}</h2>
            {hint && <span className="text-xs text-default-500">{hint}</span>}
          </div>
          {rows.map((s) => (
            <Row key={s.id} s={s} />
          ))}
        </CardBody>
      </Card>
    );
  }

  return (
    <FinanceShell
      title="Scheduled"
      subtitle="Mortgage, car, bills and contributions. Posted transactions are matched automatically by the sync."
      onSynced={load}
      actions={
        <Button size="sm" color="primary" startContent={<FaPlus />} onPress={openNew}>
          New
        </Button>
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <Card>
          <CardBody>
            <div className="text-xs text-default-500">Coming in / month</div>
            <Money value={totals.inflow} className="text-lg font-semibold text-success-600" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-xs text-default-500">Going out / month</div>
            <Money value={-totals.outflow} className="text-lg font-semibold" />
          </CardBody>
        </Card>
        <Card className="col-span-2 sm:col-span-1">
          <CardBody>
            <div className="text-xs text-default-500">Net / month</div>
            <Money value={totals.inflow - totals.outflow} sign className="text-lg font-semibold" />
          </CardBody>
        </Card>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState title="Nothing scheduled yet">Add the mortgage, the car payment and each person&apos;s monthly contribution.</EmptyState>
      ) : (
        <>
          <Section title="Upcoming" rows={groups.upcoming} hint="next 30 days" />
          <Section title="Later" rows={groups.later} />
          <Section title="Inactive" rows={groups.inactive} hint="paused, ended or one-time and done" />
        </>
      )}

      <Modal isOpen={!!form} onClose={() => setForm(null)} size="2xl" scrollBehavior="inside">
        <ModalContent>
          {form && (
            <>
              <ModalHeader>{form.id ? "Edit scheduled transaction" : "New scheduled transaction"}</ModalHeader>
              <ModalBody>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Description" value={form.description} onValueChange={(v) => setForm({ ...form, description: v })} className="sm:col-span-2" isRequired />
                  <Select label="Type" selectedKeys={[form.type]} onChange={(e) => e.target.value && setForm({ ...form, type: e.target.value as Form["type"] })}>
                    {TYPES.map((t) => (
                      <SelectItem key={t.key}>{t.label}</SelectItem>
                    ))}
                  </Select>
                  <Input
                    label="Amount"
                    type="number"
                    min={0}
                    step="0.01"
                    startContent={<span className="text-default-400 text-sm">$</span>}
                    value={form.amount}
                    onValueChange={(v) => setForm({ ...form, amount: v })}
                    description="The usual amount; the sign follows the type"
                    isRequired
                  />
                  <Select label="How often" selectedKeys={[form.cadence]} onChange={(e) => e.target.value && setForm({ ...form, cadence: e.target.value as Cadence })}>
                    {CADENCES.map((c) => (
                      <SelectItem key={c}>{CADENCE_LABELS[c]}</SelectItem>
                    ))}
                  </Select>
                  <Input label="Next due" type="date" value={form.nextDate} onValueChange={(v) => setForm({ ...form, nextDate: v })} isRequired />
                  <Select label="Account" selectedKeys={form.accountId ? [form.accountId] : []} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                    {refs.accounts.map((a) => (
                      <SelectItem key={a.id}>{a.name}</SelectItem>
                    ))}
                  </Select>
                  {form.type === "TRANSFER" ? (
                    <Select label="To account" selectedKeys={form.toAccountId ? [form.toAccountId] : []} onChange={(e) => setForm({ ...form, toAccountId: e.target.value })}>
                      {refs.accounts
                        .filter((a) => a.id !== form.accountId)
                        .map((a) => (
                          <SelectItem key={a.id}>{a.name}</SelectItem>
                        ))}
                    </Select>
                  ) : form.type === "INCOME" ? (
                    <Select label="Contributed by" selectedKeys={form.personId ? [form.personId] : []} onChange={(e) => setForm({ ...form, personId: e.target.value })}>
                      {refs.people.map((p) => (
                        <SelectItem key={p.id}>{p.name}</SelectItem>
                      ))}
                    </Select>
                  ) : (
                    <Input label="Ends on (optional)" type="date" value={form.endDate} onValueChange={(v) => setForm({ ...form, endDate: v })} />
                  )}
                  <FreeCombobox label="Category" value={form.category} onValueChange={(v) => setForm({ ...form, category: v })} options={refs.categories} />
                  {form.type !== "EXPENSE" && <Input label="Ends on (optional)" type="date" value={form.endDate} onValueChange={(v) => setForm({ ...form, endDate: v })} />}
                  <Input
                    label="Match pattern"
                    placeholder="ROCKET MORTGAGE  or  /TOYOTA.*PMT/i"
                    value={form.matchPattern}
                    onValueChange={(v) => setForm({ ...form, matchPattern: v })}
                    description="A word from the bank description (or /regex/flags). Lets the sync link posted transactions even when the amount varies."
                    className="sm:col-span-2"
                  />
                  <Input label="Link (optional)" placeholder="https://…" value={form.url} onValueChange={(v) => setForm({ ...form, url: v })} className="sm:col-span-2" />
                  <Input label="Notes" value={form.notes} onValueChange={(v) => setForm({ ...form, notes: v })} className="sm:col-span-2" />
                  <Switch isSelected={form.autopay} onValueChange={(v) => setForm({ ...form, autopay: v })}>
                    Autopay
                  </Switch>
                  <Switch isSelected={form.active} onValueChange={(v) => setForm({ ...form, active: v })}>
                    Active
                  </Switch>
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

      <MatchModal
        schedule={matchFor}
        onClose={() => setMatchFor(null)}
        onLinked={() => {
          setMatchFor(null);
          load();
        }}
      />
    </FinanceShell>
  );
}

/** Unlinked transactions from the last 90 days that look like an occurrence of this schedule. */
function MatchModal({ schedule, onClose, onLinked }: { schedule: Schedule | null; onClose: () => void; onLinked: () => void }) {
  const [candidates, setCandidates] = useState<Array<{ tx: Tx; score: number; reasons: string[] }> | null>(null);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    if (!schedule) return;
    setCandidates(null);
    const today = todayIso();
    listTransactions(financeClient, { fromIso: addDays(today, -90), toIso: today, accountIds: [schedule.accountId] })
      .then((txs) => {
        const out = txs
          .filter((t) => !t.recurringId && t.status !== "PENDING")
          .map((tx) => {
            const m = findScheduleMatches(tx, [schedule], 1)[0];
            return { tx, score: m?.score ?? 0, reasons: m?.reasons ?? [] };
          })
          .filter((c) => c.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 25);
        setCandidates(out);
      })
      .catch((e) => {
        addToast({ title: "Couldn't load transactions", description: e instanceof Error ? e.message : String(e), color: "danger" });
        setCandidates([]);
      });
  }, [schedule]);

  async function link(tx: Tx) {
    if (!schedule) return;
    setLinking(tx.id);
    const r = await financeClient.models.homeFinanceTransaction.update({ id: tx.id, recurringId: schedule.id });
    if (r.errors?.length) {
      setLinking(null);
      addToast({ title: "Couldn't link", description: r.errors[0].message, color: "danger" });
      return;
    }
    const next = nextDateAfter(schedule, tx.date);
    if (next && next !== schedule.nextDate) {
      const op = await callOp(financeClient, "save_finance_schedule", { recurringId: schedule.id, nextDate: next });
      if ("error" in op) addToast({ title: "Linked, but couldn't move the due date", description: op.error, color: "warning" });
    }
    setLinking(null);
    addToast({ title: next ? `Linked — next due ${fmtDate(next)}` : "Linked", color: "success" });
    onLinked();
  }

  return (
    <Modal isOpen={!!schedule} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>Transactions matching “{schedule?.description}”</ModalHeader>
        <ModalBody>
          {candidates == null ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : candidates.length === 0 ? (
            <EmptyState title="No likely matches in the last 90 days">Same account, same direction and a close amount are required; a match pattern widens the amount range.</EmptyState>
          ) : (
            <div className="divide-y divide-default-100">
              {candidates.map(({ tx, score, reasons }) => (
                <div key={tx.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{tx.description}</div>
                    <div className="text-xs text-default-500">
                      {fmtDate(tx.date)} · score {score} · {reasons.join(", ")}
                    </div>
                  </div>
                  <Money value={tx.amount} sign />
                  <Button size="sm" variant="flat" startContent={<FaLink />} isLoading={linking === tx.id} onPress={() => link(tx)}>
                    Link
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Close
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
