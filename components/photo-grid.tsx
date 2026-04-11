"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import dynamic from "next/dynamic";
import { FaCheck, FaHeart, FaRegHeart } from "react-icons/fa";
import { photoUrl } from "@/lib/image-loader";
import { PhotoModal } from "./photo-modal";
import type { Schema } from "@/amplify/data/resource";

type Photo = Schema["homePhoto"]["type"];

const Masonry = dynamic(() => import("masonic").then((m) => m.Masonry), {
  ssr: false,
  loading: () => <p className="text-sm text-default-400">Loading…</p>,
});

interface PhotoGridProps {
  photos: Photo[];
  onDelete?: (photo: Photo) => void;
  // How many photos to render initially and on each "load more" trigger.
  // Defaults to 24, which is enough for several screens of a 200-px column grid.
  pageSize?: number;
  // Multi-select mode. When selectionEnabled is true, clicking a photo
  // toggles its selection instead of opening the modal. Selection state is
  // owned by the parent so it can build the bulk-action toolbar.
  selectionEnabled?: boolean;
  selectedIds?: Set<string>;
  onSelectionChange?: (selected: Set<string>) => void;
  // When provided, each card shows a heart in the bottom-right corner.
  // Clicking it calls this callback with the new value (and stops propagation
  // so it doesn't also open the photo modal).
  onToggleFavorite?: (photo: Photo, next: boolean) => void;
}

interface PhotoCardData extends Photo {
  onClick: (p: Photo) => void;
  onFavoriteClick?: (p: Photo) => void;
  isSelected: boolean;
  selectionEnabled: boolean;
}

interface PhotoCardProps {
  index: number;
  data: PhotoCardData;
  width: number;
}

const PhotoCard = React.memo(function PhotoCard({ data, width }: PhotoCardProps) {
  const imgWidth = data.width || 800;
  const imgHeight = data.height || 600;
  const scaledHeight = Math.round((width / imgWidth) * imgHeight);

  // Bucket the requested image width to the nearest 200 px. Masonic can
  // pass slightly different widths across renders (e.g. after a layout
  // recalc), and even a 1-px change was producing a brand-new image URL,
  // a fresh network fetch, and a visible flicker as the old image got
  // dropped from the DOM while the new one loaded. Rounding to a stable
  // bucket means the same column width always maps to the same URL.
  const bucketedWidth = Math.max(400, Math.ceil((width * 2) / 200) * 200);

  return (
    <div
      className={`relative cursor-pointer overflow-hidden bg-default-100 rounded-sm ${
        data.isSelected ? "ring-4 ring-primary" : ""
      }`}
      style={{ height: scaledHeight }}
      onClick={() => data.onClick(data)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl(data.s3key, bucketedWidth, 70)}
        alt={data.originalFilename ?? data.id}
        loading="lazy"
        width={width}
        height={scaledHeight}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
      {data.selectionEnabled && (
        <div
          className={`absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center border-2 ${
            data.isSelected
              ? "bg-primary border-primary text-white"
              : "bg-white/80 border-white/80 text-transparent"
          }`}
        >
          <FaCheck size={10} />
        </div>
      )}
      {data.onFavoriteClick && (
        <button
          type="button"
          className="absolute bottom-2 right-2 w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center text-white hover:bg-black/60 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            data.onFavoriteClick?.(data);
          }}
          aria-label={data.isFavorite ? "Unfavorite" : "Favorite"}
        >
          {data.isFavorite ? (
            <FaHeart size={14} className="text-red-500" />
          ) : (
            <FaRegHeart size={14} />
          )}
        </button>
      )}
    </div>
  );
});

