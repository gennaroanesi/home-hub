"use client";

// /finance/rules — the category rules the sync classifies with
// (homeFinanceCategoryRule; first match wins by sortOrder). While the table
// is empty the bundled lib/finance/category-rules.json applies; it can be
// copied here to edit. Includes a tester and a "re-apply" pass over recent
// transactions that never touches anything set by hand.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Switch } from "@heroui/switch";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast, Spinner } from "@heroui/react";
import { FaArrowDown, FaArrowUp, FaCopy, FaPen, FaPlus, FaSyncAlt, FaTrash } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { FinanceCategoryManager } from "@/components/finance/category-manager";
import { financeClient } from "@/components/finance/client";
import { EmptyState, PersonChip } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { CategoryInput } from "@/components/finance/category-input";
import { CATEGORY_RULES, rulesFromDbRows } from "@/lib/finance/categories";
import { addDays, todayIso } from "@/lib/finance/dates";
import { listCategoryRules, listTransactions } from "@/lib/finance/data";
import { HOUSEHOLD as HOUSEHOLD_LEDGER, accountLedger, ledgerLabel, ledgerPeople } from "@/lib/finance/ledger";
import {
  moveRuleUpdates,
  newRuleSortOrder,
  planRuleChanges,
  reapplyDays,
  ruleChangePatch,
  rulePatternError,
  ruleSaveError,
  testRules,
  type RuleChange,
} from "@/lib/finance/rule-tools";
import { REFUND_LOOKBACK_DAYS } from "@/lib/finance/refunds";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HOUSEHOLD = "__none";
const ACCOUNT_LEDGER = "__account";

