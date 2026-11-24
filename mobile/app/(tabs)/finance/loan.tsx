// One loan — the phone's /finance/loans/[id]: what's owed against the
// original schedule, the payment, the payoff date at this payment (ahead /
// behind), interest left and paid; a payoff what-if (extra each month, a
// lump sum, a paid-off-by date) with the balance at each year's end on the
// original schedule, at this payment and with the what-if; what secures it
// (equity, LTV); its terms and the scheduled transaction that pays it;
// recorded payments by year against the plan (tap one to fix or delete it);
// and the remaining schedule. Opened with openFinance("loan", { id }).
//
// Header: ✎ edits the terms / asset / paying schedule or removes the loan
// (save_finance_loan), + records a payment (record_loan_payment); sheets in
// components/finance/loan-detail-forms.tsx. Rows are read through the
// mobile data client like the web; math is lib/finance/loans.ts and
// lib/finance/loan-detail.ts.
//
// Left out on the phone: the web's "Import lender schedule" (PDF upload and
// parse, import_loan_payments). Do that on the web.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../lib/amplify";
import { ACCENT, BudgetBar, Card, Chip, FinanceHeader, GOOD, HeaderButton, Money, WARN, ago, fs, openFinance } from "../../../components/finance/ui";
import { DateField, Input } from "../../../components/finance/form";
import { LoanPaymentSheet, LoanTermsSheet } from "../../../components/finance/loan-detail-forms";
import { fmtCurrency, fmtDate, round2, todayIso } from "../../../../lib/finance/dates";
import { listAccounts, listAssets, listLoanPayments, listLoans, listSchedules } from "../../../../lib/finance/data";
import { LOAN_TYPE_LABELS, fmtDuration, loanOutlook, type LoanType } from "../../../../lib/finance/loans";
import { loanTermsOf, longDate, monthYear, owedOnAccount, payoffSeries, payoffWhatIf, paymentsByYear, planByPayment, ratePct, yearEndBalances } from "../../../../lib/finance/loan-detail";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Loaded = { loans: any[]; payments: any[]; assets: any[]; schedules: any[]; accounts: any[] };

const QUICK_EXTRA = [100, 250, 500, 1000];

