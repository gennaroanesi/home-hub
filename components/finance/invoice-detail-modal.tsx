"use client";

// Invoice detail for /finance/invoices: edit the extracted fields and items,
// mark reviewed, see / unlink the transactions that paid it, find a payment
// (exact auto-match rule plus a looser ±30 days / 5% list), and delete.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Chip } from "@heroui/chip";
import { Input, Textarea } from "@heroui/input";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { Select, SelectItem } from "@heroui/select";
import { Switch } from "@heroui/switch";
import { Spinner, addToast } from "@heroui/react";
import { FaExternalLinkAlt, FaLink, FaPlus, FaSearch, FaTrash, FaUnlink } from "react-icons/fa";

import { financeClient } from "@/components/finance/client";
import { Money } from "@/components/finance/ui";
import { FreeCombobox } from "@/components/free-combobox";
import { listAllPages } from "@/lib/list-all";
import { listTransactions } from "@/lib/finance/data";
import { addDays, fmtDate } from "@/lib/finance/dates";
import { autoMatchCandidates } from "@/lib/finance/invoice-fields";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type InvoiceItem = { description: string; qty: number | null; unitPrice: number | null; amount: number | null };

export function parseItems(raw: string | null | undefined): InvoiceItem[] {
  if (!raw) return [];
  try {
    let v: unknown = raw;
    while (typeof v === "string") v = JSON.parse(v);
    if (!Array.isArray(v)) return [];
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
    return v.map((it: any) => ({ description: String(it?.description ?? ""), qty: num(it?.qty), unitPrice: num(it?.unitPrice), amount: num(it?.amount) }));
  } catch {
    return [];
  }
}

export const fileUrl = (key: string) => `/api/finance/file?key=${encodeURIComponent(key)}`;

type Form = {
  vendor: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  category: string;
  spendGroupId: string;
  paid: boolean;
  notes: string;
  items: InvoiceItem[];
};

const toStr = (n: number | null | undefined) => (n == null ? "" : String(n));
const toNum = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : null;
};

function formFrom(inv: any): Form {
  return {
    vendor: inv.vendor ?? "",
    invoiceNumber: inv.invoiceNumber ?? "",
    issueDate: inv.issueDate ?? "",
    dueDate: inv.dueDate ?? "",
    currency: inv.currency ?? "USD",
    subtotal: toStr(inv.subtotal),
    tax: toStr(inv.tax),
    total: toStr(inv.total),
    category: inv.category ?? "",
    spendGroupId: inv.spendGroupId ?? "",
    paid: !!inv.paid,
    notes: inv.notes ?? "",
    items: parseItems(inv.items),
  };
}

type Linked = { link: any; tx: any | null };

