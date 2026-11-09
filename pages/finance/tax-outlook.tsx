"use client";

// /finance/tax-outlook — the household's federal tax picture for a year,
// projected from each person's paychecks: year-to-date, year-end projection
// and a single-filer outcome per person, then the joint (or separate)
// return, Additional Medicare, and whether withholding + estimated payments
// clear the underpayment-penalty safe harbor. A 401(k) what-if rate applies
// to everyone, capped at the IRS limit. Ported from gennaroanesi.com; math
// in lib/finance/tax.ts. Settings persist in homeFinanceSetting
// "tax-outlook:<year>".

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { Button } from "@heroui/button";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Spinner, addToast } from "@heroui/react";
import { FaExclamationTriangle } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, PersonChip } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { Divider, nativeSelectCls, StatRow, TaxCard } from "@/components/finance/tax-stat";
import { fmtCurrency, fmtDate, todayIso } from "@/lib/finance/dates";
import { getFinanceSetting, listPaychecks, setFinanceSetting } from "@/lib/finance/data";
import {
  combinedOutcome,
  contribPctToReachCap,
  current401kPct,
  extractEmployerMatchPeriod,
  extractEmployerMatchYtd,
  FILING_STATUS_LABELS,
  irs401kElectiveLimit,
  isPaycheckStale,
  nextEstimatedDueDate,
  personOutcome,
  project415cTotal,
  projectFromPaychecks,
  RSU_VEST_CADENCE_LABELS,
  RSU_VEST_CADENCES,
  safeHarbor,
  sortLatestFirst,
  TAX_CONSTANTS_SOURCE,
  type FilingStatus,
  type RsuVestCadence,
  type TaxPaycheck,
} from "@/lib/finance/tax";

/* eslint-disable @typescript-eslint/no-explicit-any */

type TaxSettings = {
  filingStatus: FilingStatus;
  rsuVestCadence: Record<string, RsuVestCadence>; // personId → cadence
  priorYearTax?: number | null; // last year's TOTAL federal tax (return's total tax line)
  priorYearAgi?: number | null; // decides 100% vs 110% of last year
  estimatedPaid?: number | null; // estimated payments already made for this year
  whatIfPct?: number | null; // 401(k) what-if, 0..0.5; null = each person's current rate
};