export default function FinanceLoan() {
  const { id = "" } = useLocalSearchParams<{ id?: string }>();
  const today = todayIso();
  const [d, setD] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [paymentSheet, setPaymentSheet] = useState<any | null | undefined>(undefined);
  const [sim, setSim] = useState({ extra: "", lump: "", by: "" });
  const [showSchedule, setShowSchedule] = useState(false);
  const [openYears, setOpenYears] = useState<Set<string>>(() => new Set([today.slice(0, 4)]));

  const load = useCallback(async () => {
    if (!id) return;
    const c = getClient();
    try {
      const [loans, payments, assets, schedules, accounts] = await Promise.all([listLoans(c), listLoanPayments(c, id), listAssets(c), listSchedules(c), listAccounts(c)]);
      setD({ loans, payments, assets, schedules, accounts });
      setError(null);
    } catch (e: any) {
      setError(e?.errors?.[0]?.message ?? e?.message ?? String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const loan = d?.loans.find((l) => l.id === id) ?? null;
  const account = loan ? (d?.accounts.find((a) => a.id === loan.accountId) ?? null) : null;
  const synced = !!account?.simplefinAccountId;
  const owed = owedOnAccount(account);
  const payments = d?.payments ?? [];
  const asset = loan?.assetId ? d?.assets.find((a) => a.id === loan.assetId) : null;
  const schedule = loan?.recurringId ? d?.schedules.find((s) => s.id === loan.recurringId) : null;
  const terms = useMemo(() => (loan ? loanTermsOf(loan) : null), [loan]);
  const o = useMemo(() => (terms ? loanOutlook(terms, owed, payments, today) : null), [terms, owed, payments, today]);
  const plan = useMemo(() => (terms ? planByPayment(terms, payments) : null), [terms, payments]);
  const years = useMemo(() => paymentsByYear(payments), [payments]);
  const whatIf = useMemo(() => (terms && o ? payoffWhatIf(terms, o, sim) : null), [terms, o, sim]);
  const yearly = useMemo(() => (terms && o && whatIf ? yearEndBalances(payoffSeries(terms, o, whatIf.scenario, whatIf.lump, today)) : []), [terms, o, whatIf, today]);

  const title = account?.name ?? "Loan";
  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader
        title={title}
        right={
          loan ? (
            <View style={{ flexDirection: "row" }}>
              <HeaderButton icon="create-outline" onPress={() => setEditing(true)} />
              <HeaderButton icon="add" onPress={() => setPaymentSheet(null)} />
            </View>
          ) : undefined
        }
      />
      {!d ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : !loan || !o || !terms || !plan || !whatIf ? (
        <Text style={fs.empty}>Loan not found.</Text>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} keyboardShouldPersistTaps="handled">
          <Text style={[fs.muted, { paddingHorizontal: 4 }]}>
            {LOAN_TYPE_LABELS[(loan.loanType ?? "OTHER") as LoanType]}
            {loan.lender ? ` · ${loan.lender}` : ""} · {synced ? `balance synced ${ago(account?.balanceUpdatedAt)}` : "manual balance"}
          </Text>

          {/* Where it stands */}
          <Card>
            <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 14 }}>
              <Stat label="Owed">
                <Money value={o.owed} cents={false} style={fs.big} />
                <BudgetBar spent={o.paidOffPct * 100} budgeted={100} income />
                <Text style={fs.muted}>
                  {Math.round(o.paidOffPct * 100)}% of {fmtCurrency(o.original, { cents: false })} paid
                </Text>
              </Stat>
              <Stat label="Payment">
                <Money value={o.payment + o.escrow} style={fs.big} />
                <Text style={fs.muted}>
                  {fmtCurrency(o.payment)} P&amp;I{o.escrow ? ` + ${fmtCurrency(o.escrow)} escrow` : ""} · {ratePct(loan.interestRate)}
                </Text>
                <Text style={fs.muted}>Next {longDate(o.nextPaymentDate)}</Text>
              </Stat>
              <Stat label="Paid off">
                <Text style={fs.big}>{o.projected.payoffDate ? monthYear(o.projected.payoffDate) : "—"}</Text>
                <Text style={fs.muted}>{fmtDuration(o.projected.months)} at this payment</Text>
                {!Number.isFinite(o.monthsAhead) ? (
                  <Text style={[fs.muted, fs.danger]}>The payment doesn&apos;t cover the interest</Text>
                ) : o.monthsAhead === 0 ? (
                  <Text style={fs.muted}>On the original schedule ({monthYear(o.contractEnd)})</Text>
                ) : (
                  <Text style={[fs.muted, { color: o.monthsAhead > 0 ? GOOD : WARN, fontWeight: "600" }]}>
                    {o.monthsAhead > 0 ? `${fmtDuration(o.monthsAhead)} ahead` : `${fmtDuration(-o.monthsAhead)} behind`} of {monthYear(o.contractEnd)}
                  </Text>
                )}
              </Stat>
              <Stat label="Interest">
                <Money value={o.interestLeft} cents={false} style={fs.big} />
                <Text style={fs.muted}>still to pay at this rate</Text>
                <Text style={fs.muted}>
                  {fmtCurrency(o.interestPaid, { cents: false })} paid in {payments.length} recorded payment{payments.length === 1 ? "" : "s"}
                </Text>
              </Stat>
            </View>
          </Card>

          {/* The what-if */}
          <Card title="Pay it off faster?">
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={fs.label}>Extra / month</Text>
                <Input value={sim.extra} onChangeText={(v) => setSim({ ...sim, extra: v.replace(/[^0-9.]/g, "") })} keyboardType="decimal-pad" placeholder="$0" />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={fs.label}>Lump sum</Text>
                <Input value={sim.lump} onChangeText={(v) => setSim({ ...sim, lump: v.replace(/[^0-9.]/g, "") })} keyboardType="decimal-pad" placeholder="$0" />
              </View>
            </View>
            <View style={{ gap: 4 }}>
              <Text style={fs.label}>Paid off by</Text>
              <DateField value={sim.by} onChange={(v) => setSim({ ...sim, by: v })} placeholder="Pick a target date" clearable />
            </View>
            <View style={fs.chipRow}>
              {QUICK_EXTRA.map((x) => (
                <Chip key={x} label={`+${fmtCurrency(x, { cents: false })}/mo`} on={whatIf.extra === x} onPress={() => setSim({ ...sim, extra: whatIf.extra === x ? "" : String(x) })} />
              ))}
              {(sim.extra || sim.lump || sim.by) && <Chip label="Clear" onPress={() => setSim({ extra: "", lump: "", by: "" })} />}
            </View>
            {whatIf.scenario && (
              <View style={{ backgroundColor: "#eef6f1", borderRadius: 8, padding: 10 }}>
                <Text style={fs.text}>
                  {whatIf.scenario.stalls ? (
                    "That still doesn't cover the interest."
                  ) : (
                    <>
                      Paid off <Text style={{ fontWeight: "700" }}>{monthYear(whatIf.scenario.payoffDate)}</Text> ({fmtDuration(whatIf.scenario.months)}),{" "}
                      <Text style={{ fontWeight: "700" }}>{fmtDuration(Math.max(0, o.projected.months - whatIf.scenario.months))}</Text> sooner, saving{" "}
                      <Text style={{ fontWeight: "700" }}>{fmtCurrency(o.projected.totalInterest - whatIf.scenario.totalInterest, { cents: false })}</Text> in interest.
                    </>
                  )}
                </Text>
              </View>
            )}
            {whatIf.targetTooEarly && <Text style={[fs.muted, fs.warn]}>The next payment is {longDate(o.nextPaymentDate)}; pick a later date.</Text>}
            {whatIf.byTarget && (
              <View style={{ backgroundColor: "#f3f1ef", borderRadius: 8, padding: 10 }}>
                <Text style={fs.text}>
                  To be done by <Text style={{ fontWeight: "700" }}>{longDate(sim.by)}</Text> ({whatIf.byTarget.n} payments{whatIf.lump ? ", after the lump sum" : ""}):{" "}
                  <Text style={{ fontWeight: "700" }}>{fmtCurrency(whatIf.byTarget.payment)}</Text> a month P&amp;I
                  {whatIf.byTarget.extra > 0 ? `, ${fmtCurrency(whatIf.byTarget.extra)} more than now.` : ": the current payment already gets there."}
                </Text>
              </View>
            )}
            <YearEndTable rows={yearly} withScenario={!!whatIf.scenario} />
          </Card>

          {asset && (
            <Card title={`Secured by ${asset.name}`}>
              <Row label="Value">
                <Money value={asset.currentValue} cents={false} />
              </Row>
              <Row label="Owed">
                <Money value={-o.owed} cents={false} />
              </Row>
              <Row label="Equity">
                <Money value={(asset.currentValue ?? 0) - o.owed} cents={false} style={{ fontWeight: "700" }} />
              </Row>
              {asset.currentValue > 0 && (
                <>
                  <BudgetBar spent={o.owed} budgeted={asset.currentValue} />
                  <Text style={[fs.muted, o.owed / asset.currentValue > 0.8 && fs.warn]}>
                    {Math.round((o.owed / asset.currentValue) * 100)}% loan-to-value · valued {longDate(asset.valuedOn)}
                  </Text>
                </>
              )}
            </Card>
          )}

          <Card title="Terms" link="Account" onLink={() => openFinance("account", { id: loan.accountId })}>
            <Row label="Borrowed">
              <Text style={fs.text}>
                {fmtCurrency(loan.originalPrincipal, { cents: false })}
                {loan.startDate ? <Text style={fs.muted}> · {monthYear(loan.startDate)}</Text> : null}
              </Text>
            </Row>
            <Row label="Rate">
              <Text style={fs.text}>{ratePct(loan.interestRate)}</Text>
            </Row>
            <Row label="Term">
              <Text style={fs.text}>
                {loan.termMonths} months ({round2(loan.termMonths / 12)} years)
              </Text>
            </Row>
            <Row label="Payments">
              <Text style={fs.text}>
                {longDate(loan.firstPaymentDate)} → {longDate(o.contractEnd)}
              </Text>
            </Row>
            <Row label="Made so far">
              <Text style={fs.text}>
                {o.paymentsMade} of {loan.termMonths}
              </Text>
            </Row>
            <Row label="Schedule says">
              <Text style={fs.text}>{fmtCurrency(o.contractBalance, { cents: false })} owed now</Text>
            </Row>
            {o.recentAverage != null && (
              <Row label="Recently paying">
                <Text style={fs.text}>{fmtCurrency(o.recentAverage)} /mo</Text>
              </Row>
            )}
            {loan.interestAccrual === "DAILY" && (
              <Row label="Interest">
                <Text style={fs.text}>daily simple interest</Text>
              </Row>
            )}
            <Row label="Paid by">
              {schedule ? (
                <Pressable onPress={() => openFinance("scheduled")} style={({ pressed }) => pressed && fs.pressed}>
                  <Text style={[fs.text, { color: ACCENT, textAlign: "right" }]}>
                    {schedule.description}
                    <Text style={fs.muted}> · next {fmtDate(schedule.nextDate)}</Text>
                  </Text>
                </Pressable>
              ) : (
                <Pressable onPress={() => setEditing(true)} style={({ pressed }) => pressed && fs.pressed}>
                  <Text style={[fs.muted, { textDecorationLine: "underline" }]}>no scheduled transaction</Text>
                </Pressable>
              )}
            </Row>
            {loan.notes ? <Text style={fs.muted}>{loan.notes}</Text> : null}
          </Card>

          {/* Payments */}
          <Card title="Payments" link="Record" onLink={() => setPaymentSheet(null)}>
            {payments.length > 0 && Math.abs(plan.ahead) >= 1 && (
              <Text style={[fs.muted, { color: plan.ahead > 0 ? GOOD : WARN, fontWeight: "600" }]}>
                {fmtCurrency(Math.abs(plan.ahead), { cents: false })} of principal {plan.ahead > 0 ? "ahead of" : "behind"} the contract
              </Text>
            )}
            {years.length === 0 && (
              <Text style={fs.muted}>
                No payments recorded yet.{synced ? " The balance still follows the bank; recording them adds the interest history." : " Each one you record lowers the balance by its principal."} The web can import the lender&apos;s schedule to load them all at once.
              </Text>
            )}
            {years.map((g) => {
              const open = openYears.has(g.year);
              return (
                <View key={g.year} style={{ gap: 6 }}>
                  <Pressable
                    onPress={() =>
                      setOpenYears((s) => {
                        const n = new Set(s);
                        if (n.has(g.year)) n.delete(g.year);
                        else n.add(g.year);
                        return n;
                      })
                    }
                    style={({ pressed }) => [{ gap: 2, paddingVertical: 4 }, pressed && fs.pressed]}
                  >
                    <View style={fs.rowBetween}>
                      <Text style={[fs.text, { fontWeight: "600" }]}>
                        <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={13} color="#999" /> {g.year}
                        <Text style={fs.muted}>
                          {" "}
                          · {g.rows.length} payment{g.rows.length === 1 ? "" : "s"}
                        </Text>
                      </Text>
                      <Money value={g.total} cents={false} />
                    </View>
                    <Text style={fs.muted}>
                      Principal {fmtCurrency(g.principal, { cents: false })} · Interest {fmtCurrency(g.interest, { cents: false })}
                      {g.escrow > 0 ? ` · Escrow ${fmtCurrency(g.escrow, { cents: false })}` : ""}
                    </Text>
                  </Pressable>
                  {open &&
                    g.rows.map((p: any) => {
                      const vs = plan.byId.get(p.id);
                      const shown = vs && Math.abs(vs.delta) >= 0.5;
                      return (
                        <Pressable key={p.id} onPress={() => setPaymentSheet(p)} style={({ pressed }) => [{ gap: 2, paddingLeft: 16, paddingVertical: 4, borderTopWidth: 1, borderTopColor: "#f3f3f3" }, pressed && fs.pressed]}>
                          <View style={fs.rowBetween}>
                            <Text style={fs.text}>
                              {(p.paymentNumber ?? vs?.n) ? <Text style={fs.muted}>#{p.paymentNumber ?? vs?.n} </Text> : null}
                              {fmtDate(p.date)}
                              {p.isExtra ? <Text style={[fs.muted, fs.good]}> · extra</Text> : null}
                              {p.estimated ? <Text style={[fs.muted, fs.warn]}> · estimated</Text> : null}
                            </Text>
                            <Money value={p.totalAmount} />
                          </View>
                          <Text style={fs.muted}>
                            P {fmtCurrency(p.principal)} · I {fmtCurrency(p.interest)}
                            {p.escrow ? ` · E ${fmtCurrency(p.escrow)}` : ""}
                            {shown ? (
                              <Text style={{ color: vs!.delta > 0 ? GOOD : WARN }}>
                                {" "}
                                · {vs!.delta > 0 ? "+" : "−"}
                                {fmtCurrency(Math.abs(vs!.delta), { cents: false })} vs plan
                              </Text>
                            ) : null}
                          </Text>
                        </Pressable>
                      );
                    })}
                </View>
              );
            })}
          </Card>

          {/* Remaining schedule */}
          <Card title="Remaining schedule" link={showSchedule ? "Hide" : `Show ${o.projected.rows.length} payments`} onLink={() => setShowSchedule(!showSchedule)}>
            {showSchedule && (
              <View>
                <View style={[fs.rowBetween, { paddingBottom: 4 }]}>
                  <Text style={[fs.label, { width: 34 }]}>#</Text>
                  <Text style={[fs.label, { flex: 1 }]}>Date</Text>
                  <Text style={[fs.label, { width: 78, textAlign: "right" }]}>Principal</Text>
                  <Text style={[fs.label, { width: 70, textAlign: "right" }]}>Interest</Text>
                  <Text style={[fs.label, { width: 84, textAlign: "right" }]}>Balance</Text>
                </View>
                {o.projected.rows.map((r) => (
                  <View key={r.n} style={[fs.rowBetween, { paddingVertical: 2 }, r.date.slice(5, 7) === "12" && { borderBottomWidth: 1, borderBottomColor: "#e5e5e5", paddingBottom: 4 }]}>
                    <Text style={[fs.muted, { width: 34 }]}>{o.paymentsMade + r.n}</Text>
                    <Text style={[fs.money, { flex: 1, fontSize: 12 }]}>{monthYear(r.date)}</Text>
                    <Text style={[fs.money, { width: 78, textAlign: "right", fontSize: 12 }]}>{fmtCurrency(r.principal)}</Text>
                    <Text style={[fs.money, { width: 70, textAlign: "right", fontSize: 12 }]}>{fmtCurrency(r.interest)}</Text>
                    <Text style={[fs.money, { width: 84, textAlign: "right", fontSize: 12 }]}>{fmtCurrency(r.balance, { cents: false })}</Text>
                  </View>
                ))}
              </View>
            )}
          </Card>
        </ScrollView>
      )}

      {loan && d && (
        <LoanTermsSheet
          visible={editing}
          loan={loan}
          account={account}
          accounts={d.accounts}
          assets={d.assets}
          schedules={d.schedules}
          onClose={() => setEditing(false)}
          onSaved={(removed) => {
            setEditing(false);
            if (removed) router.back();
            else void load();
          }}
        />
      )}
      {loan && (
        <LoanPaymentSheet
          payment={paymentSheet}
          loan={loan}
          owed={owed}
          synced={synced}
          payments={payments}
          onClose={() => setPaymentSheet(undefined)}
          onSaved={() => {
            setPaymentSheet(undefined);
            void load();
          }}
        />
      )}
    </SafeAreaView>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ width: "50%", paddingRight: 8, gap: 3 }}>
      <Text style={fs.label}>{label}</Text>
      {children}
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={[fs.rowBetween, { alignItems: "flex-start" }]}>
      <Text style={fs.muted}>{label}</Text>
      <View style={{ flexShrink: 1, alignItems: "flex-end" }}>{children}</View>
    </View>
  );
}