export function InvoiceDetailModal({
  invoice,
  categories,
  groups,
  accounts,
  onClose,
  onChanged,
}: {
  invoice: any | null;
  categories: string[];
  groups: any[];
  accounts: any[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [links, setLinks] = useState<Linked[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [candidates, setCandidates] = useState<{ exact: any[]; loose: any[] } | null>(null);
  const [searching, setSearching] = useState(false);

  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name as string])), [accounts]);

  const loadLinks = useCallback(async (invoiceId: string) => {
    setLinksLoading(true);
    try {
      const rows = await listAllPages<any>(financeClient.models.homeInvoiceLink, { filter: { invoiceId: { eq: invoiceId } } });
      const withTx = await Promise.all(
        rows.map(async (link) => {
          const { data } = await financeClient.models.homeFinanceTransaction.get({ id: link.transactionId });
          return { link, tx: data ?? null };
        }),
      );
      setLinks(withTx);
    } finally {
      setLinksLoading(false);
    }
  }, []);

  useEffect(() => {
    setCandidates(null);
    setLinks([]);
    if (!invoice) {
      setForm(null);
      return;
    }
    setForm(formFrom(invoice));
    loadLinks(invoice.id).catch((e) => addToast({ title: "Couldn't load linked transactions", description: String(e), color: "danger" }));
    // Only when a different invoice opens: a reload after saving or linking
    // must not wipe edits in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id, loadLinks]);

  if (!invoice || !form) return null;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const total = toNum(form.total);
  const anchor = form.issueDate || form.dueDate || null;

  async function save(extra: Record<string, unknown> = {}) {
    if (!form) return;
    setSaving(true);
    try {
      const items = form.items.filter((it) => it.description.trim() || it.amount != null);
      const r = await financeClient.models.homeInvoice.update({
        id: invoice.id,
        vendor: form.vendor.trim() || null,
        invoiceNumber: form.invoiceNumber.trim() || null,
        issueDate: form.issueDate || null,
        dueDate: form.dueDate || null,
        currency: form.currency.trim().toUpperCase() || "USD",
        subtotal: toNum(form.subtotal),
        tax: toNum(form.tax),
        total: toNum(form.total),
        category: form.category.trim() || null,
        spendGroupId: form.spendGroupId || null,
        paid: form.paid,
        notes: form.notes.trim() || null,
        items: items.length ? JSON.stringify(items) : null,
        ...extra,
      } as any);
      if (r.errors?.length) throw new Error(r.errors[0].message);
      addToast({ title: "Invoice saved", color: "success" });
      onChanged();
      return true;
    } catch (e) {
      addToast({ title: "Couldn't save", description: e instanceof Error ? e.message : String(e), color: "danger" });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function findPayment() {
    if (!anchor || total == null) {
      addToast({ title: "Needs a date and a total", description: "Fill in the issue or due date and the total first.", color: "warning" });
      return;
    }
    setSearching(true);
    try {
      const txs = await listTransactions(financeClient, { fromIso: addDays(anchor, -30), toIso: addDays(anchor, 30) });
      const linkedIds = new Set(links.map((l) => l.link.transactionId));
      const pool = txs.filter((t) => !linkedIds.has(t.id));
      const exact = autoMatchCandidates(pool, anchor, total);
      const exactIds = new Set(exact.map((t) => t.id));
      const loose = pool
        .filter((t) => !exactIds.has(t.id) && Math.abs(total) > 0 && Math.abs(Math.abs(t.amount ?? 0) - Math.abs(total)) / Math.abs(total) <= 0.05)
        .sort((a, b) => Math.abs(Math.abs(a.amount) - Math.abs(total)) - Math.abs(Math.abs(b.amount) - Math.abs(total)));
      setCandidates({ exact, loose });
    } catch (e) {
      addToast({ title: "Couldn't search transactions", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setSearching(false);
    }
  }

  async function link(tx: any) {
    const r = await financeClient.models.homeInvoiceLink.create({ invoiceId: invoice.id, transactionId: tx.id, amount: total });
    if (r.errors?.length) return addToast({ title: "Couldn't link", description: r.errors[0].message, color: "danger" });
    await financeClient.models.homeInvoice.update({ id: invoice.id, paid: true });
    set("paid", true);
    setCandidates((c) => (c ? { exact: c.exact.filter((t) => t.id !== tx.id), loose: c.loose.filter((t) => t.id !== tx.id) } : c));
    await loadLinks(invoice.id);
    onChanged();
  }

  async function unlink(l: Linked) {
    const r = await financeClient.models.homeInvoiceLink.delete({ id: l.link.id });
    if (r.errors?.length) return addToast({ title: "Couldn't unlink", description: r.errors[0].message, color: "danger" });
    await loadLinks(invoice.id);
    onChanged();
  }

  async function remove() {
    if (!confirm(`Delete the invoice from ${invoice.vendor ?? "this vendor"}${links.length ? ` and its ${links.length} payment link(s)` : ""}?\n\nThe PDF stays stored in S3.`)) return;
    for (const l of links) await financeClient.models.homeInvoiceLink.delete({ id: l.link.id });
    const r = await financeClient.models.homeInvoice.delete({ id: invoice.id });
    if (r.errors?.length) return addToast({ title: "Couldn't delete", description: r.errors[0].message, color: "danger" });
    addToast({ title: "Invoice deleted", color: "success" });
    onChanged();
    onClose();
  }

  const setItem = (i: number, patch: Partial<InvoiceItem>) => set("items", form.items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const itemsSum = form.items.reduce((s, it) => s + (it.amount ?? 0), 0);

  const txRow = (t: any, action: React.ReactNode) => (
    <div key={t.id} className="flex items-center justify-between gap-2 text-sm py-1">
      <span className="min-w-0">
        <span className="block truncate">{t.description ?? "(no description)"}</span>
        <span className="text-xs text-default-400">
          {fmtDate(t.date, { month: "short", day: "numeric", year: "numeric" })} · {accountName.get(t.accountId) ?? "account"}
        </span>
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <Money value={t.amount} />
        {action}
      </span>
    </div>
  );

  return (
    <Modal isOpen={!!invoice} onClose={onClose} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-wrap items-center gap-2">
          <span>{invoice.vendor ?? "Invoice"}</span>
          {invoice.parseStatus !== "PARSED" && (
            <Chip size="sm" color={invoice.parseStatus === "ERROR" ? "danger" : "warning"} variant="flat">
              {invoice.parseStatus === "ERROR" ? "Couldn't read" : "Needs review"}
            </Chip>
          )}
          <a href={fileUrl(invoice.s3KeyPdf)} target="_blank" rel="noreferrer" className="text-sm text-primary flex items-center gap-1 font-normal">
            PDF <FaExternalLinkAlt className="text-xs" />
          </a>
          {invoice.s3KeyOriginal && (
            <a href={`${fileUrl(invoice.s3KeyOriginal)}&download=1`} className="text-sm text-primary font-normal">
              Original email
            </a>
          )}
        </ModalHeader>
        <ModalBody className="gap-4">
          {invoice.parseError && <p className="text-sm text-warning-600">{invoice.parseError}</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input size="sm" label="Vendor" value={form.vendor} onValueChange={(v) => set("vendor", v)} />
            <Input size="sm" label="Invoice number" value={form.invoiceNumber} onValueChange={(v) => set("invoiceNumber", v)} />
            <Input size="sm" type="date" label="Issue date" value={form.issueDate} onValueChange={(v) => set("issueDate", v)} />
            <Input size="sm" type="date" label="Due date" value={form.dueDate} onValueChange={(v) => set("dueDate", v)} />
            <Input size="sm" label="Subtotal" inputMode="decimal" value={form.subtotal} onValueChange={(v) => set("subtotal", v)} />
            <Input size="sm" label="Tax" inputMode="decimal" value={form.tax} onValueChange={(v) => set("tax", v)} />
            <Input size="sm" label="Total" inputMode="decimal" value={form.total} onValueChange={(v) => set("total", v)} />
            <Input size="sm" label="Currency" value={form.currency} onValueChange={(v) => set("currency", v)} />
            <FreeCombobox label="Category" value={form.category} onValueChange={(v) => set("category", v)} options={categories} />
            <Select
              size="sm"
              label="Spend group"
              selectedKeys={form.spendGroupId ? new Set([form.spendGroupId]) : new Set()}
              onSelectionChange={(k) => set("spendGroupId", (Array.from(k as Set<string>)[0] as string) ?? "")}
            >
              {groups.map((g) => (
                <SelectItem key={g.id}>{g.name}</SelectItem>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <Switch size="sm" isSelected={form.paid} onValueChange={(v) => set("paid", v)}>
              Paid
            </Switch>
            {form.spendGroupId && (
              <Button size="sm" variant="light" onPress={() => set("spendGroupId", "")}>
                Clear group
              </Button>
            )}
          </div>
          <Textarea size="sm" label="Notes" minRows={2} value={form.notes} onValueChange={(v) => set("notes", v)} />

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-semibold">Items</span>
              <Button size="sm" variant="light" startContent={<FaPlus />} onPress={() => set("items", [...form.items, { description: "", qty: null, unitPrice: null, amount: null }])}>
                Add item
              </Button>
            </div>
            {form.items.length === 0 ? (
              <p className="text-xs text-default-500">No itemization.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {form.items.map((it, i) => (
                  <div key={i} className="grid grid-cols-[1fr_4rem_6rem_6rem_2rem] gap-1 items-center">
                    <Input size="sm" aria-label="Description" value={it.description} onValueChange={(v) => setItem(i, { description: v })} />
                    <Input size="sm" aria-label="Qty" value={toStr(it.qty)} onValueChange={(v) => setItem(i, { qty: toNum(v) })} />
                    <Input size="sm" aria-label="Unit price" value={toStr(it.unitPrice)} onValueChange={(v) => setItem(i, { unitPrice: toNum(v) })} />
                    <Input size="sm" aria-label="Amount" value={toStr(it.amount)} onValueChange={(v) => setItem(i, { amount: toNum(v) })} />
                    <Button size="sm" isIconOnly variant="light" aria-label="Remove item" onPress={() => set("items", form.items.filter((_, j) => j !== i))}>
                      <FaTrash className="text-default-400" />
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-default-500 text-right">
                  Items add up to <Money value={itemsSum} />
                  {total != null && Math.abs(itemsSum - total) >= 0.01 ? ` (total is ${total.toFixed(2)})` : ""}
                </p>
              </div>
            )}
          </div>

          {/* Payments */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-semibold">Paid with</span>
              <Button size="sm" variant="flat" startContent={searching ? <Spinner size="sm" /> : <FaSearch />} isDisabled={searching} onPress={findPayment}>
                Find payment
              </Button>
            </div>
            {linksLoading ? (
              <Spinner size="sm" />
            ) : links.length === 0 ? (
              <p className="text-xs text-default-500">Not linked to a transaction.</p>
            ) : (
              links.map((l) =>
                l.tx ? (
                  txRow(
                    l.tx,
                    <Button size="sm" isIconOnly variant="light" aria-label="Unlink" onPress={() => unlink(l)}>
                      <FaUnlink />
                    </Button>,
                  )
                ) : (
                  <div key={l.link.id} className="flex justify-between text-sm text-default-500">
                    <span>Transaction no longer exists</span>
                    <Button size="sm" variant="light" onPress={() => unlink(l)}>
                      Remove link
                    </Button>
                  </div>
                ),
              )
            )}
            {candidates && (
              <div className="mt-2 rounded-medium border border-default-200 p-2">
                {candidates.exact.length + candidates.loose.length === 0 ? (
                  <p className="text-xs text-default-500">No transaction within 30 days of {fmtDate(anchor)} and 5% of the total.</p>
                ) : (
                  <>
                    {candidates.exact.length > 0 && <p className="text-xs font-medium text-success-600">Exact match (amount, within −2/+10 days)</p>}
                    {candidates.exact.map((t) =>
                      txRow(
                        t,
                        <Button size="sm" variant="flat" color="success" startContent={<FaLink />} onPress={() => link(t)}>
                          Link
                        </Button>,
                      ),
                    )}
                    {candidates.loose.length > 0 && <p className="text-xs font-medium text-default-500 mt-1">Close (±30 days, within 5%)</p>}
                    {candidates.loose.slice(0, 15).map((t) =>
                      txRow(
                        t,
                        <Button size="sm" variant="flat" startContent={<FaLink />} onPress={() => link(t)}>
                          Link
                        </Button>,
                      ),
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-default-400">
            {invoice.source === "EMAIL" ? `Emailed by ${invoice.emailFrom ?? "?"}${invoice.emailSubject ? ` · “${invoice.emailSubject}”` : ""}` : "Uploaded"}
            {invoice.receivedAt ? ` · ${fmtDate(invoice.receivedAt.slice(0, 10), { month: "short", day: "numeric", year: "numeric" })}` : ""}
          </p>
        </ModalBody>
        <ModalFooter className="justify-between">
          <Button color="danger" variant="light" startContent={<FaTrash />} onPress={remove}>
            Delete
          </Button>
          <div className="flex gap-2">
            {invoice.parseStatus !== "PARSED" && (
              <Button variant="flat" isDisabled={saving} onPress={() => save({ parseStatus: "PARSED", parseError: null })}>
                Save &amp; mark reviewed
              </Button>
            )}
            <Button color="primary" isLoading={saving} onPress={() => save()}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
