"use client";

// /finance/review — looking back at a month, quarter, year or the last 3
// months: what we each put in vs what went out, spending by category against
// the budget and the usual level, the trend over the last year, the biggest
// transactions, which scheduled payments happened, and spend groups.
// Read-only. The period picker is shared with Budget (period-picker.tsx).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Spinner, addToast } from "@heroui/react";
import { FaCheckCircle, FaRegCircle } from "react-icons/fa";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money, PersonChip } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { effectiveCategory } from "@/lib/finance/categories";
import { fmtCurrency, fmtDate, todayIso } from "@/lib/finance/dates";
import { periodNoun } from "@/lib/finance/periods";
import { PeriodPicker, usePeriod } from "@/components/finance/period-picker";
import { isOutsideCashFlow } from "@/lib/finance/accounts";
import { listBudgetLines, listSchedules, listTransactions } from "@/lib/finance/data";
import { type BudgetLine } from "@/lib/finance/budget";
import { ALL_LEDGERS, HOUSEHOLD } from "@/lib/finance/ledger";
import { REVIEW_TREND_MONTHS, REVIEW_USUAL_MONTHS, buildReview, defaultReviewPeriod, reviewWindow } from "@/lib/finance/review";
import { LedgerTabs, useLedger } from "@/components/finance/ledger-tabs";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Categorical palette (8 hues), readable on light and dark backgrounds.
const PALETTE = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1", "#9c755f"];

