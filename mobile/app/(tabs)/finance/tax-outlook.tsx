// Tax outlook — the household's federal tax picture for a year, like the
// web's Finance → Tax outlook: per person with paychecks, year to date, the
// year-end projection and a single-filer outcome; then the joint (or
// separate) return and whether withholding + estimated payments clear the
// underpayment-penalty safe harbor. A 401(k) what-if rate (− / + or typed,
// in place of the web's slider) applies to everyone, capped at the IRS
// limit. Everything is computed by lib/finance/tax-screen.ts over
// lib/finance/tax.ts; settings are shared with the web in homeFinanceSetting
// "tax-outlook:<year>" (saved a moment after each change). Paychecks come
// from the model client (listPaychecks), like the web.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../lib/amplify";
import { usePeople } from "../../../lib/use-people";
import { Input } from "../../../components/finance/form";
import { ACCENT, Card, Chip, DANGER, FinanceHeader, GOOD, WARN, fs, openFinance } from "../../../components/finance/ui";
import { fmtCurrency, fmtDate, todayIso } from "../../../../lib/finance/dates";
import { getFinanceSetting, listPaychecks, setFinanceSetting } from "../../../../lib/finance/data";
import { financePeople } from "../../../../lib/finance/ledger";
import {
  FILING_STATUS_LABELS,
  irs401kElectiveLimit,
  RSU_VEST_CADENCE_LABELS,
  RSU_VEST_CADENCES,
  TAX_CONSTANTS_SOURCE,
  type FilingStatus,
  type TaxPaycheck,
} from "../../../../lib/finance/tax";
import { DEFAULT_TAX_SETTINGS, normalizeTaxSettings, parseTaxAmount, paycheckYears, taxOutlook, taxSettingsKey, type TaxSettings } from "../../../../lib/finance/tax-screen";

/* eslint-disable @typescript-eslint/no-explicit-any */

const money = (n: number | null | undefined) => fmtCurrency(n ?? 0, { cents: false });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const longDate = (iso: string) => fmtDate(iso, { month: "short", day: "numeric", year: "numeric" });
const errText = (e: any) => e?.errors?.[0]?.message ?? e?.message ?? String(e);

