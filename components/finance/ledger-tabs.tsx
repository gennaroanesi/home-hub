"use client";

// Whose money a finance page shows: the household, one person's own, or
// everything (lib/finance/ledger.ts). Kept in the URL (?ledger=<personId>|all;
// household is the default and leaves it out), so a link or a refresh keeps it.

import React, { useMemo } from "react";
import { useRouter } from "next/router";
import { Tabs, Tab } from "@heroui/tabs";

import type { PersonLite } from "@/components/finance/ui";
import { ALL_LEDGERS, HOUSEHOLD, ledgerLabel, ledgerPeople } from "@/lib/finance/ledger";

export type LedgerState = {
  ledger: string;
  setLedger: (key: string) => void;
  /** Household, each person, everything. */
  keys: string[];
  /** The people with a personal ledger. */
  people: PersonLite[];
  personal: boolean;
  label: string;
};

export function useLedger(people: PersonLite[], opts: { allowAll?: boolean } = {}): LedgerState {
  const router = useRouter();
  const allowAll = opts.allowAll !== false;
  const owners = useMemo(() => ledgerPeople(people as (PersonLite & { cognitoUsername?: string | null })[]), [people]);
  const keys = useMemo(() => [HOUSEHOLD, ...owners.map((p) => p.id), ...(allowAll ? [ALL_LEDGERS] : [])], [owners, allowAll]);
  const param = typeof router.query.ledger === "string" ? router.query.ledger : HOUSEHOLD;
  const ledger = keys.includes(param) ? param : HOUSEHOLD;
  const setLedger = (key: string) =>
    router.replace({ pathname: router.pathname, query: { ...router.query, ledger: key === HOUSEHOLD ? undefined : key } }, undefined, { shallow: true });
  return { ledger, setLedger, keys, people: owners, personal: ledger !== HOUSEHOLD && ledger !== ALL_LEDGERS, label: ledgerLabel(ledger, people) };
}

export function LedgerTabs({ state, className = "mb-3" }: { state: LedgerState; className?: string }) {
  if (state.people.length === 0) return null;
  return (
    <Tabs aria-label="Whose money" size="sm" className={className} selectedKey={state.ledger} onSelectionChange={(k) => state.setLedger(String(k))}>
      {state.keys.map((k) => (
        <Tab key={k} title={k === ALL_LEDGERS ? "Everything" : ledgerLabel(k, state.people)} />
      ))}
    </Tabs>
  );
}
