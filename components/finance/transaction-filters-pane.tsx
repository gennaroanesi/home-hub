// The web Transactions page's filters and sort in one side pane, like the
// phone's TransactionFiltersSheet: sort, money in / out, needs a category,
// whose budget, spend group, and any number of accounts, categories and
// contributors. Changes apply as you pick (the list stays visible behind
// it); Reset clears them. The rules themselves are lib/finance/tx-filter.ts.

import React, { useState } from "react";
import { Autocomplete, AutocompleteItem, Button, Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader } from "@heroui/react";
import { FaTimes } from "react-icons/fa";

import { TX_SORTS, TX_SORT_LABELS, type TxSort } from "@/lib/finance/tx-filter";
import { UNCATEGORIZED } from "@/lib/finance/categories";

export type WebTxFilters = {
  sort: TxSort;
  direction: "" | "in" | "out";
  /** Category names; UNCATEGORIZED = "needs a category". */
  cats: string[];
  ledger: string;
  group: string;
  accounts: string[];
  persons: string[];
};

export const NO_WEB_TX_FILTERS: Omit<WebTxFilters, "sort"> = { direction: "", cats: [], ledger: "", group: "", accounts: [], persons: [] };

/** How many filters are on (sort not counted). */
export function webTxFilterCount(f: WebTxFilters): number {
  return f.accounts.length + f.cats.length + f.persons.length + (f.direction ? 1 : 0) + (f.ledger ? 1 : 0) + (f.group ? 1 : 0);
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function TransactionFiltersPane({
  isOpen,
  onClose,
  value,
  onChange,
  accounts,
  categories,
  people,
  ledgers,
  groups,
  matching,
}: {
  isOpen: boolean;
  onClose: () => void;
  value: WebTxFilters;
  onChange: (patch: Partial<WebTxFilters>) => void;
  accounts: Array<{ id: string; name: string; type?: string | null }>;
  categories: string[];
  /** Contributors: the household. */
  people: Array<{ id: string; name: string }>;
  /** Budgets: household and each person with one. */
  ledgers: Array<{ key: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
  /** How many rows the filters leave, for the footer. */
  matching: number;
}) {
  const [catText, setCatText] = useState("");
  const f = value;
  const uncategorized = f.cats.includes(UNCATEGORIZED);
  const picked = f.cats.filter((c) => c !== UNCATEGORIZED);
  const catOptions = categories.filter((c) => c !== UNCATEGORIZED && !picked.includes(c));

  return (
    <Drawer isOpen={isOpen} onOpenChange={(open) => !open && onClose()} placement="right" size="sm" scrollBehavior="inside">
      <DrawerContent>
        <DrawerHeader className="flex items-center justify-between gap-2">
          <span>Filters</span>
        </DrawerHeader>
        <DrawerBody className="gap-6">
          <Section label="Sort">
            {TX_SORTS.map((k) => (
              <Toggle key={k} on={f.sort === k} onClick={() => onChange({ sort: k })}>
                {TX_SORT_LABELS[k]}
              </Toggle>
            ))}
          </Section>

          <Section label="Show">
            <Toggle on={!f.direction} onClick={() => onChange({ direction: "" })}>
              In and out
            </Toggle>
            <Toggle on={f.direction === "in"} onClick={() => onChange({ direction: "in" })}>
              Money in
            </Toggle>
            <Toggle on={f.direction === "out"} onClick={() => onChange({ direction: "out" })}>
              Money out
            </Toggle>
            <Toggle on={uncategorized} warn onClick={() => onChange({ cats: uncategorized ? picked : [...picked, UNCATEGORIZED] })}>
              Needs category
            </Toggle>
          </Section>

          {ledgers.length > 1 && (
            <Section label="Counts in">
              <Toggle on={!f.ledger} onClick={() => onChange({ ledger: "" })}>
                Any budget
              </Toggle>
              {ledgers.map((l) => (
                <Toggle key={l.key} on={f.ledger === l.key} onClick={() => onChange({ ledger: f.ledger === l.key ? "" : l.key })}>
                  {l.name}
                </Toggle>
              ))}
            </Section>
          )}

          <Section label={`Accounts${f.accounts.length ? ` · ${f.accounts.length}` : ""}`}>
            {accounts.map((a) => (
              <Toggle key={a.id} on={f.accounts.includes(a.id)} onClick={() => onChange({ accounts: toggle(f.accounts, a.id) })}>
                {a.name}
              </Toggle>
            ))}
          </Section>

          <div className="space-y-2">
            <Label>Categories{picked.length ? ` · ${picked.length}` : ""}</Label>
            {picked.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {picked.map((c) => (
                  <Toggle key={c} on onClick={() => onChange({ cats: f.cats.filter((x) => x !== c) })}>
                    {c} <FaTimes className="inline text-[10px] ml-1 opacity-70" />
                  </Toggle>
                ))}
              </div>
            )}
            <Autocomplete
              aria-label="Add a category"
              size="sm"
              placeholder="Add a category…"
              inputValue={catText}
              onInputChange={setCatText}
              selectedKey={null}
              onSelectionChange={(k) => {
                if (k) onChange({ cats: [...f.cats, String(k)] });
                setCatText("");
              }}
            >
              {catOptions.map((c) => (
                <AutocompleteItem key={c}>{c}</AutocompleteItem>
              ))}
            </Autocomplete>
            <p className="text-xs text-default-400">A parent category includes its sub-categories (Baby → Baby: Furniture).</p>
          </div>

          {people.length > 0 && (
            <Section label={`Contributors (money in)${f.persons.length ? ` · ${f.persons.length}` : ""}`}>
              {people.map((p) => (
                <Toggle key={p.id} on={f.persons.includes(p.id)} onClick={() => onChange({ persons: toggle(f.persons, p.id) })}>
                  {p.name}
                </Toggle>
              ))}
            </Section>
          )}

          {groups.length > 1 && (
            <Section label="Spend group">
              <Toggle on={!f.group} onClick={() => onChange({ group: "" })}>
                Any
              </Toggle>
              {groups.map((g) => (
                <Toggle key={g.id} on={f.group === g.id} onClick={() => onChange({ group: f.group === g.id ? "" : g.id })}>
                  {g.name}
                </Toggle>
              ))}
            </Section>
          )}
        </DrawerBody>
        <DrawerFooter className="items-center">
          <span className="text-sm text-default-500 mr-auto">{matching} shown</span>
          <Button variant="light" onPress={() => onChange({ ...NO_WEB_TX_FILTERS, sort: "newest" })}>
            Reset
          </Button>
          <Button color="primary" onPress={onClose}>
            Done
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium uppercase tracking-wider text-default-400">{children}</p>;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function Toggle({ on, warn, onClick, children }: { on?: boolean; warn?: boolean; onClick: () => void; children: React.ReactNode }) {
  const cls = on ? (warn ? "bg-warning text-warning-foreground" : "bg-primary text-primary-foreground") : warn ? "bg-warning-50 text-warning-700 hover:bg-warning-100" : "bg-default-100 text-default-700 hover:bg-default-200";
  return (
    <button type="button" onClick={onClick} className={`px-3 py-1 rounded-full text-sm transition-colors ${cls}`}>
      {children}
    </button>
  );
}
