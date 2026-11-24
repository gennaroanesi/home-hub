"use client";

// A category field for transaction editors: pick from the vocabulary (the
// category tree, in tree order, sub-categories indented) or create one by
// typing it ("Parent: Child" or "Parent > Child" makes a sub-category).
// Search matches any words of the path, like the inventory picker. A new
// name is added to the tree when the transaction saves
// (update_finance_transaction → lib/finance/category-list.ts).

import React from "react";

import { FreeCombobox } from "@/components/free-combobox";
import { SUBCATEGORY_SEPARATOR } from "@/lib/finance/categories";
import { normalizeCategoryName } from "@/lib/finance/category-list";
import { categoryMatches } from "@/lib/inventory";

export function isNewCategory(value: string, options: string[]): boolean {
  const v = normalizeCategoryName(value).toLowerCase();
  return !!v && !options.some((o) => o.toLowerCase() === v);
}

/** Indented leaf name while browsing; the whole path once something is typed. */
function CategoryOption({ path, typed }: { path: string; typed: string }) {
  const parts = path.split(SUBCATEGORY_SEPARATOR);
  if (typed.trim() || parts.length === 1) {
    return (
      <span>
        {parts.length > 1 && <span className="text-default-400">{parts.slice(0, -1).join(SUBCATEGORY_SEPARATOR) + SUBCATEGORY_SEPARATOR}</span>}
        {parts[parts.length - 1]}
      </span>
    );
  }
  return <span style={{ paddingLeft: (parts.length - 1) * 14 }}>{parts[parts.length - 1]}</span>;
}

export function CategoryInput({
  label = "Category",
  placeholder,
  value,
  onValueChange,
  options,
  hint = true,
}: {
  label?: string;
  placeholder?: string;
  value: string;
  onValueChange: (v: string) => void;
  options: string[];
  /** Say under the field that a new name will be created (off for cramped item rows). */
  hint?: boolean;
}) {
  const created = isNewCategory(value, options);
  const normalized = normalizeCategoryName(value);
  const parent = normalized.includes(SUBCATEGORY_SEPARATOR) ? normalized.split(SUBCATEGORY_SEPARATOR).slice(0, -1).join(SUBCATEGORY_SEPARATOR) : "";
  return (
    <FreeCombobox
      label={label}
      placeholder={placeholder}
      value={value}
      onValueChange={onValueChange}
      options={options}
      createLabel={(t) => `Create “${normalizeCategoryName(t)}”`}
      matches={(o, t) => categoryMatches(o, t.replace(/:/g, " "))}
      renderOption={(o, t) => <CategoryOption path={o} typed={t} />}
      maxResults={50}
      description={
        hint && created ? (
          <span className="text-primary">
            New category{parent ? ` under ${parent}` : ""}: created when you save
          </span>
        ) : undefined
      }
    />
  );
}
