// Import a bank / card CSV export into an account SimpleFIN doesn't sync
// (import_finance_transactions): pick the file, check the preview, import.

import React, { useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Checkbox } from "@heroui/checkbox";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { Select, SelectItem } from "@heroui/select";
import { addToast } from "@heroui/react";

import { financeClient } from "@/components/finance/client";
import { Money } from "@/components/finance/ui";
import { CSV_FORMATS } from "@/lib/finance/csv-import";
import { callOp } from "@/lib/ops-client";
import type { OpOutput } from "@/lib/ops/registry";

type Preview = OpOutput<"import_finance_transactions">;
type Account = { id: string; name?: string | null; simplefinAccountId?: string | null; active?: boolean | null };

const AUTO = "auto";

export function ImportCsvModal({
  isOpen,
  onClose,
  accounts,
  accountId: initialAccount,
  onImported,
}: {
  isOpen: boolean;
  onClose: () => void;
  accounts: Account[];
  accountId?: string | null;
  onImported?: () => void;
}) {
  const importable = accounts.filter((a) => !a.simplefinAccountId && a.active !== false);
  const [accountId, setAccountId] = useState("");
  const [format, setFormat] = useState(AUTO);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setBalance, setSetBalance] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    setAccountId(initialAccount ?? (importable.length === 1 ? importable[0].id : ""));
    setFormat(AUTO);
    setFile(null);
    setPreview(null);
    setError(null);
    setSetBalance(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  async function run(dryRun: boolean, text = file?.text, acct = accountId, fmt = format) {
    if (!text || !acct) return;
    setBusy(true);
    setError(null);
    const r = await callOp(financeClient, "import_finance_transactions", { accountId: acct, csv: text, dryRun, setBalance: dryRun || setBalance, ...(fmt !== AUTO ? { format: fmt } : {}) });
    setBusy(false);
    if ("error" in r) {
      setError(r.error);
      setPreview(null);
      return;
    }
    if (dryRun) {
      setPreview(r.result);
      return;
    }
    const linked = r.result.linked.length;
    addToast({
      title: r.result.created ? `Imported ${r.result.created} into ${r.result.account}` : `${r.result.account} balance updated`,
      description: [r.result.duplicates ? `${r.result.duplicates} already there` : "", linked ? `${linked} linked to scheduled bills` : "", r.result.balance ? `balance ${r.result.balance.after.toFixed(2)}` : ""].filter(Boolean).join(" · ") || undefined,
      color: "success",
    });
    onImported?.();
    onClose();
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    const text = await f.text();
    setFile({ name: f.name, text });
    void run(true, text);
  }

  const balanceChanges = setBalance && !!preview?.balance && Math.abs(preview.balance.after - preview.balance.before) >= 0.005;
  const uncategorized = preview?.rows.filter((r) => !r.category).length ?? 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>Import transactions</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-500">
            For accounts SimpleFIN doesn&apos;t reach. Download the activity export from the bank or card site (on H-E-B: Activity → Export, CSV) and pick it here. Rows already in the account are skipped, so overlapping
            exports are fine.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <Select
              label="Account"
              size="sm"
              selectedKeys={accountId ? [accountId] : []}
              onSelectionChange={(k) => {
                const id = String(Array.from(k)[0] ?? "");
                setAccountId(id);
                void run(true, file?.text, id);
              }}
              description={importable.length === 0 ? "Every account syncs from SimpleFIN. Add a manual account first." : "Accounts synced from SimpleFIN aren't listed."}
            >
              {importable.map((a) => (
                <SelectItem key={a.id}>{a.name ?? a.id}</SelectItem>
              ))}
            </Select>
            <Select
              label="Format"
              size="sm"
              selectedKeys={[format]}
              onSelectionChange={(k) => {
                const f = String(Array.from(k)[0] ?? AUTO);
                setFormat(f);
                void run(true, file?.text, accountId, f);
              }}
              description="Detected from the file's column names. Change it if the amounts' signs look backwards."
            >
              {[<SelectItem key={AUTO}>Detect</SelectItem>, ...CSV_FORMATS.map((f) => <SelectItem key={f}>{f}</SelectItem>)]}
            </Select>
          </div>
          <label className="flex items-center gap-3 rounded-medium border border-dashed border-default-300 px-4 py-3 cursor-pointer hover:bg-default-50">
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
            <span className="text-sm font-medium">{file ? file.name : "Choose a CSV file"}</span>
            {file && <span className="text-xs text-default-400">click to pick another</span>}
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}
          {busy && <p className="text-sm text-default-400">Reading…</p>}
          {preview && !busy && (
            <div className="space-y-2">
              <p className="text-sm">
                <span className="font-medium">{preview.format}</span> · {preview.parsed} rows{preview.from ? ` from ${preview.from} to ${preview.to}` : ""} ·{" "}
                <span className="font-medium">{preview.created} new</span>
                {preview.duplicates ? ` · ${preview.duplicates} already there` : ""}
                {preview.skipped ? ` · ${preview.skipped} unreadable lines skipped` : ""}
                {uncategorized ? ` · ${uncategorized} without a category (they'll be in Review)` : ""}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <Checkbox size="sm" isSelected={setBalance} onValueChange={setSetBalance}>
                  Set the balance from the transactions
                </Checkbox>
                {setBalance && preview.balance && (
                  <span className="text-default-500">
                    <Money value={preview.balance.before} /> → <Money value={preview.balance.after} />
                  </span>
                )}
              </div>
              <p className="text-xs text-default-400 -mt-1">
                A running total of every row in the account. Right when your exports go back to when the account was opened (or its balance was zero); otherwise uncheck it and set the balance by hand.
              </p>
              {preview.rows.length > 0 && (
                <div className="max-h-80 overflow-y-auto border border-default-200 rounded-medium">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-content1">
                      <tr className="text-left text-xs text-default-500">
                        <th className="px-2 py-1 font-medium">Date</th>
                        <th className="px-2 py-1 font-medium">Description</th>
                        <th className="px-2 py-1 font-medium">Category</th>
                        <th className="px-2 py-1 font-medium text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r, i) => (
                        <tr key={i} className="border-t border-default-100">
                          <td className="px-2 py-1 whitespace-nowrap text-default-500">{r.date}</td>
                          <td className="px-2 py-1">{r.description}</td>
                          <td className="px-2 py-1 text-default-500">{r.category ?? "—"}</td>
                          <td className="px-2 py-1 text-right">
                            <Money value={r.amount} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {preview.created > preview.rows.length && <p className="text-xs text-default-400">Showing the first {preview.rows.length}.</p>}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" isLoading={busy && !!preview} isDisabled={!preview || (preview.created === 0 && !balanceChanges) || busy} onPress={() => void run(false)}>
            {!preview ? "Import" : preview.created === 0 && balanceChanges ? "Set balance" : `Import ${preview.created}`}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
