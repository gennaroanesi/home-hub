"use client";

// /finance/invoices — household invoices, receipts and bills. They arrive by
// email (invoices@import.cristinegennaro.com → SES → invoice-processor) or
// are uploaded here (→ ingestInvoicePdf); Claude reads the fields, and the
// processor links the one transaction that paid it when exactly one
// matches. This page reviews and corrects them, and links payments by hand.
// Ported and trimmed from gennaroanesi.com's /finance/invoices.
// Each has an owner (household or a member) and can be private: another
// member's private invoices aren't listed (lib/finance/invoice-owner.ts).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Spinner, addToast } from "@heroui/react";
import { FaEnvelope, FaExternalLinkAlt, FaFileUpload, FaLink, FaLock, FaSearch } from "react-icons/fa";
import { getCurrentUser } from "aws-amplify/auth";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { InvoiceDetailModal, fileUrl } from "@/components/finance/invoice-detail-modal";
import { listAllPages } from "@/lib/list-all";
import { fmtDate } from "@/lib/finance/dates";
import { invoiceOwnerIds, invoiceOwnerLabel } from "@/lib/finance/invoice-owner";
import {
  INVOICE_INBOX as INBOX,
  filterInvoices,
  invoiceIsPaid,
  invoiceTotals,
  invoiceYears,
  type InvoicePaidFilter as PaidFilter,
  type InvoiceStatusFilter as StatusFilter,
} from "@/lib/finance/invoice-screen";

/* eslint-disable @typescript-eslint/no-explicit-any */

function unwrap(data: unknown): any {
  let v = data;
  while (typeof v === "string") v = JSON.parse(v);
  return v;
}

