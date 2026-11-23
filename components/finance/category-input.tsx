"use client";

// A category field for transaction editors: pick from the vocabulary or
// create one by typing it ("Parent: Child" makes a sub-category). A new
// name is remembered when the transaction saves (update_finance_transaction
// → lib/finance/category-list.ts), so it shows in every picker afterwards.

import React from "react";

import { FreeCombobox } from "@/components/free-combobox";
import { SUBCATEGORY_SEPARATOR } from "@/lib/finance/categories";

export function isNewCategory(value: string, options: string[]): boolean {
  const v = value.trim().toLowerCase();
  return !!v && !options.some((o) => o.toLowerCase() === v);
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
  const parent = value.includes(SUBCATEGORY_SEPARATOR) ? value.split(SUBCATEGORY_SEPARATOR)[0].trim() : "";
  return (
    <FreeCombobox
      label={label}
      placeholder={placeholder}
      value={value}
      onValueChange={onValueChange}
      options={options}
      createLabel={(t) => `Create “${t}”`}
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
