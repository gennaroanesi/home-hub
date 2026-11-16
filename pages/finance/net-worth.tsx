"use client";

// /finance/net-worth — what the household owns minus what it owes: accounts
// (cash, invested, debts), property (the house, cars) with each one's equity
// against the loans it secures, the loans themselves, and the total over
// time (daily account snapshots + asset valuations; lib/finance/net-worth.ts).
// Writes go through save_finance_asset / save_finance_loan.

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Progress, Spinner, addToast } from "@heroui/react";
import { FaCar, FaGem, FaHome, FaPen, FaPlus, FaBox } from "react-icons/fa";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money, ago } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { AssetModal, LoanModal } from "@/components/finance/net-worth-modals";
import { accountTypeLabel } from "@/lib/finance/accounts";
import { listAssetValuations, listAssets, listLoanPayments, listLoans, listSnapshots } from "@/lib/finance/data";
import { fmtCurrency, fmtDate, todayIso } from "@/lib/finance/dates";
import { LOAN_TYPE_LABELS, fmtDuration, loanOutlook, type LoanType } from "@/lib/finance/loans";
import { ASSET_TYPE_LABELS, GROUP_LABELS, accountGroup, assetEquity, changeSince, netWorthHistory, netWorthNow, type AssetType, type NetWorthGroup } from "@/lib/finance/net-worth";

const ASSET_ICON: Record<string, React.ReactNode> = {
  REAL_ESTATE: <FaHome />,
  VEHICLE: <FaCar />,
  COLLECTIBLE: <FaGem />,
  OTHER: <FaBox />,
};

const GROUP_COLORS: Record<NetWorthGroup, string> = {
  cash: "#17c964",
  invested: "#006fee",
  property: "#7828c8",
  debt: "#f31260",
  other: "#a1a1aa",
};

