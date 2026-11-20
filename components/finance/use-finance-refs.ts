"use client";

// Reference data most finance pages need: accounts, household members,
// spend groups, and the category vocabulary + active rules.

import { useCallback, useEffect, useState } from "react";

import { financeClient } from "@/components/finance/client";
import { allCategories, rulesFromDbRows, type CategoryRule } from "@/lib/finance/categories";
import { bucketCategories } from "@/lib/finance/budget";
import { listAccounts, listBudgetLines, listCategoryRules, listHouseholdPeople, listSpendGroups, type HouseholdPerson } from "@/lib/finance/data";
import { financePeople } from "@/lib/finance/ledger";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FinanceRefs = {
  accounts: any[];
  /** Who finance pickers and lists show (financePeople): members with a login, those opted in, and current account owners. */
  people: HouseholdPerson[];
  /** Every household member, for keeping people referenced by other saved data (paychecks) via financePeople. */
  household: HouseholdPerson[];
  groups: any[];
  rules: CategoryRule[];
  categories: string[];
  loading: boolean;
  reload: () => Promise<void>;
};

export function useFinanceRefs(): FinanceRefs {
  const [state, setState] = useState<Omit<FinanceRefs, "reload">>({ accounts: [], people: [], household: [], groups: [], rules: [], categories: [], loading: true });

  const reload = useCallback(async () => {
    const [accounts, household, groups, ruleRows, lines] = await Promise.all([
      listAccounts(financeClient),
      listHouseholdPeople(financeClient),
      listSpendGroups(financeClient),
      listCategoryRules(financeClient),
      listBudgetLines(financeClient),
    ]);
    const people = financePeople(household, accounts.flatMap((a) => a.ownerPersonIds ?? []));
    const rules = rulesFromDbRows(ruleRows);
    const cats = new Set(allCategories(rules));
    for (const l of lines) for (const c of bucketCategories(l)) cats.add(c);
    setState({ accounts, people, household, groups, rules, categories: [...cats].sort((a, b) => a.localeCompare(b)), loading: false });
  }, []);

  useEffect(() => {
    reload().catch((e) => {
      console.error("[finance] loading reference data failed", e);
      setState((s) => ({ ...s, loading: false }));
    });
  }, [reload]);

  return { ...state, reload };
}
