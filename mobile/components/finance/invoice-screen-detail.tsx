// One invoice (homeInvoice), the phone's version of the web's
// InvoiceDetailModal: fix the extracted fields and items, mark it reviewed,
// see / unlink the transactions that paid it (homeInvoiceLink), find a
// payment (the auto-match rule's exact ones plus anything within 5% and 30
// days, lib/finance/invoice-screen.ts paymentCandidates) and link it, open
// the PDF through a signed link, and delete. The original .eml isn't offered
// on the phone. Whose it is and whether it's private: lib/finance/invoice-owner.ts.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { callOp } from "../../lib/ops";
import { getClient } from "../../lib/amplify";
import { listAllPages } from "../../../lib/list-all";
import { listTransactions } from "../../../lib/finance/data";
import { fmtCurrency, fmtDate } from "../../../lib/finance/dates";
import {
  invoiceAnchor,
  invoiceForm,
  invoiceNum,
  invoiceUpdate,
  paymentCandidates,
  paymentSearchRange,
  type InvoiceForm,
  type InvoiceItemDraft,
  EMPTY_INVOICE_ITEM,
  invoiceItemsSum,
} from "../../../lib/finance/invoice-screen";
import { CategoryField, DateField, Field, FormSheet, Input, ff } from "./form";
import { ACCENT, Chip, DANGER, GOOD, Money, WARN, fs, useFinanceAccounts } from "./ui";
import { openFinancePdf } from "./paycheck-screen-pdf";
import { usePeople } from "../../lib/use-people";
import { usePerson } from "../../lib/use-person";
import { invoiceOwnerError } from "../../../lib/finance/invoice-owner";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Linked = { link: any; tx: any | null };
const errText = (e: any) => e?.errors?.[0]?.message ?? e?.message ?? String(e);

