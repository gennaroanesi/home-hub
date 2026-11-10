"use client";

// /finance/paychecks — both of our paystubs: the review inbox for stubs
// emailed to paychecks@import.cristinegennaro.com (paycheck-processor), PDF
// upload (parsePaycheckPdf → prefilled form), per-person YTD from the latest
// stub, and "contributions vs pay": of what each of us took home, how much
// went into the joint account. Ported from gennaroanesi.com's paychecks page
// with personId instead of ME/SPOUSE.

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Select, SelectItem } from "@heroui/select";
import { Spinner, addToast } from "@heroui/react";
import { FaEnvelopeOpenText, FaExternalLinkAlt, FaFilePdf, FaPen, FaPlus, FaTimes, FaUpload } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money, PersonChip, ago } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { PeriodPicker, usePeriod } from "@/components/finance/period-picker";
import { PaycheckForm, parseJsonLayers, type PaycheckFormInit } from "@/components/finance/paycheck-form";
import { listAllPages } from "@/lib/list-all";
import { isInvested } from "@/lib/finance/accounts";
import { listPaychecks, listTransactions } from "@/lib/finance/data";
import { fmtCurrency, fmtDate, todayIso } from "@/lib/finance/dates";
import { periodContaining } from "@/lib/finance/periods";
import { contributionShare, latestByPerson } from "@/lib/finance/paychecks";
import { draftToPaycheck } from "@/lib/finance/paycheck-fields";

const n = (v: number | null | undefined) => v ?? 0;
const taxesOf = (p: any) => n(p.fedWh) + n(p.stateWh) + n(p.oasdi) + n(p.medicare);
const retirementOf = (p: any) => n(p.contrib401k) + n(p.contribRoth401k) + n(p.contribAfterTax401k);
const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);

