// Invoices — household invoices, receipts and bills, like the web's Finance
// → Invoices. They arrive by email (invoices@import.cristinegennaro.com →
// invoice-processor), which reads the fields and links the one transaction
// that paid it when exactly one matches. Search and filter (status, paid,
// year; lib/finance/invoice-screen.ts), totals, and tap one to fix it, mark
// it reviewed, link / unlink its payment, open its PDF (signed link,
// components/finance/paycheck-screen-pdf.ts) or delete it
// (InvoiceDetailSheet).
//
// Reads homeInvoice / homeInvoiceLink through the model client (there are
// no invoice ops), like the web. No PDF upload on the phone (the web's
// ingestInvoicePdf picker): forward it to the invoices@ inbox instead.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../lib/amplify";
import { Input } from "../../../components/finance/form";
import { Card, Chip, DANGER, FinanceHeader, GOOD, Money, WARN, fs } from "../../../components/finance/ui";
import { InvoiceDetailSheet } from "../../../components/finance/invoice-screen-detail";
import { listAllPages } from "../../../../lib/list-all";
import { fmtDate } from "../../../../lib/finance/dates";
import {
  INVOICE_INBOX,
  filterInvoices,
  invoiceIsPaid,
  invoiceTotals,
  invoiceYears,
  type InvoicePaidFilter,
  type InvoiceStatusFilter,
} from "../../../../lib/finance/invoice-screen";

/* eslint-disable @typescript-eslint/no-explicit-any */

const errText = (e: any) => e?.errors?.[0]?.message ?? e?.message ?? String(e);

const STATUS: Array<[InvoiceStatusFilter, string]> = [
  ["all", "Any status"],
  ["review", "Needs review"],
  ["parsed", "Reviewed"],
];
const PAID: Array<[InvoicePaidFilter, string]> = [
  ["all", "Paid or not"],
  ["unpaid", "Unpaid"],
  ["paid", "Paid"],
];

