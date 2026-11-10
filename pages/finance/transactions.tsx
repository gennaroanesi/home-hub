"use client";

// /finance/transactions — the household ledger across accounts. Month (or
// last-90-days) window, filters (initial values from the query string:
// ?account=&category=&uncategorized=1&person=&group=&dir=in|out&q=), row
// edit through the update_finance_transaction op (with "remember for
// similar" → a category rule), bulk edit, and manual rows for accounts
// that don't sync from SimpleFIN.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Checkbox } from "@heroui/checkbox";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast, Spinner } from "@heroui/react";
import { FaPlus, FaRedo, FaSearch, FaTrash } from "react-icons/fa";

import { FinanceShell } from "@/components/finance/finance-shell";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money, PersonChip } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { FreeCombobox } from "@/components/free-combobox";
import { callOp } from "@/lib/ops-client";
import { categoryParts, effectiveCategory, parseLineItems, stripProcessorPrefix, UNCATEGORIZED } from "@/lib/finance/categories";
import { addDays, fmtDate, monthRange, normalizeAmountSign, shiftMonth, todayIso, type DateRange } from "@/lib/finance/dates";
import { listTransactions } from "@/lib/finance/data";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LAST_90 = "last90";
const HOUSEHOLD = "__household";
const NONE = "__none";

