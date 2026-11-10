"use client";

// Which budget lines to show by how often they repeat (monthly, quarterly,
// yearly, one-time), kept in the URL (?include=MONTHLY,QUARTERLY) like the
// period. No param = the default for the period kind (defaultCadences):
// a month shows monthly lines, a quarter adds quarterly ones, a year adds
// yearly ones. One-time lines are always in; filterBudgetView shows them
// only in periods their date falls in.

import React, { useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import { Select, SelectItem } from "@heroui/select";

import { BUDGET_PERIODS, type BudgetPeriod } from "@/lib/finance/budget";
import type { Period } from "@/lib/finance/periods";

const LABELS: Record<BudgetPeriod, string> = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", ANNUALLY: "Yearly", ONCE: "One-time" };

/** What a period kind shows when nothing was picked. */
export function defaultCadences(kind: Period["kind"]): Set<BudgetPeriod> {
  if (kind === "month") return new Set(["MONTHLY", "ONCE"]);
  if (kind === "quarter" || kind === "last3") return new Set(["MONTHLY", "QUARTERLY", "ONCE"]);
  return new Set(["MONTHLY", "ANNUALLY", "ONCE"]);
}

export function useCadenceFilter(kind: Period["kind"]) {
  const router = useRouter();
  const raw = router.query.include;
  const param = Array.isArray(raw) ? raw[0] : raw;
  const include = useMemo(() => {
    const picked = (param ?? "").split(",").filter((p): p is BudgetPeriod => (BUDGET_PERIODS as readonly string[]).includes(p));
    return picked.length ? new Set<BudgetPeriod>(picked) : defaultCadences(kind);
  }, [param, kind]);
  const setInclude = useCallback(
    (next: Set<BudgetPeriod>) => {
      const { include: _drop, ...rest } = router.query;
      const query = next.size === 0 ? rest : { ...rest, include: BUDGET_PERIODS.filter((p) => next.has(p)).join(",") };
      router.replace({ pathname: router.pathname, query }, undefined, { shallow: true, scroll: false });
    },
    [router],
  );
  return { include, setInclude };
}

export function CadenceFilter({ value, onChange }: { value: Set<BudgetPeriod>; onChange: (v: Set<BudgetPeriod>) => void }) {
  const all = BUDGET_PERIODS.every((p) => value.has(p));
  return (
    <Select
      aria-label="Include budget lines"
      size="sm"
      selectionMode="multiple"
      className="w-48"
      selectedKeys={value}
      onSelectionChange={(k) => onChange(new Set(Array.from(k as Set<string>) as BudgetPeriod[]))}
      renderValue={() => (all ? "All lines" : BUDGET_PERIODS.filter((p) => value.has(p)).map((p) => LABELS[p]).join(" + "))}
      startContent={<span className="text-xs text-default-500 shrink-0">Include</span>}
    >
      {BUDGET_PERIODS.map((p) => (
        <SelectItem key={p}>{LABELS[p]}</SelectItem>
      ))}
    </Select>
  );
}
