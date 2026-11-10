"use client";

// /finance — household money at a glance: account balances, this month's
// budget headline, scheduled debits in the next 14 days with a projected
// balance, goals, uncategorized count and the last SimpleFIN sync.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Progress, Spinner } from "@heroui/react";
import { FaExclamationTriangle } from "react-icons/fa";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { BudgetBar, EmptyState, Money, PersonChip, ago } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { householdBudget, type HouseholdBudgetView } from "@/lib/finance/budget";
import { effectiveCategory, UNCATEGORIZED } from "@/lib/finance/categories";
import { addDays, fmtCurrency, fmtDate, monthRange, todayIso } from "@/lib/finance/dates";
import { listBudgetLines, listGoals, listSchedules, listTransactions } from "@/lib/finance/data";
import { goalProgress, type GoalProgress } from "@/lib/finance/goals";
import { lowestPoint, projectBalance, upcomingEvents, type ProjectedEvent, type ProjectionPoint } from "@/lib/finance/recurring";
import { listAllPages } from "@/lib/list-all";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CASH_TYPES = new Set(["CHECKING", "SAVINGS", "CASH"]);

type AccountOutlook = {
  account: any;
  events: ProjectedEvent[];
  points: ProjectionPoint[];
  low: ProjectionPoint | null;
  belowBuffer: boolean;
};

