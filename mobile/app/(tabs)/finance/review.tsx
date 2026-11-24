// Review — looking back at a month, quarter, year or the last 3 months, like
// the web's Finance → Review, for the household, one person's own money or
// everything: what came in vs what went out, spending by category against
// its budget line and the usual level, the last 12 months, the biggest
// transactions, which scheduled payments happened, and spend groups.
// Read-only; the numbers are lib/finance/review.ts (shared with the web).
// Tap a category to see its transactions.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../lib/amplify";
import { ACCENT, Card, Chip, DANGER, FinanceHeader, GOOD, Money, fs, openFinance } from "../../../components/finance/ui";
import { fmtCurrency, fmtDate, todayIso } from "../../../../lib/finance/dates";
import { containsToday, PERIOD_KINDS, periodContaining, periodNoun, periodRange, periodToParam, shiftPeriod, switchKind, type Period } from "../../../../lib/finance/periods";
import { isOutsideCashFlow } from "../../../../lib/finance/accounts";
import { effectiveCategory } from "../../../../lib/finance/categories";
import { listAccounts, listBudgetLines, listHouseholdPeople, listSchedules, listSpendGroups, listTransactions, type HouseholdPerson } from "../../../../lib/finance/data";
import { ALL_LEDGERS, HOUSEHOLD, financePeople, ledgerLabel, ledgerPeople } from "../../../../lib/finance/ledger";
import { sortSpendGroups } from "../../../../lib/finance/spend-groups";
import { REVIEW_TREND_MONTHS, REVIEW_USUAL_MONTHS, buildReview, defaultReviewPeriod, reviewWindow } from "../../../../lib/finance/review";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Same categorical palette as the web chart.
const PALETTE = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1", "#9c755f"];
const OTHER_COLOR = "#9ca3af";
const CHART_HEIGHT = 140;

type Refs = { accounts: any[]; people: HouseholdPerson[]; groups: any[] };
type Data = { txs: any[]; lines: any[]; schedules: any[] };

function errorText(e: any): string {
  return e?.errors?.[0]?.message ?? e?.message ?? String(e);
}

