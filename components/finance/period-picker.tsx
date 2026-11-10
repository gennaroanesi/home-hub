"use client";

// Period selection shared by the finance pages (Budget, Review): month /
// quarter / year / last 3 months, prev/next, and Today. usePeriod keeps the
// choice in the URL (?period=2026-11 | 2026-Q3 | 2026 | last3) so a reload
// or a shared link lands on the same period. Model: lib/finance/periods.ts.

import React, { useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Chip } from "@heroui/chip";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa";

import { todayIso } from "@/lib/finance/dates";
import {
  containsToday,
  MONTH_NAMES,
  PERIOD_KINDS,
  periodContaining,
  periodFromParam,
  periodRange,
  periodToParam,
  shiftPeriod,
  switchKind,
  type Period,
  type PeriodKind,
} from "@/lib/finance/periods";

/**
 * The page's period, from ?period= or `fallback`. Changing it rewrites the
 * query string in place (shallow, no reload, no history entry).
 */
export function usePeriod(fallback: () => Period) {
  const router = useRouter();
  const today = todayIso();
  const raw = router.query.period;
  const param = Array.isArray(raw) ? raw[0] : raw;
  // fallback is only consulted when the URL has no period; it's not a dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const period = useMemo(() => periodFromParam(param) ?? fallback(), [param]);
  const range = useMemo(() => periodRange(period, today), [period, today]);
  const setPeriod = useCallback(
    (p: Period, opts: { dropParams?: string[] } = {}) => {
      const query: Record<string, string | string[] | undefined> = { ...router.query, period: periodToParam(p) };
      for (const k of opts.dropParams ?? []) delete query[k];
      router.replace({ pathname: router.pathname, query }, undefined, { shallow: true, scroll: false });
    },
    [router],
  );
  return { period, range, setPeriod, ready: router.isReady };
}

const selectCls = "rounded-medium border-2 border-default-200 bg-default-100 text-sm px-2 h-8 text-foreground";

export function PeriodPicker({
  value,
  onChange,
  years,
  kinds = PERIOD_KINDS.map((k) => k.kind),
  allowFuture = true,
}: {
  value: Period;
  onChange: (p: Period) => void;
  /** Years offered in the year select; defaults to the last 4 and next 1, plus the selected one. */
  years?: number[];
  kinds?: PeriodKind[];
  /** False hides periods that haven't started (Review looks back only). */
  allowFuture?: boolean;
}) {
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const yearList = useMemo(() => {
    const set = new Set(years ?? [thisYear - 3, thisYear - 2, thisYear - 1, thisYear, ...(allowFuture ? [thisYear + 1] : [])]);
    if ("year" in value) set.add(value.year);
    return [...set].sort((a, b) => b - a);
  }, [years, thisYear, allowFuture, value]);

  const next = shiftPeriod(value, 1);
  const nextIsFuture = periodRange(next, today).fromIso > today;
  const current = periodContaining(value.kind, today);
  const atCurrent = periodToParam(current) === periodToParam(value);
  const inProgress = containsToday(value, today);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-medium border border-default-200 overflow-hidden" role="group" aria-label="Period length">
        {PERIOD_KINDS.filter((k) => kinds.includes(k.kind)).map((k) => (
          <button
            key={k.kind}
            type="button"
            onClick={() => onChange(switchKind(value, k.kind, today))}
            aria-pressed={value.kind === k.kind}
            className={`px-3 h-8 text-xs font-medium whitespace-nowrap transition-colors ${
              value.kind === k.kind ? "bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300" : "text-default-600 hover:bg-default-100"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {value.kind !== "last3" && (
        <>
          <Button size="sm" isIconOnly variant="flat" aria-label="Previous period" onPress={() => onChange(shiftPeriod(value, -1))}>
            <FaChevronLeft />
          </Button>
          {value.kind === "month" && (
            <select aria-label="Month" className={selectCls} value={value.month} onChange={(e) => onChange({ ...value, month: Number(e.target.value) })}>
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1} disabled={!allowFuture && `${value.year}-${String(i + 1).padStart(2, "0")}-01` > today}>
                  {m}
                </option>
              ))}
            </select>
          )}
          {value.kind === "quarter" && (
            <select aria-label="Quarter" className={selectCls} value={value.quarter} onChange={(e) => onChange({ ...value, quarter: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((q) => (
                <option key={q} value={q} disabled={!allowFuture && `${value.year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01` > today}>
                  Q{q}
                </option>
              ))}
            </select>
          )}
          <select aria-label="Year" className={selectCls} value={value.year} onChange={(e) => onChange({ ...value, year: Number(e.target.value) })}>
            {yearList.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <Button size="sm" isIconOnly variant="flat" aria-label="Next period" isDisabled={!allowFuture && nextIsFuture} onPress={() => onChange(next)}>
            <FaChevronRight />
          </Button>
          {!atCurrent && (
            <Button size="sm" variant="light" onPress={() => onChange(current)}>
              Today
            </Button>
          )}
        </>
      )}
      {inProgress && (
        <Chip size="sm" variant="flat">
          in progress
        </Chip>
      )}
    </div>
  );
}
