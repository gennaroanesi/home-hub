"use client";

// /finance/transactions — the household ledger across accounts. Month,
// last-90-days or custom dates, search, and a Filters pane like the phone's
// sheet (components/finance/transaction-filters-pane.tsx; what's on shows
// as removable chips; initial values from the query
// string: ?account=a,b&category=c,d&uncategorized=1&person=&group=&dir=in|out
// &q=&from=&to=; account, category and contributor take several), row
// edit through the update_finance_transaction op (with "remember for
// similar" → a category rule), bulk edit, and manual rows for accounts
// that don't sync from SimpleFIN. Every editor can create a category (type
// a new name) or a spend group ("New group…") without leaving the page.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Checkbox } from "@heroui/checkbox";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast, Spinner } from "@heroui/react";
import { FaFileImport, FaFilter, FaPlus, FaRedo, FaSearch, FaTrash } from "react-icons/fa";
import { NO_WEB_TX_FILTERS, TransactionFiltersPane, webTxFilterCount, type WebTxFilters } from "@/components/finance/transaction-filters-pane";

import { CategoryQuickEdit } from "@/components/finance/category-quick-edit";
import { FinanceShell } from "@/components/finance/finance-shell";
import { ImportCsvModal } from "@/components/finance/import-csv-modal";
import { financeClient } from "@/components/finance/client";
import { EmptyState, Money, PersonChip } from "@/components/finance/ui";
import { useFinanceRefs } from "@/components/finance/use-finance-refs";
import { CategoryInput } from "@/components/finance/category-input";
import { SpendGroupPicker } from "@/components/finance/spend-group-picker";
import { callOp } from "@/lib/ops-client";
import { NO_SPEND_GROUP, TX_SORT_LABELS, filterTransactions, sortTransactions, type TxSort } from "@/lib/finance/tx-filter";
import { categoryParts, effectiveCategory, parseLineItems, suggestPattern, UNCATEGORIZED } from "@/lib/finance/categories";
import { addDays, fmtDate, monthRange, normalizeAmountSign, shiftMonth, todayIso, type DateRange } from "@/lib/finance/dates";
import { listTransactions } from "@/lib/finance/data";
import { rememberCategories } from "@/lib/finance/category-list";
import { HOUSEHOLD as HOUSEHOLD_LEDGER, accountLedger, ledgerLabel, ledgerParts, ledgerPeople } from "@/lib/finance/ledger";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LAST_90 = "last90";
const CUSTOM = "custom";
const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
// Filters wide enough to read: the menu is at least as wide as its longest names.
const FILTER_SELECT = { classNames: { popoverContent: "min-w-[16rem]" }, popoverProps: { placement: "bottom-start" as const } };
const HOUSEHOLD = "__household";
const NONE = NO_SPEND_GROUP;

function sourceLabel(src: string | null | undefined): string | null {
  if (src === "LLM") return "guessed";
  if (src === "MANUAL") return "manual";
  if (src === "RULE") return "rule";
  return null;
}