export default function NetWorthPage() {
  const router = useRouter();
  const refs = useFinanceRefs();
  const today = todayIso();
  const [assets, setAssets] = useState<any[]>([]);
  const [valuations, setValuations] = useState<any[]>([]);
  const [loans, setLoans] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [assetModal, setAssetModal] = useState<any | null | undefined>(undefined);
  const [loanModal, setLoanModal] = useState<{ loan: any | null; accountId?: string } | null>(null);
  const [showSold, setShowSold] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, v, l, p, s] = await Promise.all([listAssets(financeClient), listAssetValuations(financeClient), listLoans(financeClient), listLoanPayments(financeClient), listSnapshots(financeClient)]);
      setAssets(a);
      setValuations(v);
      setLoans(l);
      setPayments(p);
      setSnapshots(s);
    } catch (e) {
      addToast({ title: "Couldn't load net worth", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    await Promise.all([refs.reload(), load()]);
  }, [refs, load]);

  const accounts = refs.accounts;
  const totals = useMemo(() => netWorthNow(accounts, assets), [accounts, assets]);
  const history = useMemo(() => netWorthHistory({ accounts, snapshots, assets, valuations, today }), [accounts, snapshots, assets, valuations, today]);
  const change30 = changeSince(history, 30);
  const changeAll = history.length > 1 ? { from: history[0].date, amount: history[history.length - 1].total - history[0].total } : null;
  const equity = useMemo(() => assetEquity(assets, loans, accounts), [assets, loans, accounts]);
  const sold = assets.filter((a) => a.active === false);

  const loanCards = useMemo(
    () =>
      loans
        .map((l) => {
          const account = accounts.find((a) => a.id === l.accountId);
          const owed = Math.max(0, -(account?.currentBalance ?? 0));
          return { loan: l, account, outlook: loanOutlook(l, owed, payments.filter((p) => p.loanId === l.id), today), asset: assets.find((a) => a.id === l.assetId) ?? null };
        })
        .sort((a, b) => b.outlook.owed - a.outlook.owed),
    [loans, accounts, payments, assets, today],
  );
  const bareLoanAccounts = accounts.filter((a) => a.type === "LOAN" && a.active !== false && !loans.some((l) => l.accountId === a.id));

  const groups = useMemo(() => {
    const out = new Map<NetWorthGroup, any[]>();
    for (const a of accounts.filter((x) => x.active !== false)) {
      const g = accountGroup(a.type);
      if (!out.has(g)) out.set(g, []);
      out.get(g)!.push(a);
    }
    return (["cash", "invested", "debt", "other"] as NetWorthGroup[]).filter((g) => out.has(g)).map((g) => ({ group: g, accounts: out.get(g)! }));
  }, [accounts]);

  if (refs.loading || (loading && !assets.length && !loans.length)) {
    return (
      <FinanceShell title="Net worth">
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </FinanceShell>
    );
  }

  const actions = (
    <>
      <Button size="sm" variant="flat" startContent={<FaPlus />} onPress={() => setAssetModal(null)}>
        Asset
      </Button>
      <Button size="sm" variant="flat" startContent={<FaPlus />} onPress={() => setLoanModal({ loan: null })}>
        Loan
      </Button>
    </>
  );

  return (
    <FinanceShell title="Net worth" actions={actions} onSynced={reload}>
      {/* Headline + breakdown + chart */}
      <Card shadow="sm" className="mb-5">
        <CardBody className="gap-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-xs uppercase text-default-500">Net worth</div>
              <Money value={totals.total} cents={false} className="text-4xl font-bold" />
              <div className="text-sm text-default-500 mt-1 flex flex-wrap gap-x-3">
                {change30 && (
                  <span>
                    <Money value={change30.amount} sign cents={false} /> in 30 days
                  </span>
                )}
                {!change30 && changeAll && (
                  <span>
                    <Money value={changeAll.amount} sign cents={false} /> since {fmtDate(changeAll.from)}
                  </span>
                )}
                <span>
                  Own <Money value={totals.assets} cents={false} /> · owe <Money value={totals.liabilities} cents={false} />
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-sm">
              {(["cash", "invested", "property", "debt"] as NetWorthGroup[]).map((g) => (
                <div key={g}>
                  <div className="flex items-center gap-1.5 text-xs text-default-500">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: GROUP_COLORS[g] }} />
                    {GROUP_LABELS[g]}
                  </div>
                  <Money value={totals[g]} cents={false} className="font-semibold" />
                </div>
              ))}
            </div>
          </div>
          <CompositionBar totals={totals} />
          <HistoryChart history={history} />
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Property */}
        <Card shadow="sm">
          <CardHeader className="flex justify-between">
            <span className="font-semibold">Property</span>
            <Button size="sm" variant="light" startContent={<FaPlus />} onPress={() => setAssetModal(null)}>
              Asset
            </Button>
          </CardHeader>
          <CardBody className="pt-0 gap-4">
            {equity.length === 0 && <EmptyState title="No assets yet">Add the house and cars so their value (and equity) counts.</EmptyState>}
            {equity.map((e) => {
              const a = e.asset as any;
              const gain = a.purchaseValue ? e.value - a.purchaseValue : null;
              return (
                <div key={a.id} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium min-w-0">
                      <span className="text-default-500">{ASSET_ICON[a.type ?? "OTHER"]}</span>
                      <span className="truncate">{a.name}</span>
                    </span>
                    <span className="flex items-center gap-1">
                      <Money value={e.value} cents={false} className="font-semibold" />
                      <Button size="sm" isIconOnly variant="light" aria-label={`Edit ${a.name}`} onPress={() => setAssetModal(a)}>
                        <FaPen className="text-default-400" />
                      </Button>
                    </span>
                  </div>
                  <div className="text-xs text-default-500 flex flex-wrap gap-x-2">
                    <span>{ASSET_TYPE_LABELS[(a.type ?? "OTHER") as AssetType]}</span>
                    <span>· valued {a.valuedOn ? fmtDate(a.valuedOn, { month: "short", day: "numeric", year: "numeric" }) : "—"}</span>
                    {gain != null && (
                      <span>
                        · <Money value={gain} sign cents={false} /> vs purchase
                      </span>
                    )}
                    <button type="button" className="text-primary" onClick={() => setAssetModal(a)}>
                      Update value
                    </button>
                  </div>
                  {e.loans.length > 0 && (
                    <>
                      <Progress aria-label="Loan to value" size="sm" value={Math.min(100, (e.ltv ?? 0) * 100)} color={(e.ltv ?? 0) > 0.8 ? "warning" : "secondary"} />
                      <div className="text-xs text-default-500 flex flex-wrap justify-between gap-2">
                        <span>
                          Owe <Money value={e.owed} cents={false} /> ({e.loans.map((l) => l.name).join(", ")}) · {Math.round((e.ltv ?? 0) * 100)}% LTV
                        </span>
                        <span className="text-foreground">
                          Equity <Money value={e.equity} cents={false} className="font-semibold" />
                        </span>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            {sold.length > 0 && (
              <button type="button" className="text-xs text-default-500 text-left" onClick={() => setShowSold(!showSold)}>
                {showSold ? "Hide" : "Show"} {sold.length} sold
              </button>
            )}
            {showSold &&
              sold.map((a) => (
                <div key={a.id} className="flex justify-between text-sm text-default-500">
                  <button type="button" className="truncate text-left" onClick={() => setAssetModal(a)}>
                    {a.name}
                  </button>
                  <span>
                    sold {fmtDate(a.soldDate, { month: "short", year: "numeric" })}
                    {a.soldValue != null && ` for ${fmtCurrency(a.soldValue, { cents: false })}`}
                  </span>
                </div>
              ))}
          </CardBody>
        </Card>

        {/* Loans */}
        <Card shadow="sm">
          <CardHeader className="flex justify-between">
            <span className="font-semibold">Loans</span>
            <Button size="sm" variant="light" startContent={<FaPlus />} onPress={() => setLoanModal({ loan: null })}>
              Loan
            </Button>
          </CardHeader>
          <CardBody className="pt-0 gap-3">
            {loanCards.length === 0 && bareLoanAccounts.length === 0 && <EmptyState title="No loans">Add the mortgage or a car loan to track payoff and equity.</EmptyState>}
            {loanCards.map(({ loan, account, outlook: o, asset }) => (
              <NextLink key={loan.id} href={`/finance/loans/${loan.id}`} className="block rounded-lg p-2 -mx-2 hover:bg-default-100">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{account?.name ?? "Loan"}</span>
                  <Money value={-o.owed} cents={false} className="font-semibold" />
                </div>
                <div className="text-xs text-default-500 flex flex-wrap gap-x-2 mb-1.5">
                  <span>{LOAN_TYPE_LABELS[(loan.loanType ?? "OTHER") as LoanType]}</span>
                  <span>· {(loan.interestRate * 100).toFixed(3).replace(/\.?0+$/, "")}%</span>
                  <span>· {fmtCurrency(o.payment + o.escrow, { cents: false })}/mo</span>
                  {asset && <span>· {asset.name}</span>}
                </div>
                <Progress aria-label="Paid off" size="sm" value={o.paidOffPct * 100} color="success" />
                <div className="text-xs text-default-500 flex flex-wrap justify-between gap-2 mt-1">
                  <span>{Math.round(o.paidOffPct * 100)}% paid off</span>
                  <span>
                    {o.projected.payoffDate ? `Paid off ${fmtDate(o.projected.payoffDate, { month: "short", year: "numeric" })} · ${fmtDuration(o.projected.months)}` : fmtDuration(o.projected.months)}
                    {Number.isFinite(o.monthsAhead) && o.monthsAhead !== 0 && (
                      <Chip size="sm" variant="flat" color={o.monthsAhead > 0 ? "success" : "warning"} className="ml-2 h-5">
                        {o.monthsAhead > 0 ? `${o.monthsAhead} mo ahead` : `${-o.monthsAhead} mo behind`}
                      </Chip>
                    )}
                  </span>
                </div>
              </NextLink>
            ))}
            {bareLoanAccounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-default-300 p-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{a.name}</span> <Money value={a.currentBalance} cents={false} className="text-default-500" />
                  <div className="text-xs text-default-500">No terms yet: add them for payoff dates and interest.</div>
                </span>
                <Button size="sm" variant="flat" onPress={() => setLoanModal({ loan: null, accountId: a.id })}>
                  Add terms
                </Button>
              </div>
            ))}
          </CardBody>
        </Card>

        {/* Accounts */}
        <Card shadow="sm" className="lg:col-span-2">
          <CardHeader className="flex justify-between">
            <span className="font-semibold">Accounts</span>
            <NextLink href="/finance/accounts" className="text-xs text-primary">
              Accounts →
            </NextLink>
          </CardHeader>
          <CardBody className="pt-0">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
              {groups.map(({ group, accounts: rows }) => (
                <div key={group}>
                  <div className="flex justify-between text-xs uppercase text-default-500 mb-1">
                    <span>{GROUP_LABELS[group]}</span>
                    <Money value={rows.reduce((s, a) => s + (a.currentBalance ?? 0), 0)} cents={false} />
                  </div>
                  <ul className="divide-y divide-default-100 text-sm">
                    {rows.map((a) => {
                      const loan = loans.find((l) => l.accountId === a.id);
                      return (
                        <li key={a.id}>
                          <button type="button" className="w-full flex items-center justify-between gap-2 py-1.5 text-left hover:bg-default-50" onClick={() => router.push(loan ? `/finance/loans/${loan.id}` : `/finance/accounts/${a.id}`)}>
                            <span className="min-w-0">
                              <span className="truncate">{a.name}</span>
                              <span className="text-xs text-default-400">
                                {" "}
                                · {accountTypeLabel(a)} · {ago(a.balanceUpdatedAt)}
                              </span>
                            </span>
                            <Money value={a.currentBalance ?? 0} cents={false} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>

      <AssetModal
        asset={assetModal}
        valuations={valuations}
        loans={assetModal ? (equity.find((e) => e.asset.id === assetModal.id)?.loans ?? []).map((l) => ({ id: l.loanId, name: l.name ?? "Loan", owed: l.owed })) : []}
        onClose={() => setAssetModal(undefined)}
        onSaved={reload}
      />
      <LoanModal
        loan={loanModal ? loanModal.loan : undefined}
        presetAccountId={loanModal?.accountId}
        accounts={accounts}
        loans={loans}
        assets={assets}
        onClose={() => setLoanModal(null)}
        onSaved={(id) => {
          reload();
          if (id && !loanModal?.loan) router.push(`/finance/loans/${id}`);
        }}
      />
    </FinanceShell>
  );
}

/** What's owned (cash, invested, property) against what's owed, on one scale. */
function CompositionBar({ totals }: { totals: ReturnType<typeof netWorthNow> }) {
  const scale = Math.max(totals.assets, totals.liabilities, 1);
  const seg = (g: NetWorthGroup, v: number) => (v > 0 ? <div key={g} title={`${GROUP_LABELS[g]} ${fmtCurrency(v, { cents: false })}`} style={{ width: `${(v / scale) * 100}%`, background: GROUP_COLORS[g] }} /> : null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-2.5 rounded-full overflow-hidden bg-default-100">{(["cash", "invested", "property"] as NetWorthGroup[]).map((g) => seg(g, Math.max(0, totals[g])))}</div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-default-100">{seg("debt", totals.liabilities)}</div>
      <div className="flex justify-between text-[11px] text-default-500">
        <span>Own</span>
        <span>Owe</span>
      </div>
    </div>
  );
}

function HistoryChart({ history }: { history: Array<{ date: string; total: number; cash: number; invested: number; property: number; debt: number }> }) {
  if (history.length < 2) {
    return <div className="text-xs text-default-500">The chart fills in day by day from the account snapshots the nightly sync takes.</div>;
  }
  const lo = Math.min(...history.map((p) => p.total));
  const hi = Math.max(...history.map((p) => p.total));
  const pad = Math.max(1000, (hi - lo) * 0.15);
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="nw" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7828c8" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#7828c8" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tickFormatter={(d) => fmtDate(d)} tick={{ fontSize: 10 }} minTickGap={24} />
          <YAxis tickFormatter={(v) => fmtCurrency(v, { cents: false })} tick={{ fontSize: 10 }} width={80} domain={[Math.floor(lo - pad), Math.ceil(hi + pad)]} />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as (typeof history)[number];
              return (
                <div className="rounded-md bg-content1 shadow-md px-3 py-2 text-xs flex flex-col gap-0.5">
                  <div className="font-medium">{fmtDate(p.date, { month: "short", day: "numeric", year: "numeric" })}</div>
                  <div>
                    Net worth <Money value={p.total} cents={false} className="font-semibold" />
                  </div>
                  {(["cash", "invested", "property", "debt"] as const).map((g) => (
                    <div key={g} className="text-default-500">
                      {GROUP_LABELS[g]} <Money value={p[g]} cents={false} />
                    </div>
                  ))}
                </div>
              );
            }}
          />
          <Area type="monotone" dataKey="total" stroke="#7828c8" strokeWidth={2} fill="url(#nw)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
