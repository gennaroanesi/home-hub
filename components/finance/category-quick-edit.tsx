"use client";

// Edit a transaction's category in place: the row's category label opens
// a small popover with a searchable list (and "Create …" for a new category,
// which the save remembers: lib/finance/category-list.ts). Picking calls onPick and closes; the caller saves and updates
// the row. Clicks inside never reach the row (its own onClick opens the
// full edit modal), including from the portaled popover content, since
// React events bubble through the component tree.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@heroui/popover";
import { Input } from "@heroui/input";
import { Spinner } from "@heroui/react";
import { FaSearch } from "react-icons/fa";

import { normalizeCategoryName, SUBCATEGORY_SEPARATOR, UNCATEGORIZED } from "@/lib/finance/categories";
import { categoryMatches } from "@/lib/inventory";

export function CategoryQuickEdit({
  value,
  options,
  onPick,
  saving,
  children,
  className,
}: {
  /** The category shown on the row (UNCATEGORIZED when none). */
  value: string;
  options: string[];
  /** null = Uncategorized. */
  onPick: (category: string | null) => void;
  saving?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // Tree order (the vocabulary's) with sub-categories indented; while
  // searching, any words of the path, names starting with it first. Plus
  // the typed text as a new category when nothing is exactly it.
  const choices = useMemo(() => {
    const q = query.trim().toLowerCase();
    const typed = normalizeCategoryName(query);
    const base = options.filter((o) => o !== UNCATEGORIZED);
    const hits = q ? base.filter((o) => categoryMatches(o, q.replace(/:/g, " "))) : base;
    if (q) {
      const leaf = (o: string) => o.split(SUBCATEGORY_SEPARATOR).pop()!.toLowerCase();
      hits.sort((a, b) => (leaf(a).startsWith(q) ? 0 : 1) - (leaf(b).startsWith(q) ? 0 : 1));
    }
    const out: Array<{ key: string; label: string; value: string | null; isNew?: boolean; depth?: number; parent?: string }> = hits.map((o) => {
      const parts = o.split(SUBCATEGORY_SEPARATOR);
      return q
        ? { key: o, label: parts[parts.length - 1], parent: parts.length > 1 ? parts.slice(0, -1).join(SUBCATEGORY_SEPARATOR) + SUBCATEGORY_SEPARATOR : undefined, value: o }
        : { key: o, label: parts[parts.length - 1], depth: parts.length - 1, value: o };
    });
    if (typed && !base.some((o) => o.toLowerCase() === typed.toLowerCase())) out.push({ key: "__new", label: `Create “${typed}”`, value: typed, isNew: true });
    if (!q || UNCATEGORIZED.toLowerCase().includes(q)) out.push({ key: "__none", label: UNCATEGORIZED, value: null });
    return out;
  }, [options, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(v: string | null) {
    setOpen(false);
    onPick(v);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, choices.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = choices[active];
      if (c) pick(c.value);
    }
  }

  return (
    // Keep clicks (trigger and portaled content) from reaching the row.
    <span onClick={(e) => e.stopPropagation()} className="inline-flex">
      <Popover isOpen={open} onOpenChange={setOpen} placement="bottom-start" shouldBlockScroll={false}>
        <PopoverTrigger>
          <button
            type="button"
            title="Change category"
            disabled={saving}
            className={`inline-flex items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary hover:opacity-80 ${saving ? "opacity-70 cursor-wait" : "cursor-pointer"} ${className ?? ""}`}
          >
            {children}
            {saving && <Spinner size="sm" className="scale-50 -my-2 -ml-1" />}
          </button>
        </PopoverTrigger>
        <PopoverContent className="p-2 w-64">
          <div className="w-full flex flex-col gap-1" onKeyDown={onKeyDown}>
            <Input
              size="sm"
              autoFocus
              aria-label="Search categories"
              placeholder={value === UNCATEGORIZED ? "Category" : value}
              value={query}
              onValueChange={setQuery}
              startContent={<FaSearch className="text-default-400 text-xs" />}
            />
            <div ref={listRef} role="listbox" aria-label="Categories" className="max-h-64 overflow-y-auto flex flex-col">
              {choices.map((c, i) => {
                const current = c.value === null ? value === UNCATEGORIZED : c.value === value;
                return (
                  <button
                    key={c.key}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    data-idx={i}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(c.value)}
                    style={c.depth ? { paddingLeft: 8 + c.depth * 14 } : undefined}
                    // shrink-0: with truncate's overflow hidden, flex rows would otherwise squash to fit the list's max height.
                    className={`shrink-0 text-left text-sm px-2 py-1.5 rounded-md truncate ${i === active ? "bg-default-100" : ""} ${current ? "font-semibold" : ""} ${c.isNew ? "text-primary" : ""} ${c.value === null ? "text-default-500" : ""}`}
                  >
                    {c.parent && <span className="text-default-400 font-normal">{c.parent}</span>}
                    {c.label}
                  </button>
                );
              })}
              {choices.length === 0 && <span className="text-xs text-default-400 px-2 py-1.5">No categories</span>}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