export default function InvoicesPage() {
  const refs = useFinanceRefs();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [paid, setPaid] = useState<PaidFilter>("all");
  const [year, setYear] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<string>("all");
  const [username, setUsername] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, links] = await Promise.all([
        listAllPages<any>(financeClient.models.homeInvoice),
        listAllPages<any>(financeClient.models.homeInvoiceLink),
      ]);
      setInvoices(rows);
      setLinkedIds(new Set(links.map((l) => l.invoiceId)));
    } catch (e) {
      addToast({ title: "Couldn't load invoices", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    getCurrentUser()
      .then((u) => setUsername(u.username))
      .catch(() => setUsername(null));
  }, [load]);

  // Who's looking, as a household member: their private invoices show, others' don't.
  const viewerId = useMemo(() => refs.household.find((p: any) => p.cognitoUsername === username)?.id ?? null, [refs.household, username]);

  const years = useMemo(() => invoiceYears(invoices), [invoices]);
  const shown = useMemo(
    () => filterInvoices(invoices, linkedIds, { status, paid, year, query, viewer: viewerId, owner }),
    [invoices, linkedIds, status, paid, year, query, viewerId, owner],
  );
  const totals = useMemo(() => invoiceTotals(shown, linkedIds), [shown, linkedIds]);

  async function upload(file: File) {
    if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      addToast({ title: "Only PDFs", color: "warning" });
      return;
    }
    setUploading(true);
    try {
      const presign = await fetch("/api/finance/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "invoice", sizeBytes: file.size }),
      });
      const p = await presign.json().catch(() => ({}));
      if (!presign.ok) throw new Error(p.error ?? `Upload URL failed (${presign.status})`);
      const put = await fetch(p.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const r = await financeClient.mutations.ingestInvoicePdf({ s3Key: p.s3Key, filename: file.name });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      const out = unwrap(r.data) ?? {};
      if (!out.ok) {
        if (out.invoiceId) {
          addToast({ title: "Already have this invoice", color: "warning" });
          await load();
          setOpenId(out.invoiceId);
          return;
        }
        throw new Error(out.error ?? "Couldn't read the invoice");
      }
      addToast({ title: "Invoice added", description: out.linkedTransactionId ? "Matched to its payment." : undefined, color: "success" });
      await load();
      setOpenId(out.invoiceId);
    } catch (e) {
      addToast({ title: "Upload failed", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const open = invoices.find((i) => i.id === openId) ?? null;

  return (
    <FinanceShell
      title="Invoices"
      subtitle={
        <span className="flex items-center gap-1">
          <FaEnvelope /> Forward invoices and receipts to <span className="font-mono">{INBOX}</span>; only our own addresses are processed.
        </span>
      }
      actions={
        <>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <Button size="sm" color="primary" startContent={uploading ? <Spinner size="sm" color="white" /> : <FaFileUpload />} isDisabled={uploading} onPress={() => fileInput.current?.click()}>
            {uploading ? "Reading…" : "Upload invoice"}
          </Button>
        </>
      }
    >
      {uploading && <p className="text-xs text-default-500 mb-3">Reading the PDF with Claude; this takes 20–40 seconds.</p>}

      <div className="flex flex-wrap items-end gap-2 mb-3">
        <Input size="sm" className="w-56" placeholder="Vendor, number, notes" startContent={<FaSearch className="text-default-400" />} value={query} onValueChange={setQuery} aria-label="Search" />
        <Select size="sm" className="w-40" aria-label="Status" selectedKeys={new Set([status])} onSelectionChange={(k) => setStatus((Array.from(k as Set<string>)[0] as StatusFilter) ?? "all")}>
          <SelectItem key="all">All statuses</SelectItem>
          <SelectItem key="review">Needs review</SelectItem>
          <SelectItem key="parsed">Reviewed</SelectItem>
        </Select>
        <Select size="sm" className="w-36" aria-label="Paid" selectedKeys={new Set([paid])} onSelectionChange={(k) => setPaid((Array.from(k as Set<string>)[0] as PaidFilter) ?? "all")}>
          <SelectItem key="all">Paid or not</SelectItem>
          <SelectItem key="unpaid">Unpaid</SelectItem>
          <SelectItem key="paid">Paid</SelectItem>
        </Select>
        <Select size="sm" className="w-40" aria-label="Whose" selectedKeys={new Set([owner])} onSelectionChange={(k) => setOwner((Array.from(k as Set<string>)[0] as string) ?? "all")}>
          {[<SelectItem key="all">Everyone&apos;s</SelectItem>, ...refs.household.map((p: any) => <SelectItem key={p.id}>{`${p.name} + household`}</SelectItem>)]}
        </Select>
        <Select size="sm" className="w-32" aria-label="Year" selectedKeys={new Set([year])} onSelectionChange={(k) => setYear((Array.from(k as Set<string>)[0] as string) ?? "all")}>
          {[<SelectItem key="all">All years</SelectItem>, ...years.map((y) => <SelectItem key={y}>{y}</SelectItem>)]}
        </Select>
      </div>

      {loading || refs.loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : invoices.length === 0 ? (
        <EmptyState title="No invoices yet">
          Forward one to <span className="font-mono">{INBOX}</span> or upload a PDF.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Card>
              <CardBody className="gap-0.5">
                <span className="text-xs text-default-500">{shown.length} invoice{shown.length === 1 ? "" : "s"}</span>
                <Money value={totals.sum} className="text-lg font-semibold" />
              </CardBody>
            </Card>
            <Card>
              <CardBody className="gap-0.5">
                <span className="text-xs text-default-500">Not paid yet</span>
                <Money value={totals.unpaid} className="text-lg font-semibold" />
              </CardBody>
            </Card>
            <Card>
              <CardBody className="gap-0.5">
                <span className="text-xs text-default-500">Need review</span>
                <span className={`text-lg font-semibold ${totals.review ? "text-warning-600" : ""}`}>{totals.review}</span>
              </CardBody>
            </Card>
          </div>

          {shown.length === 0 ? (
            <EmptyState title="Nothing matches these filters" />
          ) : (
            <Card>
              <CardBody className="p-0">
                {shown.map((inv) => {
                  const isLinked = linkedIds.has(inv.id);
                  const isPaid = invoiceIsPaid(inv, linkedIds);
                  return (
                    <div
                      key={inv.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setOpenId(inv.id)}
                      onKeyDown={(e) => e.key === "Enter" && setOpenId(inv.id)}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 border-b border-default-100 last:border-0 hover:bg-default-50 cursor-pointer"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium truncate">{inv.vendor ?? "Unknown vendor"}</span>
                          {inv.invoiceNumber && <span className="text-xs text-default-400">#{inv.invoiceNumber}</span>}
                          {inv.parseStatus === "ERROR" && (
                            <Chip size="sm" color="danger" variant="flat">
                              couldn&apos;t read
                            </Chip>
                          )}
                          {inv.parseStatus === "NEEDS_REVIEW" && (
                            <Chip size="sm" color="warning" variant="flat">
                              needs review
                            </Chip>
                          )}
                          {inv.category && (
                            <Chip size="sm" variant="flat">
                              {inv.category}
                            </Chip>
                          )}
                          {invoiceOwnerIds(inv).length > 0 && (
                            <Chip size="sm" variant="bordered" startContent={inv.private ? <FaLock className="ml-1" size={9} /> : undefined}>
                              {invoiceOwnerLabel(inv, refs.household)}
                              {inv.private ? " · private" : ""}
                            </Chip>
                          )}
                        </div>
                        <div className="text-xs text-default-400 flex flex-wrap gap-x-2">
                          <span>{inv.issueDate ? fmtDate(inv.issueDate, { month: "short", day: "numeric", year: "numeric" }) : "no date"}</span>
                          {inv.dueDate && <span>due {fmtDate(inv.dueDate, { month: "short", day: "numeric", year: "numeric" })}</span>}
                          <span>{inv.source === "EMAIL" ? `emailed by ${inv.emailFrom ?? "?"}` : "uploaded"}</span>
                          {inv.parseStatus !== "PARSED" && inv.parseError && <span className="text-warning-600">{inv.parseError}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0" onClick={(e) => e.stopPropagation()}>
                        {isPaid ? (
                          <Chip size="sm" color="success" variant="flat" startContent={isLinked ? <FaLink className="ml-1" /> : undefined}>
                            {isLinked ? "paid · linked" : "paid"}
                          </Chip>
                        ) : (
                          <Chip size="sm" variant="flat">
                            unpaid
                          </Chip>
                        )}
                        <a href={fileUrl(inv.s3KeyPdf)} target="_blank" rel="noreferrer" className="text-xs text-primary flex items-center gap-1" aria-label="Open PDF">
                          PDF <FaExternalLinkAlt />
                        </a>
                        {inv.s3KeyOriginal && (
                          <a href={`${fileUrl(inv.s3KeyOriginal)}&download=1`} className="text-xs text-primary" aria-label="Download original email">
                            .eml
                          </a>
                        )}
                        <span className="w-24 text-right font-medium">
                          {inv.total == null ? <span className="text-default-400">—</span> : <Money value={inv.total} />}
                          {inv.currency && inv.currency !== "USD" && <span className="text-xs text-default-400"> {inv.currency}</span>}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </CardBody>
            </Card>
          )}
        </>
      )}

      <InvoiceDetailModal invoice={open} categories={refs.categories} groups={refs.groups} accounts={refs.accounts} people={refs.household} viewerId={viewerId} onClose={() => setOpenId(null)} onChanged={load} />
    </FinanceShell>
  );
}
