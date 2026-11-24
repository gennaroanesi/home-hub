"use client";

import React, { useState, useEffect, useRef } from "react";
import { Input } from "@heroui/input";

interface FreeComboboxProps {
  label?: string;
  placeholder?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: string[];
  maxResults?: number;
  /** Offer what was typed as a new entry ("Create “…”") when it matches no option. */
  createLabel?: (typed: string) => string;
  description?: React.ReactNode;
  /** Does an option match what's typed? Default: contains it. */
  matches?: (option: string, typed: string) => boolean;
  /** How an option shows in the list. Default: the option. */
  renderOption?: (option: string, typed: string) => React.ReactNode;
}

/**
 * A text input with autocomplete suggestions from a static list, but that
 * also accepts any custom value the user types.
 */
export function FreeCombobox({
  label,
  placeholder,
  value,
  onValueChange,
  options,
  maxResults = 8,
  createLabel,
  description,
  matches = (o, t) => o.toLowerCase().includes(t.toLowerCase()),
  renderOption = (o) => o,
}: FreeComboboxProps) {
  const [showResults, setShowResults] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filtered = value
    ? options
        .filter((o) => matches(o, value))
        .slice(0, maxResults)
    : options.slice(0, maxResults);
  const typed = value.trim();
  const offerCreate = !!createLabel && !!typed && !options.some((o) => o.toLowerCase() === typed.toLowerCase());

  return (
    <div className="relative" ref={containerRef}>
      <Input
        label={label}
        placeholder={placeholder}
        value={value}
        onValueChange={(v) => {
          onValueChange(v);
          setShowResults(true);
        }}
        onFocus={() => setShowResults(true)}
        description={description}
      />
      {showResults && (filtered.length > 0 || offerCreate) && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-default-100 border border-default-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
          {filtered.map((opt) => (
            <button
              key={opt}
              type="button"
              className="w-full text-left px-3 py-2 hover:bg-default-100 dark:hover:bg-default-200 text-sm border-b border-default-100 last:border-b-0"
              onClick={() => {
                onValueChange(opt);
                setShowResults(false);
              }}
            >
              {renderOption(opt, value)}
            </button>
          ))}
          {offerCreate && (
            <button
              type="button"
              className="w-full text-left px-3 py-2 hover:bg-default-100 dark:hover:bg-default-200 text-sm text-primary"
              onClick={() => {
                onValueChange(typed);
                setShowResults(false);
              }}
            >
              {createLabel!(typed)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
