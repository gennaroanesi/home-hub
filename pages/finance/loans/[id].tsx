"use client";

// /finance/loans/[id] — one loan: what's owed against the original
// schedule, the payoff date at the current payment, what secures it, a
// payoff simulator (extra each month, a lump sum, a target date), recorded
// payments by year (interest per year, for taxes) and the remaining
// schedule. Math: lib/finance/loans.ts. Writes: save_finance_loan,
// record_loan_payment.

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Progress, Spinner, addToast } from "@heroui/react";
import { FaArrowLeft, FaFileImport, FaPen, FaPlus } from "react-icons/fa";
import { Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money, ago } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { LoanModal, PaymentModal } from "@/components/finance/net-worth-modals";
import { LoanImportModal, parseLoanSchedulePdf } from "@/components/finance/loan-import-modal";
import { listAssets, listLoanPayments, listLoans, listSchedules } from "@/lib/finance/data";
import { fmtCurrency, fmtDate, round2, todayIso } from "@/lib/finance/dates";
import type { ExtractedLoanSchedule } from "@/lib/finance/loan-schedule-extract";
import { LOAN_TYPE_LABELS, compareToPlan, fmtDuration, loanOutlook, paymentDate, paymentsBetween, paymentToFinishIn, simulatePayoff, type LoanType } from "@/lib/finance/loans";

const pct = (r: number) => `${(r * 100).toFixed(3).replace(/\.?0+$/, "")}%`;
const longDate = (d: string | null | undefined) => fmtDate(d, { month: "short", day: "numeric", year: "numeric" });
const monthYear = (d: string | null | undefined) => fmtDate(d, { month: "short", year: "numeric" });