function qs(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The stored fields an update_finance_transaction input changes, as the op
 * writes them (lib/ops/finance.ts), so a save can update the row in place:
 * the op returns only { transactionId, category, personId, ruleCreated }.
 */
function txPatchFromInput(input: Record<string, any>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if ("category" in input) {
    const cat = (input.category as string | null)?.trim() || null;
    p.category = cat;
    p.categorySource = cat ? "MANUAL" : null;
  }
  if ("personId" in input) {
    p.personId = input.personId || null;
    p.personSource = input.personId ? "MANUAL" : null;
  }
  if ("spendGroupId" in input) p.spendGroupId = input.spendGroupId ?? null;
  if ("notes" in input) p.notes = input.notes ?? null;
  if ("ledger" in input) p.ledger = input.ledger || null;
  if ("lineItems" in input) {
    const items = ((input.lineItems ?? []) as Array<Record<string, any>>).map((i) => ({
      name: i.name?.trim() || null,
      amount: r2(i.amount),
      category: String(i.category).trim(),
      ...(i.ledger ? { ledger: i.ledger } : {}),
    }));
    p.lineItems = items.length ? JSON.stringify(items) : null;
  }
  return p;
}

const byNewest = (a: any, b: any) => (b.date ?? "").localeCompare(a.date ?? "") || (b.createdAt ?? "").localeCompare(a.createdAt ?? "");

type EditResult = { deleted?: boolean; patch?: Record<string, unknown>; ruleCreated?: boolean; newCategories?: string[] };

export default function TransactionsPage() {
  const router = useRouter();
  const refs = useFinanceRefs();
  const today = todayIso();

  const [period, setPeriod] = useState<string>(today.slice(0, 7));
  const [txs, setTxs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [accounts, setAccounts] = useState<string[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [persons, setPersons] = useState<string[]>([]);
  const [customFrom, setCustomFrom] = useState(() => addDays(today, -30));
  const [customTo, setCustomTo] = useState(today);
  const [group, setGroup] = useState("");
  const [direction, setDirection] = useState("");
  const [query, setQuery] = useState("");
  const [ledgerFilter, setLedgerFilter] = useState("");
  const [filtersReady, setFiltersReady] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<any | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // Initial filters from the query string, once the router is ready.
  useEffect(() => {
    if (!router.isReady || filtersReady) return;
    const q = router.query;
    setAccounts(list(qs(q.account)));
    setCats(qs(q.uncategorized) === "1" ? [UNCATEGORIZED] : list(qs(q.category)));
    setPersons(list(qs(q.person)));
    setGroup(qs(q.group));
    setDirection(qs(q.dir));
    setQuery(qs(q.q));
    setLedgerFilter(qs(q.ledger));
    const p = qs(q.period) || qs(q.month);
    const from = qs(q.from);
    const to = qs(q.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      setCustomFrom(from);
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) setCustomTo(to);
      setPeriod(CUSTOM);
    } else if (p === LAST_90 || /^\d{4}-\d{2}$/.test(p)) setPeriod(p);
    // A group filter usually spans more than a month.
    else if (qs(q.group) || qs(q.uncategorized) === "1") setPeriod(LAST_90);
    setFiltersReady(true);
  }, [router.isReady, router.query, filtersReady]);

  const range: DateRange = useMemo(
    () =>
      period === LAST_90
        ? { fromIso: addDays(today, -90), toIso: today, label: "Last 90 days" }
        : period === CUSTOM
          ? {
              fromIso: customFrom <= customTo ? customFrom : customTo,
              toIso: customFrom <= customTo ? customTo : customFrom,
              label: `${fmtDate(customFrom, { month: "short", day: "numeric", year: "numeric" })} – ${fmtDate(customTo, { month: "short", day: "numeric", year: "numeric" })}`,
            }
          : monthRange(`${period}-01`),
    [period, today, customFrom, customTo],
  );

  // quiet: refresh in the background (after a sync or a new rule), the
  // list stays up. Only the latest call's result lands.
  const loadSeq = useRef(0);
  // Rows saved while a load is in flight: its answer was read before them,
  // so they're laid back over it instead of flashing the old values.
  const editsDuringLoad = useRef<Map<string, Record<string, unknown>> | null>(null);
  const load = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      const seq = ++loadSeq.current;
      editsDuringLoad.current = new Map();
      if (!opts.quiet) setLoading(true);
      try {
        // Invested accounts' rows only when one of them is picked in the filter.
        const next = await listTransactions(financeClient, { fromIso: range.fromIso, toIso: range.toIso, ...(accounts.length ? { accountIds: accounts } : {}) });
        if (seq === loadSeq.current) {
          const edits = editsDuringLoad.current ?? new Map();
          editsDuringLoad.current = null;
          setTxs(edits.size ? next.map((t: any) => (edits.has(t.id) ? { ...t, ...edits.get(t.id) } : t)) : next);
        }
      } catch (e) {
        if (seq === loadSeq.current) addToast({ title: "Couldn't load transactions", description: e instanceof Error ? e.message : String(e), color: "danger" });
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [range.fromIso, range.toIso, accounts],
  );
  const quietReload = useCallback(() => load({ quiet: true }), [load]);

  /** Saves update just their rows (the rows useMemo derives _cat etc. from txs). */
  const patchTxs = useCallback((ids: string[], patch: Record<string, unknown>) => {
    if (!ids.length || !Object.keys(patch).length) return;
    const set = new Set(ids);
    const during = editsDuringLoad.current;
    if (during) for (const id of ids) during.set(id, { ...during.get(id), ...patch });
    setTxs((ts) => ts.map((t) => (set.has(t.id) ? { ...t, ...patch } : t)));
  }, []);

  // Category edited in place from the row (CategoryQuickEdit).
  const [savingCat, setSavingCat] = useState<Set<string>>(new Set());
  async function quickCategory(t: any, picked: string | null) {
    const shown = t._cat === UNCATEGORIZED ? null : t._cat;
    // Same as shown: nothing to do, unless it's a guess (saving confirms it).
    if (picked === shown && !(t.categorySource === "LLM" && picked)) return;
    const before = { category: t.category ?? null, categorySource: t.categorySource ?? null };
    const input = { transactionId: t.id, category: picked };
    patchTxs([t.id], txPatchFromInput(input));
    setSavingCat((s) => new Set(s).add(t.id));
    let error: string | null = null;
    try {
      const r = await callOp(financeClient, "update_finance_transaction", input);
      if ("error" in r) error = r.error;
      else if (r.result.newCategories.length) void refs.reload();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    setSavingCat((s) => {
      const n = new Set(s);
      n.delete(t.id);
      return n;
    });
    if (error) {
      patchTxs([t.id], before);
      addToast({ title: "Couldn't change the category", description: error, color: "danger" });
    }
  }

  useEffect(() => {
    if (filtersReady) load();
  }, [load, filtersReady]);

  const periodOptions = useMemo(() => {
    const opts = [
      { key: LAST_90, label: "Last 90 days" },
      { key: CUSTOM, label: "Custom dates…" },
    ];
    for (let i = 0; i < 24; i++) {
      const m = shiftMonth(today, -i);
      opts.push({ key: m.slice(0, 7), label: monthRange(m).label });
    }
    if (period !== LAST_90 && period !== CUSTOM && !opts.some((o) => o.key === period)) opts.push({ key: period, label: monthRange(`${period}-01`).label });
    return opts;
  }, [today, period]);

  const accName = useMemo(() => new Map(refs.accounts.map((a) => [a.id, a.name])), [refs.accounts]);
  const accLedger = useMemo(() => new Map(refs.accounts.map((a) => [a.id, accountLedger(a)])), [refs.accounts]);
  const owners = useMemo(() => ledgerPeople(refs.people as any[]), [refs.people]);
  const groupName = useMemo(() => new Map(refs.groups.map((g) => [g.id, g.name])), [refs.groups]);

  const [sort, setSort] = useState<TxSort>("newest");
  // Same rules as list_finance_transactions (lib/finance/tx-filter.ts).
  const rows = useMemo(() => {
    const shown = filterTransactions(
      txs,
      {
        query,
        accountIds: accounts,
        categories: cats.filter((c) => c !== UNCATEGORIZED),
        uncategorized: cats.includes(UNCATEGORIZED),
        personIds: persons,
        spendGroupId: group || undefined,
        direction: (direction || undefined) as "in" | "out" | undefined,
        ledger: ledgerFilter || undefined,
      },
      { rules: refs.rules, accountLedger: (id) => accLedger.get(id) ?? HOUSEHOLD_LEDGER },
    );
    return sortTransactions(shown, sort).map((t) => ({
      ...t,
      _cat: effectiveCategory(t, refs.rules),
      _cats: categoryParts(t, refs.rules).map((p) => p.category),
      _ledgers: ledgerParts(t, accLedger.get(t.accountId) ?? HOUSEHOLD_LEDGER).map((p) => p.ledger),
    }));
  }, [txs, refs.rules, accLedger, accounts, cats, persons, group, direction, query, ledgerFilter, sort]);

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

  // The pane (components/finance/transaction-filters-pane.tsx) edits these.
  const [paneOpen, setPaneOpen] = useState(false);
  const paneValue: WebTxFilters = { sort, direction: direction as WebTxFilters["direction"], cats, ledger: ledgerFilter, group, accounts, persons };
  const filterCount = webTxFilterCount(paneValue);
  function setFilters(p: Partial<WebTxFilters>) {
    if (p.sort !== undefined) setSort(p.sort);
    if (p.direction !== undefined) setDirection(p.direction);
    if (p.cats !== undefined) setCats(p.cats);
    if (p.ledger !== undefined) setLedgerFilter(p.ledger);
    if (p.group !== undefined) setGroup(p.group);
    if (p.accounts !== undefined) setAccounts(p.accounts);
    if (p.persons !== undefined) setPersons(p.persons);
  }
  function clearFilters() {
    setFilters(NO_WEB_TX_FILTERS);
    setQuery("");
  }
  const activeChips: Array<{ key: string; label: string; warn?: boolean; remove: () => void }> = [
    ...(cats.includes(UNCATEGORIZED) ? [{ key: "uncat", label: "Needs category", warn: true, remove: () => setCats(cats.filter((c) => c !== UNCATEGORIZED)) }] : []),
    ...(direction ? [{ key: "dir", label: direction === "in" ? "Money in" : "Money out", remove: () => setDirection("") }] : []),
    ...(ledgerFilter ? [{ key: "ledger", label: `Counts in ${ledgerLabel(ledgerFilter, refs.people)}`, remove: () => setLedgerFilter("") }] : []),
    ...(group ? [{ key: "group", label: group === NONE ? "No group" : (groupName.get(group) ?? "Group"), remove: () => setGroup("") }] : []),
    ...accounts.map((id) => ({ key: `a-${id}`, label: accName.get(id) ?? "Account", remove: () => setAccounts(accounts.filter((x) => x !== id)) })),
    ...cats.filter((c) => c !== UNCATEGORIZED).map((c) => ({ key: `c-${c}`, label: c, remove: () => setCats(cats.filter((x) => x !== c)) })),
    ...persons.map((id) => ({ key: `p-${id}`, label: `from ${refs.people.find((p) => p.id === id)?.name ?? "?"}`, remove: () => setPersons(persons.filter((x) => x !== id)) })),
    ...(query ? [{ key: "q", label: `“${query}”`, remove: () => setQuery("") }] : []),
  ];
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
      onSynced={quietReload}
      actions={
        <div className="flex gap-2">
          <Button size="sm" variant="flat" startContent={<FaFileImport />} onPress={() => setImportOpen(true)} isDisabled={refs.loading}>
            Import
          </Button>
          <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => setAddOpen(true)} isDisabled={refs.loading}>
            Add
          </Button>
        </div>
      }
    >
      <TransactionFiltersPane
        isOpen={paneOpen}
        onClose={() => setPaneOpen(false)}
        value={paneValue}
        onChange={setFilters}
        accounts={refs.accounts.filter((a) => a.active !== false || accounts.includes(a.id)).map((a) => ({ id: a.id, name: a.name }))}
        categories={categoryOptions}
        people={refs.people.map((p) => ({ id: p.id, name: p.name }))}
        ledgers={owners.length ? [HOUSEHOLD_LEDGER, ...owners.map((p) => p.id)].map((k) => ({ key: k, name: ledgerLabel(k, refs.people) })) : []}
        groups={[{ id: NONE, name: "No group" }, ...refs.groups]}
        matching={rows.length}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-3">
        <Select {...FILTER_SELECT} size="sm" label="Period" selectedKeys={[period]} onChange={(e) => e.target.value && setPeriod(e.target.value)}>
          {periodOptions.map((o) => (
            <SelectItem key={o.key}>{o.label}</SelectItem>
          ))}
        </Select>
        {period === CUSTOM && (
          <>
            <Input size="sm" type="date" label="From" placeholder=" " value={customFrom} onValueChange={(v) => v && setCustomFrom(v)} />
            <Input size="sm" type="date" label="To" placeholder=" " value={customTo} onValueChange={(v) => v && setCustomTo(v)} />
          </>
        )}
        <Input size="sm" label="Search" value={query} onValueChange={setQuery} startContent={<FaSearch className="text-default-400" />} isClearable onClear={() => setQuery("")} className="lg:col-span-2" />
        <Button size="lg" variant="flat" className="h-12" startContent={<FaFilter />} onPress={() => setPaneOpen(true)}>
          Filters{filterCount ? ` · ${filterCount}` : ""}
          {sort !== "newest" ? ` · ↕ ${TX_SORT_LABELS[sort]}` : ""}
        </Button>
      </div>

      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {activeChips.map((c) => (
            <Chip key={c.key} size="sm" variant="flat" color={c.warn ? "warning" : "primary"} onClose={c.remove}>
              {c.label}
            </Chip>
          ))}
          <Button size="sm" variant="light" startContent={<FaRedo />} onPress={clearFilters}>
            Clear all
          </Button>
        </div>
      )}

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
                      <CategoryQuickEdit value={t._cat} options={categoryOptions} saving={savingCat.has(t.id)} onPick={(c) => quickCategory(t, c)}>
                        <Chip size="sm" variant="flat" color={t._cat === UNCATEGORIZED ? "warning" : "default"} className="cursor-pointer">
                          {t._cat}
                          {src && !parseLineItems(t) && <span className="opacity-60"> · {src}</span>}
                        </Chip>
                      </CategoryQuickEdit>
                    )}
                    {t.personId && (t.amount ?? 0) > 0 && (
                      <span className="flex items-center gap-1">
                        from <PersonChip personId={t.personId} people={refs.people} />
                      </span>
                    )}
                    {(t._ledgers.length > 1 || t._ledgers[0] !== HOUSEHOLD_LEDGER) && (
                      <Chip size="sm" variant="dot" color="secondary" title="Whose budget it counts in">
                        {t._ledgers.length > 1 ? `Split · ${[...new Set(t._ledgers as string[])].map((k) => ledgerLabel(k, refs.people)).join(" + ")}` : `${ledgerLabel(t._ledgers[0], refs.people)}'s`}
                      </Chip>
                    )}
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
          accountLedgerKey={accLedger.get(editing.accountId) ?? HOUSEHOLD_LEDGER}
          owners={owners}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            const id = editing.id;
            setEditing(null);
            if (r.deleted) setTxs((ts) => ts.filter((x) => x.id !== id));
            else if (r.patch) patchTxs([id], r.patch);
            // A new rule can recategorize other rows: pick it up in the background.
            if (r.ruleCreated) {
              refs.reload();
              quietReload();
            } else if (r.newCategories?.length) refs.reload();
          }}
        />
      )}
      {bulkOpen && (
        <BulkModal
          ids={[...selected]}
          refs={refs}
          owners={owners}
          onClose={() => setBulkOpen(false)}
          onSaved={(ids, patch, newCategories) => {
            setBulkOpen(false);
            setSelected(new Set());
            patchTxs(ids, patch);
            if (newCategories) refs.reload();
          }}
        />
      )}
      {addOpen && (
        <AddModal
          accounts={manualAccounts}
          refs={refs}
          onClose={() => setAddOpen(false)}
          onSaved={(row) => {
            setAddOpen(false);
            if (row?.id && row.date >= range.fromIso && row.date <= range.toIso) setTxs((ts) => [row, ...ts.filter((x) => x.id !== row.id)].sort(byNewest));
          }}
        />
      )}
      <ImportCsvModal isOpen={importOpen} onClose={() => setImportOpen(false)} accounts={refs.accounts} onImported={() => void load()} />
    </FinanceShell>
  );
}