export function PhotoGrid({
  photos,
  onDelete,
  pageSize = 24,
  selectionEnabled = false,
  selectedIds,
  onSelectionChange,
  onToggleFavorite,
}: PhotoGridProps) {
  const [selected, setSelected] = useState<Photo | null>(null);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reset the visible window when the photo list grows or shrinks (filter
  // applied, fresh upload, refresh). Deliberately track `photos.length` and
  // not the `photos` reference itself — in-place edits like favorite toggles
  // reuse the same length but produce a new array reference, and resetting
  // on every such edit dumps the user back to the top of an infinite scroll.
  useEffect(() => {
    setVisibleCount(pageSize);
  }, [photos.length, pageSize]);

  // IntersectionObserver: load more when the sentinel comes into view
  useEffect(() => {
    if (!sentinelRef.current) return;
    if (visibleCount >= photos.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((c) => Math.min(c + pageSize, photos.length));
        }
      },
      { rootMargin: "400px" } // start loading before the sentinel is fully visible
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [visibleCount, photos.length, pageSize]);

  const visiblePhotos = useMemo(() => photos.slice(0, visibleCount), [photos, visibleCount]);

  // Stable click handlers so `items` entries can be memoized — otherwise
  // every render creates new closures, every card gets a new `data`
  // reference, and React.memo on PhotoCard never bails out. That was
  // contributing to the scroll flicker on top of the image-url churn.
  // IMPORTANT: these hooks must run unconditionally, so they live above
  // the empty-list early return.
  const togglePhoto = useCallback(
    (photo: Photo) => {
      if (selectionEnabled) {
        const next = new Set(selectedIds ?? []);
        if (next.has(photo.id)) next.delete(photo.id);
        else next.add(photo.id);
        onSelectionChange?.(next);
      } else {
        setSelected(photo);
      }
    },
    [selectionEnabled, selectedIds, onSelectionChange]
  );

  const handleFavoriteClick = useMemo(
    () =>
      onToggleFavorite
        ? (photo: Photo) => onToggleFavorite(photo, !photo.isFavorite)
        : undefined,
    [onToggleFavorite]
  );

  const items: PhotoCardData[] = useMemo(
    () =>
      visiblePhotos.map((p) => ({
        ...p,
        onClick: togglePhoto,
        onFavoriteClick: handleFavoriteClick,
        isSelected: selectedIds?.has(p.id) ?? false,
        selectionEnabled,
      })),
    [visiblePhotos, togglePhoto, handleFavoriteClick, selectedIds, selectionEnabled]
  );

  if (photos.length === 0) {
    return <p className="text-center text-default-300 py-8 text-sm">No photos yet</p>;
  }

  const hasMore = visibleCount < photos.length;

  return (
    <>
      <Masonry
        // Re-init when the photo *set* identity changes (filter swap, fresh
        // upload, etc.) — NOT when visibleCount grows from infinite scroll.
        // masonic maintains an internal `measuredCount` that indexes into
        // items[] by position; when the filter shrinks the list, masonic
        // can try to render past the end of the new array, reading
        // `items[oldIndex] === undefined` and passing it into an internal
        // WeakMap which then throws "WeakMap keys must be objects". Keying
        // on (first-id, length, selection) catches both length-changing
        // and same-length-different-content filter swaps. Using length
        // alone wasn't enough because two filters can produce the same
        // count with different photos.
        //
        // `itemKey` gives masonic a stable id per photo so its own internal
        // render/measurement caches survive in-place edits (favorite
        // toggles, selection changes) without re-laying out.
        key={`${items[0]?.id ?? "empty"}-${items.length}-${selectionEnabled}`}
        items={items}
        itemKey={(data) => (data as PhotoCardData).id}
        render={PhotoCard as any}
        columnWidth={200}
        rowGutter={6}
        columnGutter={6}
      />
      {hasMore && (
        <div ref={sentinelRef} className="py-6 text-center text-xs text-default-400">
          Loading more… ({visibleCount} of {photos.length})
        </div>
      )}
      <PhotoModal
        photo={selected}
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        onDelete={
          onDelete
            ? () => {
                if (selected) {
                  onDelete(selected);
                  setSelected(null);
                }
              }
            : undefined
        }
        onToggleFavorite={onToggleFavorite}
      />
    </>
  );
}