export default function LoanPage() {
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : "";
  const refs = useFinanceRefs();
  const today = todayIso();
  const [loans, setLoans] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [assets, setAssets] = useState<any[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [paymentModal, setPaymentModal] = useState<any | null | undefined>(undefined);
  const [sim, setSim] = useState({ extra: "", lump: "", by: "" });
  const [showSchedule, setShowSchedule] = useState(false);
  const [importing, setImporting] = useState<ExtractedLoanSchedule | null>(null);
  const [parsing, setParsing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [l, p, a, s] = await Promise.all([listLoans(financeClient), listLoanPayments(financeClient, id), listAssets(financeClient), listSchedules(financeClient)]);
      setLoans(l);
      setPayments(p);
      setAssets(a);
      setSchedules(s);
    } catch (e) {
      addToast({ title: "Couldn't load the loan", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    await Promise.all([refs.reload(), load()]);
  }, [refs, load]);

  const loan = loans.find((l) => l.id === id) ?? null;
  const account = loan ? refs.accounts.find((a) => a.id === loan.accountId) : null;
  const synced = !!account?.simplefinAccountId;
  const owed = Math.max(0, -(account?.currentBalance ?? 0));
  const asset = loan?.assetId ? assets.find((a) => a.id === loan.assetId) : null;
  const schedule = loan?.recurringId ? schedules.find((s) => s.id === loan.recurringId) : null;
  const o = useMemo(() => (loan ? loanOutlook(loan, owed, payments, today) : null), [loan, owed, payments, today]);
  // Each payment against the contract's row: extra principal, running total.
  const plan = useMemo(() => {
    const m = new Map<string, { delta: number; cumulative: number; n: number }>();
    if (!loan) return { byId: m, ahead: 0 };
    const rows = compareToPlan(loan, payments);
    for (const r of rows) if (r.id) m.set(r.id, r);
    return { byId: m, ahead: rows.length ? rows[rows.length - 1].cumulative : 0 };
  }, [loan, payments]);

  async function importPdf(file: File) {
    setParsing(true);
    try {
      setImporting(await parseLoanSchedulePdf(file));
    } catch (e) {
      addToast({ title: "Couldn't read the schedule", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setParsing(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // The simulator: current pace vs with extra / a lump sum.
  const extra = Math.max(0, Number(sim.extra) || 0);
  const lump = Math.max(0, Number(sim.lump) || 0);
  const scenario = useMemo(() => (o && loan && (extra || lump) ? simulatePayoff({ balance: o.owed, annualRate: loan.interestRate, payment: o.payment, firstDate: o.nextPaymentDate, extraMonthly: extra, lumpSum: lump }) : null), [o, loan, extra, lump]);
  const byTarget = useMemo(() => {
    if (!o || !loan || !sim.by || sim.by < o.nextPaymentDate) return null;
    const n = paymentsBetween(o.nextPaymentDate, sim.by);
    const payment = paymentToFinishIn(Math.max(0, o.owed - lump), loan.interestRate, n);
    return { n, payment, extra: round2(Math.max(0, payment - o.payment)) };
  }, [o, loan, sim.by, lump]);

  const chart = useMemo(() => {
    if (!o || !loan) return [];
    // From today: the original schedule, the current pace and the what-if.
    const rows = new Map<string, { date: string; contract: number | null; pace: number | null; scenario: number | null }>();
    const point = (date: string) => {
      let row = rows.get(date);
      if (!row) rows.set(date, (row = { date, contract: null, pace: null, scenario: null }));
      return row;
    };
    // Contract balance on each remaining payment date.
    const r = loan.interestRate / 12;
    const pmt = o.payment;
    let b = o.contractBalance;
    point(today).contract = b;
    for (let n = o.paymentsMade + 1; n <= loan.termMonths && b > 0; n++) {
      b = Math.max(0, b * (1 + r) - pmt);
      point(paymentDate(loan, n)).contract = round2(b);
    }
    point(today).pace = o.owed;
    for (const row of o.projected.rows) point(row.date).pace = row.balance;
    if (scenario) {
      point(today).scenario = round2(Math.max(0, o.owed - lump));
      for (const row of scenario.rows) point(row.date).scenario = row.balance;
    }
    return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [o, loan, scenario, lump, today]);

  const byYear = useMemo(() => {
    const m = new Map<string, { rows: any[]; principal: number; interest: number; escrow: number; total: number }>();
    for (const p of payments) {
      const y = p.date.slice(0, 4);
      if (!m.has(y)) m.set(y, { rows: [], principal: 0, interest: 0, escrow: 0, total: 0 });
      const g = m.get(y)!;
      g.rows.push(p);
      g.principal += p.principal ?? 0;
      g.interest += p.interest ?? 0;
      g.escrow += p.escrow ?? 0;
      g.total += p.totalAmount ?? 0;
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [payments]);
  const [openYears, setOpenYears] = useState<Set<string>>(new Set([today.slice(0, 4)]));

  if (refs.loading || (loading && !loan)) {
    return (
      <FinanceShell title="Loan">
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </FinanceShell>
    );
  }
  if (!loan || !o) {
    return (
      <FinanceShell title="Loan">
        <EmptyState title="Loan not found">
          <NextLink className="text-primary" href="/finance/net-worth">
            Back to net worth
          </NextLink>
        </EmptyState>
      </FinanceShell>
    );
  }

  const actions = (
    <>
      <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => e.target.files?.[0] && importPdf(e.target.files[0])} />
      <Button size="sm" variant="flat" startContent={<FaFileImport />} isLoading={parsing} onPress={() => fileInput.current?.click()}>
        Import lender schedule
      </Button>
      <Button size="sm" variant="flat" startContent={<FaPen />} onPress={() => setEditing(true)}>
        Edit
      </Button>
      <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => setPaymentModal(null)}>
        Payment
      </Button>
    </>
  );
  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-2">
      <NextLink href="/finance/net-worth" className="text-primary inline-flex items-center gap-1">
        <FaArrowLeft className="text-[10px]" /> Net worth
      </NextLink>
      <span>· {LOAN_TYPE_LABELS[(loan.loanType ?? "OTHER") as LoanType]}</span>
      {loan.lender && <span>· {loan.lender}</span>}
      <span>· {synced ? `balance synced ${ago(account?.balanceUpdatedAt)}` : "manual balance"}</span>
    </span>
  );

  const ahead = o.monthsAhead;
  return (
    <FinanceShell title={account?.name ?? "Loan"} subtitle={subtitle} actions={actions} onSynced={reload}>
      {/* Where it stands */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat label="Owed">
          <Money value={o.owed} cents={false} className="text-2xl font-semibold" />
          <Progress aria-label="Paid off" size="sm" value={o.paidOffPct * 100} color="success" className="mt-1" />
          <div className="text-xs text-default-500 mt-1">
            {Math.round(o.paidOffPct * 100)}% of <Money value={o.original} cents={false} /> paid
          </div>
        </Stat>
        <Stat label="Payment">
          <Money value={o.payment + o.escrow} className="text-2xl font-semibold" />
          <div className="text-xs text-default-500 mt-1">
            <Money value={o.payment} /> P&amp;I{o.escrow ? <> + <Money value={o.escrow} /> escrow</> : null} · {pct(loan.interestRate)}
          </div>
          <div className="text-xs text-default-500">Next {longDate(o.nextPaymentDate)}</div>
        </Stat>
        <Stat label="Paid off">
          <div className="text-2xl font-semibold">{o.projected.payoffDate ? monthYear(o.projected.payoffDate) : "—"}</div>
          <div className="text-xs text-default-500 mt-1">{fmtDuration(o.projected.months)} at this payment</div>
          <div className="text-xs mt-0.5">
            {!Number.isFinite(ahead) ? (
              <span className="text-danger">The payment doesn&apos;t cover the interest</span>
            ) : ahead === 0 ? (
              <span className="text-default-500">On the original schedule ({monthYear(o.contractEnd)})</span>
            ) : (
              <Chip size="sm" variant="flat" color={ahead > 0 ? "success" : "warning"}>
                {ahead > 0 ? `${fmtDuration(ahead)} ahead` : `${fmtDuration(-ahead)} behind`} of {monthYear(o.contractEnd)}
              </Chip>
            )}
          </div>
        </Stat>
        <Stat label="Interest">
          <Money value={o.interestLeft} cents={false} className="text-2xl font-semibold" />
          <div className="text-xs text-default-500 mt-1">still to pay at this rate</div>
          <div className="text-xs text-default-500">
            <Money value={o.interestPaid} cents={false} /> paid in {payments.length} recorded payment{payments.length === 1 ? "" : "s"}
          </div>
        </Stat>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Simulator + chart */}
        <Card shadow="sm" className="lg:col-span-2">
          <CardHeader className="flex flex-col items-start gap-0.5">
            <span className="font-semibold">Pay it off faster?</span>
            <span className="text-xs text-default-500">Balance from today at the current payment, the original schedule, and your what-if.</span>
          </CardHeader>
          <CardBody className="pt-0 gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Input size="sm" label="Extra each month" type="number" min={0} startContent={<span className="text-default-400 text-sm">$</span>} value={sim.extra} onValueChange={(v) => setSim({ ...sim, extra: v })} />
              <Input size="sm" label="One-time lump sum" type="number" min={0} startContent={<span className="text-default-400 text-sm">$</span>} value={sim.lump} onValueChange={(v) => setSim({ ...sim, lump: v })} />
              <Input size="sm" label="Paid off by" type="date" placeholder=" " value={sim.by} onValueChange={(v) => setSim({ ...sim, by: v })} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[100, 250, 500, 1000].map((x) => (
                <Button key={x} size="sm" variant={extra === x ? "solid" : "flat"} color={extra === x ? "primary" : "default"} onPress={() => setSim({ ...sim, extra: extra === x ? "" : String(x) })}>
                  +{fmtCurrency(x, { cents: false })}/mo
                </Button>
              ))}
              {(sim.extra || sim.lump || sim.by) && (
                <Button size="sm" variant="light" onPress={() => setSim({ extra: "", lump: "", by: "" })}>
                  Clear
                </Button>
              )}
            </div>
            {scenario && (
              <div className="rounded-lg bg-success-50 dark:bg-success-50/10 px-3 py-2 text-sm">
                {scenario.stalls ? (
                  "That still doesn't cover the interest."
                ) : (
                  <>
                    Paid off <b>{monthYear(scenario.payoffDate)}</b> ({fmtDuration(scenario.months)}),{" "}
                    <b>{fmtDuration(Math.max(0, o.projected.months - scenario.months))}</b> sooner, saving <Money value={o.projected.totalInterest - scenario.totalInterest} cents={false} className="font-semibold" /> in interest.
                  </>
                )}
              </div>
            )}
            {sim.by && sim.by < o.nextPaymentDate && <div className="text-sm text-warning-600">The next payment is {longDate(o.nextPaymentDate)}; pick a later date.</div>}
            {byTarget && (
              <div className="rounded-lg bg-primary-50 dark:bg-primary-50/10 px-3 py-2 text-sm">
                To be done by <b>{longDate(sim.by)}</b> ({byTarget.n} payments{lump ? ", after the lump sum" : ""}): <Money value={byTarget.payment} className="font-semibold" /> a month P&amp;I
                {byTarget.extra > 0 ? (
                  <>
                    , <Money value={byTarget.extra} /> more than now.
                  </>
                ) : (
                  ": the current payment already gets there."
                )}
              </div>
            )}
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" tickFormatter={(d) => fmtDate(d, { year: "numeric" })} tick={{ fontSize: 10 }} minTickGap={30} />
                  <YAxis tickFormatter={(v) => fmtCurrency(v, { cents: false })} tick={{ fontSize: 10 }} width={80} />
                  <Tooltip formatter={(v) => fmtCurrency(Number(v), { cents: false })} labelFormatter={(d) => monthYear(String(d))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="contract" name="Original schedule" stroke="#a1a1aa" strokeDasharray="4 4" dot={false} connectNulls />
                  <Line type="monotone" dataKey="pace" name="At this payment" stroke="#006fee" strokeWidth={2} dot={false} connectNulls />
                  {scenario && <Line type="monotone" dataKey="scenario" name="What-if" stroke="#17c964" strokeWidth={2} dot={false} connectNulls />}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        {/* Terms + what secures it */}
        <div className="flex flex-col gap-4">
          {asset && (
            <Card shadow="sm">
              <CardHeader className="font-semibold">Secured by {asset.name}</CardHeader>
              <CardBody className="pt-0 gap-1 text-sm">
                <Row label="Value">
                  <Money value={asset.currentValue} cents={false} />
                </Row>
                <Row label="Owed">
                  <Money value={-o.owed} cents={false} />
                </Row>
                <Row label="Equity">
                  <Money value={(asset.currentValue ?? 0) - o.owed} cents={false} className="font-semibold" />
                </Row>
                {asset.currentValue > 0 && (
                  <>
                    <Progress aria-label="Loan to value" size="sm" value={Math.min(100, (o.owed / asset.currentValue) * 100)} color={o.owed / asset.currentValue > 0.8 ? "warning" : "secondary"} className="mt-1" />
                    <div className="text-xs text-default-500">
                      {Math.round((o.owed / asset.currentValue) * 100)}% loan-to-value · valued {longDate(asset.valuedOn)}
                    </div>
                  </>
                )}
              </CardBody>
            </Card>
          )}
          <Card shadow="sm">
            <CardHeader className="font-semibold">Terms</CardHeader>
            <CardBody className="pt-0 gap-1 text-sm">
              <Row label="Borrowed">
                <Money value={loan.originalPrincipal} cents={false} />
                {loan.startDate && <span className="text-default-500"> · {monthYear(loan.startDate)}</span>}
              </Row>
              <Row label="Rate">{pct(loan.interestRate)}</Row>
              <Row label="Term">
                {loan.termMonths} months ({round2(loan.termMonths / 12)} years)
              </Row>
              <Row label="Payments">
                {longDate(loan.firstPaymentDate)} → {longDate(o.contractEnd)}
              </Row>
              <Row label="Made so far">
                {o.paymentsMade} of {loan.termMonths}
              </Row>
              <Row label="Schedule says">
                <Money value={o.contractBalance} cents={false} /> owed now
              </Row>
              {o.recentAverage != null && (
                <Row label="Recently paying">
                  <Money value={o.recentAverage} /> /mo
                </Row>
              )}
              {loan.interestAccrual === "DAILY" && <Row label="Interest">daily simple interest</Row>}
              <Row label="Paid by">
                {schedule ? (
                  <NextLink href="/finance/scheduled" className="text-primary">
                    {schedule.description}
                    <span className="text-default-500"> · next {fmtDate(schedule.nextDate)}</span>
                  </NextLink>
                ) : (
                  <button type="button" className="text-default-500 underline decoration-dotted" onClick={() => setEditing(true)}>
                    no scheduled transaction
                  </button>
                )}
              </Row>
              {loan.notes && <div className="text-xs text-default-500 mt-2 whitespace-pre-wrap">{loan.notes}</div>}
            </CardBody>
          </Card>
        </div>

        {/* Payments */}
        <Card shadow="sm" className="lg:col-span-3">
          <CardHeader className="flex flex-wrap justify-between gap-2">
            <span className="font-semibold">
              Payments
              {payments.length > 0 && Math.abs(plan.ahead) >= 1 && (
                <Chip size="sm" variant="flat" color={plan.ahead > 0 ? "success" : "warning"} className="ml-2">
                  {fmtCurrency(Math.abs(plan.ahead), { cents: false })} of principal {plan.ahead > 0 ? "ahead of" : "behind"} the contract
                </Chip>
              )}
            </span>
            <Button size="sm" variant="light" startContent={<FaPlus />} onPress={() => setPaymentModal(null)}>
              Record
            </Button>
          </CardHeader>
          <CardBody className="pt-0">
            {byYear.length === 0 && (
              <div className="text-sm text-default-500">
                No payments recorded yet.{synced ? " The balance still follows the bank; recording them adds the interest history." : " Each one you record lowers the balance by its principal."} Import the lender&apos;s schedule to load them all at once.
              </div>
            )}
            {byYear.map(([year, g]) => {
              const open = openYears.has(year);
              return (
                <div key={year} className="border-b border-default-100 last:border-0">
                  <button
                    type="button"
                    className="w-full flex flex-wrap items-center justify-between gap-2 py-2 text-sm text-left"
                    onClick={() => setOpenYears((s) => {
                      const n = new Set(s);
                      if (n.has(year)) n.delete(year);
                      else n.add(year);
                      return n;
                    })}
                  >
                    <span className="font-medium">
                      {open ? "▾" : "▸"} {year} <span className="text-default-500 font-normal">· {g.rows.length} payment{g.rows.length === 1 ? "" : "s"}</span>
                    </span>
                    <span className="text-xs text-default-500 flex flex-wrap gap-x-3">
                      <span>
                        Principal <Money value={g.principal} cents={false} />
                      </span>
                      <span>
                        Interest <Money value={g.interest} cents={false} className="text-foreground" />
                      </span>
                      {g.escrow > 0 && (
                        <span>
                          Escrow <Money value={g.escrow} cents={false} />
                        </span>
                      )}
                    </span>
                  </button>
                  {open && (
                    <div className="overflow-x-auto pb-2">
                      <table className="w-full text-sm tabular-nums min-w-lg">
                        <thead className="text-xs text-default-500 text-right">
                          <tr>
                            <th className="text-left font-normal py-1">#</th>
                            <th className="text-left font-normal py-1">Date</th>
                            <th className="font-normal">Total</th>
                            <th className="font-normal">Principal</th>
                            <th className="font-normal">Interest</th>
                            <th className="font-normal">Escrow</th>
                            <th className="font-normal" title="Principal against the contract's row with the same number">
                              vs plan
                            </th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {g.rows.map((p) => {
                            const vs = plan.byId.get(p.id);
                            return (
                              <tr key={p.id} className="text-right hover:bg-default-50 cursor-pointer" onClick={() => setPaymentModal(p)}>
                                <td className="text-left text-default-400 py-1">{p.paymentNumber ?? vs?.n ?? ""}</td>
                                <td className="text-left py-1">
                                  {fmtDate(p.date)}
                                  {p.isExtra && (
                                    <Chip size="sm" variant="flat" color="success" className="ml-2 h-5">
                                      extra
                                    </Chip>
                                  )}
                                  {p.estimated && (
                                    <Chip size="sm" variant="flat" color="warning" className="ml-2 h-5" title="Split estimated from the bank transaction; the lender's schedule import makes it exact">
                                      estimated
                                    </Chip>
                                  )}
                                </td>
                                <td>
                                  <Money value={p.totalAmount} />
                                </td>
                                <td>
                                  <Money value={p.principal} />
                                </td>
                                <td>
                                  <Money value={p.interest} />
                                </td>
                                <td className="text-default-500">{p.escrow ? fmtCurrency(p.escrow) : "—"}</td>
                                <td className={vs && Math.abs(vs.delta) >= 0.5 ? (vs.delta > 0 ? "text-success-600" : "text-warning-600") : "text-default-400"}>
                                  {vs && Math.abs(vs.delta) >= 0.5 ? `${vs.delta > 0 ? "+" : "−"}${fmtCurrency(Math.abs(vs.delta), { cents: false })}` : "—"}
                                </td>
                                <td className="w-8 text-default-400">
                                  <FaPen className="inline text-xs" />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </CardBody>
        </Card>

        {/* Remaining schedule */}
        <Card shadow="sm" className="lg:col-span-3">
          <CardHeader className="flex justify-between">
            <span className="font-semibold">Remaining schedule</span>
            <Button size="sm" variant="light" onPress={() => setShowSchedule(!showSchedule)}>
              {showSchedule ? "Hide" : `Show ${o.projected.rows.length} payments`}
            </Button>
          </CardHeader>
          {showSchedule && (
            <CardBody className="pt-0 overflow-x-auto">
              <table className="w-full text-sm tabular-nums min-w-md">
                <thead className="text-xs text-default-500 text-right">
                  <tr>
                    <th className="text-left font-normal">#</th>
                    <th className="text-left font-normal">Date</th>
                    <th className="font-normal">Principal</th>
                    <th className="font-normal">Interest</th>
                    <th className="font-normal">Balance after</th>
                  </tr>
                </thead>
                <tbody>
                  {o.projected.rows.map((r) => (
                    <tr key={r.n} className={`text-right ${r.date.slice(5, 7) === "12" ? "border-b border-default-200" : ""}`}>
                      <td className="text-left text-default-400">{o.paymentsMade + r.n}</td>
                      <td className="text-left">{monthYear(r.date)}</td>
                      <td>
                        <Money value={r.principal} />
                      </td>
                      <td>
                        <Money value={r.interest} />
                      </td>
                      <td>
                        <Money value={r.balance} cents={false} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          )}
        </Card>
      </div>

      <LoanModal
        loan={editing ? loan : undefined}
        accounts={refs.accounts}
        loans={loans}
        assets={assets}
        onClose={() => setEditing(false)}
        onSaved={(savedId) => {
          if (!savedId) router.push("/finance/net-worth");
          else reload();
        }}
      />
      <PaymentModal payment={paymentModal} loan={loan} owed={owed} synced={synced} payments={payments} onClose={() => setPaymentModal(undefined)} onSaved={reload} />
      <LoanImportModal schedule={importing} loan={loan} synced={synced} existingDates={new Set(payments.map((p) => p.date))} onClose={() => setImporting(null)} onSaved={reload} />
    </FinanceShell>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card shadow="sm">
      <CardBody className="gap-0.5">
        <div className="text-xs uppercase text-default-500">{label}</div>
        {children}
      </CardBody>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-default-500">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
