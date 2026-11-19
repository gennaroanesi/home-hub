"use client";

// The detail fields of an inventory item's type, generated from
// lib/inventory-details.ts: one input per field (text with suggestions,
// numbers with units, yes/no, dates, choices, shopping list). Values are
// strings; the inventory ops convert and check them.

import React from "react";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Checkbox } from "@heroui/checkbox";

import { DateInput } from "@/components/date-input";
import { DETAIL_SPECS, type DetailField, type DetailType } from "@/lib/inventory-details";

export function DetailFields({
  type,
  values,
  onChange,
  lists,
}: {
  type: DetailType;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  lists: Array<{ id: string; name: string; emoji?: string | null }>;
}) {
  const spec = DETAIL_SPECS[type];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {spec.fields.map((f) => (
        <FieldInput key={f.key} field={f} value={values[f.key] ?? ""} onChange={(v) => onChange(f.key, v)} lists={lists} listId={`inv-${type}-${f.key}`} />
      ))}
    </div>
  );
}

function FieldInput({
  field: f,
  value,
  onChange,
  lists,
  listId,
}: {
  field: DetailField;
  value: string;
  onChange: (v: string) => void;
  lists: Array<{ id: string; name: string; emoji?: string | null }>;
  listId: string;
}) {
  switch (f.kind) {
    case "choice":
      return (
        <Select label={f.label} selectedKeys={value ? [value] : []} onChange={(e) => onChange(e.target.value)} description={f.hint}>
          {(f.options ?? []).map((o) => (
            <SelectItem key={o}>{f.optionLabels?.[o] ?? o}</SelectItem>
          ))}
        </Select>
      );
    case "shoppingList":
      return (
        <Select label={f.label} placeholder="Default list" selectedKeys={value ? [value] : []} onChange={(e) => onChange(e.target.value)}>
          {lists.map((l) => (
            <SelectItem key={l.id}>{`${l.emoji ?? ""} ${l.name}`.trim()}</SelectItem>
          ))}
        </Select>
      );
    case "bool":
      return (
        <div className="flex items-center px-1">
          <Checkbox isSelected={value === "true"} onValueChange={(on) => onChange(on ? "true" : "false")} size="sm">
            {f.label}
          </Checkbox>
        </div>
      );
    case "date":
      return <DateInput label={f.label} value={value} onChange={onChange} />;
    case "int":
    case "float":
      return (
        <Input
          label={f.label}
          type="number"
          step={f.kind === "float" ? "any" : "1"}
          value={value}
          onValueChange={onChange}
          description={f.hint}
          endContent={f.unit ? <span className="text-default-400 text-xs">{f.unit}</span> : undefined}
        />
      );
    default:
      return (
        <>
          <Input label={f.label} value={value} onValueChange={onChange} description={f.hint} list={f.options?.length ? listId : undefined} />
          {f.options?.length ? (
            <datalist id={listId}>
              {f.options.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          ) : null}
        </>
      );
  }
}