function StatRow({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "good" ? GOOD : tone === "warn" ? WARN : tone === "bad" ? DANGER : "#333";
  return (
    <View style={[fs.rowBetween, { alignItems: "baseline" }]}>
      <Text style={[fs.muted, { flex: 1, fontSize: 13 }]}>
        {label}
        {hint ? <Text style={{ fontSize: 11, color: "#aaa" }}> {hint}</Text> : null}
      </Text>
      <Text style={[fs.money, { fontWeight: "500", color }]}>{value}</Text>
    </View>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card style={{ gap: 6 }}>
      <View style={[fs.rowBetween, { alignItems: "baseline" }]}>
        <Text style={[fs.label, { fontWeight: "600" }]}>{title}</Text>
        {subtitle ? (
          <Text style={[fs.muted, { flexShrink: 1, textAlign: "right" }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {children}
    </Card>
  );
}

/** A money setting typed in; kept as text while editing, saved as a number. */
function AmountSetting({ label, value, onChange }: { label: string; value: number | null | undefined; onChange: (v: number | null) => void }) {
  const [text, setText] = useState(value != null ? String(value) : "");
  useEffect(() => setText(value != null ? String(value) : ""), [value]);
  return (
    <View style={[fs.rowBetween, { gap: 12 }]}>
      <Text style={fs.textFlex}>{label}</Text>
      <Input value={text} onChangeText={setText} onEndEditing={() => onChange(parseTaxAmount(text))} keyboardType="decimal-pad" placeholder="—" style={{ width: 130, textAlign: "right" }} />
    </View>
  );
}

export default function FinanceTaxOutlook() {
  const { people: household } = usePeople();
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);

  const [paychecks, setPaychecks] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settings, setSettings] = useState<TaxSettings>(DEFAULT_TAX_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);

  const load = useCallback(async () => {
    try {
      setPaychecks(await listPaychecks(getClient()));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Settings per year: load on year change, save (debounced) on edit.
  const settingsKey = taxSettingsKey(year);
  useEffect(() => {
    let live = true;
    setSettingsReady(false);
    getFinanceSetting<TaxSettings>(getClient(), settingsKey)
      .then((v) => live && setSettings(normalizeTaxSettings(v)))
      .catch(() => live && setSettings(DEFAULT_TAX_SETTINGS))
      .finally(() => live && setSettingsReady(true));
    return () => {
      live = false;
    };
  }, [settingsKey]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback(
    (patch: Partial<TaxSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          setFinanceSetting(getClient(), settingsKey, next).catch((e) => Alert.alert("Couldn't save settings", errText(e)));
        }, 800);
        return next;
      });
    },
    [settingsKey],
  );
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const order = useMemo(() => financePeople(household).map((p) => p.id), [household]);
  const nameOf = (id: string) => household.find((p) => p.id === id)?.name ?? "Someone";
  const years = useMemo(() => paycheckYears(paychecks ?? [], thisYear), [paychecks, thisYear]);
  const view = useMemo(
    () => taxOutlook({ paychecks: (paychecks ?? []) as (TaxPaycheck & Record<string, any>)[], personOrder: order, settings, year, today }),
    [paychecks, order, settings, year, today],
  );
  const whatIf = settings.whatIfPct ?? null;
  const shownPct = whatIf ?? view.defaultPct;
  const setPct = (p: number) => update({ whatIfPct: Math.round(Math.max(0, Math.min(0.5, p)) * 1000) / 1000 });
  const { combined, harbor } = view;

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Tax outlook" />
      {!paychecks || !settingsReady ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} keyboardShouldPersistTaps="handled">
          <Text style={[fs.muted, { paddingHorizontal: 4 }]}>Federal, projected from each person&apos;s latest paycheck · {TAX_CONSTANTS_SOURCE}</Text>
          <View style={fs.chipRow}>
            {years.map((y) => (
              <Chip key={y} label={String(y)} on={year === y} onPress={() => setYear(y)} />
            ))}
          </View>

          {view.people.length === 0 ? (
            <Card>
              <Text style={fs.text}>No paychecks for {year}.</Text>
              <Pressable onPress={() => openFinance("paychecks")} hitSlop={8}>
                <Text style={fs.link}>Add one on Paychecks ›</Text>
              </Pressable>
            </Card>
          ) : (
            <>
              {!view.isCurrentYear && <Text style={[fs.muted, { paddingHorizontal: 4 }]}>Past year: the latest stubs are the year-end numbers, so this checks the model against what you filed.</Text>}
              {view.people.some((p) => p.stale) && (
                <View style={[fs.card, { flexDirection: "row", gap: 8, backgroundColor: "#fdf6e7" }]}>
                  <Ionicons name="warning-outline" size={18} color={WARN} />
                  <Text style={[fs.textFlex, { color: "#6b4e16" }]}>
                    {view.people
                      .filter((p) => p.stale)
                      .map((p) => nameOf(p.personId))
                      .join(" and ")}
                    &apos;s latest paycheck is more than 30 days old. The projection assumes the YTD numbers are current; add a fresher stub.
                  </Text>
                </View>
              )}

              {/* 401(k) what-if */}
              <Section title="401(k) what-if" subtitle={`IRS limit ${money(irs401kElectiveLimit(year))} per person`}>
                {view.people.map((p) => (
                  <Text key={p.personId} style={fs.muted}>
                    {nameOf(p.personId)} now {pct(p.currentPct)} · {p.capPct == null ? "already at the cap" : `hits the cap at ${pct(p.capPct)}`}
                  </Text>
                ))}
                <View style={[fs.rowBetween, { marginTop: 4 }]}>
                  <Pressable onPress={() => setPct(shownPct - 0.005)} hitSlop={8} accessibilityLabel="Lower the rate">
                    <Ionicons name="remove-circle-outline" size={30} color={ACCENT} />
                  </Pressable>
                  <Text style={{ fontSize: 22, fontWeight: "600", fontVariant: ["tabular-nums"], color: "#333" }}>{pct(shownPct)}</Text>
                  <Pressable onPress={() => setPct(shownPct + 0.005)} hitSlop={8} accessibilityLabel="Raise the rate">
                    <Ionicons name="add-circle-outline" size={30} color={ACCENT} />
                  </Pressable>
                  <Pressable onPress={() => update({ whatIfPct: null })} disabled={whatIf == null} hitSlop={8}>
                    <Text style={[fs.link, whatIf == null && { opacity: 0.4 }]}>Reset</Text>
                  </Pressable>
                </View>
                <View style={fs.chipRow}>
                  {view.people
                    .filter((p) => p.capPct != null)
                    .map((p) => (
                      <Chip key={p.personId} label={`${nameOf(p.personId)}'s cap rate`} onPress={() => setPct(p.capPct!)} />
                    ))}
                </View>
                <Text style={fs.muted}>Applies to everyone. Contributions stop at the limit, so past the cap rate only the timing changes. Withholding is held as is.</Text>
              </Section>

              {/* Per person */}
              {view.people.map((p) => {
                const pr = p.projection;
                const hasSupplemental = pr.ytdRsuGross > 0 || pr.ytdBonusGross > 0;
                return (
                  <View key={p.personId} style={{ gap: 8 }}>
                    <View style={{ paddingHorizontal: 4, gap: 2 }}>
                      <Text style={fs.cardTitle}>
                        {nameOf(p.personId)}
                        {p.stale ? <Text style={[fs.muted, { color: WARN }]}> · stale</Text> : null}
                      </Text>
                      <Text style={fs.muted}>
                        latest stub {longDate(p.latest.payDate)}
                        {(p.latest as any).employer ? ` · ${(p.latest as any).employer}` : ""}
                      </Text>
                    </View>
                    {(pr.ytdRsuGross > 0 || settings.rsuVestCadence[p.personId]) && (
                      <View style={{ gap: 6 }}>
                        <Text style={[fs.label, { paddingHorizontal: 4 }]}>RSU vests</Text>
                        <View style={fs.chipRow}>
                          {RSU_VEST_CADENCES.map((c) => (
                            <Chip
                              key={c}
                              label={RSU_VEST_CADENCE_LABELS[c]}
                              on={p.cadence === c}
                              onPress={() => update({ rsuVestCadence: { ...settings.rsuVestCadence, [p.personId]: c } })}
                            />
                          ))}
                        </View>
                      </View>
                    )}
                    <Section title="Year to date" subtitle={`${p.paychecks.length} stub${p.paychecks.length === 1 ? "" : "s"}`}>
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
                    </Section>
                    <Section title="Year-end projection" subtitle={`${pr.paychecksElapsed}/${pr.paychecksPerYear} paychecks`}>
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
                      <StatRow label="Taxable wages" value={money(p.current.taxableWage)} />
                      <StatRow label="Federal withheld" value={money(pr.projectedFedWh)} />
                      <StatRow label="401(k)" value={money(p.current.new401k)} hint={`of ${money(p.current.irsLimit)}${p.current.capReached ? " · capped" : ""}`} />
                      <StatRow
                        label="All 401(k) additions"
                        value={money(p.mega.projectedTotal)}
                        hint={`of ${money(p.mega.irsLimit)}${p.mega.afterTaxHeadroom > 0 && (p.latest.ytdAfterTax401k ?? 0) > 0 ? ` · ${money(p.mega.afterTaxHeadroom)} after-tax room` : ""}`}
                      />
                      <StatRow label="Take-home" value={money(pr.projectedNet)} />
                    </Section>
                    <Section title={p.sliderOn ? `Outcome at ${pct(whatIf!)} 401(k)` : "Outcome"} subtitle="as a single filer">
                      <StatRow label="Taxable income" value={money(p.adjusted.taxableWage)} />
                      <StatRow label="Tax" value={money(p.adjusted.taxOwed)} />
                      <StatRow label="Withheld" value={money(p.adjusted.fedWh)} />
                      <View style={fs.divider} />
                      <StatRow label={p.adjusted.gap >= 0 ? "Refund" : "Owed at filing"} value={money(Math.abs(p.adjusted.gap))} tone={p.adjusted.gap >= 0 ? "good" : "bad"} />
                      {p.sliderOn && <Text style={fs.muted}>{fmtCurrency(p.adjusted.taxOwed - p.current.taxOwed, { cents: false, sign: true })} tax vs the current rate</Text>}
                    </Section>
                  </View>
                );
              })}

              {/* Household return */}
              {combined && harbor && view.householdGap != null && (
                <>
                  <Section title="Household return" subtitle={FILING_STATUS_LABELS[settings.filingStatus]}>
                    <View style={fs.chipRow}>
                      {(["MFJ", "SINGLE"] as FilingStatus[]).map((f) => (
                        <Chip key={f} label={f === "MFJ" ? "Jointly" : "Separately (single)"} on={settings.filingStatus === f} onPress={() => update({ filingStatus: f })} />
                      ))}
                    </View>
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
                    <View style={fs.divider} />
                    <StatRow label={view.householdGap >= 0 ? "Refund" : "Owed at filing"} value={money(Math.abs(view.householdGap))} tone={view.householdGap >= 0 ? "good" : "bad"} />
                    {settings.filingStatus === "MFJ" && view.people.length < 2 && (
                      <Text style={fs.muted}>
                        Only {nameOf(view.people[0].personId)} has paychecks for {year}; the joint return counts no other wages.
                      </Text>
                    )}
                  </Section>

                  <Section title="Underpayment penalty" subtitle="safe harbor">
                    <View style={{ borderRadius: 10, padding: 10, backgroundColor: harbor.safe ? "#eaf4ee" : "#fdf6e7", gap: 4 }}>
                      <Text style={{ fontWeight: "600", color: harbor.safe ? GOOD : WARN }}>{harbor.safe ? "On track, no penalty" : "Paid in is short"}</Text>
                      <Text style={fs.text}>
                        {harbor.safe
                          ? `${money(harbor.paid)} paid in clears ${money(harbor.floor)} (${harbor.binding}). You can owe up to ${money(harbor.cushion)} at filing without a penalty; you're ${harbor.balanceDue > 0 ? `at ${money(harbor.balanceDue)}` : "getting a refund"}.`
                          : `Pay about ${money(harbor.shortfall)} more to clear ${money(harbor.floor)} (${harbor.binding}).${view.nextDue ? ` As an estimated payment, by ${longDate(view.nextDue)};` : ""} extra withholding on a December paycheck or vest counts as paid evenly through the year, so it also covers earlier quarters.`}
                      </Text>
                    </View>
                    <StatRow label="Required" value={money(harbor.floor)} hint={harbor.binding} />
                    <StatRow label="Paid in" value={money(harbor.paid)} tone={harbor.safe ? "good" : "warn"} />
                    <StatRow label="90% of this year" value={money(harbor.t90)} />
                    {harbor.priorTest != null && <StatRow label={`${Math.round(harbor.priorMultiplier * 100)}% of last year`} value={money(harbor.priorTest)} />}
                    {view.nextDue && <StatRow label="Next estimated-tax due date" value={longDate(view.nextDue)} />}
                    <View style={{ gap: 8, marginTop: 6 }}>
                      <AmountSetting label="Last year's total tax" value={settings.priorYearTax} onChange={(v) => update({ priorYearTax: v })} />
                      <AmountSetting label="Last year's AGI" value={settings.priorYearAgi} onChange={(v) => update({ priorYearAgi: v })} />
                      <AmountSetting label={`Estimated paid for ${year}`} value={settings.estimatedPaid} onChange={(v) => update({ estimatedPaid: v })} />
                    </View>
                    <Text style={fs.muted}>
                      Last year&apos;s return: the total tax line (not what you paid at filing) and AGI. Over $150k AGI the prior-year test is 110%. Blank = only the 90% test. Owing under $1,000 is
                      never penalized. Estimated payments count from the day paid; this checks the year as a whole.
                    </Text>
                  </Section>
                </>
              )}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