/** Balance at each year's end: original schedule, this payment, and the what-if. The phone's stand-in for the web's chart. */
function YearEndTable({ rows, withScenario }: { rows: Array<{ year: string; contract: number | null; pace: number | null; scenario: number | null }>; withScenario: boolean }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  // Stop once every shown line is at zero.
  const done = rows.findIndex((r) => (r.contract ?? 0) <= 0 && (r.pace ?? 0) <= 0 && (!withScenario || (r.scenario ?? 0) <= 0));
  const live = done >= 0 ? rows.slice(0, done + 1) : rows;
  const shown = all ? live : live.slice(0, 12);
  const cell = (v: number | null) => (v == null ? "—" : fmtCurrency(v, { cents: false }));
  return (
    <View style={{ marginTop: 4 }}>
      <Text style={[fs.muted, { paddingBottom: 4 }]}>Balance at each year&apos;s end</Text>
      <View style={[fs.rowBetween, { paddingBottom: 4 }]}>
        <Text style={[fs.label, { width: 44 }]}>Year</Text>
        <Text style={[fs.label, { flex: 1, textAlign: "right" }]}>Original</Text>
        <Text style={[fs.label, { flex: 1, textAlign: "right" }]}>Now</Text>
        {withScenario && <Text style={[fs.label, { flex: 1, textAlign: "right", color: GOOD }]}>What-if</Text>}
      </View>
      {shown.map((r) => (
        <View key={r.year} style={[fs.rowBetween, { paddingVertical: 2 }]}>
          <Text style={[fs.muted, { width: 44 }]}>{r.year}</Text>
          <Text style={[fs.money, { flex: 1, textAlign: "right", fontSize: 12, color: "#999" }]}>{cell(r.contract)}</Text>
          <Text style={[fs.money, { flex: 1, textAlign: "right", fontSize: 12 }]}>{cell(r.pace)}</Text>
          {withScenario && <Text style={[fs.money, { flex: 1, textAlign: "right", fontSize: 12, color: GOOD }]}>{cell(r.scenario)}</Text>}
        </View>
      ))}
      {live.length > 12 && (
        <Pressable onPress={() => setAll(!all)} style={({ pressed }) => [{ alignSelf: "flex-end", paddingTop: 4 }, pressed && fs.pressed]}>
          <Text style={fs.link}>{all ? "Fewer years" : `All ${live.length} years`}</Text>
        </Pressable>
      )}
    </View>
  );
}