/** A starting point for "remember for similar": the first merchant-looking words. */
function suggestPattern(description: string | null | undefined): string {
  const words = stripProcessorPrefix(description ?? "")
    .split(/\s+/)
    .filter((w) => /^[A-Za-z][A-Za-z&'.-]{2,}$/.test(w));
  return words.slice(0, 2).join(" ").toUpperCase();
}

function sourceLabel(src: string | null | undefined): string | null {
  if (src === "LLM") return "guessed";
  if (src === "MANUAL") return "manual";
  if (src === "RULE") return "rule";
  return null;
}

function qs(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

export default function TransactionsPage() {
  const router = useRouter();
  const refs = useFinanceRefs();
  const today = todayIso();

  const [period, setPeriod] = useState<string>(today.slice(0, 7));
  const [txs, setTxs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [account, setAccount] = useState("");
  const [category, setCategory] = useState("");
  const [person, setPerson] = useState("");
  const [group, setGroup] = useState("");
  const [direction, setDirection] = useState("");
  const [query, setQuery] = useState("");
  const [filtersReady, setFiltersReady] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<any | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // Initial filters from the query string, once the router is ready.
  useEffect(() => {
    if (!router.isReady || filtersReady) return;
    const q = router.query;
    setAccount(qs(q.account));
    setCategory(qs(q.uncategorized) === "1" ? UNCATEGORIZED : qs(q.category));
    setPerson(qs(q.person));
    setGroup(qs(q.group));
    setDirection(qs(q.dir));
    setQuery(qs(q.q));
    const p = qs(q.period) || qs(q.month);
    if (p === LAST_90 || /^\d{4}-\d{2}$/.test(p)) setPeriod(p);
    // A group filter usually spans more than a month.
    else if (qs(q.group) || qs(q.uncategorized) === "1") setPeriod(LAST_90);
    setFiltersReady(true);
  }, [router.isReady, router.query, filtersReady]);

  const range: DateRange = useMemo(
    () => (period === LAST_90 ? { fromIso: addDays(today, -90), toIso: today, label: "Last 90 days" } : monthRange(`${period}-01`)),
    [period, today],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Invested accounts' rows only when one of them is picked in the filter.
      setTxs(await listTransactions(financeClient, { fromIso: range.fromIso, toIso: range.toIso, ...(account ? { accountIds: [account] } : {}) }));
    } catch (e) {
      addToast({ title: "Couldn't load transactions", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setLoading(false);
    }
  }, [range.fromIso, range.toIso, account]);

  useEffect(() => {
    if (filtersReady) load();
  }, [load, filtersReady]);

  const periodOptions = useMemo(() => {
    const opts = [{ key: LAST_90, label: "Last 90 days" }];
    for (let i = 0; i < 24; i++) {
      const m = shiftMonth(today, -i);
      opts.push({ key: m.slice(0, 7), label: monthRange(m).label });
    }
    if (period !== LAST_90 && !opts.some((o) => o.key === period)) opts.push({ key: period, label: monthRange(`${period}-01`).label });
    return opts;
  }, [today, period]);

  const accName = useMemo(() => new Map(refs.accounts.map((a) => [a.id, a.name])), [refs.accounts]);
  const groupName = useMemo(() => new Map(refs.groups.map((g) => [g.id, g.name])), [refs.groups]);

  const rows = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return txs
      .map((t) => ({ ...t, _cat: effectiveCategory(t, refs.rules), _cats: categoryParts(t, refs.rules).map((p) => p.category) }))
      .filter((t) => {
        if (account && t.accountId !== account) return false;
        // An itemized charge matches any of its items' categories.
        if (category && !t._cats.includes(category)) return false;
        if (person === HOUSEHOLD ? !!t.personId : person && t.personId !== person) return false;
        if (group === NONE ? !!t.spendGroupId : group && t.spendGroupId !== group) return false;
        if (direction === "in" && (t.amount ?? 0) <= 0) return false;
        if (direction === "out" && (t.amount ?? 0) >= 0) return false;
        const hay = `${t.description ?? ""} ${t.notes ?? ""} ${t._cats.join(" ")} ${(parseLineItems(t) ?? []).map((i) => i.name ?? "").join(" ")}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
  }, [txs, refs.rules, account, category, person, group, direction, query]);

  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    for (const t of rows) {
      if (t.status === "PENDING") continue;
      if ((t.amount ?? 0) > 0) inflow += t.amount;
      else outflow += t.amount ?? 0;
    }
    return { inflow, outflow };
  }, [rows]);

  const categoryOptions = useMemo(() => {
    const set = new Set(refs.categories);
    for (const t of txs) for (const p of categoryParts(t, refs.rules)) set.add(p.category);
    set.add(UNCATEGORIZED);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [refs.categories, refs.rules, txs]);

  const filtersActive = !!(account || category || person || group || direction || query);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const manualAccounts = refs.accounts.filter((a) => a.active !== false && !a.simplefinAccountId);

  return (
    <FinanceShell
      title="Transactions"
      subtitle={range.label}
      onSynced={load}
      actions={
        <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => setAddOpen(true)} isDisabled={refs.loading}>
          Add
        </Button>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 mb-3">
        <Select size="sm" label="Period" selectedKeys={[period]} onChange={(e) => e.target.value && setPeriod(e.target.value)}>
          {periodOptions.map((o) => (
            <SelectItem key={o.key}>{o.label}</SelectItem>
          ))}
        </Select>
        <Select size="sm" label="Account" selectedKeys={account ? [account] : []} onChange={(e) => setAccount(e.target.value)}>
          {refs.accounts.map((a) => (
            <SelectItem key={a.id}>{a.name}</SelectItem>
          ))}
        </Select>
        <Select size="sm" label="Category" selectedKeys={category ? [category] : []} onChange={(e) => setCategory(e.target.value)}>
          {categoryOptions.map((c) => (
            <SelectItem key={c}>{c}</SelectItem>
          ))}
        </Select>
        <Select size="sm" label="Person" selectedKeys={person ? [person] : []} onChange={(e) => setPerson(e.target.value)}>
          {[{ id: HOUSEHOLD, name: "Household" }, ...refs.people].map((p) => (
            <SelectItem key={p.id}>{p.name}</SelectItem>
          ))}
        </Select>
        <Select size="sm" label="Group" selectedKeys={group ? [group] : []} onChange={(e) => setGroup(e.target.value)}>
          {[{ id: NONE, name: "No group" }, ...refs.groups].map((g) => (
            <SelectItem key={g.id}>{g.name}</SelectItem>
          ))}
        </Select>
        <Select size="sm" label="Direction" selectedKeys={direction ? [direction] : []} onChange={(e) => setDirection(e.target.value)}>
          <SelectItem key="in">Money in</SelectItem>
          <SelectItem key="out">Money out</SelectItem>
        </Select>
        <Input size="sm" label="Search" value={query} onValueChange={setQuery} startContent={<FaSearch className="text-default-400" />} isClearable onClear={() => setQuery("")} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 text-sm">
        <div className="flex items-center gap-4">
          <span className="text-default-500">{rows.length} transactions</span>
          <span>
            In <Money value={totals.inflow} sign />
          </span>
          <span>
            Out <Money value={totals.outflow} />
          </span>
          <span className="text-default-500">
            Net <Money value={totals.inflow + totals.outflow} sign />
          </span>
        </div>
        <div className="flex items-center gap-2">
          {filtersActive && (
            <Button
              size="sm"
              variant="light"
              startContent={<FaRedo />}
              onPress={() => {
                setAccount("");
                setCategory("");
                setPerson("");
                setGroup("");
                setDirection("");
                setQuery("");
              }}
            >
              Clear filters
            </Button>
          )}
          {selected.size > 0 && (
            <>
              <Button size="sm" variant="flat" onPress={() => setSelected(new Set())}>
                Deselect
              </Button>
              <Button size="sm" color="primary" variant="flat" onPress={() => setBulkOpen(true)}>
                Edit {selected.size} selected
              </Button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={txs.length ? "No transactions match these filters" : "No transactions in this period"}>
          {refs.accounts.length === 0 ? "Add an account on the Accounts tab and link it to SimpleFIN." : null}
        </EmptyState>
      ) : (
        <div className="border border-default-200 rounded-lg divide-y divide-default-100">
          <div className="flex items-center gap-3 px-3 py-2 text-xs text-default-500">
            <Checkbox
              size="sm"
              aria-label="Select all"
              isSelected={allSelected}
              onValueChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())}
            />
            <span>Select all shown</span>
          </div>
          {rows.map((t) => {
            const src = sourceLabel(t.categorySource);
            return (
              <div key={t.id} className="flex items-center gap-3 px-3 py-2 hover:bg-default-50 cursor-pointer" onClick={() => setEditing(t)}>
                <div onClick={(e) => e.stopPropagation()}>
                  <Checkbox size="sm" aria-label="Select" isSelected={selected.has(t.id)} onValueChange={() => toggle(t.id)} />
                </div>
                <div className="w-14 shrink-0 text-xs text-default-500 tabular-nums">{fmtDate(t.date)}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate flex items-center gap-2">
                    <span className="truncate">{t.description || "(no description)"}</span>
                    {t.status === "PENDING" && (
                      <Chip size="sm" variant="flat" color="warning">
                        pending
                      </Chip>
                    )}
                    {t.recurringId && (
                      <NextLink
                        href="/finance/scheduled"
                        title="Matched to a scheduled transaction"
                        className="text-default-400 hover:text-primary"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FaRedo className="text-[10px]" />
                      </NextLink>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-0.5 text-xs text-default-500">
                    <span>{accName.get(t.accountId) ?? "—"}</span>
                    {t._cats.length > 1 ? (
                      <Chip size="sm" variant="flat" color="primary" title={t._cats.join(", ")}>
                        Itemized · {t._cats.length} categories
                      </Chip>
                    ) : (
                      <Chip size="sm" variant="flat" color={t._cat === UNCATEGORIZED ? "warning" : "default"}>
                        {t._cat}
                        {src && !parseLineItems(t) && <span className="opacity-60"> · {src}</span>}
                      </Chip>
                    )}
                    {t.personId && <PersonChip personId={t.personId} people={refs.people} />}
                    {t.spendGroupId && (
                      <Chip size="sm" variant="flat" color="secondary">
                        {groupName.get(t.spendGroupId) ?? "group"}
                      </Chip>
                    )}
                    {t.notes && <span className="italic truncate max-w-[16rem]">{t.notes}</span>}
                  </div>
                </div>
                <Money value={t.amount} sign className="text-sm font-medium shrink-0" />
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <EditModal
          tx={editing}
          refs={refs}
          accountName={accName.get(editing.accountId) ?? ""}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refs.reload();
            load();
          }}
        />
      )}
      {bulkOpen && (
        <BulkModal
          ids={[...selected]}
          refs={refs}
          onClose={() => setBulkOpen(false)}
          onSaved={() => {
            setBulkOpen(false);
            setSelected(new Set());
            load();
          }}
        />
      )}
      {addOpen && (
        <AddModal
          accounts={manualAccounts}
          refs={refs}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            load();
          }}
        />
      )}
    </FinanceShell>
  );
}

// ── Edit one ─────────────────────────────────────────────────────────────────

type Refs = ReturnType<typeof useFinanceRefs>;

function PersonSelect({ value, onChange, people, label = "Person" }: { value: string; onChange: (v: string) => void; people: Refs["people"]; label?: string }) {
  return (
    <Select label={label} selectedKeys={[value || HOUSEHOLD]} onChange={(e) => onChange(e.target.value === HOUSEHOLD ? "" : e.target.value)}>
      {[{ id: HOUSEHOLD, name: "Household" }, ...people].map((p) => (
        <SelectItem key={p.id}>{p.name}</SelectItem>
      ))}
    </Select>
  );
}

function GroupSelect({ value, onChange, groups }: { value: string; onChange: (v: string) => void; groups: any[] }) {
  return (
    <Select label="Spend group" selectedKeys={[value || NONE]} onChange={(e) => onChange(e.target.value === NONE ? "" : e.target.value)}>
      {[{ id: NONE, name: "None (counts against the budget)" }, ...groups].map((g) => (
        <SelectItem key={g.id}>{g.name}</SelectItem>
      ))}
    </Select>
  );
}

function EditModal({ tx, refs, accountName, onClose, onSaved }: { tx: any; refs: Refs; accountName: string; onClose: () => void; onSaved: () => void }) {
  const [category, setCategory] = useState<string>(tx.category ?? "");
  const [person, setPerson] = useState<string>(tx.personId ?? "");
  const [group, setGroup] = useState<string>(tx.spendGroupId ?? "");
  const [notes, setNotes] = useState<string>(tx.notes ?? "");
  const [remember, setRemember] = useState(false);
  const [pattern, setPattern] = useState(suggestPattern(tx.description));
  const [saving, setSaving] = useState(false);
  const stored = useMemo(() => parseLineItems(tx), [tx]);
  const [items, setItems] = useState<ItemDraft[]>(() => (stored ?? []).map((i) => ({ name: i.name ?? "", amount: String(i.amount), category: i.category })));
  const manual = !tx.sfTransactionId;

  async function save() {
    const input: Record<string, unknown> = { transactionId: tx.id };
    const cat = category.trim();
    // Saving a guessed (LLM) category as is confirms it (it becomes MANUAL).
    if (cat !== (tx.category ?? "") || (tx.categorySource === "LLM" && cat)) input.category = cat || null;
    if (person !== (tx.personId ?? "")) input.personId = person || null;
    if (group !== (tx.spendGroupId ?? "")) input.spendGroupId = group || null;
    if (notes !== (tx.notes ?? "")) input.notes = notes || null;
    const rows = items.filter((i) => i.name.trim() || i.amount.trim() || i.category.trim());
    if (rows.some((i) => !(Number(i.amount) > 0) || !i.category.trim())) {
      return addToast({ title: "Each item needs an amount and a category", color: "warning" });
    }
    const next = rows.map((i) => ({ name: i.name.trim() || null, amount: Number(i.amount), category: i.category.trim() }));
    const before = (stored ?? []).map((i) => ({ name: i.name ?? null, amount: i.amount, category: i.category }));
    if (JSON.stringify(next) !== JSON.stringify(before)) input.lineItems = next.length ? next : null;
    if (remember && pattern.trim()) input.rememberPattern = pattern.trim();
    if (Object.keys(input).length === 1) return onClose();
    setSaving(true);
    const r = await callOp(financeClient, "update_finance_transaction", input as any);
    setSaving(false);
    if ("error" in r) return addToast({ title: "Couldn't save", description: r.error, color: "danger" });
    addToast({ title: r.result.ruleCreated ? "Saved, and a rule was added" : "Saved", color: "success" });
    onSaved();
  }

  async function remove() {
    if (!confirm("Delete this transaction?")) return;
    setSaving(true);
    const r = await financeClient.models.homeFinanceTransaction.delete({ id: tx.id });
    setSaving(false);
    if (r.errors?.length) return addToast({ title: "Couldn't delete", description: r.errors[0].message, color: "danger" });
    onSaved();
  }

  return (
    <Modal isOpen onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span className="truncate">{tx.description || "(no description)"}</span>
          <span className="text-xs font-normal text-default-500">
            {fmtDate(tx.date, { month: "short", day: "numeric", year: "numeric" })} · {accountName} · <Money value={tx.amount} sign />
            {tx.status === "PENDING" ? " · pending" : ""}
          </span>
        </ModalHeader>
        <ModalBody className="gap-3">
          <FreeCombobox label="Category" placeholder="Uncategorized" value={category} onValueChange={setCategory} options={refs.categories} />
          {items.length > 0 && <p className="text-xs text-default-500 -mt-2">Itemized: spending counts under the items&apos; categories below, not this one.</p>}
          {tx.categorySource === "LLM" && category === (tx.category ?? "") && (
            <p className="text-xs text-default-500 -mt-2">Guessed by the classifier. Saving confirms it, so the sync won&apos;t change it.</p>
          )}
          <PersonSelect value={person} onChange={setPerson} people={refs.people} label="Person (contributor or spender)" />
          <GroupSelect value={group} onChange={setGroup} groups={refs.groups} />
          <Input label="Notes" value={notes} onValueChange={setNotes} />
          {(tx.amount ?? 0) < 0 && (
            <ItemsEditor
              items={items}
              onChange={setItems}
              charge={Math.abs(tx.amount ?? 0)}
              categories={refs.categories}
              start={() => setItems([{ name: "", amount: String(Math.abs(tx.amount ?? 0)), category: category.trim() }, { name: "", amount: "", category: "" }])}
            />
          )}
          <div className="rounded-lg border border-default-200 p-3 flex flex-col gap-2">
            <Checkbox isSelected={remember} onValueChange={setRemember}>
              Remember for similar transactions
            </Checkbox>
            {remember && (
              <>
                <Input size="sm" label="When the description contains" description="Plain text (any case) or /regex/flags. Applies the category and person above to future transactions." value={pattern} onValueChange={setPattern} />
              </>
            )}
          </div>
        </ModalBody>
        <ModalFooter className="justify-between">
          <div>
            {manual && (
              <Button color="danger" variant="light" startContent={<FaTrash />} onPress={remove} isDisabled={saving}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="flat" onPress={onClose}>
              Cancel
            </Button>
            <Button color="primary" onPress={save} isLoading={saving}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Itemization ──────────────────────────────────────────────────────────────

type ItemDraft = { name: string; amount: string; category: string };

/**
 * Split one charge across categories (an Amazon order). Items needn't add
 * up exactly: they're scaled to the charge, so tax and shipping spread
 * proportionally (lib/finance/categories.ts categoryParts).
 */
function ItemsEditor({ items, onChange, charge, categories, start }: { items: ItemDraft[]; onChange: (items: ItemDraft[]) => void; charge: number; categories: string[]; start: () => void }) {
  const update = (i: number, patch: Partial<ItemDraft>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const sum = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  if (!items.length) {
    return (
      <Button variant="flat" size="sm" startContent={<FaPlus />} onPress={start} className="self-start">
        Itemize (split across categories)
      </Button>
    );
  }
  return (
    <div className="rounded-lg border border-default-200 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Items</span>
        <Button size="sm" variant="light" color="danger" onPress={() => onChange([])}>
          Remove itemization
        </Button>
      </div>
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1.4fr_0.7fr_1.2fr_auto] gap-2 items-center">
          <Input size="sm" label="Item" value={it.name} onValueChange={(v) => update(i, { name: v })} className="col-span-2 sm:col-span-1" />
          <Input size="sm" label="Amount" type="number" min={0} startContent={<span className="text-default-400 text-sm">$</span>} value={it.amount} onValueChange={(v) => update(i, { amount: v })} />
          <FreeCombobox label="Category" value={it.category} onValueChange={(v) => update(i, { category: v })} options={categories} />
          <Button size="sm" isIconOnly variant="light" aria-label="Remove item" onPress={() => onChange(items.filter((_, j) => j !== i))}>
            <FaTrash />
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <Button size="sm" variant="flat" startContent={<FaPlus />} onPress={() => onChange([...items, { name: "", amount: "", category: "" }])}>
          Add item
        </Button>
        <span className={`text-xs ${Math.abs(sum - charge) < 0.01 ? "text-default-500" : "text-warning-600"}`}>
          Items <Money value={sum} /> of <Money value={charge} />
          {Math.abs(sum - charge) >= 0.01 && " · scaled to the charge"}
        </span>
      </div>
    </div>
  );
}

// ── Bulk edit ────────────────────────────────────────────────────────────────

const KEEP = "__keep";

function BulkModal({ ids, refs, onClose, onSaved }: { ids: string[]; refs: Refs; onClose: () => void; onSaved: () => void }) {
  const [category, setCategory] = useState("");
  const [person, setPerson] = useState(KEEP);
  const [group, setGroup] = useState(KEEP);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(0);

  async function save() {
    const base: Record<string, unknown> = {};
    if (category.trim()) base.category = category.trim();
    if (person !== KEEP) base.personId = person === HOUSEHOLD ? null : person;
    if (group !== KEEP) base.spendGroupId = group === NONE ? null : group;
    if (!Object.keys(base).length) return onClose();
    setSaving(true);
    const failures: string[] = [];
    for (const id of ids) {
      const r = await callOp(financeClient, "update_finance_transaction", { transactionId: id, ...base } as any);
      if ("error" in r) failures.push(r.error);
      setDone((d) => d + 1);
    }
    setSaving(false);
    if (failures.length) addToast({ title: `${failures.length} of ${ids.length} failed`, description: failures[0], color: "danger" });
    else addToast({ title: `Updated ${ids.length} transactions`, color: "success" });
    onSaved();
  }

  return (
    <Modal isOpen onClose={onClose}>
      <ModalContent>
        <ModalHeader>Edit {ids.length} transactions</ModalHeader>
        <ModalBody className="gap-3">
          <p className="text-xs text-default-500">Only the fields you set change.</p>
          <FreeCombobox label="Category" placeholder="Leave unchanged" value={category} onValueChange={setCategory} options={refs.categories} />
          <Select label="Person" selectedKeys={[person]} onChange={(e) => e.target.value && setPerson(e.target.value)}>
            {[{ id: KEEP, name: "Leave unchanged" }, { id: HOUSEHOLD, name: "Household" }, ...refs.people].map((p) => (
              <SelectItem key={p.id}>{p.name}</SelectItem>
            ))}
          </Select>
          <Select label="Spend group" selectedKeys={[group]} onChange={(e) => e.target.value && setGroup(e.target.value)}>
            {[{ id: KEEP, name: "Leave unchanged" }, { id: NONE, name: "No group" }, ...refs.groups].map((g) => (
              <SelectItem key={g.id}>{g.name}</SelectItem>
            ))}
          </Select>
          {saving && <p className="text-xs text-default-500">{done} / {ids.length}…</p>}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose} isDisabled={saving}>
            Cancel
          </Button>
          <Button color="primary" onPress={save} isLoading={saving}>
            Apply
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Add (manual accounts) ────────────────────────────────────────────────────

function AddModal({ accounts, refs, onClose, onSaved }: { accounts: any[]; refs: Refs; onClose: () => void; onSaved: () => void }) {
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? "");
  const [type, setType] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [person, setPerson] = useState("");
  const [group, setGroup] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    const n = parseFloat(amount);
    if (!accountId || !Number.isFinite(n) || n === 0 || !date) return addToast({ title: "Account, amount and date are required", color: "warning" });
    setSaving(true);
    const r = await financeClient.models.homeFinanceTransaction.create({
      accountId,
      amount: normalizeAmountSign(n, type),
      type,
      date,
      description: description.trim() || null,
      category: category.trim() || null,
      categorySource: category.trim() ? "MANUAL" : null,
      status: "POSTED",
      personId: person || null,
      personSource: person ? "MANUAL" : null,
      spendGroupId: group || null,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (r.errors?.length) return addToast({ title: "Couldn't save", description: r.errors[0].message, color: "danger" });
    onSaved();
  }

  return (
    <Modal isOpen onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>Add transaction</ModalHeader>
        <ModalBody className="gap-3">
          {accounts.length === 0 ? (
            <p className="text-sm text-default-500">
              Transactions on SimpleFIN-linked accounts come from the bank. Add a manual (unlinked) account on the Accounts tab to record cash or other activity by hand.
            </p>
          ) : (
            <>
              <Select label="Account" selectedKeys={accountId ? [accountId] : []} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <SelectItem key={a.id}>{a.name}</SelectItem>
                ))}
              </Select>
              <div className="grid grid-cols-3 gap-2">
                <Select label="Type" selectedKeys={[type]} onChange={(e) => e.target.value && setType(e.target.value as "EXPENSE" | "INCOME")}>
                  <SelectItem key="EXPENSE">Money out</SelectItem>
                  <SelectItem key="INCOME">Money in</SelectItem>
                </Select>
                <Input label="Amount" type="number" inputMode="decimal" value={amount} onValueChange={setAmount} startContent={<span className="text-default-400 text-sm">$</span>} />
                <Input label="Date" type="date" value={date} onValueChange={setDate} />
              </div>
              <Input label="Description" value={description} onValueChange={setDescription} />
              <FreeCombobox label="Category" value={category} onValueChange={setCategory} options={refs.categories} />
              <PersonSelect value={person} onChange={setPerson} people={refs.people} />
              <GroupSelect value={group} onChange={setGroup} groups={refs.groups} />
              <Input label="Notes" value={notes} onValueChange={setNotes} />
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" onPress={save} isLoading={saving} isDisabled={accounts.length === 0}>
            Add
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