export default function ReviewPage() {
  const refs = useFinanceRefs();
  const today = todayIso();
  // Default: this month, or last month on the 1st (nothing to review yet).
  const { period, range, setPeriod } = usePeriod(() => defaultReviewPeriod(today));
  const noun = periodNoun(period);

  const [rawTxs, setTxs] = useState<any[]>([]);
  const [rawLines, setLines] = useState<BudgetLine[]>([]);
  // Whose money: the household's share of each charge, a person's, or everything
  // (lib/finance/ledger.ts; buildReview says what "everything" leaves out).
  const ledgerState = useLedger(refs.people);
  const { ledger } = ledgerState;
  const [schedules, setSchedules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const accountIds = useMemo(() => refs.accounts.filter((a) => !isOutsideCashFlow(a.type)).map((a) => a.id), [refs.accounts]);
  const accountName = useMemo(() => new Map(refs.accounts.map((a) => [a.id, a.name as string])), [refs.accounts]);
  // Load far enough back for the trend and the "usual" level (lib/finance/review.ts).
  const { loadFrom } = reviewWindow(range);

  const load = useCallback(async () => {
    if (refs.loading) return;
    setLoading(true);
    try {
      const [t, l, s] = await Promise.all([
        listTransactions(financeClient, { fromIso: loadFrom, toIso: range.toIso, accountIds }),
        listBudgetLines(financeClient),
        listSchedules(financeClient),
      ]);
      setTxs(t);
      setLines(l);
      setSchedules(s);
    } catch (e) {
      addToast({ title: "Couldn't load the review", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, [refs.loading, loadFrom, range.toIso, accountIds]);

  useEffect(() => {
    load();
  }, [load]);

  const { periodTxs, received, totalIn, totalOut, groupedOut, byCategory, maxCategory: maxCat, trend, biggest, scheduled, groups, hasOtherIncome } = useMemo(
    () => buildReview({ rawTxs, accounts: refs.accounts, lines: rawLines, schedules, groups: refs.groups, ledger, range, today }),
    [rawTxs, refs.accounts, rawLines, schedules, refs.groups, ledger, range, today],
  );

  const isEmpty = !loading && periodTxs.length === 0;

  return (
    <FinanceShell title="Review" subtitle={`How ${range.label} went`} onSynced={load}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <PeriodPicker value={period} onChange={setPeriod} allowFuture={false} />
        <LedgerTabs state={ledgerState} className="" />
      </div>

      {loading || refs.loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : isEmpty ? (
        <EmptyState title={`Nothing recorded in ${range.label}`}>Transactions show up here once an account syncs.</EmptyState>
      ) : (
        <div className="flex flex-col gap-5">
          {/* In vs out */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Card>
              <CardBody className="gap-2">
                <span className="text-xs text-default-500">{ledger === HOUSEHOLD ? "We put in" : ledger === ALL_LEDGERS ? "Came in, everyone" : `${ledgerState.label}'s income`}</span>
                <Money value={totalIn} className="text-xl font-semibold" />
                <div className="flex flex-col gap-1">
                  {[...received.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([pid, amt]) => (
                      <div key={pid || "household"} className="flex justify-between items-center text-sm">
                        <PersonChip personId={pid || null} people={refs.people} />
                        <Money value={amt} />
                      </div>
                    ))}
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="gap-1">
                <span className="text-xs text-default-500">We spent</span>
                <Money value={totalOut} className="text-xl font-semibold" />
                {groupedOut > 0 && <span className="text-xs text-default-500">{fmtCurrency(groupedOut)} of it on spend groups</span>}
                <span className="text-xs text-default-500">Transfers between our accounts and card payments don&apos;t count.</span>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="gap-1">
                <span className="text-xs text-default-500">Left over</span>
                <Money value={totalIn - totalOut} sign className={`text-xl font-semibold ${totalIn - totalOut < 0 ? "text-danger-600" : ""}`} />
                <span className="text-xs text-default-500">{totalIn > 0 ? `${Math.round((totalOut / totalIn) * 100)}% of what came in was spent` : "Nothing came in"}</span>
              </CardBody>
            </Card>
          </div>

          {/* By category */}
          <Card>
            <CardHeader className="font-semibold flex flex-wrap justify-between gap-2">
              <span>Spending by category</span>
              <span className="flex gap-3 text-xs font-normal text-default-500">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-2 rounded-sm bg-primary" /> {noun}
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-0.5 h-3 bg-default-500" /> usual ({REVIEW_USUAL_MONTHS}-mo median{period.kind === "month" ? "" : ", scaled"})
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-0.5 h-3 bg-danger" /> budget
                </span>
              </span>
            </CardHeader>
            <CardBody className="pt-0 gap-2">
              {byCategory.map((r) => (
                <div key={r.category} className="text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">
                      {r.category}
                      {r.line && r.lineShared && <span className="text-xs text-default-400"> · in {r.line.name} ({fmtCurrency(r.lineBudget, { cents: false })})</span>}
                    </span>
                    <span className="flex gap-3 tabular-nums shrink-0">
                      <span className="text-xs text-default-400">usual {fmtCurrency(r.median, { cents: false })}</span>
                      <Money value={r.spent} />
                    </span>
                  </div>
                  <div className="relative h-2 mt-1 rounded bg-default-100">
                    <div className="absolute inset-y-0 left-0 rounded bg-primary" style={{ width: `${(r.spent / maxCat) * 100}%` }} />
                    {r.median > 0 && <div className="absolute -inset-y-0.5 w-0.5 bg-default-500" style={{ left: `${(r.median / maxCat) * 100}%` }} title="Usual" />}
                    {r.lineBudget != null && !r.lineShared && <div className="absolute -inset-y-0.5 w-0.5 bg-danger" style={{ left: `${Math.min(100, (r.lineBudget / maxCat) * 100)}%` }} title="Budget" />}
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>

          {/* Trend */}
          <Card>
            <CardHeader className="font-semibold">Last {REVIEW_TREND_MONTHS} months</CardHeader>
            <CardBody className="pt-0">
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trend.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="currentColor" strokeOpacity={0.4} />
                    <YAxis tick={{ fontSize: 11 }} stroke="currentColor" strokeOpacity={0.4} tickFormatter={(v: number) => fmtCurrency(v, { cents: false })} width={70} />
                    <Tooltip formatter={(v) => fmtCurrency(Number(v), { cents: false })} contentStyle={{ fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {trend.shade && <ReferenceArea x1={trend.shade.x1} x2={trend.shade.x2} fill="currentColor" fillOpacity={0.06} ifOverflow="extendDomain" />}
                    {trend.series.map((s, i) => (
                      <Bar key={s} dataKey={s} stackId="spend" fill={s === "Other" ? "#9ca3af" : PALETTE[i % PALETTE.length]} />
                    ))}
                    <Line type="monotone" dataKey="Contributions" stroke="#16a34a" strokeWidth={2} dot={{ r: 2 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Biggest */}
            <Card>
              <CardHeader className="font-semibold">Biggest transactions</CardHeader>
              <CardBody className="pt-0 gap-1">
                {biggest.length === 0 ? (
                  <span className="text-sm text-default-500">No spending {noun}.</span>
                ) : (
                  biggest.map((t) => (
                    <div key={t.id} className="flex justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate">{t.description}</span>
                        <span className="text-xs text-default-400">
                          {fmtDate(t.date)} · {effectiveCategory(t)}
                          {accountName.size > 1 ? ` · ${accountName.get(t.accountId) ?? ""}` : ""}
                        </span>
                      </span>
                      <Money value={t.amount} />
                    </div>
                  ))
                )}
              </CardBody>
            </Card>

            {/* Scheduled vs actual */}
            <Card>
              <CardHeader className="font-semibold">Scheduled payments</CardHeader>
              <CardBody className="pt-0 gap-1">
                {scheduled.length === 0 ? (
                  <span className="text-sm text-default-500">Nothing was scheduled {noun}.</span>
                ) : (
                  scheduled.map(({ r, due, paid, actual, expected, done, notSeen }) => (
                    <div key={r.id} className="flex justify-between gap-2 text-sm items-center">
                      <span className="flex items-center gap-2 min-w-0">
                        {done ? <FaCheckCircle className="text-success-500 shrink-0" /> : <FaRegCircle className="text-default-400 shrink-0" />}
                        <span className="min-w-0">
                          <span className="block truncate">{r.description}</span>
                          <span className="text-xs text-default-400">
                            {due.length ? `due ${due.map((d: string) => fmtDate(d)).join(", ")}` : "not due"}
                            {paid.length ? ` · posted ${paid.map((t: any) => fmtDate(t.date)).join(", ")}` : notSeen ? " · not seen yet" : ""}
                          </span>
                        </span>
                      </span>
                      <span className="text-right tabular-nums shrink-0">
                        <Money value={paid.length ? actual : expected} className={paid.length ? "" : "text-default-400"} />
                        {paid.length > 0 && Math.abs(actual - expected) >= 1 && (
                          <span className="block text-xs text-default-400">expected {fmtCurrency(expected)}</span>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </CardBody>
            </Card>
          </div>

          {/* Groups */}
          {groups.length > 0 && (
            <Card>
              <CardHeader className="font-semibold">Spend groups</CardHeader>
              <CardBody className="pt-0 gap-1">
                <p className="text-xs text-default-500 mb-1">Tagged spending counts here instead of the monthly budget. Totals cover the last {REVIEW_TREND_MONTHS} months.</p>
                {groups.map(({ g, month, total }) => (
                  <div key={g.id} className="flex justify-between gap-2 text-sm">
                    <span>
                      {g.name}
                      {g.kind && <span className="text-xs text-default-400"> · {String(g.kind).toLowerCase()}</span>}
                    </span>
                    <span className="flex gap-3 tabular-nums">
                      <span className="text-default-500">
                        {noun} <Money value={month} />
                      </span>
                      <span>
                        <Money value={total} />
                        {g.budget ? <span className="text-default-400"> / {fmtCurrency(g.budget, { cents: false })}</span> : null}
                      </span>
                    </span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {/* Income categories other than contributions, if any */}
          {hasOtherIncome && (
            <p className="text-xs text-default-500">“We put in” also counts income landing in the account directly (interest, deposits).</p>
          )}
        </div>
      )}
    </FinanceShell>
  );
}
