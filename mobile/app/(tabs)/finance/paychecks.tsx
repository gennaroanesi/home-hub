// Paychecks — both of our paystubs, like the web's Finance → Paychecks: the
// review inbox of stubs emailed to paychecks@import.cristinegennaro.com
// (Review opens the prefilled form, saving imports it; Dismiss drops it),
// "contributions vs pay" (of what each of us took home, how much went into
// the household, lib/finance/paychecks.ts contributionShare), YTD per person
// from the latest stub, and the year's stubs. + adds one by hand; tap a stub
// to edit or delete it. PDFs open through a signed link
// (components/finance/paycheck-screen-pdf.ts).
//
// Reads homePaycheck / homePaycheckInbox through the model client (there
// are no paycheck ops), like the web. No PDF upload on the phone (the web's
// parsePaycheckPdf picker): forward the stub to the paychecks@ inbox instead
// and it shows up here to review.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../lib/amplify";
import { usePeople } from "../../../lib/use-people";
import { ACCENT, Card, Chip, DANGER, FinanceHeader, HeaderButton, Money, WARN, ago, fs, useFinanceAccounts } from "../../../components/finance/ui";
import { PaycheckFormSheet, type PaycheckFormInit } from "../../../components/finance/paycheck-screen-form";
import { openFinancePdf } from "../../../components/finance/paycheck-screen-pdf";
import { listAllPages } from "../../../../lib/list-all";
import { isOutsideCashFlow } from "../../../../lib/finance/accounts";
import { listPaychecks, listTransactions } from "../../../../lib/finance/data";
import { financePeople } from "../../../../lib/finance/ledger";
import { fmtCurrency, fmtDate, todayIso } from "../../../../lib/finance/dates";
import { PERIOD_KINDS, periodContaining, periodRange, shiftPeriod, switchKind, type Period } from "../../../../lib/finance/periods";
import { contributionShare, latestByPerson, payTotals } from "../../../../lib/finance/paychecks";
import { inboxDraftValues, inboxToReview, parseJsonLayers, sharePct, supplementalOf } from "../../../../lib/finance/paycheck-screen";
import { paycheckYears } from "../../../../lib/finance/tax-screen";

/* eslint-disable @typescript-eslint/no-explicit-any */

const errText = (e: any) => e?.errors?.[0]?.message ?? e?.message ?? String(e);

function showMenu(title: string, actions: Array<{ label: string; run: () => void; destructive?: boolean }>) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...actions.map((a) => a.label), "Cancel"], cancelButtonIndex: actions.length, destructiveButtonIndex: actions.findIndex((a) => a.destructive) },
      (i) => actions[i]?.run(),
    );
  } else {
    Alert.alert(title, undefined, [...actions.map((a) => ({ text: a.label, onPress: a.run, style: a.destructive ? ("destructive" as const) : undefined })), { text: "Cancel", style: "cancel" as const }]);
  }
}