export function InvoiceDetailSheet({ invoice, onClose, onChanged }: { invoice: any | null; onClose: () => void; onChanged: () => void }) {
  const accounts = useFinanceAccounts();
  const { people } = usePeople();
  const me = usePerson();
  const viewerId = me.status === "found" ? me.person.id : null;
  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState<InvoiceForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [links, setLinks] = useState<Linked[] | null>(null);
  const [candidates, setCandidates] = useState<{ exact: any[]; loose: any[] } | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void callOp("list_finance_spend_groups", {}).then((r) => {
      if (!("error" in r)) setGroups(r.result.groups.map((g: any) => ({ id: g.id, name: g.name })));
    });
  }, []);

  const loadLinks = useCallback(async (invoiceId: string) => {
    const client = getClient();
    const rows = await listAllPages<any>(client.models.homeInvoiceLink, { filter: { invoiceId: { eq: invoiceId } } });
    const withTx = await Promise.all(
      rows.map(async (link) => {
        const { data } = await client.models.homeFinanceTransaction.get({ id: link.transactionId });
        return { link, tx: data ?? null };
      }),
    );
    setLinks(withTx);
  }, []);

  // Only when a different invoice opens: a reload after saving or linking keeps edits.
  useEffect(() => {
    setCandidates(null);
    setLinks(null);
    if (!invoice) {
      setForm(null);
      return;
    }
    setForm(invoiceForm(invoice));
    loadLinks(invoice.id).catch((e) => {
      setLinks([]);
      Alert.alert("Couldn't load linked transactions", errText(e));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id, loadLinks]);

  const set = <K extends keyof InvoiceForm>(k: K, v: InvoiceForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const setItem = (i: number, patch: Partial<InvoiceItemDraft>) => setForm((f) => (f ? { ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) } : f));

  async function save(extra: Record<string, unknown> = {}) {
    if (!form || !invoice) return;
    const ownerErr = invoiceOwnerError(form.ownerPersonIds, form.private);
    if (ownerErr) return Alert.alert(ownerErr);
    if (form.private && !form.ownerPersonIds.includes(viewerId ?? "")) return Alert.alert("Only an owner can keep it private", "Add yourself as an owner, or turn Private off.");
    setSaving(true);
    try {
      const r = await getClient().models.homeInvoice.update({ id: invoice.id, ...invoiceUpdate(form), ...extra } as any);
      if (r.errors?.length) throw new Error(r.errors[0].message);
      onChanged();
      onClose();
    } catch (e) {
      Alert.alert("Couldn't save", errText(e));
    } finally {
      setSaving(false);
    }
  }

  async function findPayment() {
    if (!form) return;
    const anchor = invoiceAnchor(form);
    const total = invoiceNum(form.total);
    if (!anchor || total == null) return Alert.alert("Needs a date and a total", "Fill in the issue or due date and the total first.");
    setSearching(true);
    try {
      const txs = await listTransactions(getClient(), paymentSearchRange(anchor));
      setCandidates(paymentCandidates(txs, anchor, total, new Set((links ?? []).map((l) => l.link.transactionId))));
    } catch (e) {
      Alert.alert("Couldn't search transactions", errText(e));
    } finally {
      setSearching(false);
    }
  }

  async function link(tx: any) {
    if (!invoice || !form) return;
    const client = getClient();
    const r = await client.models.homeInvoiceLink.create({ invoiceId: invoice.id, transactionId: tx.id, amount: invoiceNum(form.total) } as any);
    if (r.errors?.length) return Alert.alert("Couldn't link", r.errors[0].message);
    await client.models.homeInvoice.update({ id: invoice.id, paid: true } as any);
    set("paid", true);
    setCandidates((c) => (c ? { exact: c.exact.filter((t) => t.id !== tx.id), loose: c.loose.filter((t) => t.id !== tx.id) } : c));
    await loadLinks(invoice.id).catch(() => undefined);
    onChanged();
  }

  function unlink(l: Linked) {
    Alert.alert("Unlink this payment?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unlink",
        style: "destructive",
        onPress: async () => {
          const r = await getClient().models.homeInvoiceLink.delete({ id: l.link.id });
          if (r.errors?.length) return Alert.alert("Couldn't unlink", r.errors[0].message);
          await loadLinks(invoice.id).catch(() => undefined);
          onChanged();
        },
      },
    ]);
  }

  function remove() {
    if (!invoice) return;
    const n = links?.length ?? 0;
    Alert.alert(`Delete the invoice from ${invoice.vendor ?? "this vendor"}?`, `${n ? `Its ${n} payment link${n === 1 ? "" : "s"} go too. ` : ""}The PDF stays stored.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const client = getClient();
          for (const l of links ?? []) await client.models.homeInvoiceLink.delete({ id: l.link.id });
          const r = await client.models.homeInvoice.delete({ id: invoice.id });
          if (r.errors?.length) return Alert.alert("Couldn't delete", r.errors[0].message);
          onChanged();
          onClose();
        },
      },
    ]);
  }

  const txRow = (t: any, action: React.ReactNode) => (
    <View key={t.id} style={[fs.rowBetween, { paddingVertical: 4 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={fs.text} numberOfLines={1}>
          {t.description ?? "(no description)"}
        </Text>
        <Text style={fs.muted} numberOfLines={1}>
          {fmtDate(t.date, { month: "short", day: "numeric", year: "numeric" })} · {accountName.get(t.accountId) ?? "account"}
        </Text>
      </View>
      <Money value={t.amount} />
      {action}
    </View>
  );
  const linkBtn = (t: any) => (
    <Pressable onPress={() => void link(t)} hitSlop={8} style={ff.smallBtn}>
      <Text style={ff.smallBtnText}>Link</Text>
    </Pressable>
  );

  const itemsSum = (form ? invoiceItemsSum(form.items) : 0);
  const total = form ? invoiceNum(form.total) : null;
  const anchor = form ? invoiceAnchor(form) : null;

  return (
    <FormSheet visible={!!invoice} title={invoice?.vendor ?? "Invoice"} onClose={onClose} onSave={() => void save()} busy={saving}>
      {invoice && form ? (
        <>
          <View style={[fs.chipRow, { alignItems: "center" }]}>
            {invoice.parseStatus !== "PARSED" && (
              <Text style={[fs.text, { color: invoice.parseStatus === "ERROR" ? DANGER : WARN, fontWeight: "600" }]}>{invoice.parseStatus === "ERROR" ? "Couldn't read" : "Needs review"}</Text>
            )}
            {invoice.s3KeyPdf ? (
              <Pressable onPress={() => void openFinancePdf(invoice.s3KeyPdf)} style={ff.smallBtn}>
                <Ionicons name="document-text-outline" size={16} color={ACCENT} />
                <Text style={ff.smallBtnText}>Open the PDF</Text>
              </Pressable>
            ) : null}
          </View>
          {invoice.parseError ? <Text style={[fs.text, { color: WARN }]}>{invoice.parseError}</Text> : null}
          {invoice.parseStatus !== "PARSED" && (
            <Pressable onPress={() => void save({ parseStatus: "PARSED", parseError: null })} disabled={saving} style={ff.smallBtn}>
              <Ionicons name="checkmark" size={16} color={ACCENT} />
              <Text style={ff.smallBtnText}>Save & mark reviewed</Text>
            </Pressable>
          )}

          <Field label="Vendor">
            <Input value={form.vendor} onChangeText={(v) => set("vendor", v)} />
          </Field>
          <Field label="Invoice number">
            <Input value={form.invoiceNumber} onChangeText={(v) => set("invoiceNumber", v)} placeholder="Optional" />
          </Field>
          <Field label="Issue date">
            <DateField value={form.issueDate} onChange={(v) => set("issueDate", v)} placeholder="None" clearable />
          </Field>
          <Field label="Due date">
            <DateField value={form.dueDate} onChange={(v) => set("dueDate", v)} placeholder="None" clearable />
          </Field>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Field label="Subtotal">
                <Input value={form.subtotal} onChangeText={(v) => set("subtotal", v)} keyboardType="decimal-pad" />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Tax">
                <Input value={form.tax} onChangeText={(v) => set("tax", v)} keyboardType="decimal-pad" />
              </Field>
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 2 }}>
              <Field label="Total">
                <Input value={form.total} onChangeText={(v) => set("total", v)} keyboardType="decimal-pad" />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Currency">
                <Input value={form.currency} onChangeText={(v) => set("currency", v)} autoCapitalize="characters" />
              </Field>
            </View>
          </View>
          <Field label="Category">
            <CategoryField value={form.category} onChange={(v) => set("category", v)} />
          </Field>
          {groups.length > 0 && (
            <Field label="Spend group">
              <View style={fs.chipRow}>
                <Chip label="None" on={!form.spendGroupId} onPress={() => set("spendGroupId", "")} />
                {groups.map((g) => (
                  <Chip key={g.id} label={g.name} on={form.spendGroupId === g.id} onPress={() => set("spendGroupId", g.id)} />
                ))}
              </View>
            </Field>
          )}
          <Field label="Whose">
            <View style={fs.chipRow}>
              <Chip label="Household" on={form.ownerPersonIds.length === 0} onPress={() => setForm((f) => (f ? { ...f, ownerPersonIds: [], private: false } : f))} />
              {people.map((p) => (
                <Chip
                  key={p.id}
                  label={p.name}
                  on={form.ownerPersonIds.includes(p.id)}
                  onPress={() =>
                    setForm((f) => {
                      if (!f) return f;
                      const ids = f.ownerPersonIds.includes(p.id) ? f.ownerPersonIds.filter((x) => x !== p.id) : [...f.ownerPersonIds, p.id];
                      return { ...f, ownerPersonIds: ids, private: ids.length ? f.private : false };
                    })
                  }
                />
              ))}
            </View>
          </Field>
          <View style={ff.switchRow}>
            <Text style={fs.text}>Private (only its owners see it)</Text>
            <Switch
              value={form.private}
              disabled={!viewerId}
              // On with no owner makes it yours: a private invoice needs one.
              onValueChange={(v) => setForm((f) => (f ? { ...f, private: v, ownerPersonIds: v && !f.ownerPersonIds.length && viewerId ? [viewerId] : f.ownerPersonIds } : f))}
            />
          </View>
          <View style={ff.switchRow}>
            <Text style={fs.text}>Paid</Text>
            <Switch value={form.paid} onValueChange={(v) => set("paid", v)} />
          </View>
          <Field label="Notes">
            <Input value={form.notes} onChangeText={(v) => set("notes", v)} multiline placeholder="Optional" />
          </Field>

          {/* Items */}
          <View style={ff.box}>
            <View style={fs.rowBetween}>
              <Text style={ff.label}>Items</Text>
              <Pressable onPress={() => set("items", [...form.items, { ...EMPTY_INVOICE_ITEM }])} hitSlop={8}>
                <Text style={fs.link}>+ Add item</Text>
              </Pressable>
            </View>
            {form.items.length === 0 && <Text style={fs.muted}>No itemization.</Text>}
            {form.items.map((it, i) => (
              <View key={i} style={{ gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#f0f0f0" }}>
                <View style={[fs.rowBetween, { gap: 8 }]}>
                  <Input value={it.description} onChangeText={(v) => setItem(i, { description: v })} placeholder="Description" style={{ flex: 1 }} />
                  <Pressable onPress={() => set("items", form.items.filter((_, j) => j !== i))} hitSlop={8} accessibilityLabel="Remove item">
                    <Ionicons name="trash-outline" size={18} color="#999" />
                  </Pressable>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Input value={it.qty} onChangeText={(v) => setItem(i, { qty: v })} placeholder="Qty" keyboardType="decimal-pad" style={{ flex: 1 }} />
                  <Input value={it.unitPrice} onChangeText={(v) => setItem(i, { unitPrice: v })} placeholder="Unit price" keyboardType="decimal-pad" style={{ flex: 1 }} />
                  <Input value={it.amount} onChangeText={(v) => setItem(i, { amount: v })} placeholder="Amount" keyboardType="decimal-pad" style={{ flex: 1 }} />
                </View>
              </View>
            ))}
            {form.items.length > 0 && (
              <Text style={[fs.muted, { textAlign: "right" }]}>
                Items add up to {fmtCurrency(itemsSum)}
                {total != null && Math.abs(itemsSum - total) >= 0.01 ? ` (total is ${fmtCurrency(total)})` : ""}
              </Text>
            )}
          </View>

          {/* Payments */}
          <View style={ff.box}>
            <View style={fs.rowBetween}>
              <Text style={ff.label}>Paid with</Text>
              <Pressable onPress={() => void findPayment()} disabled={searching} hitSlop={8}>
                {searching ? <ActivityIndicator size="small" /> : <Text style={fs.link}>Find payment</Text>}
              </Pressable>
            </View>
            {!links ? (
              <ActivityIndicator size="small" />
            ) : links.length === 0 ? (
              <Text style={fs.muted}>Not linked to a transaction.</Text>
            ) : (
              links.map((l) =>
                l.tx ? (
                  txRow(
                    l.tx,
                    <Pressable onPress={() => unlink(l)} hitSlop={8} accessibilityLabel="Unlink">
                      <Ionicons name="unlink-outline" size={18} color="#999" />
                    </Pressable>,
                  )
                ) : (
                  <View key={l.link.id} style={fs.rowBetween}>
                    <Text style={fs.muted}>Transaction no longer exists</Text>
                    <Pressable onPress={() => unlink(l)} hitSlop={8}>
                      <Text style={fs.link}>Remove link</Text>
                    </Pressable>
                  </View>
                ),
              )
            )}
            {candidates &&
              (candidates.exact.length + candidates.loose.length === 0 ? (
                <Text style={fs.muted}>No transaction within 30 days of {fmtDate(anchor)} and 5% of the total.</Text>
              ) : (
                <View style={{ gap: 2, paddingTop: 6, borderTopWidth: 1, borderTopColor: "#f0f0f0" }}>
                  {candidates.exact.length > 0 && <Text style={[fs.muted, { color: GOOD, fontWeight: "600" }]}>Exact match (amount, within −2/+10 days)</Text>}
                  {candidates.exact.map((t) => txRow(t, linkBtn(t)))}
                  {candidates.loose.length > 0 && <Text style={[fs.muted, { fontWeight: "600" }]}>Close (±30 days, within 5%)</Text>}
                  {candidates.loose.slice(0, 15).map((t) => txRow(t, linkBtn(t)))}
                </View>
              ))}
          </View>

          <Text style={fs.muted}>
            {invoice.source === "EMAIL" ? `Emailed by ${invoice.emailFrom ?? "?"}${invoice.emailSubject ? ` · “${invoice.emailSubject}”` : ""}` : "Uploaded"}
            {invoice.receivedAt ? ` · ${fmtDate(invoice.receivedAt.slice(0, 10), { month: "short", day: "numeric", year: "numeric" })}` : ""}
          </Text>

          <Pressable onPress={remove} style={ff.dangerBtn}>
            <Text style={ff.dangerText}>Delete invoice</Text>
          </Pressable>
        </>
      ) : null}
    </FormSheet>
  );
}
