// Picking an inventory category on the web: type to search (any words of
// the path), alphabetical by path, and "Create …" right there when nothing
// matches ("Parent > Name" files it under an existing parent). Used by the
// item form and the page's category filter (which can't create).
// save_inventory_category; lib/inventory.ts has the sorting and matching.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Autocomplete, AutocompleteItem, addToast } from "@heroui/react";
import { FaLock, FaPlus } from "react-icons/fa";

import { callOp } from "@/lib/ops-client";
import { detailSpec } from "@/lib/inventory-details";
import { categoriesAlphabetical, categoryMatches, newCategoryFromText, type CategoryLike } from "@/lib/inventory";

const CREATE = "__create__";

export function CategoryPicker<T extends CategoryLike>({
  categories,
  value,
  onChange,
  client,
  onCreated,
  extra = [],
  label,
  placeholder = "Search categories…",
  size,
  isRequired,
  className,
}: {
  categories: T[];
  value: string;
  onChange: (id: string) => void;
  /** With these two, typing a new name offers to create it. */
  client?: Parameters<typeof callOp>[0];
  onCreated?: (category: { id: string; name: string; parentId: string | null; detailType: string | null; sortOrder: number }) => void;
  /** Options after the categories, e.g. { key: "none", label: "Uncategorized" }. */
  extra?: Array<{ key: string; label: string }>;
  label?: string;
  placeholder?: string;
  size?: "sm" | "md" | "lg";
  isRequired?: boolean;
  className?: string;
}) {
  const nodes = useMemo(() => categoriesAlphabetical(categories), [categories]);
  const labelOf = (id: string) => nodes.find((n) => n.category.id === id)?.path ?? extra.find((e) => e.key === id)?.label ?? "";
  const [text, setText] = useState(labelOf(value));
  const [creating, setCreating] = useState(false);
  // Follow a value set from outside (opening another item, clearing filters).
  useEffect(() => setText(labelOf(value)), [value, nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  const typed = text.trim() && text !== labelOf(value) ? text.trim() : "";
  const planned = client && onCreated && typed ? newCategoryFromText(categories, typed) : null;
  // What "Create" was offered for: the input may be reset (blur) before the click lands.
  const offered = useRef(planned);
  if (planned) offered.current = planned;
  const options = [
    ...nodes
      .filter((n) => !typed || categoryMatches(n.path, typed))
      .map((n) => ({ key: n.category.id, label: n.path, depth: n.depth, locked: !!detailSpec(n.detailType)?.private })),
    ...extra.filter((e) => !typed || categoryMatches(e.label, typed)).map((e) => ({ ...e, depth: 0, locked: false })),
    ...(planned ? [{ key: CREATE, label: `Create “${planned.path}”`, depth: 0, locked: false }] : []),
  ];

  async function create() {
    const planned = offered.current;
    if (!planned || !client || !onCreated) return;
    setCreating(true);
    try {
      const r = await callOp(client, "save_inventory_category", { name: planned.name, parentId: planned.parentId });
      if ("error" in r) return void addToast({ title: "Couldn't create the category", description: r.error, color: "danger" });
      const c = r.result.category;
      onCreated({ id: c.id, name: c.name, parentId: c.parentId, detailType: null, sortOrder: c.sortOrder });
      onChange(c.id);
      setText(c.path);
      addToast({ title: `Created ${c.path}`, color: "success" });
    } finally {
      setCreating(false);
    }
  }

  return (
    <Autocomplete
      aria-label={label ?? "Category"}
      label={label}
      placeholder={placeholder}
      size={size}
      isRequired={isRequired}
      className={className}
      isLoading={creating}
      items={options}
      inputValue={text}
      onInputChange={setText}
      selectedKey={value || null}
      // We filter (words of the path) and always keep "Create".
      defaultFilter={() => true}
      allowsEmptyCollection={!!planned}
      onSelectionChange={(key) => {
        if (key === CREATE) return void create();
        onChange(key ? String(key) : "");
        if (!key) setText("");
      }}
      onBlur={() => {
        if (!creating) setText(labelOf(value));
      }}
      listboxProps={{ emptyContent: client && onCreated ? "No match. Type “Parent > Name” to file it under a category." : "No match." }}
    >
      {(o) => (
        <AutocompleteItem key={o.key} textValue={o.label} startContent={o.key === CREATE ? <FaPlus className="text-primary text-xs" /> : undefined} className={o.key === CREATE ? "text-primary" : undefined}>
          <span className="flex items-center gap-1.5">
            {o.label}
            {o.locked && <FaLock className="text-[10px] text-default-400" />}
          </span>
        </AutocompleteItem>
      )}
    </Autocomplete>
  );
}