export default function FinanceInvoices() {
  const [invoices, setInvoices] = useState<any[] | null>(null);
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<InvoiceStatusFilter>("all");
  const [paid, setPaid] = useState<InvoicePaidFilter>("all");
  const [year, setYear] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const client = getClient();
      const [rows, links] = await Promise.all([listAllPages<any>(client.models.homeInvoice), listAllPages<any>(client.models.homeInvoiceLink)]);
      setInvoices(rows);
      setLinkedIds(new Set(links.map((l) => l.invoiceId)));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

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

  const years = useMemo(() => invoiceYears(invoices ?? []), [invoices]);
  const shown = useMemo(() => filterInvoices(invoices ?? [], linkedIds, { status, paid, year, query }), [invoices, linkedIds, status, paid, year, query]);
  const totals = useMemo(() => invoiceTotals(shown, linkedIds), [shown, linkedIds]);
  const open = (invoices ?? []).find((i) => i.id === openId) ?? null;

  return (
    <SafeAreaView style={fs.screen} edges={["top"]}>
      <FinanceHeader title="Invoices" />
      {!invoices ? (
        <View style={fs.center}>{error ? <Text style={fs.empty}>{error}</Text> : <ActivityIndicator />}</View>
      ) : (
        <ScrollView contentContainerStyle={fs.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} keyboardShouldPersistTaps="handled">
          <Text style={[fs.muted, { paddingHorizontal: 4 }]}>Forward invoices and receipts to {INVOICE_INBOX}; only our own addresses are processed.</Text>
          {invoices.length === 0 ? (
            <Text style={fs.empty}>No invoices yet. Forward one to {INVOICE_INBOX}.</Text>
          ) : (
            <>
              <Input value={query} onChangeText={setQuery} placeholder="Vendor, number, notes" autoCorrect={false} clearButtonMode="while-editing" />
              <View style={fs.chipRow}>
                {STATUS.map(([k, label]) => (
                  <Chip key={k} label={label} on={status === k} onPress={() => setStatus(k)} />
                ))}
              </View>
              <View style={fs.chipRow}>
                {PAID.map(([k, label]) => (
                  <Chip key={k} label={label} on={paid === k} onPress={() => setPaid(k)} />
                ))}
              </View>
              {years.length > 1 && (
                <View style={fs.chipRow}>
                  <Chip label="All years" on={year === "all"} onPress={() => setYear("all")} />
                  {years.map((y) => (
                    <Chip key={y} label={y} on={year === y} onPress={() => setYear(y)} />
                  ))}
                </View>
              )}

              <View style={{ flexDirection: "row", gap: 8 }}>
                <Card style={{ flex: 1, gap: 2 }}>
                  <Text style={fs.label}>
                    {shown.length} invoice{shown.length === 1 ? "" : "s"}
                  </Text>
                  <Money value={totals.sum} cents={false} style={{ fontSize: 17, fontWeight: "600" }} />
                </Card>
                <Card style={{ flex: 1, gap: 2 }}>
                  <Text style={fs.label}>Not paid yet</Text>
                  <Money value={totals.unpaid} cents={false} style={{ fontSize: 17, fontWeight: "600" }} />
                </Card>
                <Card style={{ flex: 1, gap: 2 }}>
                  <Text style={fs.label}>Need review</Text>
                  <Text style={[{ fontSize: 17, fontWeight: "600", color: "#333" }, totals.review > 0 && { color: WARN }]}>{totals.review}</Text>
                </Card>
              </View>

              {shown.length === 0 ? (
                <Text style={fs.empty}>Nothing matches these filters.</Text>
              ) : (
                <Card>
                  {shown.map((inv, i) => {
                    const isLinked = linkedIds.has(inv.id);
                    const isPaid = invoiceIsPaid(inv, linkedIds);
                    const meta = [
                      inv.issueDate ? fmtDate(inv.issueDate, { month: "short", day: "numeric", year: "numeric" }) : "no date",
                      inv.dueDate ? `due ${fmtDate(inv.dueDate, { month: "short", day: "numeric", year: "numeric" })}` : null,
                      inv.category,
                      inv.source === "EMAIL" ? `emailed by ${inv.emailFrom ?? "?"}` : "uploaded",
                    ].filter(Boolean);
                    return (
                      <Pressable
                        key={inv.id}
                        onPress={() => setOpenId(inv.id)}
                        style={({ pressed }) => [{ gap: 2, paddingTop: i ? 10 : 0 }, i > 0 && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }, pressed && fs.pressed]}
                      >
                        <View style={fs.rowBetween}>
                          <Text style={[fs.textFlex, { fontWeight: "500" }]} numberOfLines={1}>
                            {inv.vendor ?? "Unknown vendor"}
                            {inv.invoiceNumber ? <Text style={fs.muted}> #{inv.invoiceNumber}</Text> : null}
                          </Text>
                          {inv.total == null ? <Text style={fs.muted}>—</Text> : <Money value={inv.total} style={{ fontWeight: "600" }} />}
                          {inv.currency && inv.currency !== "USD" ? <Text style={fs.muted}>{inv.currency}</Text> : null}
                        </View>
                        <View style={[fs.rowBetween, { alignItems: "flex-start" }]}>
                          <Text style={[fs.muted, { flex: 1 }]} numberOfLines={2}>
                            {meta.join(" · ")}
                          </Text>
                          <Text style={[fs.muted, { fontWeight: "600" }, isPaid && { color: GOOD }]}>{isPaid ? (isLinked ? "paid · linked" : "paid") : "unpaid"}</Text>
                        </View>
                        {inv.parseStatus === "ERROR" && <Text style={[fs.muted, { color: DANGER }]}>Couldn&apos;t read it{inv.parseError ? `: ${inv.parseError}` : ""}</Text>}
                        {inv.parseStatus === "NEEDS_REVIEW" && <Text style={[fs.muted, { color: WARN }]}>Needs review{inv.parseError ? `: ${inv.parseError}` : ""}</Text>}
                      </Pressable>
                    );
                  })}
                </Card>
              )}
            </>
          )}
        </ScrollView>
      )}
      <InvoiceDetailSheet invoice={open} onClose={() => setOpenId(null)} onChanged={() => void load()} />
    </SafeAreaView>
  );
}