// ── Edit one ─────────────────────────────────────────────────────────────────

type Refs = ReturnType<typeof useFinanceRefs>;

function PersonSelect({ value, onChange, people, label = "Person" }: { value: string; onChange: (v: string) => void; people: Refs["people"]; label?: string }) {
  return (
    <Select label={label} selectedKeys={[value || HOUSEHOLD]} onChange={(e) => onChange(e.target.value === HOUSEHOLD ? "" : e.target.value)}>
      {[{ id: HOUSEHOLD, name: "No one" }, ...people].map((p) => (
        <SelectItem key={p.id}>{p.name}</SelectItem>
      ))}
    </Select>
  );
}

/** "" = no group. "New group…" creates one and picks it. */
function GroupSelect({ value, onChange, refs }: { value: string; onChange: (v: string) => void; refs: Refs }) {
  return (
    <SpendGroupPicker
      value={value || NONE}
      onChange={(v) => onChange(v === NONE ? "" : v)}
      groups={refs.groups}
      leading={[{ id: NONE, name: "None (counts against the budget)" }]}
      onCreated={() => void refs.reload()}
    />
  );
}

/** "Counts in": whose budget. "" = the account's default. */
function LedgerSelect({ value, onChange, owners, people, defaultLabel, label = "Counts in", size }: { value: string; onChange: (v: string) => void; owners: { id: string }[]; people: Refs["people"]; defaultLabel: string; label?: string; size?: "sm" | "md" }) {
  const DEFAULT = "__default";
  return (
    <Select size={size} label={label} selectedKeys={[value || DEFAULT]} onChange={(e) => e.target.value && onChange(e.target.value === DEFAULT ? "" : e.target.value)}>
      {[{ key: DEFAULT, name: defaultLabel }, { key: HOUSEHOLD_LEDGER, name: "Household budget" }, ...owners.map((p) => ({ key: p.id, name: `${ledgerLabel(p.id, people)}'s own budget` }))].map((o) => (
        <SelectItem key={o.key}>{o.name}</SelectItem>
      ))}
    </Select>
  );
}

