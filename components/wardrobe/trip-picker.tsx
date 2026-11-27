// "My picks" for Trip looks: tick the pieces to pack from the closet,
// grouped by category, with copies for items owned more than once, and a
// running count by type ("4 T-Shirts · 3 Jeans"). The planner then builds
// looks only from these and reviews them (lib/wardrobe-trip.ts, PICKED mode).

import React, { useMemo, useState } from "react";
import { Input } from "@heroui/input";
import { FaMinus, FaPlus, FaSearch } from "react-icons/fa";

import { photoUrl } from "@/lib/image-loader";
import { mainImage, quantityOf } from "@/lib/wardrobe";
import { categoryCounts, categoryCountsLabel, pickedCopies, type TripPicks } from "@/lib/wardrobe-trip";
import { groupByCategory } from "@/lib/wardrobe-trip-edits";
import type { WardrobeItem } from "./shared";

export function TripPicker({
  closet,
  picks,
  onChange,
  disabled,
}: {
  closet: WardrobeItem[];
  picks: TripPicks;
  onChange: (next: TripPicks) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const picked = useMemo(() => new Set(picks.itemIds), [picks.itemIds]);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return closet.filter((i) => {
      const hay = [i.name, i.brand, i.color, i.category].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [closet, query]);
  const groups = useMemo(() => groupByCategory(shown), [shown]);
  const chosen = closet.filter((i) => picked.has(i.id));
  const copies = (i: WardrobeItem) => pickedCopies(i, picks);
  const total = chosen.reduce((n, i) => n + copies(i), 0);

  function toggle(it: WardrobeItem) {
    const itemIds = picked.has(it.id) ? picks.itemIds.filter((x) => x !== it.id) : [...picks.itemIds, it.id];
    const { [it.id]: _gone, ...rest } = picks.copies ?? {}; // eslint-disable-line @typescript-eslint/no-unused-vars
    onChange({ itemIds, copies: rest });
  }

  function setCopies(it: WardrobeItem, n: number) {
    const max = quantityOf(it);
    const v = Math.max(1, Math.min(max, n));
    const { [it.id]: _gone, ...rest } = picks.copies ?? {}; // eslint-disable-line @typescript-eslint/no-unused-vars
    onChange({ itemIds: picks.itemIds, copies: v > 1 ? { ...rest, [it.id]: v } : rest });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          className="w-60"
          aria-label="Search the closet"
          placeholder="Search the closet"
          startContent={<FaSearch size={11} className="text-default-400" />}
          value={query}
          onValueChange={setQuery}
          isClearable
          onClear={() => setQuery("")}
        />
        <span className="text-sm text-default-600">
          <b>{total}</b> piece{total === 1 ? "" : "s"}
          {chosen.length > 0 && <span className="text-default-500"> · {categoryCountsLabel(categoryCounts(chosen, copies))}</span>}
        </span>
        {chosen.length > 0 && (
          <button type="button" className="text-xs text-default-500 hover:text-danger" onClick={() => onChange({ itemIds: [], copies: {} })} disabled={disabled}>
            Clear
          </button>
        )}
      </div>
      <div className="max-h-[28rem] overflow-y-auto pr-1 flex flex-col gap-3">
        {groups.map(([cat, list]) => {
          const n = list.filter((i) => picked.has(i.id)).reduce((s, i) => s + copies(i), 0);
          return (
            <div key={cat}>
              <p className="text-[11px] uppercase tracking-wider text-default-400 mb-1.5">
                {cat}
                {n > 0 && <span className="text-primary normal-case tracking-normal"> · {n} picked</span>}
              </p>
              <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
                {list.map((it) => {
                  const on = picked.has(it.id);
                  const k = mainImage(it);
                  const max = quantityOf(it);
                  return (
                    <div key={it.id} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => toggle(it)}
                        disabled={disabled}
                        aria-pressed={on}
                        title={on ? "Unpick" : "Pick to pack"}
                        className={`relative block w-full aspect-[3/4] rounded-md overflow-hidden bg-white border-2 ${on ? "border-primary" : "border-default-200 opacity-80 hover:opacity-100"}`}
                      >
                        {k ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={photoUrl(k, 200)} alt={it.name} loading="lazy" className="w-full h-full object-contain" />
                        ) : (
                          <div className="w-full h-full" style={{ background: it.colorHex ?? undefined }} />
                        )}
                        {on && <span className="absolute top-1 right-1 rounded-full bg-primary text-primary-foreground text-[10px] px-1.5">✓</span>}
                      </button>
                      <p className="mt-1 text-[11px] leading-tight line-clamp-2">{it.name}</p>
                      {on && max > 1 && (
                        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-default-600">
                          <button type="button" aria-label="One fewer" onClick={() => setCopies(it, copies(it) - 1)} disabled={disabled || copies(it) <= 1} className="p-0.5 disabled:opacity-30">
                            <FaMinus size={8} />
                          </button>
                          <span>
                            {copies(it)} of {max}
                          </span>
                          <button type="button" aria-label="One more" onClick={() => setCopies(it, copies(it) + 1)} disabled={disabled || copies(it) >= max} className="p-0.5 disabled:opacity-30">
                            <FaPlus size={8} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {!groups.length && <p className="text-sm text-default-500">Nothing in the closet matches.</p>}
      </div>
    </div>
  );
}
