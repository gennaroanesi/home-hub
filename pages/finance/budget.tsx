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
import { FaChevronDown, FaChevronUp, FaExclamationTriangle, FaHistory, FaPen, FaPlus, FaStop, FaTrash } from "react-icons/fa";

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
  filterBudgetView,
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
import { CadenceFilter, useCadenceFilter } from "@/components/finance/cadence-filter";
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

  const { include, setInclude } = useCadenceFilter(period.kind);
  const fullView = useMemo(() => householdBudget(lines, txs, schedules, range, today), [lines, txs, schedules, range, today]);
  const view = useMemo(() => filterBudgetView(fullView, include), [fullView, include]);
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

  async function removeVersion(seriesId: string, v: BudgetLine) {
    const when = `${fmtDate(v.effectiveFrom, { month: "short", day: "numeric", year: "numeric" })} → ${v.effectiveTo ? fmtDate(v.effectiveTo, { month: "short", day: "numeric", year: "numeric" }) : "open"}`;
    if (!confirm(`Remove the ${fmtCurrency(v.amount, { cents: false })} version of “${v.name}” (${when})? The version before it takes those days back, if it runs right up to it.`)) return;
    const r = await callOp(financeClient, "save_finance_budget", { seriesId, removeVersionId: v.id });
    if ("error" in r) addToast({ title: "Couldn't remove it", description: r.error, color: "danger" });
    else {
      addToast({ title: "Version removed", color: "success" });
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
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Switching month / quarter / year goes back to that kind's default lines. */}
        <PeriodPicker value={period} onChange={(p) => setPeriod(p, p.kind !== period.kind ? { dropParams: ["include"] } : {})} />
        <CadenceFilter value={include} onChange={setInclude} />
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
                  <PlanRow
                    key={v.line.id}
                    v={v}
                    tag={<PersonChip personId={v.line.personId} people={refs.people} />}
                    onEdit={() => setDraft(draftFromLine(v.line, newFrom))}
                    onEnd={() => endSeries(v.line.seriesId, v.line.name)}
                  />
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
                  <PlanRow
                    key={v.line.id}
                    v={v}
                    tag={<span className="text-xs text-default-400">{refs.accounts.find((a) => a.id === v.line.accountId)?.name ?? "no account"}</span>}
                    onEdit={() => setDraft(draftFromLine(v.line, newFrom))}
                    onEnd={() => endSeries(v.line.seriesId, v.line.name)}
                  />
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
                  <div className="hidden md:grid grid-cols-[1fr_6rem_6rem_6rem_10rem_6rem_4rem] gap-2 text-xs text-default-500 pb-2">
                    <span>Line</span>
                    <span className="text-right">Budgeted</span>
                    <span className="text-right">Scheduled</span>
                    <span className="text-right">Spent</span>
                    <span>Pace</span>
                    <span className="text-right">Left</span>
                    <span />
                  </div>
                  {view.expenseViews.map((v) => (
                    <ExpenseRow
                      key={v.line.id}
                      v={v}
                      share={view.allocated > 0 ? v.budgeted / view.allocated : null}
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
                      {s.changesOn && (
                        <Chip size="sm" color="primary" variant="flat">
                          changes {fmtDate(s.changesOn, { month: "short", day: "numeric", year: "numeric" })}
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
                        <div key={v.id} className="flex flex-wrap items-center gap-x-3">
                          <span className="tabular-nums">
                            {fmtDate(v.effectiveFrom, { month: "short", day: "numeric", year: "numeric" })} → {v.effectiveTo ? fmtDate(v.effectiveTo, { month: "short", day: "numeric", year: "numeric" }) : "open"}
                          </span>
                          <Money value={v.amount} cents={false} />
                          {s.kind === "EXPENSE" && <span className="text-default-400">{bucketCategories(v).join(", ")}</span>}
                          {v.label && <span className="italic">“{v.label}”</span>}
                          <span className="flex gap-1">
                            <Button size="sm" isIconOnly variant="light" aria-label="Edit this version" onPress={() => setDraft(draftFromLine(v, newFrom, "correct"))}>
                              <FaPen />
                            </Button>
                            <Button size="sm" isIconOnly variant="light" color="danger" aria-label="Remove this version" isDisabled={s.versions.length < 2} onPress={() => removeVersion(s.seriesId, v)}>
                              <FaTrash />
                            </Button>
                          </span>
                        </div>
                      ))}
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" variant="flat" startContent={<FaPen />} onPress={() => setDraft(draftFromLine(s.latest, s.startsOn ?? newFrom, "range"))}>
                          New period
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

/**
 * A contribution or savings line: its name with the person / account, what
 * came in of what's planned, and the bar. Stacks on phones.
 */
function PlanRow({ v, tag, onEdit, onEnd }: { v: BudgetLineView; tag: React.ReactNode; onEdit: () => void; onEnd: () => void }) {
  const period = (v.line.period ?? "MONTHLY") as BudgetPeriod;
  return (
    <div className="flex flex-col gap-1.5 md:grid md:grid-cols-[16rem_1fr_12rem_4rem] md:items-center md:gap-3">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {v.line.name}
            {period !== "MONTHLY" && <span className="text-xs text-default-400 font-normal ml-1">· {BUDGET_PERIOD_LABELS[period].toLowerCase()}</span>}
          </div>
          <div className="mt-0.5">{tag}</div>
        </div>
        <span className="md:hidden">
          <LineActions line={v.line} onEdit={onEdit} onEnd={onEnd} />
        </span>
      </div>
      <div className="md:order-none order-2">
        <BudgetBar spent={Math.max(0, v.spent)} budgeted={v.budgeted} income />
      </div>
      <div className="text-sm md:text-right tabular-nums order-1 md:order-none">
        <Money value={v.spent} /> <span className="text-default-400">of</span> <Money value={v.budgeted} cents={false} />
      </div>
      <span className="hidden md:block">
        <LineActions line={v.line} onEdit={onEdit} onEnd={onEnd} />
      </span>
    </div>
  );
}

function ExpenseRow({
  v,
  open,
  onToggle,
  txs,
  onEdit,
  onEnd,
  share,
}: {
  v: BudgetLineView;
  /** This line's budget as a fraction of all spending lines (null when there's no total). */
  share: number | null;
  open: boolean;
  onToggle: () => void;
  txs: any[];
  onEdit: () => void;
  onEnd: () => void;
}) {
  const cats = bucketCategories(v.line);
  const shareText = share != null ? `${share < 0.01 && share > 0 ? "<1" : Math.round(share * 100)}% of total` : null;
  const paceText = v.pace != null && v.elapsed < 1 ? `${v.pace.toFixed(1)}× pace` : null;
  const paceClass = v.status === "over" ? "text-danger-500" : "text-default-400";
  const leftText = v.budgeted > 0 ? `${Math.round((Math.abs(v.remaining) / v.budgeted) * 100)}% ${v.remaining < 0 ? "over" : "left"}` : null;
  const leftClass = v.remaining < 0 ? "text-danger-500" : "text-default-400";
  const title = (
    <button type="button" className="text-left min-w-0" onClick={onToggle}>
      <span className="font-medium flex items-center gap-1">
        {open ? <FaChevronUp className="text-xs shrink-0" /> : <FaChevronDown className="text-xs shrink-0" />}
        <span className="truncate">{v.line.name}</span>
        {v.status === "over" && (
          <Chip size="sm" color="danger" variant="flat" className="ml-1 shrink-0">
            ahead of pace
          </Chip>
        )}
      </span>
      {(cats.length > 1 || cats[0] !== v.line.name) && <span className="block text-xs text-default-400 truncate">{cats.join(", ")}</span>}
    </button>
  );
  return (
    <div className="py-3 md:py-2">
      {/* Phone: name, spent of budgeted, bar, then the details on one line. */}
      <div className="md:hidden flex flex-col gap-1.5 text-sm">
        <div className="flex items-start justify-between gap-2">
          {title}
          <LineActions line={v.line} onEdit={onEdit} onEnd={onEnd} />
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="tabular-nums">
            <Money value={v.spent} /> <span className="text-default-400">of</span> <Money value={v.budgeted} cents={false} />
          </span>
          <span className="tabular-nums text-right">
            <Money value={v.remaining} cents={false} className={v.remaining < 0 ? "text-danger-600" : ""} />
            {leftText && <span className={`text-xs ml-1 ${leftClass}`}>{leftText}</span>}
          </span>
        </div>
        <BudgetBar spent={v.spent} budgeted={v.budgeted} elapsed={v.elapsed} />
        <div className="flex flex-wrap gap-x-3 text-xs text-default-400">
          {paceText && <span className={paceClass}>{paceText}</span>}
          {shareText && <span>{shareText}</span>}
          {v.committed > 0 && (
            <span>
              <Money value={v.committed} cents={false} /> scheduled
            </span>
          )}
        </div>
      </div>

      {/* Wider screens: one row per line under the column headers. */}
      <div className="hidden md:grid grid-cols-[1fr_6rem_6rem_6rem_10rem_6rem_4rem] gap-2 items-center text-sm">
        {title}
        <span className="text-right">
          <Money value={v.budgeted} cents={false} />
          {shareText && <span className="block text-xs text-default-400">{shareText}</span>}
        </span>
        <span className="text-right text-default-500">{v.committed ? <Money value={v.committed} cents={false} /> : "—"}</span>
        <span className="text-right">
          <Money value={v.spent} />
          {paceText && (
            <span className={`block text-xs ${paceClass}`} title="Spent vs what the budget expects by today">
              {paceText}
            </span>
          )}
        </span>
        <BudgetBar spent={v.spent} budgeted={v.budgeted} elapsed={v.elapsed} />
        <span className="text-right">
          <Money value={v.remaining} className={v.remaining < 0 ? "text-danger-600" : ""} />
          {leftText && <span className={`block text-xs ${leftClass}`}>{leftText}</span>}
        </span>
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