function EditModal({
  tx,
  refs,
  accountName,
  accountLedgerKey,
  owners,
  onClose,
  onSaved,
}: {
  tx: any;
  refs: Refs;
  accountName: string;
  accountLedgerKey: string;
  owners: { id: string }[];
  onClose: () => void;
  onSaved: (r: EditResult) => void;
}) {
  const [ledger, setLedger] = useState<string>(tx.ledger ?? "");
  const [category, setCategory] = useState<string>(tx.category ?? "");
  const [person, setPerson] = useState<string>(tx.personId ?? "");
  const [group, setGroup] = useState<string>(tx.spendGroupId ?? "");
  const [notes, setNotes] = useState<string>(tx.notes ?? "");
  const [remember, setRemember] = useState(false);
  const [pattern, setPattern] = useState(suggestPattern(tx.description));
  const [saving, setSaving] = useState(false);
  const stored = useMemo(() => parseLineItems(tx), [tx]);
  const [items, setItems] = useState<ItemDraft[]>(() => (stored ?? []).map((i) => ({ name: i.name ?? "", amount: String(i.amount), category: i.category, ledger: i.ledger ?? "" })));
  // Where the charge counts when nothing is set on it: its account's budget.
  const accountDefault = `${ledgerLabel(accountLedgerKey, refs.people)}${accountLedgerKey === HOUSEHOLD_LEDGER ? "" : "'s own"} budget (the account's)`;
  const chargeLedger = ledger || accountLedgerKey;
  const manual = !tx.sfTransactionId;

  async function save() {
    const input: Record<string, unknown> = { transactionId: tx.id };
    const cat = category.trim();
    // Saving a guessed (LLM) category as is confirms it (it becomes MANUAL).
    if (cat !== (tx.category ?? "") || (tx.categorySource === "LLM" && cat)) input.category = cat || null;
    if (person !== (tx.personId ?? "")) input.personId = person || null;
    if (group !== (tx.spendGroupId ?? "")) input.spendGroupId = group || null;
    if (notes !== (tx.notes ?? "")) input.notes = notes || null;
    if (ledger !== (tx.ledger ?? "")) input.ledger = ledger || null;
    const rows = items.filter((i) => i.name.trim() || i.amount.trim() || i.category.trim());
    if (rows.some((i) => !(Number(i.amount) > 0) || !i.category.trim())) {
      return addToast({ title: "Each item needs an amount and a category", color: "warning" });
    }
    const next = rows.map((i) => ({ name: i.name.trim() || null, amount: Number(i.amount), category: i.category.trim(), ...(i.ledger ? { ledger: i.ledger } : {}) }));
    const before = (stored ?? []).map((i) => ({ name: i.name ?? null, amount: i.amount, category: i.category, ...(i.ledger ? { ledger: i.ledger } : {}) }));
    if (JSON.stringify(next) !== JSON.stringify(before)) input.lineItems = next.length ? next : null;
    if (remember && pattern.trim()) input.rememberPattern = pattern.trim();
    if (Object.keys(input).length === 1) return onClose();
    setSaving(true);
    const r = await callOp(financeClient, "update_finance_transaction", input as any);
    setSaving(false);
    if ("error" in r) return addToast({ title: "Couldn't save", description: r.error, color: "danger" });
    addToast({ title: r.result.ruleCreated ? "Saved, and a rule was added" : "Saved", color: "success" });
    onSaved({ patch: txPatchFromInput(input), ruleCreated: r.result.ruleCreated, newCategories: r.result.newCategories });
  }

  async function remove() {
    if (!confirm("Delete this transaction?")) return;
    setSaving(true);
    const r = await financeClient.models.homeFinanceTransaction.delete({ id: tx.id });
    setSaving(false);
    if (r.errors?.length) return addToast({ title: "Couldn't delete", description: r.errors[0].message, color: "danger" });
    onSaved({ deleted: true });
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
          <CategoryInput placeholder="Uncategorized" value={category} onValueChange={setCategory} options={refs.categories} />
          {items.length > 0 && <p className="text-xs text-default-500 -mt-2">Itemized: spending counts under the items&apos; categories below, not this one.</p>}
          {tx.categorySource === "LLM" && category === (tx.category ?? "") && (
            <p className="text-xs text-default-500 -mt-2">Guessed by the classifier. Saving confirms it, so the sync won&apos;t change it.</p>
          )}
          {(tx.amount ?? 0) > 0 && <PersonSelect value={person} onChange={setPerson} people={refs.people} label="Contributor (who put this money in)" />}
          {owners.length > 0 && (
            <>
              <LedgerSelect value={ledger} onChange={setLedger} owners={owners} people={refs.people} defaultLabel={accountDefault} />
              {chargeLedger === HOUSEHOLD_LEDGER && accountLedgerKey !== HOUSEHOLD_LEDGER && (tx.amount ?? 0) < 0 && (
                <p className="text-xs text-default-500 -mt-2">Paid from {ledgerLabel(accountLedgerKey, refs.people)}&apos;s account for the household: counts as their contribution.</p>
              )}
              {items.length > 0 && <p className="text-xs text-default-500 -mt-2">Items can count in a different budget each (below).</p>}
            </>
          )}
          <GroupSelect value={group} onChange={setGroup} refs={refs} />
          <Input label="Notes" value={notes} onValueChange={setNotes} />
          {(tx.amount ?? 0) < 0 && (
            <ItemsEditor
              items={items}
              onChange={setItems}
              charge={Math.abs(tx.amount ?? 0)}
              categories={refs.categories}
              owners={owners}
              people={refs.people}
              chargeLedgerLabel={`${ledgerLabel(chargeLedger, refs.people)}${chargeLedger === HOUSEHOLD_LEDGER ? "" : "'s own"} budget (the charge's)`}
              start={() => setItems([{ name: "", amount: String(Math.abs(tx.amount ?? 0)), category: category.trim(), ledger: "" }, { name: "", amount: "", category: "", ledger: "" }])}
            />
          )}
          <div className="rounded-lg border border-default-200 p-3 flex flex-col gap-2">
            <Checkbox isSelected={remember} onValueChange={setRemember}>
              Remember for similar transactions
            </Checkbox>
            {remember && (
              <>
                <Input size="sm" label="When the description contains" description="Plain text (any case) or /regex/flags. Applies the category (and contributor, on money in) above to future transactions." value={pattern} onValueChange={setPattern} />
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

type ItemDraft = { name: string; amount: string; category: string; ledger: string };

/**
 * Split one charge across categories (an Amazon order). Items needn't add
 * up exactly: they're scaled to the charge, so tax and shipping spread
 * proportionally (lib/finance/categories.ts categoryParts).
 */
function ItemsEditor({
  items,
  onChange,
  charge,
  categories,
  owners,
  people,
  chargeLedgerLabel,
  start,
}: {
  items: ItemDraft[];
  onChange: (items: ItemDraft[]) => void;
  charge: number;
  categories: string[];
  owners: { id: string }[];
  people: Refs["people"];
  chargeLedgerLabel: string;
  start: () => void;
}) {
  const update = (i: number, patch: Partial<ItemDraft>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const sum = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  if (!items.length) {
    return (
      <Button variant="flat" size="sm" startContent={<FaPlus />} onPress={start} className="self-start">
        Itemize (split across categories{owners.length ? " or budgets" : ""})
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
          <CategoryInput value={it.category} onValueChange={(v) => update(i, { category: v })} options={categories} hint={false} />
          <Button size="sm" isIconOnly variant="light" aria-label="Remove item" onPress={() => onChange(items.filter((_, j) => j !== i))}>
            <FaTrash />
          </Button>
          {owners.length > 0 && (
            <div className="col-span-2 sm:col-span-4">
              <LedgerSelect size="sm" value={it.ledger} onChange={(v) => update(i, { ledger: v })} owners={owners} people={people} defaultLabel={chargeLedgerLabel} />
            </div>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between">
        <Button size="sm" variant="flat" startContent={<FaPlus />} onPress={() => onChange([...items, { name: "", amount: "", category: "", ledger: "" }])}>
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

function BulkModal({
  ids,
  refs,
  owners,
  onClose,
  onSaved,
}: {
  ids: string[];
  refs: Refs;
  owners: { id: string }[];
  onClose: () => void;
  /** The ids that saved, the fields they got, and whether a category was created. */
  onSaved: (savedIds: string[], patch: Record<string, unknown>, newCategories: boolean) => void;
}) {
  const [category, setCategory] = useState("");
  const [ledger, setLedger] = useState(KEEP);
  const [group, setGroup] = useState(KEEP);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(0);

  async function save() {
    const base: Record<string, unknown> = {};
    if (category.trim()) base.category = category.trim();
    if (group !== KEEP) base.spendGroupId = group === NONE ? null : group;
    if (ledger !== KEEP) base.ledger = ledger === NONE ? null : ledger;
    if (!Object.keys(base).length) return onClose();
    setSaving(true);
    const failures: string[] = [];
    const saved: string[] = [];
    let created = false;
    for (const id of ids) {
      const r = await callOp(financeClient, "update_finance_transaction", { transactionId: id, ...base } as any);
      if ("error" in r) failures.push(r.error);
      else {
        saved.push(id);
        if (r.result.newCategories.length) created = true;
      }
      setDone((d) => d + 1);
    }
    setSaving(false);
    if (failures.length) addToast({ title: `${failures.length} of ${ids.length} failed`, description: failures[0], color: "danger" });
    else addToast({ title: `Updated ${ids.length} transactions`, color: "success" });
    onSaved(saved, txPatchFromInput(base), created);
  }

  return (
    <Modal isOpen onClose={onClose}>
      <ModalContent>
        <ModalHeader>Edit {ids.length} transactions</ModalHeader>
        <ModalBody className="gap-3">
          <p className="text-xs text-default-500">Only the fields you set change.</p>
          <CategoryInput placeholder="Leave unchanged" value={category} onValueChange={setCategory} options={refs.categories} />
          <SpendGroupPicker
            value={group}
            onChange={setGroup}
            groups={refs.groups}
            leading={[{ id: KEEP, name: "Leave unchanged" }, { id: NONE, name: "No group" }]}
            onCreated={() => void refs.reload()}
          />
          {owners.length > 0 && (
            <Select label="Counts in" selectedKeys={[ledger]} onChange={(e) => e.target.value && setLedger(e.target.value)}>
              {[{ id: KEEP, name: "Leave unchanged" }, { id: NONE, name: "Each account's own budget" }, { id: HOUSEHOLD_LEDGER, name: "Household budget" }, ...owners.map((p) => ({ id: p.id, name: `${ledgerLabel(p.id, refs.people)}'s own budget` }))].map((o) => (
                <SelectItem key={o.id}>{o.name}</SelectItem>
              ))}
            </Select>
          )}
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

function AddModal({ accounts, refs, onClose, onSaved }: { accounts: any[]; refs: Refs; onClose: () => void; onSaved: (row: any) => void }) {
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
      personId: type === "INCOME" ? person || null : null,
      personSource: type === "INCOME" && person ? "MANUAL" : null,
      spendGroupId: group || null,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (r.errors?.length) return addToast({ title: "Couldn't save", description: r.errors[0].message, color: "danger" });
    // Written straight to the model, so a new category is remembered here (the op does it for edits).
    if (category.trim()) void rememberCategories(financeClient, [category]).then((added) => {
        if (added.length) void refs.reload();
      }).catch(() => {});
    onSaved(r.data);
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
              <CategoryInput value={category} onValueChange={setCategory} options={refs.categories} />
              {type === "INCOME" && <PersonSelect value={person} onChange={setPerson} people={refs.people} label="Contributor" />}
              <GroupSelect value={group} onChange={setGroup} refs={refs} />
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
