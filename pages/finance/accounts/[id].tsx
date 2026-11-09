"use client";

// /finance/accounts/[id] — one account: balance and sync status, balance
// history from daily snapshots, a month of transactions, recent sync runs.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Spinner } from "@heroui/react";
import { FaArrowLeft, FaChevronLeft, FaChevronRight } from "react-icons/fa";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money, PersonChip, ago } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { effectiveCategory, UNCATEGORIZED } from "@/lib/finance/categories";
import { addDays, fmtCurrency, fmtDate, monthRange, shiftMonth, todayIso } from "@/lib/finance/dates";
import { listAccountTransactions } from "@/lib/finance/data";
import { listAllPages } from "@/lib/list-all";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HISTORY_DAYS: Array<{ label: string; days: number | null }> = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All", days: null },
];

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export default function FinanceAccountDetailPage() {
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const refs = useFinanceRefs();
  const today = todayIso();
  const [monthIso, setMonthIso] = useState(today);
  const month = useMemo(() => monthRange(monthIso), [monthIso]);
  const [historyDays, setHistoryDays] = useState<number | null>(90);
  const [reloadTick, setReloadTick] = useState(0);

  const [account, setAccount] = useState<any | null>(null);
  const [missing, setMissing] = useState(false);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [txs, setTxs] = useState<any[] | null>(null);
  const [logs, setLogs] = useState<Array<{ log: any; entry: any }>>([]);

  const loadAccount = useCallback(async () => {
    if (!id) return;
    const { data } = await financeClient.models.homeFinanceAccount.get({ id });
    if (!data) return setMissing(true);
    setAccount(data);
    const snaps: any[] = [];
    let nextToken: string | null | undefined;
    do {
      const res: any = await financeClient.models.homeFinanceAccountSnapshot.list({ accountId: id, limit: 1000, nextToken } as any);
      snaps.push(...(res.data ?? []));
      nextToken = res.nextToken;
    } while (nextToken);
    setSnapshots(snaps.sort((a, b) => a.date.localeCompare(b.date)));
    const all = await listAllPages<any>(financeClient.models.homeFinanceSyncLog);
    const mine = all
      .map((log) => ({ log, entry: parseJson<any[]>(log.perAccountJson, []).find((p) => p?.accountId === id) }))
      .filter((x) => x.entry)
      .sort((a, b) => (b.log.startedAt ?? "").localeCompare(a.log.startedAt ?? ""))
      .slice(0, 10);
    setLogs(mine);
  }, [id]);

  useEffect(() => {
    loadAccount().catch((e) => console.error("[finance] account load failed", e));
  }, [loadAccount]);

  useEffect(() => {
    if (!id) return;
    setTxs(null);
    listAccountTransactions(financeClient, id, month)
      .then(setTxs)
      .catch((e) => {
        console.error("[finance] transactions load failed", e);
        setTxs([]);
      });
  }, [id, month, reloadTick]);

  const chartData = useMemo(() => {
    const from = historyDays == null ? "" : addDays(today, -historyDays);
    return snapshots.filter((s) => s.date >= from).map((s) => ({ date: s.date, balance: s.balance }));
  }, [snapshots, historyDays, today]);

  const totals = useMemo(() => {
    const posted = (txs ?? []).filter((t) => t.status !== "PENDING");
    return {
      inflow: posted.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0),
      outflow: posted.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0),
      pending: (txs ?? []).filter((t) => t.status === "PENDING").length,
    };
  }, [txs]);

  if (missing) {
    return (
      <FinanceShell title="Account">
        <EmptyState title="Account not found">
          <NextLink className="text-primary" href="/finance/accounts">
            Back to accounts
          </NextLink>
        </EmptyState>
      </FinanceShell>
    );
  }
  if (!account) {
    return (
      <FinanceShell title="Account">
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </FinanceShell>
    );
  }

  const details = parseJson<any>(account.lastSyncDetails, null);
  const accName = (aid: string | null | undefined) => refs.accounts.find((a) => a.id === aid)?.name ?? "another account";

  return (
    <FinanceShell
      title={account.name}
      subtitle={
        <span>
          {account.institution ?? ""}
          {account.last4 ? ` ••${account.last4}` : ""}
          {account.active === false ? " · inactive" : ""}
        </span>
      }
      onSynced={() => {
        loadAccount();
        setReloadTick((n) => n + 1);
      }}
      actions={
        <Button size="sm" variant="light" startContent={<FaArrowLeft />} onPress={() => router.push("/finance/accounts")}>
          Accounts
        </Button>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <Card shadow="sm">
          <CardBody className="gap-1">
            <div className="text-xs uppercase text-default-500">Balance</div>
            <Money value={account.currentBalance ?? 0} className="text-3xl font-semibold" />
            <div className="text-xs text-default-500">updated {ago(account.balanceUpdatedAt)}</div>
            {account.minBalance != null && (
              <div className={`text-xs ${(account.currentBalance ?? 0) < account.minBalance ? "text-warning-600" : "text-default-500"}`}>
                Buffer {fmtCurrency(account.minBalance, { cents: false })}
              </div>
            )}
            {account.creditLimit != null && <div className="text-xs text-default-500">Limit {fmtCurrency(account.creditLimit, { cents: false })}</div>}
            <div className="text-xs text-default-500 mt-2">
              {account.simplefinAccountId ? (
                <>
                  SimpleFIN · last sync {ago(account.lastSyncAt)}
                  {details && (
                    <div>
                      {details.fromIso} → {details.toIso}: {details.txNew ?? 0} new, {details.txUpdated ?? 0} updated
                      {details.linked ? `, ${details.linked} matched` : ""} of {details.txTotal ?? 0}
                    </div>
                  )}
                </>
              ) : (
                "Not linked to SimpleFIN (manual balance)"
              )}
            </div>
          </CardBody>
        </Card>

        <Card shadow="sm" className="lg:col-span-2">
          <CardHeader className="flex justify-between">
            <span className="font-semibold text-sm">Balance history</span>
            <div className="flex gap-1">
              {HISTORY_DAYS.map((h) => (
                <Button key={h.label} size="sm" variant={historyDays === h.days ? "solid" : "light"} className="min-w-0 px-2 h-7" onPress={() => setHistoryDays(h.days)}>
                  {h.label}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardBody className="pt-0">
            {chartData.length < 2 ? (
              <div className="text-sm text-default-500 py-8 text-center">Daily snapshots build up with each sync.</div>
            ) : (
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <XAxis dataKey="date" tickFormatter={(d) => fmtDate(d)} tick={{ fontSize: 10 }} minTickGap={24} />
                    <YAxis tickFormatter={(v) => fmtCurrency(v, { cents: false })} tick={{ fontSize: 10 }} width={75} domain={["auto", "auto"]} />
                    <Tooltip formatter={(v) => fmtCurrency(Number(v))} labelFormatter={(d) => fmtDate(String(d), { month: "short", day: "numeric", year: "numeric" })} />
                    {account.minBalance != null && <ReferenceLine y={account.minBalance} stroke="#f5a524" strokeDasharray="4 4" />}
                    <Line type="monotone" dataKey="balance" stroke="#006fee" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card shadow="sm" className="mb-4">
        <CardHeader className="flex flex-wrap justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button size="sm" isIconOnly variant="light" aria-label="Previous month" onPress={() => setMonthIso(shiftMonth(monthIso, -1))}>
              <FaChevronLeft />
            </Button>
            <span className="font-semibold text-sm w-36 text-center">{month.label}</span>
            <Button size="sm" isIconOnly variant="light" aria-label="Next month" isDisabled={month.toIso >= today} onPress={() => setMonthIso(shiftMonth(monthIso, 1))}>
              <FaChevronRight />
            </Button>
          </div>
          <div className="text-xs text-default-500 flex gap-3">
            <span>
              In <Money value={totals.inflow} />
            </span>
            <span>
              Out <Money value={totals.outflow} />
            </span>
            {totals.pending > 0 && <span>{totals.pending} pending</span>}
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          {txs == null ? (
            <div className="flex justify-center py-8">
              <Spinner size="sm" />
            </div>
          ) : txs.length === 0 ? (
            <div className="text-sm text-default-500 py-6 text-center">No transactions this month.</div>
          ) : (
            <ul className="flex flex-col divide-y divide-default-100">
              {txs.map((t) => {
                const cat = effectiveCategory(t, refs.rules);
                return (
                  <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="text-default-500 w-14 shrink-0">{fmtDate(t.date)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{t.description}</div>
                      <div className="flex flex-wrap items-center gap-1 mt-0.5">
                        <Chip size="sm" variant="flat" color={cat === UNCATEGORIZED ? "warning" : "default"}>
                          {cat}
                        </Chip>
                        {t.personId && <PersonChip personId={t.personId} people={refs.people} />}
                        {t.status === "PENDING" && (
                          <Chip size="sm" variant="dot" color="warning">
                            pending
                          </Chip>
                        )}
                        {t.type === "TRANSFER" && t.toAccountId && <span className="text-xs text-default-500">↔ {accName(t.toAccountId)}</span>}
                      </div>
                    </div>
                    <Money value={t.amount} sign />
                  </li>
                );
              })}
            </ul>
          )}
          <div className="text-right mt-2">
            <NextLink href={`/finance/transactions?account=${account.id}`} className="text-xs text-primary">
              Edit in Transactions →
            </NextLink>
          </div>
        </CardBody>
      </Card>

      {account.simplefinAccountId && (
        <Card shadow="sm">
          <CardHeader className="font-semibold text-sm">Recent syncs</CardHeader>
          <CardBody className="pt-0">
            {logs.length === 0 ? (
              <div className="text-sm text-default-500">No syncs yet.</div>
            ) : (
              <ul className="flex flex-col divide-y divide-default-100 text-sm">
                {logs.map(({ log, entry }) => (
                  <li key={log.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                    <span className="text-default-500 w-36">{new Date(log.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    <Chip size="sm" variant="flat" color={log.status === "OK" ? "success" : log.status === "ERROR" ? "danger" : "warning"}>
                      {log.status}
                    </Chip>
                    <span className="text-xs text-default-500">{log.trigger?.toLowerCase()}</span>
                    <span className="flex-1 text-xs">
                      {entry.txNew ?? 0} new · {entry.txUpdated ?? 0} updated · {entry.txTotal ?? 0} seen
                      {entry.linked ? ` · ${entry.linked} matched` : ""}
                      {entry.balanceAfter !== entry.balanceBefore && ` · ${fmtCurrency(entry.balanceBefore)} → ${fmtCurrency(entry.balanceAfter)}`}
                    </span>
                    {(log.errorCount ?? 0) > 0 && <span className="text-xs text-danger">{log.errorCount} error(s)</span>}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}
    </FinanceShell>
  );
}