export default function FinanceOverviewPage() {
  const refs = useFinanceRefs();
  const today = todayIso();
  const month = useMemo(() => monthRange(today), [today]);
  const [loading, setLoading] = useState(true);
  const [budget, setBudget] = useState<HouseholdBudgetView | null>(null);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [goals, setGoals] = useState<GoalProgress[]>([]);
  const [uncategorized, setUncategorized] = useState(0);
  const [lastSync, setLastSync] = useState<any | null>(null);

  const load = useCallback(async () => {
    if (refs.loading) return;
    setLoading(true);
    try {
      const active = refs.accounts.filter((a) => a.active !== false);
      const [lines, sched, goalRows, txs, logs] = await Promise.all([
        listBudgetLines(financeClient),
        listSchedules(financeClient),
        listGoals(financeClient),
        active.length ? listTransactions(financeClient, { ...month, accountIds: active.map((a) => a.id) }) : Promise.resolve([]),
        listAllPages<any>(financeClient.models.homeFinanceSyncLog),
      ]);
      setBudget(householdBudget(lines, txs, sched, month, today));
      setSchedules(sched);
      setGoals(goalProgress(goalRows, refs.accounts, today).filter((g) => g.goal.active !== false));
      setUncategorized(txs.filter((t) => effectiveCategory(t, refs.rules) === UNCATEGORIZED).length);
      setLastSync(logs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0] ?? null);
    } catch (e) {
      console.error("[finance] overview load failed", e);
    } finally {
      setLoading(false);
    }
  }, [refs.loading, refs.accounts, refs.rules, month, today]);

  useEffect(() => {
    load();
  }, [load]);

  const activeAccounts = refs.accounts.filter((a) => a.active !== false);

  const outlooks: AccountOutlook[] = useMemo(() => {
    const horizon = addDays(today, 14);
    return activeAccounts
      .filter((a) => CASH_TYPES.has(a.type ?? ""))
      .map((account) => {
        const events = upcomingEvents(account.id, schedules, today, horizon);
        const points = projectBalance(account.currentBalance ?? 0, events);
        const low = lowestPoint(points);
        return { account, events, points, low, belowBuffer: !!low && account.minBalance != null && low.balance < account.minBalance };
      });
  }, [activeAccounts, schedules, today]);

  const upcoming = useMemo(
    () =>
      outlooks
        .flatMap((o) => o.events.map((e) => ({ ...e, accountName: o.account.name })))
        .sort((a, b) => a.date.localeCompare(b.date)),
    [outlooks],
  );

  const reloadAll = async () => {
    await refs.reload();
  };

  if (refs.loading) {
    return (
      <FinanceShell title="Finance">
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </FinanceShell>
    );
  }

  if (refs.accounts.length === 0) {
    return (
      <FinanceShell title="Finance" onSynced={reloadAll}>
        <EmptyState title="No accounts yet">
          Add the joint account on the <NextLink className="text-primary underline" href="/finance/accounts">Accounts</NextLink> tab and link it to SimpleFIN.
        </EmptyState>
      </FinanceShell>
    );
  }

  const overLines = (budget?.expenseViews ?? []).filter((v) => v.spent > v.budgeted && v.budgeted > 0).sort((a, b) => b.spent - b.budgeted - (a.spent - a.budgeted));
  const syncChip = lastSync ? (
    <span>
      Last sync {ago(lastSync.finishedAt ?? lastSync.startedAt)}
      {" · "}
      <span className={lastSync.status === "OK" ? "text-success-600" : lastSync.status === "ERROR" ? "text-danger" : "text-warning-600"}>{lastSync.status}</span>
      {lastSync.txInserted ? ` · ${lastSync.txInserted} new` : ""}
    </span>
  ) : (
    "Never synced"
  );

  return (
    <FinanceShell title="Finance" subtitle={syncChip} onSynced={reloadAll}>
      {/* Accounts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
        {activeAccounts.map((a) => {
          const o = outlooks.find((x) => x.account.id === a.id);
          const belowNow = a.minBalance != null && (a.currentBalance ?? 0) < a.minBalance;
          return (
            <NextLink key={a.id} href={`/finance/accounts/${a.id}`}>
              <Card isPressable className="w-full" shadow="sm">
                <CardBody className="gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{a.name}</span>
                    <Chip size="sm" variant="flat">
                      {(a.type ?? "OTHER").toLowerCase()}
                    </Chip>
                  </div>
                  <Money value={a.currentBalance ?? 0} className="text-2xl font-semibold" />
                  <div className="text-xs text-default-500 flex items-center gap-2 flex-wrap">
                    <span>updated {ago(a.balanceUpdatedAt)}</span>
                    {a.institution && <span>· {a.institution}</span>}
                  </div>
                  {(belowNow || o?.belowBuffer) && (
                    <div className="text-xs text-warning-600 flex items-center gap-1">
                      <FaExclamationTriangle />
                      {belowNow
                        ? `Below the ${fmtCurrency(a.minBalance, { cents: false })} buffer`
                        : `Dips to ${fmtCurrency(o!.low!.balance, { cents: false })} on ${fmtDate(o!.low!.date)}`}
                    </div>
                  )}
                </CardBody>
              </Card>
            </NextLink>
          );
        })}
      </div>

      {loading && !budget ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Budget headline */}
          <Card shadow="sm">
            <CardHeader className="flex justify-between">
              <span className="font-semibold">{month.label}</span>
              <NextLink href="/finance/budget" className="text-xs text-primary">
                Budget →
              </NextLink>
            </CardHeader>
            <CardBody className="gap-4 pt-0">
              {budget && (budget.incomeViews.length > 0 || budget.expenseViews.length > 0) ? (
                <>
                  <div>
                    <div className="text-xs uppercase text-default-500 mb-1">Contributions</div>
                    {budget.incomeViews.length === 0 && <div className="text-sm text-default-500">No contribution lines in the budget.</div>}
                    <div className="flex flex-col gap-2">
                      {budget.incomeViews.map((v) => (
                        <div key={v.line.id} className="flex flex-col gap-1">
                          <div className="flex items-center justify-between text-sm">
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="truncate">{v.line.name}</span>
                              <PersonChip personId={v.line.personId} people={refs.people} />
                            </span>
                            <span>
                              <Money value={v.spent} /> <span className="text-default-500">of</span> <Money value={v.budgeted} cents={false} />
                            </span>
                          </div>
                          <BudgetBar spent={v.spent} budgeted={v.budgeted} income />
                        </div>
                      ))}
                    </div>
                    <div className="text-xs text-default-500 mt-1">
                      Received <Money value={budget.received} /> of <Money value={budget.planned} cents={false} /> planned
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-xs uppercase text-default-500">Spending</span>
                      <span>
                        <Money value={budget.spentBudgeted} /> <span className="text-default-500">of</span> <Money value={budget.allocated} cents={false} />
                      </span>
                    </div>
                    <BudgetBar spent={budget.spentBudgeted} budgeted={budget.allocated} elapsed={budget.expenseViews[0]?.elapsed} />
                    <div className="text-xs text-default-500 mt-1">
                      All money out this month: <Money value={budget.spentTotal} />
                    </div>
                  </div>
                  {overLines.length > 0 && (
                    <div>
                      <div className="text-xs uppercase text-default-500 mb-1">Over budget</div>
                      <ul className="text-sm flex flex-col gap-1">
                        {overLines.slice(0, 4).map((v) => (
                          <li key={v.line.id} className="flex justify-between">
                            <span>{v.line.name}</span>
                            <span className="text-danger tabular-nums">+{fmtCurrency(v.spent - v.budgeted)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {uncategorized > 0 && (
                    <NextLink href="/finance/transactions?uncategorized=1" className="text-sm text-warning-600">
                      {uncategorized} transaction{uncategorized === 1 ? "" : "s"} need a category →
                    </NextLink>
                  )}
                </>
              ) : (
                <div className="text-sm text-default-500">
                  No budget yet. <NextLink className="text-primary" href="/finance/budget">Set one up</NextLink>.
                  {uncategorized > 0 && (
                    <div className="mt-2">
                      <NextLink href="/finance/transactions?uncategorized=1" className="text-warning-600">
                        {uncategorized} uncategorized transaction{uncategorized === 1 ? "" : "s"} →
                      </NextLink>
                    </div>
                  )}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Upcoming */}
          <Card shadow="sm">
            <CardHeader className="flex justify-between">
              <span className="font-semibold">Next 14 days</span>
              <NextLink href="/finance/scheduled" className="text-xs text-primary">
                Scheduled →
              </NextLink>
            </CardHeader>
            <CardBody className="gap-3 pt-0">
              {outlooks
                .filter((o) => o.points.length > 0)
                .map((o) => (
                  <ProjectionChart key={o.account.id} outlook={o} today={today} />
                ))}
              {upcoming.length === 0 ? (
                <div className="text-sm text-default-500">Nothing scheduled in the next two weeks.</div>
              ) : (
                <ul className="text-sm flex flex-col divide-y divide-default-100">
                  {upcoming.map((e, i) => (
                    <li key={`${e.recurringId}-${e.date}-${i}`} className="flex items-center justify-between py-1.5 gap-2">
                      <span className="text-default-500 w-14 shrink-0">{fmtDate(e.date)}</span>
                      <span className="flex-1 truncate">
                        {e.description}
                        {outlooks.length > 1 && <span className="text-default-400"> · {e.accountName}</span>}
                      </span>
                      <Money value={e.amount} sign />
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* Goals */}
          {goals.length > 0 && (
            <Card shadow="sm" className="lg:col-span-2">
              <CardHeader className="flex justify-between">
                <span className="font-semibold">Goals</span>
                <NextLink href="/finance/goals" className="text-xs text-primary">
                  Goals →
                </NextLink>
              </CardHeader>
              <CardBody className="pt-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {goals.map((g) => (
                    <div key={g.goal.id} className="flex flex-col gap-1">
                      <div className="flex justify-between text-sm">
                        <span className="font-medium truncate">{g.goal.name}</span>
                        <span className="text-default-500">{Math.round(g.pct * 100)}%</span>
                      </div>
                      <Progress aria-label={g.goal.name} size="sm" value={g.pct * 100} color={g.pct >= 1 ? "success" : "primary"} />
                      <div className="text-xs text-default-500">
                        <Money value={g.current} cents={false} /> of <Money value={g.target} cents={false} />
                        {g.goal.targetDate && ` · by ${fmtDate(g.goal.targetDate, { month: "short", year: "numeric" })}`}
                        {g.monthlyNeeded != null && ` · ${fmtCurrency(g.monthlyNeeded, { cents: false })}/mo`}
                      </div>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </FinanceShell>
  );
}

function ProjectionChart({ outlook, today }: { outlook: AccountOutlook; today: string }) {
  const { account, points, belowBuffer, low } = outlook;
  const data = [{ date: today, balance: account.currentBalance ?? 0 }, ...points.map((p) => ({ date: p.date, balance: Math.round(p.balance * 100) / 100 }))];
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-default-500 mb-1">
        <span>{account.name} projected</span>
        {low && (
          <span className={belowBuffer ? "text-warning-600" : ""}>
            low {fmtCurrency(low.balance, { cents: false })} on {fmtDate(low.date)}
          </span>
        )}
      </div>
      <div className="h-28">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <XAxis dataKey="date" tickFormatter={(d) => fmtDate(d)} tick={{ fontSize: 10 }} />
            <YAxis tickFormatter={(v) => fmtCurrency(v, { cents: false })} tick={{ fontSize: 10 }} width={70} domain={["auto", "auto"]} />
            <Tooltip formatter={(v) => fmtCurrency(Number(v))} labelFormatter={(d) => fmtDate(String(d))} />
            {account.minBalance != null && <ReferenceLine y={account.minBalance} stroke="#f5a524" strokeDasharray="4 4" />}
            <Line type="stepAfter" dataKey="balance" stroke="#006fee" strokeWidth={2} dot={{ r: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
