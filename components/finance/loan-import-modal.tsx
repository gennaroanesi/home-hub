"use client";

// "Import lender schedule" on a loan page: a lender's amortization /
// payment-history PDF is uploaded (kind "loan"), read by
// parseLoanSchedulePdf, shown here for a check, then written with
// import_loan_payments (rows matched to existing payments by date, the
// lender's split wins, the manual balance set to the lender's figure).

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Checkbox } from "@heroui/checkbox";
import { Input } from "@heroui/input";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { Chip, addToast } from "@heroui/react";

import { financeClient } from "@/components/finance/client";
import { Money } from "@/components/finance/ui";
import { parseJsonLayers } from "@/lib/finance/paycheck-screen";
import { callOp } from "@/lib/ops-client";
import { fmtCurrency, fmtDate } from "@/lib/finance/dates";
import type { ExtractedLoanSchedule } from "@/lib/finance/loan-schedule-extract";

/** Upload the PDF and get its rows back. Throws with a readable message. */
export async function parseLoanSchedulePdf(file: File): Promise<ExtractedLoanSchedule> {
  if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) throw new Error("That isn't a PDF");
  const pres = await fetch("/api/finance/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "loan", sizeBytes: file.size }),
  });
  const presign = await pres.json().catch(() => ({}));
  if (!pres.ok) throw new Error(presign.error ?? `Upload URL failed (${pres.status})`);
  const put = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  const r = await (financeClient as any).mutations.parseLoanSchedulePdf({ s3Key: presign.s3Key });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  const res: any = parseJsonLayers(r.data) ?? {};
  if (!res.ok) throw new Error(res.error ?? "Couldn't read the schedule");
  return (parseJsonLayers(res.schedule) ?? res.schedule) as ExtractedLoanSchedule;
}

export function LoanImportModal({
  schedule,
  loan,
  synced,
  existingDates,
  onClose,
  onSaved,
}: {
  schedule: ExtractedLoanSchedule | null; // null = closed
  loan: any;
  synced: boolean;
  existingDates: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [setBalance, setSetBalance] = useState(true);
  const [source, setSource] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!schedule) return;
    setSetBalance(!synced && schedule.balanceAfter != null);
    setSource([schedule.lender, schedule.asOf ? fmtDate(schedule.asOf, { month: "short", day: "numeric", year: "numeric" }) : ""].filter(Boolean).join(" · "));
  }, [schedule, synced]);

  if (!schedule) return null;
  const rows = schedule.rows;
  const good = rows.filter((r) => !r.problem);
  const bad = rows.filter((r) => r.problem);
  const newCount = good.filter((r) => !existingDates.has(r.date)).length;
  const totals = good.reduce((t, r) => ({ principal: t.principal + r.principal, interest: t.interest + r.interest }), { principal: 0, interest: 0 });

  async function save() {
    if (!good.length) return;
    setSaving(true);
    const r = await callOp(financeClient, "import_loan_payments", {
      loanId: loan.id,
      rows: good.map((x) => ({ number: x.number, date: x.date, total: x.total, principal: x.principal, interest: x.interest, fees: x.fees, escrow: x.escrow, balance: x.balance })),
      owedAfter: setBalance ? schedule!.balanceAfter : null,
      source: source.trim() || null,
    });
    setSaving(false);
    if ("error" in r) return addToast({ title: "Couldn't import", description: r.error, color: "danger" });
    const { created, updated, unchanged, owed, balanceMoved } = r.result;
    addToast({
      title: `Imported ${good.length} payment${good.length === 1 ? "" : "s"}`,
      description: `${created} new, ${updated} corrected, ${unchanged} already right.${balanceMoved ? ` Balance set to ${fmtCurrency(owed)}.` : ""}`,
      color: "success",
    });
    onSaved();
    onClose();
  }

  return (
    <Modal isOpen onClose={onClose} size="4xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col items-start gap-0.5">
          <span>Import the lender&apos;s schedule</span>
          <span className="text-xs font-normal text-default-500">
            {[schedule.lender, schedule.accountRef, schedule.asOf ? `as of ${fmtDate(schedule.asOf, { month: "short", day: "numeric", year: "numeric" })}` : ""].filter(Boolean).join(" · ") || "Payment history"}
          </span>
        </ModalHeader>
        <ModalBody className="gap-3">
          <div className="text-sm">
            {rows.length} payment{rows.length === 1 ? "" : "s"}: <b>{newCount}</b> new, {good.length - newCount} already recorded (corrected to the lender&apos;s split). Principal <Money value={totals.principal} cents={false} />, interest <Money value={totals.interest} cents={false} />.
            {bad.length > 0 && <span className="text-warning-600"> {bad.length} row{bad.length === 1 ? "" : "s"} don&apos;t add up and will be skipped.</span>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input size="sm" label="Source" value={source} onValueChange={setSource} description="Kept in each payment's notes" />
            {schedule.balanceAfter != null && (
              <Checkbox isSelected={setBalance} onValueChange={setSetBalance} isDisabled={synced} size="sm" className="self-end">
                <span className="text-sm">
                  Set the balance to the lender&apos;s <Money value={schedule.balanceAfter} />
                  {synced && <span className="text-default-500"> (synced from the bank; can&apos;t)</span>}
                </span>
              </Checkbox>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums min-w-lg">
              <thead className="text-xs text-default-500 text-right">
                <tr>
                  <th className="text-left font-normal py-1">#</th>
                  <th className="text-left font-normal">Date</th>
                  <th className="font-normal">Paid</th>
                  <th className="font-normal">Principal</th>
                  <th className="font-normal">Interest</th>
                  <th className="font-normal">Fees</th>
                  <th className="font-normal">Balance</th>
                  <th className="text-left font-normal" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={`text-right ${r.problem ? "text-warning-600" : ""}`}>
                    <td className="text-left text-default-400 py-0.5">{r.number ?? "—"}</td>
                    <td className="text-left">{fmtDate(r.date, { month: "short", day: "numeric", year: "numeric" })}</td>
                    <td>{fmtCurrency(r.total)}</td>
                    <td>{fmtCurrency(r.principal)}</td>
                    <td>{fmtCurrency(r.interest)}</td>
                    <td className="text-default-500">{r.fees ? fmtCurrency(r.fees) : "—"}</td>
                    <td className="text-default-500">{r.balance != null ? fmtCurrency(r.balance, { cents: false }) : "—"}</td>
                    <td className="text-left pl-2">
                      {r.problem ? (
                        <Chip size="sm" color="warning" variant="flat" className="h-5">
                          {r.problem}
                        </Chip>
                      ) : existingDates.has(r.date) ? (
                        <span className="text-xs text-default-400">recorded</span>
                      ) : (
                        <Chip size="sm" color="success" variant="flat" className="h-5">
                          new
                        </Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" isLoading={saving} isDisabled={!good.length} onPress={save}>
            Import {good.length} payment{good.length === 1 ? "" : "s"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