export default function FinancePaychecks() {
  const { people: household } = usePeople();
  const accounts = useFinanceAccounts();
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));

  const [paychecks, setPaychecks] = useState<any[] | null>(null);
  const [inbox, setInbox] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [year, setYear] = useState(thisYear);
  const [personFilter, setPersonFilter] = useState("");
  const [form, setForm] = useState<PaycheckFormInit | null>(null);

  const load = useCallback(async () => {
    try {
      const client = getClient();
      const [p, ib] = await Promise.all([listPaychecks(client), listAllPages<any>(client.models.homePaycheckInbox)]);
      setPaychecks(p);
      setInbox(inboxToReview(ib));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Finance people, plus anyone a saved paycheck or account already points at.
  const people = useMemo(
    () =>
      financePeople(household, [...accounts.flatMap((a) => a.ownerPersonIds), ...(paychecks ?? []).map((p) => p.personId)]).map((p) => ({ id: p.id, name: p.name ?? "?" })),
    [household, accounts, paychecks],
  );
  const nameOf = (id: string | null | undefined) => people.find((p) => p.id === id)?.name ?? household.find((p) => p.id === id)?.name ?? "?";

  const years = useMemo(() => paycheckYears(paychecks ?? [], thisYear), [paychecks, thisYear]);
  const yearRows = useMemo(
    () => (paychecks ?? []).filter((p) => Number(String(p.payDate).slice(0, 4)) === year && (!personFilter || p.personId === personFilter)),
    [paychecks, year, personFilter],
  );
  const totals = useMemo(() => payTotals(yearRows), [yearRows]);
  const latest = useMemo(() => latestByPerson(paychecks ?? [], year), [paychecks, year]);

  // ── Contributions vs pay ──────────────────────────────────────────────────
  const [period, setPeriod] = useState<Period>(() => periodContaining("year", today));
  const range = useMemo(() => periodRange(period, today), [period, today]);
  const [txs, setTxs] = useState<any[] | null>(null);
  const cashIds = useMemo(() => accounts.filter((a) => !isOutsideCashFlow(a.type)).map((a) => a.id), [accounts]);
  useEffect(() => {
    if (!cashIds.length) return;
    let live = true;
    setTxs(null);
    listTransactions(getClient(), { fromIso: range.fromIso, toIso: range.toIso, accountIds: cashIds })
      .then((t) => live && setTxs(t))
      .catch(() => live && setTxs([]));
    return () => {
      live = false;
    };
  }, [cashIds, range.fromIso, range.toIso]);
  const shares = useMemo(
    () => (txs ? contributionShare(paychecks ?? [], txs, accounts, range, people.map((p) => p.id)) : []),
    [paychecks, txs, accounts, range, people],
  );
  const maxNet = Math.max(1, ...shares.map((s) => Math.max(s.net, s.contributed)));

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  function review(row: any) {
    setForm({ source: "EMAIL", s3KeyPdf: row.s3KeyPdf ?? null, inboxId: row.id, personId: row.personId ?? null, values: inboxDraftValues(row), warning: row.parseError ?? null });
  }

  function dismiss(row: any) {
    Alert.alert(`Dismiss “${row.emailSubject ?? row.filename ?? "this email"}”?`, "It won't be imported.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Dismiss",
        style: "destructive",
        onPress: async () => {
          const r = await getClient().models.homePaycheckInbox.update({ id: row.id, status: "DISMISSED" } as any);
          if (r.errors?.length) Alert.alert("Couldn't dismiss", r.errors[0].message);
          else void load();
        },
      },
    ]);
  }

  const edit = (p: any) => setForm({ id: p.id, source: p.source ?? "MANUAL", s3KeyPdf: p.s3KeyPdf, personId: p.personId, values: p });

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Paychecks" right={paychecks ? <HeaderButton icon="add" onPress={() => setForm({ source: "MANUAL", personId: personFilter || null })} /> : undefined} />
      {!paychecks ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          {/* Inbox */}
          {inbox.length > 0 && (
            <Card title={`${inbox.length} emailed stub${inbox.length === 1 ? "" : "s"} to review`} style={{ borderWidth: 1, borderColor: "#f0d9a8" }}>
              {inbox.map((row, i) => {
                const draft: any = parseJsonLayers(row.draft) ?? {};
                const actions = [
                  { label: "Review", run: () => review(row) },
                  ...(row.s3KeyPdf ? [{ label: "Open PDF", run: () => void openFinancePdf(row.s3KeyPdf) }] : []),
                  { label: "Dismiss", run: () => dismiss(row), destructive: true },
                ];
                return (
                  <Pressable
                    key={row.id}
                    onPress={() => review(row)}
                    style={({ pressed }) => [{ gap: 2, paddingTop: i ? 10 : 0 }, i > 0 && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}
                  >
                    <View style={fs.rowBetween}>
                      <Text style={fs.textFlex} numberOfLines={1}>
                        <Text style={!row.personId ? { color: WARN } : { fontWeight: "600" }}>{row.personId ? nameOf(row.personId) : "person?"}</Text>
                        {" · "}
                        {draft.payDate ? fmtDate(draft.payDate, { month: "short", day: "numeric", year: "numeric" }) : "—"}
                        {typeof draft.net === "number" ? <Text style={fs.muted}> · net {fmtCurrency(draft.net)}</Text> : null}
                      </Text>
                      <Pressable onPress={() => showMenu(row.emailSubject ?? "Emailed stub", actions)} hitSlop={12} accessibilityLabel="Stub actions">
                        <Ionicons name="ellipsis-horizontal" size={18} color="#999" />
                      </Pressable>
                    </View>
                    {row.status === "ERROR" && <Text style={[fs.muted, { color: DANGER }]}>Couldn&apos;t read it</Text>}
                    <Text style={fs.muted} numberOfLines={1}>
                      {row.emailFrom ?? "?"} · {row.emailSubject ?? "(no subject)"} · {ago(row.receivedAt)}
                    </Text>
                    {row.parseError ? <Text style={[fs.muted, { color: WARN }]}>{row.parseError}</Text> : null}
                  </Pressable>
                );
              })}
            </Card>
          )}

          {/* Contributions vs pay */}
          <Card title="Contributions vs pay">
            <View style={fs.chipRow}>
              {PERIOD_KINDS.map((k) => (
                <Chip key={k.kind} label={k.label} on={period.kind === k.kind} onPress={() => period.kind !== k.kind && setPeriod(switchKind(period, k.kind, today))} />
              ))}
            </View>
            {period.kind !== "last3" && (
              <View style={fs.rowBetween}>
                <Pressable onPress={() => setPeriod(shiftPeriod(period, -1))} hitSlop={10}>
                  <Ionicons name="chevron-back" size={22} color={ACCENT} />
                </Pressable>
                <Pressable onPress={() => setPeriod(periodContaining(period.kind, today))}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: "#333" }}>{range.label}</Text>
                </Pressable>
                <Pressable onPress={() => setPeriod(shiftPeriod(period, 1))} hitSlop={10}>
                  <Ionicons name="chevron-forward" size={22} color={ACCENT} />
                </Pressable>
              </View>
            )}
            {!txs ? (
              cashIds.length ? <ActivityIndicator /> : null
            ) : (
              shares.map((s) => (
                <View key={s.personId} style={{ gap: 4 }}>
                  <View style={fs.rowBetween}>
                    <Text style={[fs.text, { fontWeight: "600" }]}>{nameOf(s.personId)}</Text>
                    <Text style={[fs.text, { fontWeight: "600" }]}>{sharePct(s.shareOfNet)} of take-home</Text>
                  </View>
                  <Text style={fs.muted}>
                    took home {fmtCurrency(s.net, { cents: false })} · put in {fmtCurrency(s.contributed, { cents: false })} · {sharePct(s.shareOfGross)} of gross
                  </Text>
                  <View style={fs.bar}>
                    <View style={[fs.barFill, { position: "absolute", left: 0, width: `${(s.net / maxNet) * 100}%`, backgroundColor: "#ddd" }]} />
                    <View style={[fs.barFill, { position: "absolute", left: 0, width: `${(Math.min(s.contributed, maxNet) / maxNet) * 100}%`, backgroundColor: ACCENT }]} />
                  </View>
                  {s.net === 0 && <Text style={fs.muted}>No paychecks recorded in {range.label}.</Text>}
                </View>
              ))
            )}
            <Text style={fs.muted}>
              &ldquo;Put in&rdquo; is what the household budget counts as each person&apos;s contribution: transfers from their own account into a household one, household spending paid from
              their own accounts, and money in categorized Contribution with their name on it.
            </Text>
          </Card>

          {/* Year + person */}
          <View style={fs.chipRow}>
            {years.map((y) => (
              <Chip key={y} label={String(y)} on={year === y} onPress={() => setYear(y)} />
            ))}
          </View>
          <View style={fs.chipRow}>
            <Chip label="Both of us" on={!personFilter} onPress={() => setPersonFilter("")} />
            {people.map((p) => (
              <Chip key={p.id} label={p.name} on={personFilter === p.id} onPress={() => setPersonFilter(p.id)} />
            ))}
          </View>

          {/* YTD per person, from the latest stub */}
          {people
            .filter((p) => !personFilter || p.id === personFilter)
            .map((p) => {
              const l = latest.get(p.id);
              return (
                <Card key={p.id}>
                  <View style={fs.rowBetween}>
                    <Text style={fs.cardTitle}>{p.name}</Text>
                    <Text style={fs.muted} numberOfLines={1}>
                      {l ? `YTD as of ${fmtDate(l.payDate, { month: "short", day: "numeric" })}${l.employer ? ` · ${l.employer}` : ""}` : `No stubs in ${year}`}
                    </Text>
                  </View>
                  {l && (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 8 }}>
                      {(
                        [
                          ["Gross", l.ytdGross],
                          ["Taxable", l.ytdTaxableWage],
                          ["Fed WH", l.ytdFedWh],
                          ["401k", (l.ytd401k ?? 0) + (l.ytdRoth401k ?? 0) + (l.ytdAfterTax401k ?? 0) || null],
                          ["Net", l.ytdNet],
                        ] as Array<[string, number | null]>
                      ).map(([label, v]) => (
                        <View key={label} style={{ width: "33%" }}>
                          <Text style={fs.label}>{label}</Text>
                          <Money value={v} cents={false} />
                        </View>
                      ))}
                    </View>
                  )}
                </Card>
              );
            })}

          {/* Stubs */}
          <Card title={`${yearRows.length} paycheck${yearRows.length === 1 ? "" : "s"} in ${year}`}>
            {yearRows.length > 0 && (
              <Text style={fs.muted}>
                gross {fmtCurrency(totals.gross, { cents: false })} · taxes {fmtCurrency(totals.taxes, { cents: false })} · 401k {fmtCurrency(totals.retirement, { cents: false })} · net{" "}
                {fmtCurrency(totals.net, { cents: false })}
              </Text>
            )}
            {yearRows.length === 0 && <Text style={fs.muted}>No paychecks in {year}. Tap + to add one, or forward the PDF to paychecks@import.cristinegennaro.com.</Text>}
            {yearRows.map((p) => {
              const t = payTotals([p]);
              const sup = supplementalOf(p);
              return (
                <Pressable key={p.id} onPress={() => edit(p)} style={({ pressed }) => [{ gap: 2, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}>
                  <View style={fs.rowBetween}>
                    <Text style={fs.textFlex} numberOfLines={1}>
                      <Text style={{ fontWeight: "600" }}>{fmtDate(p.payDate, { month: "short", day: "numeric" })}</Text> · {nameOf(p.personId)}
                      {sup ? <Text style={fs.muted}> · {sup.label} {fmtCurrency(sup.amount, { cents: false })}</Text> : null}
                    </Text>
                    <Money value={p.net} style={{ fontWeight: "600" }} />
                    {p.s3KeyPdf ? (
                      <Pressable onPress={() => void openFinancePdf(p.s3KeyPdf)} hitSlop={10} accessibilityLabel="Open PDF">
                        <Ionicons name="document-text-outline" size={18} color={ACCENT} />
                      </Pressable>
                    ) : null}
                  </View>
                  <Text style={fs.muted} numberOfLines={1}>
                    gross {fmtCurrency(p.gross)} · taxes {fmtCurrency(t.taxes)} · 401k {fmtCurrency(t.retirement)}
                    {p.employer ? ` · ${p.employer}` : ""}
                    {p.source && p.source !== "MANUAL" ? ` · ${String(p.source).toLowerCase()}` : ""}
                  </Text>
                </Pressable>
              );
            })}
          </Card>
        </ScrollView>
      )}
      <PaycheckFormSheet
        init={form}
        people={people}
        onClose={() => setForm(null)}
        onSaved={() => {
          setForm(null);
          void load();
        }}
      />
    </SafeAreaView>
  );
}