const DEFAULT_SETTINGS: TaxSettings = { filingStatus: "MFJ", rsuVestCadence: {} };
const money = (n: number | null | undefined) => fmtCurrency(n ?? 0, { cents: false });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const numOrNull = (s: string) => {
  if (s.trim() === "") return null;
  const v = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

export default function TaxOutlookPage() {
  const refs = useFinanceRefs();
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const isCurrentYear = year === thisYear;

  const [paychecks, setPaychecks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<TaxSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPaychecks(await listPaychecks(financeClient));
    } catch (e) {
      addToast({ title: "Couldn't load paychecks", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Settings per year: load on year change, save (debounced) on edit.
  const settingsKey = `tax-outlook:${year}`;
  useEffect(() => {
    let cancelled = false;
    setSettingsReady(false);
    getFinanceSetting<TaxSettings>(financeClient, settingsKey)
      .then((v) => {
        if (!cancelled) setSettings({ ...DEFAULT_SETTINGS, ...(v ?? {}), rsuVestCadence: { ...(v?.rsuVestCadence ?? {}) } });
      })
      .catch(() => {
        if (!cancelled) setSettings(DEFAULT_SETTINGS);
      })
      .finally(() => {
        if (!cancelled) setSettingsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsKey]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback(
    (patch: Partial<TaxSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          setFinanceSetting(financeClient, settingsKey, next).catch((e) =>
            addToast({ title: "Couldn't save settings", description: e instanceof Error ? e.message : String(e), color: "danger" }),
          );
        }, 800);
        return next;
      });
    },
    [settingsKey],
  );
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const years = useMemo(() => {
    const ys = new Set<number>([thisYear]);
    for (const p of paychecks) if (p.payDate) ys.add(Number(p.payDate.slice(0, 4)));
    return [...ys].sort((a, b) => b - a);
  }, [paychecks, thisYear]);

  // Per person with paychecks this year.
  const byPerson = useMemo(() => {
    const out: Array<{
      personId: string;
      paychecks: TaxPaycheck[];
      latest: any;
      projection: NonNullable<ReturnType<typeof projectFromPaychecks>>;
      currentPct: number;
      stale: boolean;
      cadence: RsuVestCadence;
    }> = [];
    const ids = new Set<string>(refs.people.map((p) => p.id));
    for (const p of paychecks) if (p.personId) ids.add(p.personId);
    for (const personId of ids) {
      const mine = sortLatestFirst((paychecks as TaxPaycheck[]).filter((p) => p.personId === personId && p.payDate?.startsWith(`${year}`)));
      if (!mine.length) continue;
      const cadence = settings.rsuVestCadence[personId] ?? "IRREGULAR";
      const projection = projectFromPaychecks({ paychecks: mine, rsuVestCadence: cadence });
      if (!projection) continue;
      out.push({
        personId,
        paychecks: mine,
        latest: mine[0],
        projection,
        currentPct: current401kPct(mine, projection.ytdSalaryGross),
        stale: isCurrentYear && isPaycheckStale(mine[0].payDate, today),
        cadence,
      });
    }
    const order = new Map(refs.people.map((p, i) => [p.id, i]));
    return out.sort((a, b) => (order.get(a.personId) ?? 99) - (order.get(b.personId) ?? 99));
  }, [paychecks, refs.people, settings.rsuVestCadence, year, isCurrentYear, today]);

  const whatIf = settings.whatIfPct ?? null;
  const outcomes = byPerson.map((p) => {
    const ytd401k = (p.latest.ytd401k ?? 0) + (p.latest.ytdRoth401k ?? 0);
    const base = { projection: p.projection, ytd401k, currentPct: p.currentPct, year };
    const current = personOutcome({ ...base, pct: null });
    const adjusted = personOutcome({ ...base, pct: whatIf });
    const mega = project415cTotal({
      ytdEmployee: ytd401k,
      ytdEmployerMatch: extractEmployerMatchYtd(p.latest.lineItems),
      ytdAfterTax: p.latest.ytdAfterTax401k ?? 0,
      ytdGross: p.projection.ytdSalaryGross,
      projectedGross: p.projection.projectedGross,
      projectedEmployee: adjusted.new401k,
      latestPeriodMatch: extractEmployerMatchPeriod(p.latest.lineItems),
      year,
    });
    const capPct = contribPctToReachCap({ ytd401k, ytdGross: p.projection.ytdSalaryGross, projectedGross: p.projection.projectedGross, year });
    return { p, current, adjusted, mega, capPct };
  });

  const combined = outcomes.length ? combinedOutcome(outcomes.map((o) => o.adjusted), settings.filingStatus, year) : null;
  const harbor = combined
    ? safeHarbor({ taxOwed: combined.taxOwed, withheld: combined.fedWh, estimatedPaid: settings.estimatedPaid ?? 0, priorYearTax: settings.priorYearTax, priorYearAgi: settings.priorYearAgi })
    : null;
  const nextDue = isCurrentYear || year === thisYear - 1 ? nextEstimatedDueDate(year, today) : null;
  const defaultSlider = byPerson.length ? byPerson.reduce((s, p) => s + p.currentPct, 0) / byPerson.length : 0;
  const nameOf = (id: string) => refs.people.find((x) => x.id === id)?.name ?? "Someone";

  return (
    <FinanceShell
      title="Tax outlook"
      subtitle={`Federal, projected from each person's latest paycheck · ${TAX_CONSTANTS_SOURCE}`}
      actions={
        <select aria-label="Year" className={nativeSelectCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      }
    >
      {loading || refs.loading || !settingsReady ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : byPerson.length === 0 ? (
        <EmptyState title={`No paychecks for ${year}`}>
          <NextLink href="/finance/paychecks" className="text-primary">
            Add one
          </NextLink>{" "}
          to {isCurrentYear ? "project this year's taxes" : "check the model against that year's actuals"}.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-5">
          {!isCurrentYear && <p className="text-xs text-default-500">Past year: the latest stubs are the year-end numbers, so this checks the model against what you filed.</p>}

          {byPerson.some((p) => p.stale) && (
            <div className="rounded-medium border border-warning-300 bg-warning-50 dark:bg-warning-900/20 px-3 py-2 text-sm flex gap-2 items-start">
              <FaExclamationTriangle className="text-warning-600 mt-0.5 shrink-0" />
              <span>
                {byPerson
                  .filter((p) => p.stale)
                  .map((p) => nameOf(p.personId))
                  .join(" and ")}
                &apos;s latest paycheck is more than 30 days old. The projection assumes the YTD columns are current; add a fresher stub.
              </span>
            </div>
          )}

          {/* 401(k) what-if */}
          <TaxCard title="401(k) what-if" subtitle={`IRS limit ${money(irs401kElectiveLimit(year))} per person in ${year}`}>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-default-500">
              {outcomes.map(({ p, capPct }) => (
                <span key={p.personId}>
                  {nameOf(p.personId)} now {pct(p.currentPct)} · {capPct == null ? "already at the cap" : `hits the cap at ${pct(capPct)}`}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                aria-label="401(k) contribution rate"
                min={0}
                max={50}
                step={0.5}
                value={(whatIf ?? defaultSlider) * 100}
                onChange={(e) => update({ whatIfPct: Number(e.target.value) / 100 })}
                className="flex-1 accent-primary"
              />
              <span className="tabular-nums font-semibold w-16 text-right">{pct(whatIf ?? defaultSlider)}</span>
              <Button size="sm" variant="light" isDisabled={whatIf == null} onPress={() => update({ whatIfPct: null })}>
                Reset
              </Button>
            </div>
            <p className="text-xs text-default-400">Applies to everyone. Contributions stop at the limit, so past the cap rate only the timing changes. Withholding is held as is.</p>
          </TaxCard>

          {/* Per person */}
          {outcomes.map(({ p, current, adjusted, mega }) => {
            const pr = p.projection;
            const hasSupplemental = pr.ytdRsuGross > 0 || pr.ytdBonusGross > 0;
            const sliderOn = whatIf != null && Math.abs(whatIf - p.currentPct) > 1e-6;
            return (
              <div key={p.personId} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <PersonChip personId={p.personId} people={refs.people} size="md" />
                    <span className="text-xs text-default-500">
                      latest stub {fmtDate(p.latest.payDate, { month: "short", day: "numeric", year: "numeric" })}
                      {p.latest.employer ? ` · ${p.latest.employer}` : ""}
                    </span>
                    {p.stale && (
                      <Chip size="sm" color="warning" variant="flat">
                        stale
                      </Chip>
                    )}
                  </div>
                  {(pr.ytdRsuGross > 0 || settings.rsuVestCadence[p.personId]) && (
                    <label className="flex items-center gap-2 text-xs text-default-500">
                      RSU vests
                      <select
                        className={nativeSelectCls}
                        value={p.cadence}
                        onChange={(e) => update({ rsuVestCadence: { ...settings.rsuVestCadence, [p.personId]: e.target.value as RsuVestCadence } })}
                      >
                        {RSU_VEST_CADENCES.map((c) => (
                          <option key={c} value={c}>
                            {RSU_VEST_CADENCE_LABELS[c]}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <TaxCard title="Year to date" subtitle={`${p.paychecks.length} stub${p.paychecks.length === 1 ? "" : "s"}`}>
                    <StatRow label="Salary gross" value={money(pr.ytdSalaryGross)} />
                    {hasSupplemental && (
                      <>
                        <StatRow label="RSU vested" value={money(pr.ytdRsuGross)} hint={pr.vestsCompleted ? `${pr.vestsCompleted} vest${pr.vestsCompleted === 1 ? "" : "s"}` : undefined} />
                        <StatRow label="Bonus" value={money(pr.ytdBonusGross)} />
                      </>
                    )}
                    <StatRow label="Taxable wages" value={money(p.latest.ytdTaxableWage)} />
                    <StatRow label="Federal withheld" value={money(p.latest.ytdFedWh)} />
                    <StatRow label="401(k)" value={money((p.latest.ytd401k ?? 0) + (p.latest.ytdRoth401k ?? 0))} hint={pct(p.currentPct)} />
                    <StatRow label="Take-home" value={money(p.latest.ytdNet)} />
                  </TaxCard>
                  <TaxCard title="Year-end projection" subtitle={`${pr.paychecksElapsed}/${pr.paychecksPerYear} paychecks`}>
                    <StatRow label="Salary gross" value={money(pr.projectedGross)} />
                    {hasSupplemental && (
                      <>
                        <StatRow
                          label="RSU (full year)"
                          value={money(pr.projectedRsuGross)}
                          hint={p.cadence === "IRREGULAR" || pr.vestsExpected === 0 ? "YTD only; set the cadence" : `${pr.vestsCompleted}/${pr.vestsExpected} vests`}
                        />
                        <StatRow label="Bonus" value={money(pr.projectedBonusGross)} />
                        <StatRow label="Total earnings" value={money(pr.projectedTotalEarnings)} />
                      </>
                    )}
                    <StatRow label="Taxable wages" value={money(current.taxableWage)} />
                    <StatRow label="Federal withheld" value={money(pr.projectedFedWh)} />
                    <StatRow label="401(k)" value={money(current.new401k)} hint={`of ${money(current.irsLimit)}${current.capReached ? " · capped" : ""}`} />
                    <StatRow
                      label="All 401(k) additions"
                      value={money(mega.projectedTotal)}
                      hint={`of ${money(mega.irsLimit)}${mega.afterTaxHeadroom > 0 && (p.latest.ytdAfterTax401k ?? 0) > 0 ? ` · ${money(mega.afterTaxHeadroom)} after-tax room` : ""}`}
                    />
                    <StatRow label="Take-home" value={money(pr.projectedNet)} />
                  </TaxCard>
                  <TaxCard title={sliderOn ? `Outcome at ${pct(whatIf!)} 401(k)` : "Outcome"} subtitle="as a single filer">
                    <StatRow label="Taxable income" value={money(adjusted.taxableWage)} />
                    <StatRow label="Tax" value={money(adjusted.taxOwed)} />
                    <StatRow label="Withheld" value={money(adjusted.fedWh)} />
                    <Divider />
                    <StatRow label={adjusted.gap >= 0 ? "Refund" : "Owed at filing"} value={money(Math.abs(adjusted.gap))} tone={adjusted.gap >= 0 ? "good" : "bad"} />
                    {sliderOn && <p className="text-xs text-default-400">{fmtCurrency(adjusted.taxOwed - current.taxOwed, { cents: false, sign: true })} tax vs the current rate</p>}
                  </TaxCard>
                </div>
              </div>
            );
          })}

          {/* Household return */}
          {combined && harbor && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <TaxCard title="Household return" subtitle={FILING_STATUS_LABELS[settings.filingStatus]}>
                <div className="flex gap-2 mb-1">
                  {(["MFJ", "SINGLE"] as FilingStatus[]).map((f) => (
                    <Button key={f} size="sm" variant={settings.filingStatus === f ? "flat" : "light"} color={settings.filingStatus === f ? "primary" : "default"} onPress={() => update({ filingStatus: f })}>
                      {f === "MFJ" ? "Jointly" : "Separately (single)"}
                    </Button>
                  ))}
                </div>
                <StatRow label="Taxable income" value={money(combined.taxableWage)} />
                <StatRow label="Income tax" value={money(combined.bracketTax)} />
                {Math.abs(combined.addlMedicare) >= 1 && (
                  <StatRow
                    label="Additional Medicare"
                    value={fmtCurrency(combined.addlMedicare, { cents: false, sign: true })}
                    hint={combined.addlMedicare < 0 ? "payroll over-withheld it" : "owed beyond payroll withholding"}
                  />
                )}
                <StatRow label="Total tax" value={money(combined.taxOwed)} />
                <StatRow label="Withheld" value={money(combined.fedWh)} />
                {(settings.estimatedPaid ?? 0) > 0 && <StatRow label="Estimated payments" value={money(settings.estimatedPaid)} />}
                <Divider />
                {(() => {
                  const gap = combined.gap + (settings.estimatedPaid ?? 0);
                  return <StatRow label={gap >= 0 ? "Refund" : "Owed at filing"} value={money(Math.abs(gap))} tone={gap >= 0 ? "good" : "bad"} />;
                })()}
                {settings.filingStatus === "MFJ" && byPerson.length < 2 && (
                  <p className="text-xs text-default-400">Only {nameOf(byPerson[0].personId)} has paychecks for {year}; the joint return counts no other wages.</p>
                )}
              </TaxCard>

              <TaxCard title="Underpayment penalty" subtitle="safe harbor">
                <div className={`rounded-medium p-3 text-sm ${harbor.safe ? "bg-success-50 dark:bg-success-900/20" : "bg-warning-50 dark:bg-warning-900/20"}`}>
                  <p className={`font-semibold ${harbor.safe ? "text-success-700" : "text-warning-700"}`}>{harbor.safe ? "On track, no penalty" : "Paid in is short"}</p>
                  <p className="text-default-600 mt-1">
                    {harbor.safe
                      ? `${money(harbor.paid)} paid in clears ${money(harbor.floor)} (${harbor.binding}). You can owe up to ${money(harbor.cushion)} at filing without a penalty; you're ${harbor.balanceDue > 0 ? `at ${money(harbor.balanceDue)}` : "getting a refund"}.`
                      : `Pay about ${money(harbor.shortfall)} more to clear ${money(harbor.floor)} (${harbor.binding}).${nextDue ? ` As an estimated payment, by ${fmtDate(nextDue, { month: "short", day: "numeric", year: "numeric" })};` : ""} extra withholding on a December paycheck or vest counts as paid evenly through the year, so it also covers earlier quarters.`}
                  </p>
                </div>
                <StatRow label="Required" value={money(harbor.floor)} hint={harbor.binding} />
                <StatRow label="Paid in" value={money(harbor.paid)} tone={harbor.safe ? "good" : "warn"} />
                <StatRow label="90% of this year" value={money(harbor.t90)} />
                {harbor.priorTest != null && <StatRow label={`${Math.round(harbor.priorMultiplier * 100)}% of last year`} value={money(harbor.priorTest)} />}
                {nextDue && <StatRow label="Next estimated-tax due date" value={fmtDate(nextDue, { month: "short", day: "numeric", year: "numeric" })} />}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
                  <Input
                    size="sm"
                    label="Last year's total tax"
                    inputMode="decimal"
                    value={settings.priorYearTax != null ? String(settings.priorYearTax) : ""}
                    onValueChange={(v) => update({ priorYearTax: numOrNull(v) })}
                  />
                  <Input
                    size="sm"
                    label="Last year's AGI"
                    inputMode="decimal"
                    value={settings.priorYearAgi != null ? String(settings.priorYearAgi) : ""}
                    onValueChange={(v) => update({ priorYearAgi: numOrNull(v) })}
                  />
                  <Input
                    size="sm"
                    label={`Estimated paid for ${year}`}
                    inputMode="decimal"
                    value={settings.estimatedPaid != null ? String(settings.estimatedPaid) : ""}
                    onValueChange={(v) => update({ estimatedPaid: numOrNull(v) })}
                  />
                </div>
                <p className="text-xs text-default-400">
                  Last year&apos;s return: the total tax line (not what you paid at filing) and AGI. Over $150k AGI the prior-year test is 110%. Blank = only the 90% test. Owing under $1,000 is never
                  penalized. Estimated payments count from the day paid; this checks the year as a whole.
                </p>
              </TaxCard>
            </div>
          )}
        </div>
      )}
    </FinanceShell>
  );
}
