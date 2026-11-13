// Picks people from the household and the contact book: grouped
// (Household, then Family, Friends, … — lib/people.ts pickerSections),
// searchable by name, a checkbox on every row. `single` picks one and
// closes; otherwise rows toggle.

import React, { useMemo, useRef, useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@heroui/react";
import { Input } from "@heroui/input";
import { Button } from "@heroui/button";
import { FaCheck, FaChevronDown, FaSearch } from "react-icons/fa";

import { PersonAvatar } from "@/components/people";
import { pickerSections, type PickerPerson } from "@/lib/people";

export type PeoplePickerPerson = PickerPerson & {
  emoji?: string | null;
  color?: string | null;
  photoKey?: string | null;
};

export function PeoplePicker<P extends PeoplePickerPerson>({
  people,
  selectedIds,
  onChange,
  single = false,
  label,
  ariaLabel,
  placeholder,
  description,
  isDisabled = false,
  isRequired = false,
  size = "md",
  className = "",
}: {
  people: P[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  description?: string;
  isDisabled?: boolean;
  isRequired?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [width, setWidth] = useState(280);
  const trigger = useRef<HTMLButtonElement>(null);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const sections = useMemo(() => pickerSections(people, query), [people, query]);
  const names = useMemo(() => {
    const byId = new Map(people.map((p) => [p.id, p.name]));
    return selectedIds.map((id) => byId.get(id)).filter(Boolean).join(", ");
  }, [people, selectedIds]);
  // On phones the keyboard would cover the list before anyone types.
  const focusSearch = typeof window !== "undefined" && !window.matchMedia?.("(pointer: coarse)").matches;

  const openChange = (next: boolean) => {
    if (next && trigger.current) setWidth(Math.max(trigger.current.offsetWidth, 260));
    if (!next) setQuery("");
    setOpen(next);
  };

  const toggle = (id: string) => {
    if (single) {
      onChange(selected.has(id) && !isRequired ? [] : [id]);
      openChange(false);
      return;
    }
    onChange(selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  const small = size === "sm";
  return (
    <div className={className}>
      <Popover isOpen={open} onOpenChange={openChange} placement="bottom-start" triggerScaleOnOpen={false} shouldCloseOnBlur={false}>
        <PopoverTrigger>
          <button
            ref={trigger}
            type="button"
            disabled={isDisabled}
            aria-label={ariaLabel ?? label}
            className={`w-full flex items-center gap-2 rounded-medium bg-default-100 hover:bg-default-200 px-3 text-left transition-colors disabled:opacity-50 disabled:pointer-events-none ${
              label ? (small ? "min-h-12 py-1.5" : "min-h-14 py-2") : small ? "min-h-8 py-1" : "min-h-10 py-2"
            }`}
          >
            <span className="flex-1 min-w-0">
              {label && (
                <span className="block text-xs text-default-600">
                  {label}
                  {isRequired && <span className="text-danger ml-0.5">*</span>}
                </span>
              )}
              <span className={`block truncate ${small ? "text-xs" : "text-sm"} ${names ? "text-foreground" : "text-default-500"}`}>
                {names || placeholder || (single ? "Pick someone" : "Nobody")}
              </span>
            </span>
            <FaChevronDown size={10} className="text-default-500 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="p-0">
          <div style={{ width }}>
            <div className="p-2 border-b border-default-200">
              <Input
                size="sm"
                aria-label="Search people"
                placeholder="Search people"
                autoFocus={focusSearch}
                value={query}
                onValueChange={setQuery}
                isClearable
                onClear={() => setQuery("")}
                startContent={<FaSearch size={11} className="text-default-400" />}
              />
            </div>
            <div role="listbox" aria-label={ariaLabel ?? label ?? "People"} aria-multiselectable={!single} className="max-h-72 overflow-y-auto py-1">
              {sections.map((s) => (
                <div key={s.key} role="group" aria-label={s.label}>
                  <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-default-500">{s.label}</div>
                  {s.people.map((p) => {
                    const on = selected.has(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="option"
                        aria-selected={on}
                        onClick={() => toggle(p.id)}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left hover:bg-default-100 focus-visible:bg-default-100 outline-none"
                      >
                        <span
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
                            on ? "bg-primary border-primary text-primary-foreground" : "border-default-400"
                          }`}
                        >
                          {on && <FaCheck size={8} />}
                        </span>
                        <PersonAvatar person={p} size={22} />
                        <span className="truncate">{p.name}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {sections.length === 0 && (
                <p className="px-3 py-4 text-sm text-default-400">{query.trim() ? `No one matches “${query.trim()}”.` : "No one to pick."}</p>
              )}
            </div>
            {!single && (
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-default-200">
                <span className="text-xs text-default-500">{selected.size ? `${selected.size} selected` : "Nobody selected"}</span>
                <div className="flex gap-1">
                  {selected.size > 0 && (
                    <Button size="sm" variant="light" onPress={() => onChange([])}>
                      Clear
                    </Button>
                  )}
                  <Button size="sm" color="primary" variant="flat" onPress={() => openChange(false)}>
                    Done
                  </Button>
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {description && <p className="text-tiny text-default-400 px-1 mt-1">{description}</p>}
    </div>
  );
}
