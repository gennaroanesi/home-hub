"use client";

// Reference data most finance pages need: accounts, household members,
// spend groups, and the category vocabulary + active rules.

import { useCallback, useEffect, useState } from "react";

import { financeClient } from "@/components/finance/client";
import type { PersonLite } from "@/components/finance/ui";
import { allCategories, rulesFromDbRows, type CategoryRule } from "@/lib/finance/categories";
import { bucketCategories } from "@/lib/finance/budget";
import { listAccounts, listBudgetLines, listCategoryRules, listHouseholdPeople, listSpendGroups } from "@/lib/finance/data";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FinanceRefs = {
  accounts: any[];
  people: PersonLite[];
  groups: any[];
  rules: CategoryRule[];
  categories: string[];
  loading: boolean;
  reload: () => Promise<void>;
};

export function useFinanceRefs(): FinanceRefs {
  const [state, setState] = useState<Omit<FinanceRefs, "reload">>({ accounts: [], people: [], groups: [], rules: [], categories: [], loading: true });

  const reload = useCallback(async () => {
    const [accounts, people, groups, ruleRows, lines] = await Promise.all([
      listAccounts(financeClient),
      listHouseholdPeople(financeClient),
      listSpendGroups(financeClient),
      listCategoryRules(financeClient),
      listBudgetLines(financeClient),
    ]);
    const rules = rulesFromDbRows(ruleRows);
    const cats = new Set(allCategories(rules));
    for (const l of lines) for (const c of bucketCategories(l)) cats.add(c);
    setState({ accounts, people, groups, rules, categories: [...cats].sort((a, b) => a.localeCompare(b)), loading: false });
  }, []);

  useEffect(() => {
    reload().catch((e) => {
      console.error("[finance] loading reference data failed", e);
      setState((s) => ({ ...s, loading: false }));
    });
  }, [reload]);

  return { ...state, reload };
}
