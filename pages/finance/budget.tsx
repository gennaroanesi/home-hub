"use client";

// /finance/budget — the household budget for a month, quarter or year:
// what each of us planned to put in vs what came in, what went to savings,
// each spending line's pace, what isn't budgeted, and every budget series
// with its versions.
// Computation is lib/finance/budget.ts (householdBudget); writes go
// through the save_finance_budget op, which versions lines.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Select, SelectItem } from "@heroui/select";
import { Spinner, addToast } from "@heroui/react";
import { FaChevronDown, FaChevronUp, FaExclamationTriangle, FaHistory, FaPen, FaPlus, FaStop } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { BudgetBar, EmptyState, Money, PersonChip } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { BudgetLineModal, draftFromLine, emptyDraft, type BudgetDraft } from "@/components/finance/budget-line-modal";
import { callOp } from "@/lib/ops-client";
import {
  BUDGET_PERIOD_LABELS,
  bucketCategories,
  budgetTransactions,
  householdBudget,
  listBudgetSeries,
  seedFromHistory,
  type BudgetLine,
  type BudgetLineView,
  type BudgetPeriod,
  type CategorySeed,
} from "@/lib/finance/budget";
import { fmtCurrency, fmtDate, monthEnd, monthStart, monthsIn, shiftMonth, todayIso } from "@/lib/finance/dates";
import { periodContaining } from "@/lib/finance/periods";
import { PeriodPicker, usePeriod } from "@/components/finance/period-picker";
import { listBudgetLines, listSchedules, listTransactions } from "@/lib/finance/data";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function BudgetPage() {
  const refs = useFinanceRefs();
  const today = todayIso();
  const { period, range, setPeriod } = usePeriod(() => periodContaining("month", today));

  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [txs, setTxs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<BudgetDraft | null>(null);
  const [seeds, setSeeds] = useState<CategorySeed[] | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [pickTarget, setPickTarget] = useState<string>("");

  const activeAccountIds = useMemo(() => refs.accounts.filter((a) => a.active !== false).map((a) => a.id), [refs.accounts]);

  const load = useCallback(async () => {
    if (refs.loading) return;
    setLoading(true);
    try {
      const [l, s, t] = await Promise.all([
        listBudgetLines(financeClient),
        listSchedules(financeClient),
        listTransactions(financeClient, { fromIso: range.fromIso, toIso: range.toIso, accountIds: activeAccountIds }),
      ]);
      setLines(l);
      setSchedules(s);
      setTxs(t);
    } catch (e) {
      addToast({ title: "Couldn't load the budget", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, [refs.loading, range.fromIso, range.toIso, activeAccountIds]);

  useEffect(() => {
    load();
  }, [load]);

  const view = useMemo(() => householdBudget(lines, txs, schedules, range, today), [lines, txs, schedules, range, today]);
  const series = useMemo(() => listBudgetSeries(lines, today), [lines, today]);
  const elapsed = view.expenseViews[0]?.elapsed ?? view.incomeViews[0]?.elapsed;
  // New lines and changes start no earlier than this month: past months keep their budget.
  const newFrom = range.fromIso > monthStart(today) ? range.fromIso : monthStart(today);

  async function endSeries(seriesId: string, name: string) {
    // Ends with this month: the current month keeps it, the next one doesn't.
    const endOn = monthEnd(today);
    if (!confirm(`End “${name}” on ${fmtDate(endOn, { month: "short", day: "numeric", year: "numeric" })}? Past months keep it.`)) return;
    const r = await callOp(financeClient, "save_finance_budget", { seriesId, endOn });
    if ("error" in r) addToast({ title: "Couldn't end it", description: r.error, color: "danger" });
    else {
      addToast({ title: `Ended “${name}”`, color: "success" });
      load();
    }
  }

  async function startFromHistory() {
    setSeeding(true);
    try {
      const lastFull = shiftMonth(monthStart(today), -1);
      const from = shiftMonth(lastFull, -2);
      const hist = await listTransactions(financeClient, { fromIso: from, toIso: monthEnd(lastFull), accountIds: activeAccountIds });
      setSeeds(seedFromHistory(hist, monthsIn({ fromIso: from, toIso: lastFull })));
    } finally {
      setSeeding(false);
    }
  }

  function addToLine(category: string) {
    const target = view.expenseViews.find((v) => v.line.seriesId === pickTarget);
    if (!target) return setDraft(emptyDraft(newFrom, { name: category, categories: [category] }));
    const d = draftFromLine(target.line, newFrom);
    setDraft({ ...d, categories: [...d.categories, category] });
  }

  return (
    <FinanceShell
      title="Budget"
      subtitle="What we planned to put in and spend, and how it's going"
      onSynced={load}
      actions={
        <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => setDraft(emptyDraft(newFrom))}>
          New line
        </Button>
      }
    >
      <div className="mb-4">
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      {loading || refs.loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {view.issues.length > 0 && (
            <Card className="border border-warning-300 bg-warning-50">
              <CardBody className="text-sm gap-1">
                <p className="font-medium flex items-center gap-2">
                  <FaExclamationTriangle className="text-warning-600" /> The budget has {view.issues.length} problem{view.issues.length === 1 ? "" : "s"}
                </p>
                {view.issues.map((i, n) => (
                  <p key={n} className="text-default-700">
                    <span className="font-medium">{i.name}:</span> {i.detail}
                  </p>
                ))}
              </CardBody>
            </Card>
          )}

          {/* Headline */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="We planned to put in" value={view.planned} sub={<>received <Money value={view.received} /></>} />
            <Stat
              label="Budgeted to spend"
              value={view.allocated}
              sub={
                <>
                  {view.unallocated < 0 ? (
                    <span className="text-danger-600">{fmtCurrency(-view.unallocated)} more than comes in</span>
                  ) : (
                    <>{fmtCurrency(view.unallocated)} not allocated</>
                  )}
                  {view.savingsPlanned > 0 && <> after {fmtCurrency(view.savingsPlanned, { cents: false })} to savings</>}
                </>
              }
            />
            <Stat label="Spent on budgeted lines" value={view.spentBudgeted} sub={<>of {fmtCurrency(view.allocated)}</>} />
            <Stat
              label="Spent in total"
              value={view.spentTotal}
              sub={view.overspend > 0 ? <span className="text-danger-600">{fmtCurrency(view.overspend)} over on some lines</span> : "no line over"}
            />
          </div>

          {/* Contributions */}
          <Card>
            <CardHeader className="font-semibold">Contributions</CardHeader>
            <CardBody className="gap-3 pt-0">
              {view.incomeViews.length === 0 ? (
                <p className="text-sm text-default-500">
                  No contribution lines yet. Add one per person (&quot;Contribution&quot;) so the budget knows what comes in.
                  <Button size="sm" variant="light" color="primary" className="ml-2" onPress={() => setDraft(emptyDraft(newFrom, { kind: "INCOME" }))}>
                    Add contribution
                  </Button>
                </p>
              ) : (
                view.incomeViews.map((v) => (
                  <div key={v.line.id} className="flex items-center gap-3">
                    <div className="w-40 shrink-0">
                      <PersonChip personId={v.line.personId} people={refs.people} />
                    </div>
                    <div className="flex-1">
                      <BudgetBar spent={v.spent} budgeted={v.budgeted} income />
                    </div>
                    <div className="text-sm w-48 text-right tabular-nums">
                      <Money value={v.spent} /> <span className="text-default-400">of</span> <Money value={v.budgeted} cents={false} />
                    </div>
                    <LineActions line={v.line} onEdit={() => setDraft(draftFromLine(v.line, newFrom))} onEnd={() => endSeries(v.line.seriesId, v.line.name)} />
                  </div>
                ))
              )}
            </CardBody>
          </Card>

          {/* Savings */}
          <Card>
            <CardHeader className="font-semibold">Savings</CardHeader>
            <CardBody className="gap-3 pt-0">
              {view.savingsViews.length === 0 ? (
                <p className="text-sm text-default-500">
                  No savings lines. Add one to plan what moves into a savings account each month; it&apos;s measured by what lands there.
                  <Button size="sm" variant="light" color="primary" className="ml-2" onPress={() => setDraft(emptyDraft(newFrom, { kind: "SAVINGS" }))}>
                    Add savings
                  </Button>
                </p>
              ) : (
                view.savingsViews.map((v) => (
                  <div key={v.line.id} className="flex items-center gap-3">
                    <div className="w-40 shrink-0 text-sm">
                      {v.line.name}
                      <div className="text-xs text-default-400">{refs.accounts.find((a) => a.id === v.line.accountId)?.name ?? "no account"}</div>
                    </div>
                    <div className="flex-1">
                      <BudgetBar spent={Math.max(0, v.spent)} budgeted={v.budgeted} income />
                    </div>
                    <div className="text-sm w-48 text-right tabular-nums">
                      <Money value={v.spent} /> <span className="text-default-400">of</span> <Money value={v.budgeted} cents={false} />
                    </div>
                    <LineActions line={v.line} onEdit={() => setDraft(draftFromLine(v.line, newFrom))} onEnd={() => endSeries(v.line.seriesId, v.line.name)} />
                  </div>
                ))
              )}
            </CardBody>
          </Card>

          {/* Spending lines */}
          <Card>
            <CardHeader className="font-semibold flex justify-between">
              <span>Spending</span>
              {elapsed != null && <span className="text-xs text-default-500 font-normal">{Math.round(elapsed * 100)}% of the period gone</span>}
            </CardHeader>
            <CardBody className="pt-0">
              {view.expenseViews.length === 0 ? (
                <EmptyState title="No spending lines for this period">
                  Add one, or{" "}
                  <Button size="sm" variant="light" color="primary" isLoading={seeding} onPress={startFromHistory}>
                    start from history
                  </Button>
                </EmptyState>
              ) : (
                <div className="flex flex-col divide-y divide-default-100">
                  <div className="hidden md:grid grid-cols-[1fr_6rem_6rem_6rem_6rem_10rem_5rem_4rem] gap-2 text-xs text-default-500 pb-2">
                    <span>Line</span>
                    <span className="text-right">Budgeted</span>
                    <span className="text-right">Scheduled</span>
                    <span className="text-right">Spent</span>
                    <span className="text-right">Left</span>
                    <span>Pace</span>
                    <span className="text-right">Per day</span>
                    <span />
                  </div>
                  {view.expenseViews.map((v) => (
                    <ExpenseRow
                      key={v.line.id}
                      v={v}
                      open={expanded === v.line.seriesId}
                      onToggle={() => setExpanded(expanded === v.line.seriesId ? null : v.line.seriesId)}
                      txs={expanded === v.line.seriesId ? budgetTransactions(txs, range, bucketCategories(v.line)) : []}
                      onEdit={() => setDraft(draftFromLine(v.line, newFrom))}
                      onEnd={() => endSeries(v.line.seriesId, v.line.name)}
                    />
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Not budgeted */}
          {view.unassigned.length > 0 && (
            <Card>
              <CardHeader className="font-semibold flex flex-wrap gap-2 justify-between">
                <span>Not budgeted</span>
                <Select
                  size="sm"
                  aria-label="Add to line"
                  placeholder="Add to: new line"
                  className="w-56"
                  selectedKeys={pickTarget ? new Set([pickTarget]) : new Set()}
                  onSelectionChange={(k) => setPickTarget((Array.from(k as Set<string>)[0] as string) ?? "")}
                >
                  {view.expenseViews.map((v) => (
                    <SelectItem key={v.line.seriesId}>{v.line.name}</SelectItem>
                  ))}
                </Select>
              </CardHeader>
              <CardBody className="pt-0 gap-1">
                <p className="text-xs text-default-500 mb-1">Spending in categories no line covers. Pick a line above (or none for a new one), then add.</p>
                {view.unassigned.map((u) => (
                  <div key={u.category} className="flex items-center justify-between text-sm py-1">
                    <span>{u.category}</span>
                    <span className="flex items-center gap-3">
                      <Money value={u.spent} />
                      <Button size="sm" variant="flat" onPress={() => addToLine(u.category)}>
                        Add to line…
                      </Button>
                    </span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {/* Seed from history */}
          <Card>
            <CardHeader className="font-semibold flex justify-between">
              <span>Start from history</span>
              <Button size="sm" variant="flat" startContent={<FaHistory />} isLoading={seeding} onPress={startFromHistory}>
                {seeds ? "Refresh" : "Look at the last 3 months"}
              </Button>
            </CardHeader>
            {seeds && (
              <CardBody className="pt-0 gap-1">
                {seeds.length === 0 ? (
                  <p className="text-sm text-default-500">No spending in the last 3 complete months.</p>
                ) : (
                  <>
                    <p className="text-xs text-default-500 mb-1">Median month per category. Volatile ones swing a lot; one number won&apos;t describe them well.</p>
                    {seeds.map((s) => (
                      <div key={s.category} className="flex items-center justify-between text-sm py-1 gap-2">
                        <span className="flex items-center gap-2">
                          {s.category}
                          {s.volatility > 1 && (
                            <Chip size="sm" variant="flat" color="warning">
                              volatile
                            </Chip>
                          )}
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="text-xs text-default-400 tabular-nums hidden sm:inline">
                            {s.monthly.map((m) => fmtCurrency(m, { cents: false })).join(" · ")}
                          </span>
                          <Money value={s.median} cents={false} />
                          <Button size="sm" variant="flat" onPress={() => setDraft(emptyDraft(newFrom, { name: s.category, categories: [s.category], amount: String(Math.ceil(s.median / 10) * 10) }))}>
                            Budget it
                          </Button>
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </CardBody>
            )}
          </Card>

          {/* Inventory */}
          <Card>
            <CardHeader className="font-semibold">All budgets</CardHeader>
            <CardBody className="pt-0 gap-2">
              {series.length === 0 ? (
                <p className="text-sm text-default-500">None yet.</p>
              ) : (
                series.map((s) => (
                  <details key={s.seriesId} className="text-sm">
                    <summary className="cursor-pointer flex flex-wrap items-center gap-2 py-1">
                      <span className="font-medium">{s.name}</span>
                      <Chip size="sm" variant="flat">
                        {s.kind === "INCOME" ? "Contribution" : s.kind === "SAVINGS" ? "Savings" : "Spending"}
                      </Chip>
                      {s.liveNow && (
                        <Chip size="sm" color="success" variant="flat">
                          in force
                        </Chip>
                      )}
                      {s.startsOn && (
                        <Chip size="sm" color="primary" variant="flat">
                          starts {fmtDate(s.startsOn, { month: "short", day: "numeric", year: "numeric" })}
                        </Chip>
                      )}
                      {s.endedOn && (
                        <Chip size="sm" variant="flat">
                          ended {fmtDate(s.endedOn, { month: "short", day: "numeric", year: "numeric" })}
                        </Chip>
                      )}
                      <span className="text-default-500">
                        {fmtCurrency(s.latest.amount, { cents: false })} / {BUDGET_PERIOD_LABELS[(s.latest.period ?? "MONTHLY") as BudgetPeriod].toLowerCase()}
                      </span>
                    </summary>
                    <div className="pl-4 py-1 flex flex-col gap-1 text-default-600">
                      {s.versions.map((v) => (
                        <div key={v.id} className="flex flex-wrap gap-x-3">
                          <span className="tabular-nums">
                            {fmtDate(v.effectiveFrom, { month: "short", day: "numeric", year: "numeric" })} → {v.effectiveTo ? fmtDate(v.effectiveTo, { month: "short", day: "numeric", year: "numeric" }) : "open"}
                          </span>
                          <Money value={v.amount} cents={false} />
                          {s.kind === "EXPENSE" && <span className="text-default-400">{bucketCategories(v).join(", ")}</span>}
                          {v.label && <span className="italic">“{v.label}”</span>}
                        </div>
                      ))}
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" variant="flat" startContent={<FaPen />} onPress={() => setDraft(draftFromLine(s.latest, s.startsOn ?? newFrom))}>
                          Change
                        </Button>
                        {!s.endedOn && (
                          <Button size="sm" variant="flat" color="danger" startContent={<FaStop />} onPress={() => endSeries(s.seriesId, s.name)}>
                            End
                          </Button>
                        )}
                      </div>
                    </div>
                  </details>
                ))
              )}
            </CardBody>
          </Card>
        </div>
      )}

      <BudgetLineModal
        draft={draft}
        categories={refs.categories}
        people={refs.people}
        accounts={refs.accounts}
        onClose={() => setDraft(null)}
        onSaved={() => {
          setDraft(null);
          refs.reload();
          load();
        }}
      />
    </FinanceShell>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: React.ReactNode }) {
  return (
    <Card>
      <CardBody className="gap-0.5">
        <span className="text-xs text-default-500">{label}</span>
        <Money value={value} cents={false} className="text-xl font-semibold" />
        {sub && <span className="text-xs text-default-500">{sub}</span>}
      </CardBody>
    </Card>
  );
}

function LineActions({ onEdit, onEnd }: { line: BudgetLine; onEdit: () => void; onEnd: () => void }) {
  return (
    <span className="flex gap-1">
      <Button size="sm" isIconOnly variant="light" aria-label="Change" onPress={onEdit}>
        <FaPen />
      </Button>
      <Button size="sm" isIconOnly variant="light" aria-label="End" onPress={onEnd}>
        <FaStop />
      </Button>
    </span>
  );
}

function ExpenseRow({
  v,
  open,
  onToggle,
  txs,
  onEdit,
  onEnd,
}: {
  v: BudgetLineView;
  open: boolean;
  onToggle: () => void;
  txs: any[];
  onEdit: () => void;
  onEnd: () => void;
}) {
  const cats = bucketCategories(v.line);
  return (
    <div className="py-2">
      <div className="grid grid-cols-2 md:grid-cols-[1fr_6rem_6rem_6rem_6rem_10rem_5rem_4rem] gap-2 items-center text-sm">
        <button type="button" className="text-left min-w-0 col-span-2 md:col-span-1" onClick={onToggle}>
          <span className="font-medium flex items-center gap-1">
            {open ? <FaChevronUp className="text-xs" /> : <FaChevronDown className="text-xs" />}
            {v.line.name}
            {v.status === "over" && (
              <Chip size="sm" color="danger" variant="flat" className="ml-1">
                ahead of pace
              </Chip>
            )}
          </span>
          {(cats.length > 1 || cats[0] !== v.line.name) && <span className="block text-xs text-default-400 truncate">{cats.join(", ")}</span>}
        </button>
        <Cell label="Budgeted">
          <Money value={v.budgeted} cents={false} />
        </Cell>
        <Cell label="Scheduled">
          <span className="text-default-500">{v.committed ? <Money value={v.committed} cents={false} /> : "—"}</span>
        </Cell>
        <Cell label="Spent">
          <Money value={v.spent} />
        </Cell>
        <Cell label="Left">
          <Money value={v.remaining} className={v.remaining < 0 ? "text-danger-600" : ""} />
        </Cell>
        <div className="col-span-2 md:col-span-1">
          <BudgetBar spent={v.spent} budgeted={v.budgeted} elapsed={v.elapsed} />
        </div>
        <Cell label="Per day left">
          <span className="text-default-500">{v.safeDailyRemaining > 0 && v.elapsed < 1 ? fmtCurrency(v.safeDailyRemaining, { cents: false }) : "—"}</span>
        </Cell>
        <LineActions line={v.line} onEdit={onEdit} onEnd={onEnd} />
      </div>
      {open && (
        <div className="mt-2 ml-4 text-sm flex flex-col gap-1">
          {txs.length === 0 ? (
            <span className="text-default-500">No spending yet.</span>
          ) : (
            txs.map((t) => (
              <div key={t.id} className="flex justify-between gap-2">
                <span className="truncate">
                  <span className="text-default-400 tabular-nums mr-2">{fmtDate(t.date)}</span>
                  {t.description}
                  {cats.length > 1 && <span className="text-default-400"> · {t.category}</span>}
                </span>
                <Money value={t.amount} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="md:text-right flex md:block justify-between">
      <span className="md:hidden text-xs text-default-400">{label}</span>
      {children}
    </span>
  );
}
