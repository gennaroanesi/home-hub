"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { FaCheck } from "react-icons/fa";
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
}

interface PhotoCardData extends Photo {
  onClick: (p: Photo) => void;
  isSelected: boolean;
  selectionEnabled: boolean;
}

interface PhotoCardProps {
  index: number;
  data: PhotoCardData;
  width: number;
}

function PhotoCard({ data, width }: PhotoCardProps) {
  const imgWidth = data.width || 800;
  const imgHeight = data.height || 600;
  const scaledHeight = Math.round((width / imgWidth) * imgHeight);

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
        src={photoUrl(data.s3key, Math.max(width * 2, 400), 70)}
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
    </div>
  );
}

export function PhotoGrid({
  photos,
  onDelete,
  pageSize = 24,
  selectionEnabled = false,
  selectedIds,
  onSelectionChange,
}: PhotoGridProps) {
  const [selected, setSelected] = useState<Photo | null>(null);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reset the visible window whenever the underlying photo list changes
  // (e.g. after applying a filter or after a fresh upload reload).
  useEffect(() => {
    setVisibleCount(pageSize);
  }, [photos, pageSize]);

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

  if (photos.length === 0) {
    return <p className="text-center text-default-300 py-8 text-sm">No photos yet</p>;
  }

  function togglePhoto(photo: Photo) {
    if (selectionEnabled) {
      const next = new Set(selectedIds ?? []);
      if (next.has(photo.id)) next.delete(photo.id);
      else next.add(photo.id);
      onSelectionChange?.(next);
    } else {
      setSelected(photo);
    }
  }

  const items: PhotoCardData[] = visiblePhotos.map((p) => ({
    ...p,
    onClick: togglePhoto,
    isSelected: selectedIds?.has(p.id) ?? false,
    selectionEnabled,
  }));

  const hasMore = visibleCount < photos.length;

  return (
    <>
      <Masonry
        key={`${photos.length}-${visibleCount}-${selectionEnabled}` /* re-init when window changes */}
        items={items}
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
      />
    </>
  );
}
