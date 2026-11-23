"use client";

// The transactions behind a budget row (a spending line, a line for a
// stretch of dates, or a "Not budgeted" category), each with its category
// as a chip that recategorizes in place (CategoryQuickEdit, "Create …"
// included). Itemized charges link to the Transactions page, where the
// items are edited.

import React from "react";
import NextLink from "next/link";
import { Chip } from "@heroui/chip";

import { CategoryQuickEdit } from "@/components/finance/category-quick-edit";
import { Money } from "@/components/finance/ui";
import { effectiveCategory, parseLineItems, UNCATEGORIZED, type CategoryRule } from "@/lib/finance/categories";
import { fmtDate } from "@/lib/finance/dates";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function BudgetTxList({
  txs,
  categories,
  rules,
  saving,
  onRecategorize,
  allHref,
  empty = "No spending yet.",
}: {
  txs: any[];
  categories: string[];
  rules?: CategoryRule[];
  saving: Set<string>;
  /** null = Uncategorized. */
  onRecategorize: (tx: any, category: string | null) => void;
  /** "See all in Transactions" link (same filter there), when given. */
  allHref?: string;
  empty?: string;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      {txs.length === 0 ? (
        <span className="text-default-500">{empty}</span>
      ) : (
        txs.map((t) => {
          const cat = effectiveCategory(t, rules);
          const itemized = !!parseLineItems(t);
          return (
            <div key={t.id} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-default-400 tabular-nums shrink-0">{fmtDate(t.date)}</span>
                <span className="truncate">{t.description || "(no description)"}</span>
                {itemized ? (
                  <NextLink href={`/finance/transactions?q=${encodeURIComponent(t.description ?? "")}&from=${t.date}&to=${t.date}`} className="shrink-0" title="Split across categories: edit the items in Transactions">
                    <Chip size="sm" variant="flat" color="primary" className="cursor-pointer">
                      Itemized
                    </Chip>
                  </NextLink>
                ) : (
                  <span className="shrink-0">
                    <CategoryQuickEdit value={cat} options={categories} saving={saving.has(t.id)} onPick={(c) => onRecategorize(t, c)}>
                      <Chip size="sm" variant="flat" color={cat === UNCATEGORIZED ? "warning" : "default"} className="cursor-pointer">
                        {cat}
                        {t.categorySource === "LLM" && <span className="opacity-60"> · guessed</span>}
                      </Chip>
                    </CategoryQuickEdit>
                  </span>
                )}
              </span>
              <Money value={t.amount} className="shrink-0" />
            </div>
          );
        })
      )}
      {allHref && (
        <NextLink href={allHref} className="text-xs text-primary hover:underline self-start mt-1">
          See them in Transactions ›
        </NextLink>
      )}
    </div>
  );
}