export default function PaychecksPage() {
  const refs = useFinanceRefs();
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));

  const [paychecks, setPaychecks] = useState<any[]>([]);
  const [inbox, setInbox] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState(thisYear);
  const [personFilter, setPersonFilter] = useState("");
  const [form, setForm] = useState<PaycheckFormInit | null>(null);
  const [parsing, setParsing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, ib] = await Promise.all([listPaychecks(financeClient), listAllPages<any>(financeClient.models.homePaycheckInbox)]);
      setPaychecks(p);
      setInbox(ib.filter((r) => r.status === "NEEDS_REVIEW" || r.status === "ERROR").sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "")));
    } catch (e) {
      addToast({ title: "Couldn't load paychecks", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const years = useMemo(() => {
    const ys = new Set<number>([thisYear]);
    for (const p of paychecks) ys.add(Number(String(p.payDate).slice(0, 4)));
    return [...ys].sort((a, b) => b - a);
  }, [paychecks, thisYear]);

  const yearRows = useMemo(
    () => paychecks.filter((p) => Number(String(p.payDate).slice(0, 4)) === year && (!personFilter || p.personId === personFilter)),
    [paychecks, year, personFilter],
  );
  const latest = useMemo(() => latestByPerson(paychecks, year), [paychecks, year]);
  const peopleById = useMemo(() => new Map(refs.people.map((p) => [p.id, p])), [refs.people]);

  // ── Contributions vs pay ──────────────────────────────────────────────────
  const { period, range, setPeriod } = usePeriod(() => periodContaining("year", today));
  const [txs, setTxs] = useState<any[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const accountIds = useMemo(() => refs.accounts.filter((a) => !isInvested(a.type)).map((a) => a.id), [refs.accounts]);
  useEffect(() => {
    if (refs.loading) return;
    let cancelled = false;
    setTxLoading(true);
    listTransactions(financeClient, { fromIso: range.fromIso, toIso: range.toIso, accountIds })
      .then((t) => !cancelled && setTxs(t))
      .catch((e) => addToast({ title: "Couldn't load contributions", description: e instanceof Error ? e.message : String(e), color: "danger" }))
      .finally(() => !cancelled && setTxLoading(false));
    return () => {
      cancelled = true;
    };
  }, [refs.loading, range.fromIso, range.toIso, accountIds]);
  const shares = useMemo(() => contributionShare(paychecks, txs, range, refs.people.map((p) => p.id)), [paychecks, txs, range, refs.people]);
  const maxNet = Math.max(1, ...shares.map((s) => Math.max(s.net, s.contributed)));

  // ── Upload ────────────────────────────────────────────────────────────────
  async function upload(file: File) {
    if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      addToast({ title: "That isn't a PDF", color: "warning" });
      return;
    }
    setParsing(true);
    try {
      const pres = await fetch("/api/finance/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "paycheck", sizeBytes: file.size }),
      });
      const presign = await pres.json().catch(() => ({}));
      if (!pres.ok) throw new Error(presign.error ?? `Upload URL failed (${pres.status})`);
      const put = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const r = await financeClient.mutations.parsePaycheckPdf({ s3Key: presign.s3Key });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      const res: any = parseJsonLayers(r.data) ?? {};
      if (!res.ok) {
        // Keep the PDF: open an empty form so it can be typed in by hand.
        addToast({ title: "Couldn't read the stub", description: res.error ?? "Enter it by hand.", color: "warning" });
        setForm({ source: "UPLOAD", s3KeyPdf: presign.s3Key, warning: `Extraction failed: ${res.error ?? "unknown error"}. Enter the numbers from the PDF.` });
        return;
      }
      const draft = (parseJsonLayers(res.draft) ?? {}) as Record<string, unknown>;
      const dupe = res.duplicateOf ? "A paycheck for this person, pay date and net already exists. Saving will add a second one." : null;
      const noPerson = res.personId ? null : `Couldn't tell whose stub this is${draft.employeeName ? ` (“${draft.employeeName}”)` : ""}; pick the person.`;
      setForm({
        source: "UPLOAD",
        s3KeyPdf: res.s3Key ?? presign.s3Key,
        personId: res.personId ?? null,
        values: draftToPaycheck(draft),
        warning: [dupe, noPerson].filter(Boolean).join(" ") || null,
      });
    } catch (e) {
      addToast({ title: "Upload failed", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function review(row: any) {
    const draft = (parseJsonLayers(row.draft) ?? {}) as Record<string, unknown>;
    setForm({
      source: "EMAIL",
      s3KeyPdf: row.s3KeyPdf ?? null,
      inboxId: row.id,
      personId: row.personId ?? null,
      values: draftToPaycheck(draft),
      warning: row.parseError ?? null,
    });
  }

  async function dismiss(row: any) {
    if (!confirm(`Dismiss “${row.emailSubject ?? row.filename ?? "this email"}”? It won't be imported.`)) return;
    const r = await financeClient.models.homePaycheckInbox.update({ id: row.id, status: "DISMISSED" });
    if (r.errors?.length) addToast({ title: "Couldn't dismiss", description: r.errors[0].message, color: "danger" });
    else load();
  }

  const totals = useMemo(
    () =>
      yearRows.reduce(
        (t, p) => ({ gross: t.gross + n(p.gross), taxes: t.taxes + taxesOf(p), retirement: t.retirement + retirementOf(p), net: t.net + n(p.net) }),
        { gross: 0, taxes: 0, retirement: 0, net: 0 },
      ),
    [yearRows],
  );

  return (
    <FinanceShell
      title="Paychecks"
      subtitle="Our paystubs, and how much of what we take home goes to the house"
      onSynced={load}
      actions={
        <>
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <Button size="sm" variant="flat" startContent={parsing ? <Spinner size="sm" /> : <FaUpload />} isDisabled={parsing} onPress={() => fileRef.current?.click()}>
            {parsing ? "Reading stub…" : "Upload stub"}
          </Button>
          <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => setForm({ source: "MANUAL", personId: personFilter || null })}>
            Add manually
          </Button>
        </>
      }
    >
      {parsing && <p className="text-xs text-default-500 mb-3">Claude is reading the stub; this usually takes 20–40 seconds.</p>}

      {loading || refs.loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* Inbox */}
          {inbox.length > 0 && (
            <Card className="border border-warning-200">
              <CardHeader className="font-semibold flex items-center gap-2">
                <FaEnvelopeOpenText className="text-warning-500" /> {inbox.length} emailed stub{inbox.length === 1 ? "" : "s"} to review
              </CardHeader>
              <CardBody className="pt-0 gap-2">
                {inbox.map((row) => {
                  const draft: any = parseJsonLayers(row.draft) ?? {};
                  return (
                    <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 text-sm border-b border-default-100 last:border-0 pb-2 last:pb-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {row.personId ? <PersonChip personId={row.personId} people={refs.people} /> : <Chip size="sm" color="warning" variant="flat">person?</Chip>}
                          <span className="font-medium">{draft.payDate ? fmtDate(draft.payDate, { month: "short", day: "numeric", year: "numeric" }) : "—"}</span>
                          {typeof draft.net === "number" && <span className="text-default-500">net {fmtCurrency(draft.net)}</span>}
                          {row.status === "ERROR" && <Chip size="sm" color="danger" variant="flat">couldn&apos;t read</Chip>}
                        </div>
                        <div className="text-xs text-default-400 truncate">
                          {row.emailFrom ?? "?"} · {row.emailSubject ?? "(no subject)"} · {ago(row.receivedAt)}
                        </div>
                        {row.parseError && <div className="text-xs text-warning-600">{row.parseError}</div>}
                      </div>
                      <div className="flex items-center gap-1">
                        {row.s3KeyPdf && (
                          <Button as="a" href={`/api/finance/file?key=${encodeURIComponent(row.s3KeyPdf)}`} target="_blank" rel="noreferrer" size="sm" variant="light" isIconOnly aria-label="Open PDF">
                            <FaFilePdf />
                          </Button>
                        )}
                        <Button size="sm" color="primary" variant="flat" onPress={() => review(row)}>
                          Review
                        </Button>
                        <Button size="sm" variant="light" isIconOnly aria-label="Dismiss" onPress={() => dismiss(row)}>
                          <FaTimes />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </CardBody>
            </Card>
          )}

          {/* Contributions vs pay */}
          <Card>
            <CardHeader className="flex flex-col items-start gap-2">
              <span className="font-semibold">Contributions vs pay</span>
              <PeriodPicker value={period} onChange={setPeriod} />
            </CardHeader>
            <CardBody className="pt-0 gap-3">
              {txLoading ? (
                <Spinner size="sm" />
              ) : (
                shares.map((s) => {
                  const person = peopleById.get(s.personId);
                  return (
                    <div key={s.personId} className="text-sm">
                      <div className="flex flex-wrap justify-between gap-2 items-center">
                        <PersonChip personId={s.personId} people={refs.people} />
                        <span className="flex gap-4 tabular-nums text-xs sm:text-sm">
                          <span>
                            took home <Money value={s.net} cents={false} />
                          </span>
                          <span>
                            put in <Money value={s.contributed} cents={false} />
                          </span>
                          <span className="font-semibold">{pct(s.shareOfNet)} of take-home</span>
                          <span className="text-default-500">{pct(s.shareOfGross)} of gross</span>
                        </span>
                      </div>
                      <div className="relative h-2 mt-1 rounded bg-default-100" title={`${person?.name ?? ""}: contributed vs take-home`}>
                        <div className="absolute inset-y-0 left-0 rounded bg-default-300" style={{ width: `${(s.net / maxNet) * 100}%` }} />
                        <div className="absolute inset-y-0 left-0 rounded bg-primary" style={{ width: `${(Math.min(s.contributed, maxNet) / maxNet) * 100}%` }} />
                      </div>
                      {s.net === 0 && <p className="text-xs text-default-400 mt-1">No paychecks recorded in {range.label}.</p>}
                    </div>
                  );
                })
              )}
              <p className="text-xs text-default-500">
                &ldquo;Put in&rdquo; is money into the household accounts categorized Contribution and attributed to each person. Set that up with a person rule per transfer on{" "}
                <NextLink href="/finance/rules" className="text-primary">
                  Rules
                </NextLink>
                .
              </p>
            </CardBody>
          </Card>

          {/* Year + filter */}
          <div className="flex flex-wrap items-center gap-2">
            <Select size="sm" aria-label="Year" className="w-28" selectedKeys={new Set([String(year)])} onSelectionChange={(k) => setYear(Number(Array.from(k as Set<string>)[0] ?? thisYear))}>
              {years.map((y) => (
                <SelectItem key={String(y)}>{String(y)}</SelectItem>
              ))}
            </Select>
            <Select size="sm" aria-label="Person" className="w-44" selectedKeys={new Set([personFilter || "all"])} onSelectionChange={(k) => {
              const v = String(Array.from(k as Set<string>)[0] ?? "all");
              setPersonFilter(v === "all" ? "" : v);
            }}>
              {[{ id: "all", name: "Both of us" }, ...refs.people].map((p) => (
                <SelectItem key={p.id}>{p.name}</SelectItem>
              ))}
            </Select>
          </div>

          {/* YTD per person, from the latest stub */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {refs.people
              .filter((p) => !personFilter || p.id === personFilter)
              .map((p) => {
                const l = latest.get(p.id);
                return (
                  <Card key={p.id}>
                    <CardBody className="gap-2">
                      <div className="flex justify-between items-center">
                        <PersonChip personId={p.id} people={refs.people} />
                        <span className="text-xs text-default-500">{l ? `YTD as of ${fmtDate(l.payDate, { month: "short", day: "numeric" })}${l.employer ? ` · ${l.employer}` : ""}` : `No stubs in ${year}`}</span>
                      </div>
                      {l && (
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-sm">
                          {[
                            ["Gross", l.ytdGross],
                            ["Taxable", l.ytdTaxableWage],
                            ["Fed WH", l.ytdFedWh],
                            ["401k", n(l.ytd401k) + n(l.ytdRoth401k) + n(l.ytdAfterTax401k) || null],
                            ["Net", l.ytdNet],
                          ].map(([label, v]) => (
                            <div key={label as string}>
                              <div className="text-xs text-default-500">{label}</div>
                              <Money value={v as number | null} cents={false} />
                            </div>
                          ))}
                        </div>
                      )}
                    </CardBody>
                  </Card>
                );
              })}
          </div>

          {/* Stubs */}
          <Card>
            <CardHeader className="font-semibold flex justify-between flex-wrap gap-2">
              <span>
                {yearRows.length} paycheck{yearRows.length === 1 ? "" : "s"} in {year}
              </span>
              {yearRows.length > 0 && (
                <span className="text-xs font-normal text-default-500 flex gap-3 tabular-nums">
                  <span>gross {fmtCurrency(totals.gross, { cents: false })}</span>
                  <span>taxes {fmtCurrency(totals.taxes, { cents: false })}</span>
                  <span>401k {fmtCurrency(totals.retirement, { cents: false })}</span>
                  <span>net {fmtCurrency(totals.net, { cents: false })}</span>
                </span>
              )}
            </CardHeader>
            <CardBody className="pt-0">
              {yearRows.length === 0 ? (
                <EmptyState title={`No paychecks in ${year}`}>Upload a stub, add one by hand, or forward the PDF to paychecks@import.cristinegennaro.com.</EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-default-500 text-left">
                        <th className="py-1 pr-2 font-normal">Pay date</th>
                        <th className="py-1 pr-2 font-normal">Who</th>
                        <th className="py-1 pr-2 font-normal hidden md:table-cell">Employer</th>
                        <th className="py-1 pr-2 font-normal text-right">Gross</th>
                        <th className="py-1 pr-2 font-normal text-right">Taxes</th>
                        <th className="py-1 pr-2 font-normal text-right">401k</th>
                        <th className="py-1 pr-2 font-normal text-right">Net</th>
                        <th className="py-1 font-normal" />
                      </tr>
                    </thead>
                    <tbody>
                      {yearRows.map((p) => {
                        const supplemental = n(p.bonusGross) + n(p.rsuGross);
                        return (
                          <tr key={p.id} className="border-t border-default-100 hover:bg-default-50 cursor-pointer" onClick={() => setForm({ id: p.id, source: p.source ?? "MANUAL", s3KeyPdf: p.s3KeyPdf, personId: p.personId, values: p })}>
                            <td className="py-1.5 pr-2 whitespace-nowrap">
                              {fmtDate(p.payDate, { month: "short", day: "numeric" })}
                              {supplemental > 0 && (
                                <Chip size="sm" variant="flat" color="secondary" className="ml-1">
                                  {n(p.rsuGross) > 0 ? "RSU" : "bonus"} {fmtCurrency(supplemental, { cents: false })}
                                </Chip>
                              )}
                            </td>
                            <td className="py-1.5 pr-2">
                              <PersonChip personId={p.personId} people={refs.people} />
                            </td>
                            <td className="py-1.5 pr-2 hidden md:table-cell text-default-500 truncate max-w-40">{p.employer ?? "—"}</td>
                            <td className="py-1.5 pr-2 text-right">
                              <Money value={p.gross} />
                            </td>
                            <td className="py-1.5 pr-2 text-right text-default-500">
                              <Money value={taxesOf(p)} />
                            </td>
                            <td className="py-1.5 pr-2 text-right text-default-500">
                              <Money value={retirementOf(p)} />
                            </td>
                            <td className="py-1.5 pr-2 text-right font-medium">
                              <Money value={p.net} />
                            </td>
                            <td className="py-1.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              {p.source && p.source !== "MANUAL" && (
                                <Chip size="sm" variant="flat" className="mr-1">
                                  {String(p.source).toLowerCase()}
                                </Chip>
                              )}
                              {p.s3KeyPdf && (
                                <a href={`/api/finance/file?key=${encodeURIComponent(p.s3KeyPdf)}`} target="_blank" rel="noreferrer" aria-label="Open PDF" className="inline-flex text-default-500 hover:text-primary mr-2">
                                  <FaExternalLinkAlt />
                                </a>
                              )}
                              <button type="button" aria-label="Edit" className="inline-flex text-default-500 hover:text-primary" onClick={() => setForm({ id: p.id, source: p.source ?? "MANUAL", s3KeyPdf: p.s3KeyPdf, personId: p.personId, values: p })}>
                                <FaPen />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {form && (
        <PaycheckForm
          init={form}
          people={refs.people}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            load();
          }}
        />
      )}
    </FinanceShell>
  );
}

