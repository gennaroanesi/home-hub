"use client";

import React, { useState, useEffect, useRef } from "react";
import { Input } from "@heroui/input";

export interface CityResult {
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  // OSM doesn't return timezone — caller can resolve via tz lookup if needed
}

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  type: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    state?: string;
    country?: string;
  };
}

interface CityAutocompleteProps {
  label?: string;
  placeholder?: string;
  value: string;
  onValueChange: (value: string) => void;
  onSelect?: (result: CityResult) => void;
}

export function CityAutocomplete({
  label = "Location",
  placeholder = "Start typing a city…",
  value,
  onValueChange,
  onSelect,
}: CityAutocompleteProps) {
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Only run the autocomplete search when the user actively types — not
  // when the parent pre-fills the value (e.g. opening an existing trip
  // for editing). Without this flag the dropdown pops open on mount.
  const userTypingRef = useRef(false);

  function handleInputChange(v: string) {
    userTypingRef.current = true;
    onValueChange(v);
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!userTypingRef.current) return;
    if (!value || value.length < 3) {
      setResults([]);
      setShowResults(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("q", value);
        url.searchParams.set("format", "json");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("limit", "5");
        url.searchParams.set("featuretype", "city");
        const res = await fetch(url.toString(), {
          headers: { "Accept-Language": navigator.language || "en" },
        });
        const data: NominatimResult[] = await res.json();
        setResults(data);
        setShowResults(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleSelect(r: NominatimResult) {
    const city =
      r.address?.city ||
      r.address?.town ||
      r.address?.village ||
      r.address?.municipality ||
      r.display_name.split(",")[0];
    const country = r.address?.country ?? "";
    const display = country ? `${city}, ${country}` : city;
    // Selecting a result is also "user-driven" but we want to immediately
    // collapse the dropdown — clear the typing flag so the value-changed
    // effect doesn't reopen it.
    userTypingRef.current = false;
    onValueChange(display);
    setShowResults(false);
    onSelect?.({
      city,
      country,
      latitude: parseFloat(r.lat),
      longitude: parseFloat(r.lon),
    });
  }

  return (
    <div className="relative" ref={containerRef}>
      <Input
        label={label}
        placeholder={placeholder}
        value={value}
        onValueChange={handleInputChange}
        onFocus={() => results.length > 0 && setShowResults(true)}
        endContent={loading ? <span className="text-xs text-default-400">…</span> : null}
      />
      {showResults && results.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-default-100 border border-default-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              className="w-full text-left px-3 py-2 hover:bg-default-100 dark:hover:bg-default-200 text-sm border-b border-default-100 last:border-b-0"
              onClick={() => handleSelect(r)}
            >
              {r.display_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