export default function FinanceReview() {
  const today = todayIso();
  const [period, setPeriod] = useState<Period>(() => defaultReviewPeriod(today));
  const [ledger, setLedger] = useState(HOUSEHOLD);
  const [refs, setRefs] = useState<Refs | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => periodRange(period, today), [period, today]);
  const { loadFrom } = reviewWindow(range);

  const loadRefs = useCallback(async () => {
    const db: any = getClient();
    const [accounts, household, groups] = await Promise.all([listAccounts(db), listHouseholdPeople(db), listSpendGroups(db)]);
    const r = { accounts, people: financePeople(household, accounts.flatMap((a) => a.ownerPersonIds ?? [])), groups: sortSpendGroups(groups) };
    setRefs(r);
    return r;
  }, []);

  const load = useCallback(
    async (r: Refs | null) => {
      const db: any = getClient();
      setLoading(true);
      try {
        const refsNow = r ?? (await loadRefs());
        const accountIds = refsNow.accounts.filter((a) => !isOutsideCashFlow(a.type)).map((a) => a.id);
        const [txs, lines, schedules] = await Promise.all([listTransactions(db, { fromIso: loadFrom, toIso: range.toIso, accountIds }), listBudgetLines(db), listSchedules(db)]);
        setData({ txs, lines, schedules });
        setError(null);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [loadFrom, range.toIso, loadRefs],
  );

  useEffect(() => {
    void load(refs);
    // Refs load once; a new period reloads the rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load(null);
    } finally {
      setRefreshing(false);
    }
  }

  const people = refs?.people ?? [];
  const owners = useMemo(() => ledgerPeople(people), [people]);
  const review = useMemo(
    () => (refs && data ? buildReview({ rawTxs: data.txs, accounts: refs.accounts, lines: data.lines, schedules: data.schedules, groups: refs.groups, ledger, range, today }) : null),
    [refs, data, ledger, range, today],
  );
  const accountName = useMemo(() => new Map((refs?.accounts ?? []).map((a) => [a.id, a.name as string])), [refs]);
  const noun = periodNoun(period);
  const next = shiftPeriod(period, 1);
  const nextIsFuture = periodRange(next, today).fromIso > today;
  const atCurrent = periodToParam(periodContaining(period.kind, today)) === periodToParam(period);
  const personName = (id: string) => (id ? (people.find((p) => p.id === id)?.name ?? "Someone") : "Household");

  function openCategory(category: string) {
    const month = period.kind === "month" ? range.fromIso.slice(0, 7) : containsToday(period, today) ? today.slice(0, 7) : range.fromIso.slice(0, 7);
    openFinance("transactions", { categories: category, month, title: category });
  }

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Review" />
      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 8 }}>
        {owners.length > 0 && (
          <View style={fs.chipRow}>
            {[HOUSEHOLD, ...owners.map((p) => p.id), ALL_LEDGERS].map((k) => (
              <Chip key={k} label={ledgerLabel(k, people)} on={ledger === k} onPress={() => setLedger(k)} />
            ))}
          </View>
        )}
        <View style={fs.chipRow}>
          {PERIOD_KINDS.map((k) => (
            <Chip key={k.kind} label={k.label} on={period.kind === k.kind} onPress={() => period.kind !== k.kind && setPeriod(switchKind(period, k.kind, today))} />
          ))}
        </View>
        <View style={[fs.rowBetween, { paddingHorizontal: 4 }]}>
          {period.kind !== "last3" ? (
            <Pressable onPress={() => setPeriod(shiftPeriod(period, -1))} hitSlop={10}>
              <Ionicons name="chevron-back" size={22} color={ACCENT} />
            </Pressable>
          ) : (
            <View style={{ width: 22 }} />
          )}
          <Pressable onPress={() => setPeriod(periodContaining(period.kind, today))} disabled={atCurrent}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: "#333", textAlign: "center" }}>
              {range.label}
              {containsToday(period, today) ? <Text style={fs.muted}> · in progress</Text> : null}
            </Text>
          </Pressable>
          {period.kind !== "last3" ? (
            <Pressable onPress={() => setPeriod(next)} disabled={nextIsFuture} hitSlop={10} style={nextIsFuture && { opacity: 0.25 }}>
              <Ionicons name="chevron-forward" size={22} color={ACCENT} />
            </Pressable>
          ) : (
            <View style={{ width: 22 }} />
          )}
        </View>
      </View>

      {!review ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          {loading && !refreshing && <ActivityIndicator style={{ marginTop: -4 }} />}
          {error && <Text style={[fs.muted, fs.danger]}>{error}</Text>}
          {review.periodTxs.length === 0 ? (
            <Text style={fs.empty}>Nothing recorded in {range.label}. Transactions show up here once an account syncs.</Text>
          ) : (
            <>
              {/* In vs out */}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
                <View style={[fs.card, s.stat]}>
                  <Text style={fs.muted}>{ledger === HOUSEHOLD ? "We put in" : ledger === ALL_LEDGERS ? "Came in, everyone" : `${ledgerLabel(ledger, people)}'s income`}</Text>
                  <Money value={review.totalIn} cents={false} style={s.statValue} />
                  {[...review.received.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([pid, amt]) => (
                      <View key={pid || "household"} style={fs.rowBetween}>
                        <Text style={fs.muted} numberOfLines={1}>
                          {personName(pid)}
                        </Text>
                        <Money value={amt} cents={false} style={{ fontSize: 12 }} />
                      </View>
                    ))}
                </View>
                <View style={[fs.card, s.stat]}>
                  <Text style={fs.muted}>We spent</Text>
                  <Money value={review.totalOut} cents={false} style={s.statValue} />
                  {review.groupedOut > 0 && <Text style={fs.muted}>{fmtCurrency(review.groupedOut, { cents: false })} of it on spend groups</Text>}
                </View>
                <View style={[fs.card, s.stat, { flexBasis: "100%" }]}>
                  <Text style={fs.muted}>Left over</Text>
                  <Money value={review.totalIn - review.totalOut} cents={false} sign style={[s.statValue, review.totalIn - review.totalOut < 0 && fs.danger]} />
                  <Text style={fs.muted}>
                    {review.totalIn > 0 ? `${Math.round((review.totalOut / review.totalIn) * 100)}% of what came in was spent` : "Nothing came in"}. Transfers between our accounts and card payments don&apos;t count.
                  </Text>
                </View>
              </View>

              {/* By category */}
              <Card title="Spending by category">
                <View style={[fs.chipRow, { gap: 12 }]}>
                  <Legend color={ACCENT} label={noun} />
                  <Legend color="#555" label={`usual (${REVIEW_USUAL_MONTHS}-mo median${period.kind === "month" ? "" : ", scaled"})`} tick />
                  <Legend color={DANGER} label="budget" tick />
                </View>
                {review.byCategory.length === 0 && <Text style={fs.muted}>No spending {noun}.</Text>}
                {review.byCategory.map((r, i) => (
                  <Pressable key={r.category} onPress={() => openCategory(r.category)} style={({ pressed }) => [{ gap: 4, paddingTop: i ? 6 : 0 }, pressed && fs.pressed]}>
                    <View style={fs.rowBetween}>
                      <Text style={fs.textFlex} numberOfLines={1}>
                        {r.category}
                        {r.line && r.lineShared ? (
                          <Text style={fs.muted}>
                            {" "}
                            · in {r.line.name} ({fmtCurrency(r.lineBudget, { cents: false })})
                          </Text>
                        ) : null}
                      </Text>
                      <Text style={fs.muted}>usual {fmtCurrency(r.median, { cents: false })}</Text>
                      <Money value={r.spent} cents={false} />
                    </View>
                    <View style={s.track}>
                      <View style={[s.fill, { width: `${Math.min(100, (r.spent / review.maxCategory) * 100)}%` }]} />
                      {r.median > 0 && <View style={[s.tick, { left: `${Math.min(99, (r.median / review.maxCategory) * 100)}%`, backgroundColor: "#555" }]} />}
                      {r.lineBudget != null && !r.lineShared && <View style={[s.tick, { left: `${Math.min(99, (r.lineBudget / review.maxCategory) * 100)}%`, backgroundColor: DANGER }]} />}
                    </View>
                  </Pressable>
                ))}
              </Card>

              {/* Trend */}
              <Card title={`Last ${REVIEW_TREND_MONTHS} months`}>
                <Trend rows={review.trend.rows} series={review.trend.series} shade={review.trend.shade} />
              </Card>

              {/* Biggest */}
              <Card title="Biggest transactions">
                {review.biggest.length === 0 ? (
                  <Text style={fs.muted}>No spending {noun}.</Text>
                ) : (
                  review.biggest.map((t) => (
                    <View key={t.id} style={fs.rowBetween}>
                      <View style={{ flex: 1 }}>
                        <Text style={fs.text} numberOfLines={1}>
                          {t.description}
                        </Text>
                        <Text style={fs.muted} numberOfLines={1}>
                          {fmtDate(t.date)} · {effectiveCategory(t)}
                          {accountName.size > 1 ? ` · ${accountName.get(t.accountId) ?? ""}` : ""}
                        </Text>
                      </View>
                      <Money value={t.amount} />
                    </View>
                  ))
                )}
              </Card>

              {/* Scheduled vs actual */}
              <Card title="Scheduled payments">
                {review.scheduled.length === 0 ? (
                  <Text style={fs.muted}>Nothing was scheduled {noun}.</Text>
                ) : (
                  review.scheduled.map(({ r, due, paid, actual, expected, done, notSeen }) => (
                    <View key={r.id} style={[fs.rowBetween, { alignItems: "flex-start" }]}>
                      <Ionicons name={done ? "checkmark-circle" : "ellipse-outline"} size={18} color={done ? GOOD : "#bbb"} style={{ marginTop: 1 }} />
                      <View style={{ flex: 1 }}>
                        <Text style={fs.text} numberOfLines={1}>
                          {r.description}
                        </Text>
                        <Text style={fs.muted}>
                          {due.length ? `due ${due.map((d: string) => fmtDate(d)).join(", ")}` : "not due"}
                          {paid.length ? ` · posted ${paid.map((t: any) => fmtDate(t.date)).join(", ")}` : notSeen ? " · not seen yet" : ""}
                        </Text>
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Money value={paid.length ? actual : expected} style={!paid.length ? { color: "#aaa" } : undefined} />
                        {paid.length > 0 && Math.abs(actual - expected) >= 1 && <Text style={fs.muted}>expected {fmtCurrency(expected)}</Text>}
                      </View>
                    </View>
                  ))
                )}
              </Card>

              {/* Groups */}
              {review.groups.length > 0 && (
                <Card title="Spend groups">
                  <Text style={fs.muted}>Tagged spending counts here instead of the monthly budget. Totals cover the last {REVIEW_TREND_MONTHS} months.</Text>
                  {review.groups.map(({ g, month, total }) => (
                    <View key={g.id} style={fs.rowBetween}>
                      <Text style={fs.textFlex} numberOfLines={1}>
                        {g.name}
                        {g.kind ? <Text style={fs.muted}> · {String(g.kind).toLowerCase()}</Text> : null}
                      </Text>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={fs.money}>
                          {fmtCurrency(total, { cents: false })}
                          {g.budget ? <Text style={fs.muted}> / {fmtCurrency(g.budget, { cents: false })}</Text> : null}
                        </Text>
                        <Text style={fs.muted}>
                          {noun} {fmtCurrency(month, { cents: false })}
                        </Text>
                      </View>
                    </View>
                  ))}
                </Card>
              )}

              {review.hasOtherIncome && <Text style={[fs.muted, { paddingHorizontal: 4 }]}>“We put in” also counts income landing in the account directly (interest, deposits).</Text>}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Legend({ color, label, tick }: { color: string; label: string; tick?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={tick ? { width: 2, height: 12, backgroundColor: color } : { width: 12, height: 8, borderRadius: 2, backgroundColor: color }} />
      <Text style={fs.muted}>{label}</Text>
    </View>
  );
}

/** Stacked monthly spending by top category, with contributions as a green dot; the period's months shaded. */
function Trend({ rows, series, shade }: { rows: Array<Record<string, number | string>>; series: string[]; shade: { x1: string; x2: string } | null }) {
  const colorOf = (sName: string, i: number) => (sName === "Other" ? OTHER_COLOR : PALETTE[i % PALETTE.length]);
  const totals = rows.map((r) => series.reduce((sum, k) => sum + (Number(r[k]) || 0), 0));
  const max = Math.max(1, ...totals, ...rows.map((r) => Number(r.Contributions) || 0));
  const shadeFrom = shade ? rows.findIndex((r) => r.month === shade.x1) : -1;
  const shadeTo = shade ? rows.findIndex((r) => r.month === shade.x2) : -1;
  return (
    <View style={{ gap: 8 }}>
      <View style={[fs.rowBetween, { alignItems: "flex-end" }]}>
        <Text style={fs.muted}>{fmtCurrency(max, { cents: false })}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-end", height: CHART_HEIGHT, gap: 3 }}>
        {rows.map((r, i) => {
          const inPeriod = shadeFrom >= 0 && i >= shadeFrom && i <= shadeTo;
          const contrib = Number(r.Contributions) || 0;
          return (
            <View key={String(r.month)} style={[s.col, inPeriod && s.colShade]}>
              {series.map((k, si) => {
                const v = Number(r[k]) || 0;
                return v > 0 ? <View key={k} style={{ height: (v / max) * (CHART_HEIGHT - 4), backgroundColor: colorOf(k, si) }} /> : null;
              })}
              {contrib > 0 && <View style={[s.dot, { bottom: (contrib / max) * (CHART_HEIGHT - 4) - 3 }]} />}
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", gap: 3 }}>
        {rows.map((r, i) => (
          <Text key={String(r.month)} style={s.axis} numberOfLines={1}>
            {(rows.length - 1 - i) % 2 === 0 ?String(r.month).split(" ")[0] : ""}
          </Text>
        ))}
      </View>
      <View style={[fs.chipRow, { gap: 10 }]}>
        {series.map((k, si) => (
          <Legend key={k} color={colorOf(k, si)} label={k} />
        ))}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={[s.dot, { position: "relative", bottom: 0 }]} />
          <Text style={fs.muted}>Contributions</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  stat: { flexBasis: "47%", flexGrow: 1, gap: 2 },
  statValue: { fontSize: 19, fontWeight: "600" },
  track: { height: 8, borderRadius: 4, backgroundColor: "#eee", position: "relative" },
  fill: { position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 4, backgroundColor: ACCENT },
  tick: { position: "absolute", top: -2, bottom: -2, width: 2 },
  col: { flex: 1, height: "100%", justifyContent: "flex-end", position: "relative", borderRadius: 2 },
  colShade: { backgroundColor: "rgba(115,95,85,0.08)" },
  dot: { position: "absolute", alignSelf: "center", width: 7, height: 7, borderRadius: 4, backgroundColor: "#16a34a", borderWidth: 1, borderColor: "#fff" },
  axis: { flex: 1, fontSize: 9, color: "#999", textAlign: "center" },
});
