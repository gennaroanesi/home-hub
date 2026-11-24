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
  FILING_STATUS_LABELS,
  irs401kElectiveLimit,
  RSU_VEST_CADENCE_LABELS,
  RSU_VEST_CADENCES,
  TAX_CONSTANTS_SOURCE,
  type FilingStatus,
  type RsuVestCadence,
} from "@/lib/finance/tax";
import {
  DEFAULT_TAX_SETTINGS,
  normalizeTaxSettings,
  parseTaxAmount,
  paycheckYears,
  taxOutlook,
  taxSettingsKey,
  type TaxSettings,
} from "@/lib/finance/tax-screen";

/* eslint-disable @typescript-eslint/no-explicit-any */

const money = (n: number | null | undefined) => fmtCurrency(n ?? 0, { cents: false });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function TaxOutlookPage() {
  const refs = useFinanceRefs();
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);

  const [paychecks, setPaychecks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<TaxSettings>(DEFAULT_TAX_SETTINGS);
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
  const settingsKey = taxSettingsKey(year);
  useEffect(() => {
    let cancelled = false;
    setSettingsReady(false);
    getFinanceSetting<TaxSettings>(financeClient, settingsKey)
      .then((v) => {
        if (!cancelled) setSettings(normalizeTaxSettings(v));
      })
      .catch(() => {
        if (!cancelled) setSettings(DEFAULT_TAX_SETTINGS);
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

  const years = useMemo(() => paycheckYears(paychecks, thisYear), [paychecks, thisYear]);

  // Per person with paychecks this year, their outcomes, and the household return.
  const personOrder = useMemo(() => refs.people.map((p) => p.id), [refs.people]);
  const view = useMemo(() => taxOutlook({ paychecks, personOrder, settings, year, today }), [paychecks, personOrder, settings, year, today]);
  const { people: byPerson, combined, harbor, householdGap, nextDue, defaultPct: defaultSlider, isCurrentYear } = view;
  const whatIf = settings.whatIfPct ?? null;
  const nameOf = (id: string) => refs.household.find((x) => x.id === id)?.name ?? "Someone";

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
              {byPerson.map((p) => (
                <span key={p.personId}>
                  {nameOf(p.personId)} now {pct(p.currentPct)} · {p.capPct == null ? "already at the cap" : `hits the cap at ${pct(p.capPct)}`}
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
          {byPerson.map((p) => {
            const { current, adjusted, mega, sliderOn } = p;
            const pr = p.projection;
            const hasSupplemental = pr.ytdRsuGross > 0 || pr.ytdBonusGross > 0;
            return (
              <div key={p.personId} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <PersonChip personId={p.personId} people={refs.household} size="md" />
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
                {householdGap != null && (
                  <StatRow label={householdGap >= 0 ? "Refund" : "Owed at filing"} value={money(Math.abs(householdGap))} tone={householdGap >= 0 ? "good" : "bad"} />
                )}
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
                    onValueChange={(v) => update({ priorYearTax: parseTaxAmount(v) })}
                  />
                  <Input
                    size="sm"
                    label="Last year's AGI"
                    inputMode="decimal"
                    value={settings.priorYearAgi != null ? String(settings.priorYearAgi) : ""}
                    onValueChange={(v) => update({ priorYearAgi: parseTaxAmount(v) })}
                  />
                  <Input
                    size="sm"
                    label={`Estimated paid for ${year}`}
                    inputMode="decimal"
                    value={settings.estimatedPaid != null ? String(settings.estimatedPaid) : ""}
                    onValueChange={(v) => update({ estimatedPaid: parseTaxAmount(v) })}
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