export default function RulesPage() {
  const refs = useFinanceRefs();
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<any | null>(null); // {} = new

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listCategoryRules(financeClient));
    } catch (e) {
      addToast({ title: "Couldn't load rules", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const usingBundled = !loading && rows.length === 0;

  async function copyBundled() {
    setBusy(true);
    try {
      let order = 0;
      for (const r of CATEGORY_RULES) {
        const res = await financeClient.models.homeFinanceCategoryRule.create({ pattern: r.pattern, category: r.category, sortOrder: (order += 100), active: true });
        if (res.errors?.length) throw new Error(res.errors[0].message);
      }
      addToast({ title: `Copied ${CATEGORY_RULES.length} rules`, color: "success" });
      await load();
      refs.reload();
    } catch (e) {
      addToast({ title: "Copy failed", description: e instanceof Error ? e.message : String(e), color: "danger" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function update(id: string, patch: Record<string, unknown>) {
    const r = await financeClient.models.homeFinanceCategoryRule.update({ id, ...patch });
    if (r.errors?.length) throw new Error(r.errors[0].message);
  }

  async function move(index: number, dir: -1 | 1) {
    const updates = moveRuleUpdates(rows, index, dir);
    if (!updates.length) return;
    setBusy(true);
    try {
      for (const u of updates) await update(u.id, { sortOrder: u.sortOrder });
      await load();
    } catch (e) {
      addToast({ title: "Couldn't reorder", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(rule: any, active: boolean) {
    setRows((rs) => rs.map((r) => (r.id === rule.id ? { ...r, active } : r)));
    try {
      await update(rule.id, { active });
      refs.reload();
    } catch (e) {
      addToast({ title: "Couldn't save", description: e instanceof Error ? e.message : String(e), color: "danger" });
      load();
    }
  }

  async function remove(rule: any) {
    if (!confirm(`Delete the rule "${rule.pattern}"?`)) return;
    const r = await financeClient.models.homeFinanceCategoryRule.delete({ id: rule.id });
    if (r.errors?.length) return addToast({ title: "Couldn't delete", description: r.errors[0].message, color: "danger" });
    load();
    refs.reload();
  }

  return (
    <FinanceShell
      title="Rules"
      subtitle="How transactions get a category and a person. First match wins, top to bottom."
      actions={
        <div className="flex gap-2">
          <Button size="sm" variant="flat" onPress={() => setCategoriesOpen(true)}>
            Categories
          </Button>
          {!usingBundled && (
            <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => setEditing({})}>
              Add rule
            </Button>
          )}
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : usingBundled ? (
            <>
              <div className="rounded-lg border border-default-200 p-3 mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-default-600">
                  No editable rules yet, so the {CATEGORY_RULES.length} built-in rules below are in use. Copy them to reorder, edit or add your own.
                </p>
                <Button size="sm" color="primary" startContent={<FaCopy />} onPress={copyBundled} isLoading={busy}>
                  Copy to editable rules
                </Button>
              </div>
              <RuleList rules={CATEGORY_RULES.map((r, i) => ({ id: String(i), ...r, active: true }))} people={refs.people} />
            </>
          ) : (
            <RuleList
              rules={rows}
              people={refs.people}
              busy={busy}
              onMove={move}
              onToggle={toggleActive}
              onEdit={setEditing}
              onDelete={remove}
            />
          )}
        </div>
        <div className="flex flex-col gap-4">
          <Tester dbRows={rows} people={refs.people} />
          <Reapply dbRows={rows} people={refs.people} accounts={refs.accounts} />
        </div>
      </div>

      {editing && (
        <RuleModal
          rule={editing}
          refs={refs}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
            refs.reload();
          }}
        />
      )}
      <FinanceCategoryManager
        isOpen={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        onChanged={async () => {
          await refs.reload();
          await load();
        }}
      />
    </FinanceShell>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────

function RuleList({
  rules,
  people,
  busy,
  onMove,
  onToggle,
  onEdit,
  onDelete,
}: {
  rules: any[];
  people: ReturnType<typeof useFinanceRefs>["people"];
  busy?: boolean;
  onMove?: (i: number, dir: -1 | 1) => void;
  onToggle?: (r: any, v: boolean) => void;
  onEdit?: (r: any) => void;
  onDelete?: (r: any) => void;
}) {
  const editable = !!onEdit;
  if (rules.length === 0) return <EmptyState title="No rules" />;
  return (
    <div className="border border-default-200 rounded-lg divide-y divide-default-100">
      {rules.map((r, i) => (
        <div key={r.id} className={`flex items-center gap-2 px-3 py-2 ${r.active === false ? "opacity-50" : ""}`}>
          <span className="w-7 text-xs text-default-400 tabular-nums">{i + 1}</span>
          <div className="flex-1 min-w-0">
            <code className="text-xs break-all">{r.pattern}</code>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              {r.category ? (
                <Chip size="sm" variant="flat">
                  {r.category}
                </Chip>
              ) : null}
              {r.personId && <PersonChip personId={r.personId} people={people} />}
              {r.ledger && (
                <Chip size="sm" variant="flat" color="secondary">
                  {ledgerLabel(r.ledger, people)}&apos;s budget
                </Chip>
              )}
              {r.notes && <span className="text-xs text-default-500 italic truncate">{r.notes}</span>}
            </div>
          </div>
          {editable && (
            <div className="flex items-center gap-1 shrink-0">
              <Switch size="sm" aria-label="Active" isSelected={r.active !== false} onValueChange={(v) => onToggle?.(r, v)} />
              <Button size="sm" isIconOnly variant="light" aria-label="Move up" isDisabled={busy || i === 0} onPress={() => onMove?.(i, -1)}>
                <FaArrowUp />
              </Button>
              <Button size="sm" isIconOnly variant="light" aria-label="Move down" isDisabled={busy || i === rules.length - 1} onPress={() => onMove?.(i, 1)}>
                <FaArrowDown />
              </Button>
              <Button size="sm" isIconOnly variant="light" aria-label="Edit" onPress={() => onEdit?.(r)}>
                <FaPen />
              </Button>
              <Button size="sm" isIconOnly variant="light" color="danger" aria-label="Delete" onPress={() => onDelete?.(r)}>
                <FaTrash />
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Edit / add ───────────────────────────────────────────────────────────────

function RuleModal({
  rule,
  refs,
  onClose,
  onSaved,
}: {
  rule: any;
  refs: ReturnType<typeof useFinanceRefs>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !rule.id;
  const [pattern, setPattern] = useState<string>(rule.pattern ?? "");
  const [category, setCategory] = useState<string>(rule.category ?? "");
  const [person, setPerson] = useState<string>(rule.personId ?? "");
  const [ledger, setLedger] = useState<string>(rule.ledger ?? "");
  const [notes, setNotes] = useState<string>(rule.notes ?? "");
  const [position, setPosition] = useState<"top" | "bottom">("top");
  const [saving, setSaving] = useState(false);

  const regexError = useMemo(() => rulePatternError(pattern), [pattern]);

  async function save() {
    const invalid = ruleSaveError({ pattern, category, personId: person, ledger });
    if (invalid) return addToast({ title: invalid, color: "warning" });
    setSaving(true);
    const fields = { pattern: pattern.trim(), category: category.trim() || null, personId: person || null, ledger: ledger || null, notes: notes.trim() || null };
    let r;
    if (isNew) {
      const rows = await listCategoryRules(financeClient);
      r = await financeClient.models.homeFinanceCategoryRule.create({ ...fields, active: true, sortOrder: newRuleSortOrder(rows, position) });
    } else {
      r = await financeClient.models.homeFinanceCategoryRule.update({ id: rule.id, ...fields });
    }
    setSaving(false);
    if (r.errors?.length) return addToast({ title: "Couldn't save", description: r.errors[0].message, color: "danger" });
    onSaved();
  }

  return (
    <Modal isOpen onClose={onClose} size="lg">
      <ModalContent>
        <ModalHeader>{isNew ? "Add rule" : "Edit rule"}</ModalHeader>
        <ModalBody className="gap-3">
          <Input
            label="When the description contains"
            description="Plain text (any case), or /regex/flags such as /costco(?! gas)/i"
            value={pattern}
            onValueChange={setPattern}
            isInvalid={!!regexError}
            errorMessage={regexError ?? undefined}
          />
          <CategoryInput label="Category" placeholder="Leave empty to only set the person or budget" value={category} onValueChange={setCategory} options={refs.categories} />
          <Select
            label="Counts in"
            description="Whose budget matching spending counts in. A budget picked by hand on a transaction, or its bill's, still wins."
            selectedKeys={[ledger || ACCOUNT_LEDGER]}
            onChange={(e) => setLedger(e.target.value === ACCOUNT_LEDGER ? "" : e.target.value)}
          >
            {[
              <SelectItem key={ACCOUNT_LEDGER}>Its account&apos;s budget (default)</SelectItem>,
              <SelectItem key={HOUSEHOLD_LEDGER}>Household</SelectItem>,
              ...ledgerPeople(refs.people).map((p) => <SelectItem key={p.id}>{p.name}</SelectItem>),
            ]}
          </Select>
          <Select label="Person" description="e.g. 'transfer from … 1234' → whoever owns that account" selectedKeys={[person || HOUSEHOLD]} onChange={(e) => setPerson(e.target.value === HOUSEHOLD ? "" : e.target.value)}>
            {[{ id: HOUSEHOLD, name: "Don't set a person" }, ...refs.people].map((p) => (
              <SelectItem key={p.id}>{p.name}</SelectItem>
            ))}
          </Select>
          <Input label="Notes" value={notes} onValueChange={setNotes} />
          {isNew && (
            <Select label="Position" selectedKeys={[position]} onChange={(e) => e.target.value && setPosition(e.target.value as "top" | "bottom")}>
              <SelectItem key="top">Top (wins over everything)</SelectItem>
              <SelectItem key="bottom">Bottom (only if nothing else matches)</SelectItem>
            </Select>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" onPress={save} isLoading={saving} isDisabled={!!regexError}>
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Tester ───────────────────────────────────────────────────────────────────

function Tester({ dbRows, people }: { dbRows: any[]; people: ReturnType<typeof useFinanceRefs>["people"] }) {
  const [description, setDescription] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const rules = useMemo(() => rulesFromDbRows(dbRows), [dbRows]);

  const result = useMemo(() => testRules(description, direction, rules), [description, direction, rules]);

  return (
    <div className="rounded-lg border border-default-200 p-3 flex flex-col gap-2">
      <p className="text-sm font-medium">Test a description</p>
      <Input size="sm" label="Bank description" placeholder="SQ *BLUE BOTTLE COFFEE" value={description} onValueChange={setDescription} />
      <Select size="sm" label="Direction" selectedKeys={[direction]} onChange={(e) => e.target.value && setDirection(e.target.value as "out" | "in")}>
        <SelectItem key="out">Money out</SelectItem>
        <SelectItem key="in">Money in</SelectItem>
      </Select>
      {result && (
        <div className="text-sm flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-default-500 w-16">Category</span>
            <Chip size="sm" variant="flat" color={result.category ? "primary" : "warning"}>
              {result.category ?? "Uncategorized (the classifier would guess)"}
            </Chip>
          </div>
          {result.catRule && (
            <p className="text-xs text-default-500">
              Rule #{result.catRule.n} <code className="break-all">{result.catRule.pattern}</code>
              {result.category !== result.catRule.category && <> → {result.catRule.category}, rewritten for money in</>}
            </p>
          )}
          <div className="flex items-center gap-2">
            <span className="text-default-500 w-16">Person</span>
            {result.personId ? <PersonChip personId={result.personId} people={people} /> : <span className="text-xs text-default-500">none</span>}
          </div>
          {result.personRule && (
            <p className="text-xs text-default-500">
              Rule #{result.personRule.n} <code className="break-all">{result.personRule.pattern}</code>
            </p>
          )}
          <div className="flex items-center gap-2">
            <span className="text-default-500 w-16">Budget</span>
            <span className="text-xs text-default-500">{result.ledger ? `${ledgerLabel(result.ledger, people)}'s` : "its account's"}</span>
          </div>
          {result.ledgerRule && (
            <p className="text-xs text-default-500">
              Rule #{result.ledgerRule.n} <code className="break-all">{result.ledgerRule.pattern}</code>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Re-apply ─────────────────────────────────────────────────────────────────

function Reapply({ dbRows, people, accounts }: { dbRows: any[]; people: ReturnType<typeof useFinanceRefs>["people"]; accounts: any[] }) {
  const [days, setDays] = useState("90");
  const [plan, setPlan] = useState<RuleChange[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(0);

  useEffect(() => setPlan(null), [dbRows, days]);

  async function preview() {
    const n = reapplyDays(days);
    setChecking(true);
    try {
      const today = todayIso();
      // REFUND_LOOKBACK_DAYS more, so a refund can find the purchase it reverses.
      const txs = await listTransactions(financeClient, { fromIso: addDays(today, -n - REFUND_LOOKBACK_DAYS), toIso: today });
      const rules = rulesFromDbRows(dbRows);
      const ledgerOfAccount = (id: string) => accountLedger(accounts.find((a) => a.id === id));
      setPlan(planRuleChanges(txs, rules, ledgerOfAccount, addDays(today, -n)));
    } catch (e) {
      addToast({ title: "Couldn't check", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setChecking(false);
    }
  }

  async function apply() {
    if (!plan?.length) return;
    setApplying(true);
    setDone(0);
    let failed = 0;
    for (const c of plan) {
      const r = await financeClient.models.homeFinanceTransaction.update({ id: c.tx.id, ...ruleChangePatch(c) });
      if (r.errors?.length) failed++;
      setDone((d) => d + 1);
    }
    setApplying(false);
    addToast({ title: failed ? `${failed} of ${plan.length} failed` : `Updated ${plan.length} transactions`, color: failed ? "danger" : "success" });
    setPlan(null);
  }

  const personName = (id?: string) => people.find((p) => p.id === id)?.name ?? "someone";

  return (
    <div className="rounded-lg border border-default-200 p-3 flex flex-col gap-2">
      <p className="text-sm font-medium">Re-apply rules</p>
      <p className="text-xs text-default-500">Recategorize recent transactions with the current rules. Anything you set by hand is left alone.</p>
      <div className="flex items-end gap-2">
        <Input size="sm" type="number" label="Last N days" value={days} onValueChange={setDays} className="w-32" />
        <Button size="sm" variant="flat" startContent={<FaSyncAlt />} onPress={preview} isLoading={checking}>
          Preview
        </Button>
      </div>
      {plan && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{plan.length === 0 ? "Nothing would change." : `${plan.length} transactions would change:`}</p>
          {plan.length > 0 && (
            <>
              <div className="max-h-64 overflow-y-auto text-xs divide-y divide-default-100 border border-default-100 rounded">
                {plan.slice(0, 100).map((c) => (
                  <div key={c.tx.id} className="px-2 py-1">
                    <div className="truncate">{c.tx.description}</div>
                    <div className="text-default-500">
                      {c.category !== undefined && (
                        <>
                          {c.tx.category ?? "Uncategorized"} → <b>{c.category}</b>
                        </>
                      )}
                      {c.category !== undefined && c.personId !== undefined && " · "}
                      {c.personId !== undefined && <>person → {personName(c.personId)}</>}
                      {(c.category !== undefined || c.personId !== undefined) && c.ledger !== undefined && " · "}
                      {c.ledger !== undefined && <>budget → {ledgerLabel(c.ledger, people)}</>}
                      {c.refundOf && (
                        <span className="block text-default-400">
                          refund of {c.refundOf.date} {c.refundOf.description} (${Math.abs(c.refundOf.amount ?? 0).toFixed(2)})
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {plan.length > 100 && <div className="px-2 py-1 text-default-500">…and {plan.length - 100} more</div>}
              </div>
              <Button size="sm" color="primary" onPress={apply} isLoading={applying}>
                {applying ? `${done} / ${plan.length}` : `Apply to ${plan.length}`}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
