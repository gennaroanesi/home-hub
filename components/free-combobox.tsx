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
        .filter((o) => o.toLowerCase().includes(value.toLowerCase()))
        .slice(0, maxResults)
    : options.slice(0, maxResults);

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
      />
      {showResults && filtered.length > 0 && (
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
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
