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
import { bucketCategories, budgetedForRange, budgetKind, monthsInRange, receivedByPerson, resolutionDate, resolveBudgetLines, seedFromHistory, spendByCategory, totalOutflow, type BudgetLine } from "@/lib/finance/budget";
import { effectiveCategory, isExcludedFromBudget, INCOME_CATEGORIES } from "@/lib/finance/categories";
import { fmtCurrency, fmtDate, monthEnd, monthStart, monthsIn, occurrencesBetween, shiftMonth, todayIso } from "@/lib/finance/dates";
import { periodContaining, periodNoun, shiftPeriod } from "@/lib/finance/periods";
import { PeriodPicker, usePeriod } from "@/components/finance/period-picker";
import { listBudgetLines, listSchedules, listTransactions } from "@/lib/finance/data";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TREND_MONTHS = 12;
// "Usual" = median month over this many months before the period, scaled to its length.
const USUAL_MONTHS = 6;
const TOP_CATEGORIES = 6;
// Categorical palette (8 hues), readable on light and dark backgrounds.
const PALETTE = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1", "#9c755f"];

function monthLabel(ym: string): string {
  return new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

export default function ReviewPage() {
  const refs = useFinanceRefs();
  const today = todayIso();
  // Default: this month, or last month on the 1st (nothing to review yet).
  const { period, range, setPeriod } = usePeriod(() => {
    const m = periodContaining("month", today);
    return monthStart(today) === today ? shiftPeriod(m, -1) : m;
  });
  const noun = periodNoun(period);

  const [txs, setTxs] = useState<any[]>([]);
  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const accountIds = useMemo(() => refs.accounts.map((a) => a.id), [refs.accounts]);
  const accountName = useMemo(() => new Map(refs.accounts.map((a) => [a.id, a.name as string])), [refs.accounts]);
  // The trend ends with the period; "usual" looks at the months before it.
  const endMonth = monthStart(range.toIso);
  const trendFrom = shiftMonth(endMonth, -(TREND_MONTHS - 1));
  const usualFrom = shiftMonth(monthStart(range.fromIso), -USUAL_MONTHS);
  const loadFrom = usualFrom < trendFrom ? usualFrom : trendFrom;

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

  const periodTxs = useMemo(() => txs.filter((t) => t.date >= range.fromIso && t.date <= range.toIso), [txs, range]);

  // In vs out
  const received = useMemo(() => receivedByPerson(txs, range), [txs, range]);
  const totalIn = [...received.values()].reduce((s, n) => s + n, 0);
  const totalOut = useMemo(() => totalOutflow(txs, range), [txs, range]);
  const groupedOut = useMemo(
    () => periodTxs.filter((t) => t.status !== "PENDING" && t.spendGroupId && (t.amount ?? 0) < 0 && !isExcludedFromBudget(effectiveCategory(t))).reduce((s, t) => s - t.amount, 0),
    [periodTxs],
  );

  // By category: the period, its budget line, and the usual level — the
  // median month over the USUAL_MONTHS before the period (only months we
  // have data for), times the period's length in months.
  const byCategory = useMemo(() => {
    const spent = spendByCategory(txs, range);
    const firstMonth = txs.reduce((min: string, t) => (t.date && t.date < min ? t.date : min), "9999").slice(0, 7);
    const prior = monthsIn({ fromIso: usualFrom, toIso: shiftMonth(monthStart(range.fromIso), -1) }).filter((ym) => ym >= firstMonth);
    const scale = monthsInRange(range);
    const medians = new Map(seedFromHistory(txs, prior).map((s) => [s.category, s.median * scale]));
    const inForce = resolveBudgetLines(lines, resolutionDate(range, today)).filter((l) => budgetKind(l) === "EXPENSE");
    const lineOf = new Map<string, BudgetLine>();
    for (const l of inForce) for (const c of bucketCategories(l)) lineOf.set(c, l);
    const cats = new Set([...spent.keys(), ...medians.keys()]);
    return [...cats]
      .map((category) => {
        const line = lineOf.get(category) ?? null;
        return {
          category,
          spent: spent.get(category) ?? 0,
          median: medians.get(category) ?? 0,
          line,
          lineBudget: line ? budgetedForRange(line, range) : null,
          lineShared: line ? bucketCategories(line).length > 1 : false,
        };
      })
      .filter((r) => r.spent > 0 || r.median > 0)
      .sort((a, b) => b.spent - a.spent || b.median - a.median);
  }, [txs, range, usualFrom, lines, today]);
  const maxCat = Math.max(1, ...byCategory.map((r) => Math.max(r.spent, r.median, r.lineShared ? 0 : r.lineBudget ?? 0)));

  // Trend: spending by top categories per month + contributions.
  const trend = useMemo(() => {
    const months = monthsIn({ fromIso: trendFrom, toIso: endMonth });
    const total = spendByCategory(txs, { fromIso: trendFrom, toIso: range.toIso, label: "" });
    const top = [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_CATEGORIES).map(([c]) => c);
    const rows = months.map((ym) => {
      const r = { fromIso: `${ym}-01`, toIso: monthEnd(`${ym}-01`), label: ym };
      const spent = spendByCategory(txs, r);
      const row: Record<string, number | string> = { month: monthLabel(ym) };
      let other = 0;
      for (const [c, v] of spent) {
        if (top.includes(c)) row[c] = Math.round(v);
        else other += v;
      }
      row.Other = Math.round(other);
      row.Contributions = Math.round([...receivedByPerson(txs, r).values()].reduce((s, n) => s + n, 0));
      return row;
    });
    // The months of the selected period, shaded on the chart.
    const inPeriod = months.filter((ym) => `${ym}-01` >= monthStart(range.fromIso)).map(monthLabel);
    return { rows, series: [...top, "Other"], shade: inPeriod.length ? { x1: inPeriod[0], x2: inPeriod[inPeriod.length - 1] } : null };
  }, [txs, trendFrom, endMonth, range.fromIso]);

  const biggest = useMemo(
    () =>
      periodTxs
        .filter((t) => t.status !== "PENDING" && (t.amount ?? 0) < 0 && !isExcludedFromBudget(effectiveCategory(t)))
        .sort((a, b) => a.amount - b.amount)
        .slice(0, 10),
    [periodTxs],
  );

  // Scheduled vs actual: every schedule due in the period, and whether a posted row is linked to it.
  const scheduled = useMemo(() => {
    const linked = new Map<string, any[]>();
    for (const t of periodTxs) if (t.recurringId) linked.set(t.recurringId, [...(linked.get(t.recurringId) ?? []), t]);
    return schedules
      .filter((r) => r.active !== false || linked.has(r.id))
      .map((r) => {
        const due = occurrencesBetween({ ...r, nextDate: r.startDate ?? r.nextDate }, range.fromIso, range.toIso);
        return { r, due, paid: linked.get(r.id) ?? [] };
      })
      .filter((x) => x.due.length > 0 || x.paid.length > 0)
      .sort((a, b) => (a.due[0] ?? a.paid[0]?.date ?? "").localeCompare(b.due[0] ?? b.paid[0]?.date ?? ""));
  }, [schedules, periodTxs, range]);

  // Spend groups with activity in the period, or whose dates overlap it.
  const groups = useMemo(() => {
    return refs.groups
      .map((g) => {
        const tagged = txs.filter((t) => t.spendGroupId === g.id && t.status !== "PENDING");
        const net = (rows: any[]) => -rows.reduce((s, t) => s + (t.amount ?? 0), 0);
        const inMonth = tagged.filter((t) => t.date >= range.fromIso && t.date <= range.toIso);
        const overlaps = (!g.startDate || g.startDate <= range.toIso) && (!g.endDate || g.endDate >= range.fromIso) && (g.startDate || g.endDate);
        return { g, month: net(inMonth), total: net(tagged), active: inMonth.length > 0 || !!overlaps };
      })
      .filter((x) => x.active)
      .sort((a, b) => b.month - a.month);
  }, [refs.groups, txs, range]);

  const isEmpty = !loading && periodTxs.length === 0;

  return (
    <FinanceShell title="Review" subtitle={`How ${range.label} went`} onSynced={load}>
      <div className="mb-4">
        <PeriodPicker value={period} onChange={setPeriod} allowFuture={false} />
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
                <span className="text-xs text-default-500">We put in</span>
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
                  <span className="inline-block w-0.5 h-3 bg-default-500" /> usual ({USUAL_MONTHS}-mo median{period.kind === "month" ? "" : ", scaled"})
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
            <CardHeader className="font-semibold">Last {TREND_MONTHS} months</CardHeader>
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
                  scheduled.map(({ r, due, paid }) => {
                    const actual = paid.reduce((s: number, t: any) => s + t.amount, 0);
                    const done = paid.length >= due.length && paid.length > 0;
                    return (
                      <div key={r.id} className="flex justify-between gap-2 text-sm items-center">
                        <span className="flex items-center gap-2 min-w-0">
                          {done ? <FaCheckCircle className="text-success-500 shrink-0" /> : <FaRegCircle className="text-default-400 shrink-0" />}
                          <span className="min-w-0">
                            <span className="block truncate">{r.description}</span>
                            <span className="text-xs text-default-400">
                              {due.length ? `due ${due.map((d: string) => fmtDate(d)).join(", ")}` : "not due"}
                              {paid.length ? ` · posted ${paid.map((t: any) => fmtDate(t.date)).join(", ")}` : due.some((d: string) => d < today) ? " · not seen yet" : ""}
                            </span>
                          </span>
                        </span>
                        <span className="text-right tabular-nums shrink-0">
                          <Money value={paid.length ? actual : r.amount * due.length} className={paid.length ? "" : "text-default-400"} />
                          {paid.length > 0 && Math.abs(actual - r.amount * Math.max(1, due.length)) >= 1 && (
                            <span className="block text-xs text-default-400">expected {fmtCurrency(r.amount * Math.max(1, due.length))}</span>
                          )}
                        </span>
                      </div>
                    );
                  })
                )}
              </CardBody>
            </Card>
          </div>

          {/* Groups */}
          {groups.length > 0 && (
            <Card>
              <CardHeader className="font-semibold">Spend groups</CardHeader>
              <CardBody className="pt-0 gap-1">
                <p className="text-xs text-default-500 mb-1">Tagged spending counts here instead of the monthly budget. Totals cover the last {TREND_MONTHS} months.</p>
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
          {periodTxs.some((t) => (t.amount ?? 0) > 0 && INCOME_CATEGORIES.has(effectiveCategory(t)) && effectiveCategory(t) !== "Contribution") && (
            <p className="text-xs text-default-500">“We put in” also counts income landing in the account directly (interest, deposits).</p>
          )}
        </div>
      )}
    </FinanceShell>
  );
}
