// One outfit card: palette dots, optional try-on image, the pieces (wishlist
// ones flagged "Not owned"), the note and caller-supplied actions. Used by
// saved looks, the outfit suggester and trip looks on /wardrobe.

import React, { useState } from "react";
import { FaChevronDown } from "react-icons/fa";

import { photoUrl } from "@/lib/image-loader";
import { mainImage } from "@/lib/wardrobe";
import type { WardrobeItem } from "./shared";

export function LookCard({
  previewImageKey,
  previewCollapsible,
  preview,
  title,
  occasion,
  palette,
  note,
  itemIds,
  wishlistItemIds,
  byId,
  onOpenItem,
  actions,
}: {
  previewImageKey?: string | null;
  /** Hide the try-on behind a chevron toggle (saved looks list). */
  previewCollapsible?: boolean;
  preview?: React.ReactNode;
  title: string;
  occasion?: string | null;
  palette?: string | null;
  note?: string | null;
  itemIds?: (string | null)[] | null;
  wishlistItemIds?: (string | null)[] | null;
  byId: Map<string, WardrobeItem>;
  onOpenItem: (it: WardrobeItem) => void;
  actions?: React.ReactNode;
}) {
  const pieces = (itemIds ?? []).map((id) => (id ? byId.get(id) : undefined)).filter((x): x is WardrobeItem => !!x);
  // Older suggestions listed wishlist extras separately; skip ones already shown as pieces.
  const wish = (wishlistItemIds ?? [])
    .filter((id) => id && !(itemIds ?? []).includes(id))
    .map((id) => (id ? byId.get(id) : undefined))
    .filter((x): x is WardrobeItem => !!x);
  const future = pieces.some((p) => p.status === "WISHLIST");
  const [showPreview, setShowPreview] = useState(!previewCollapsible);
  return (
    <article className="rounded-xl border border-default-200 bg-content1 p-3 sm:p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-lg font-semibold">{title}</h3>
        <span
          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
            future ? "bg-warning-100 text-warning-700 border border-warning-300" : "bg-primary-100 text-primary-700"
          }`}
        >
          {future ? "⚠ Includes pieces you don't own" : occasion || "Any time"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-default-400">
        <span className="flex">
          {pieces
            .map((p) => p.colorHex)
            .filter(Boolean)
            .slice(0, 4)
            .map((h, n) => (
              <span key={n} className="w-4 h-4 rounded-full border-2 border-content1 -ml-1 first:ml-0" style={{ background: h! }} />
            ))}
        </span>
        {palette}
      </div>
      {previewImageKey && previewCollapsible && (
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          aria-expanded={showPreview}
          className="flex items-center justify-between gap-2 rounded-lg bg-default-100 px-3 py-2 text-sm text-default-600 hover:bg-default-200"
        >
          <span>{showPreview ? "Hide try-on" : "Show try-on"}</span>
          <FaChevronDown size={12} className={`transition-transform ${showPreview ? "rotate-180" : ""}`} />
        </button>
      )}
      {previewImageKey && showPreview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl(previewImageKey, 800)} alt={`AI-generated preview of ${title}`} loading="lazy" className="w-full max-h-[70vh] sm:max-h-[600px] object-contain rounded-lg bg-default-50" />
      )}
      {preview}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {pieces.map((p) => {
          const k = mainImage(p);
          return (
            <button key={p.id} type="button" onClick={() => onOpenItem(p)} className="text-left min-w-0">
              <div
                className={`relative aspect-[3/4] rounded-md overflow-hidden bg-white ${
                  p.status === "WISHLIST" ? "border-2 border-dashed border-warning-400" : "border border-default-200"
                }`}
              >
                {k ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoUrl(k, 240)} alt={p.name} loading="lazy" className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full" style={{ background: p.colorHex ?? undefined }} />
                )}
                {p.status === "WISHLIST" && (
                  <span className="absolute left-1 top-1 text-[9px] font-semibold bg-warning-100 text-warning-700 border border-warning-300 rounded-full px-1.5">
                    Not owned
                  </span>
                )}
              </div>
              <p className="text-[10px] uppercase tracking-wider text-default-400 mt-1">{p.category}</p>
              <p className="text-xs leading-tight line-clamp-2">{p.name}</p>
            </button>
          );
        })}
      </div>
      {note && <p className="text-sm text-default-600">{note}</p>}
      {wish.length > 0 && (
        <p className="text-xs text-primary-600">Would be even better with: {wish.map((w) => w.name).join(", ")}</p>
      )}
      {actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
    </article>
  );
}
