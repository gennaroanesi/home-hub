"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
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
}

interface PhotoCardProps {
  index: number;
  data: Photo & { onClick: (p: Photo) => void };
  width: number;
}

function PhotoCard({ data, width }: PhotoCardProps) {
  const imgWidth = data.width || 800;
  const imgHeight = data.height || 600;
  const scaledHeight = Math.round((width / imgWidth) * imgHeight);

  return (
    <div
      className="cursor-pointer overflow-hidden bg-default-100 rounded-sm"
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
    </div>
  );
}

export function PhotoGrid({ photos, onDelete, pageSize = 24 }: PhotoGridProps) {
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

  const items = visiblePhotos.map((p) => ({
    ...p,
    onClick: (photo: Photo) => setSelected(photo),
  }));

  const hasMore = visibleCount < photos.length;

  return (
    <>
      <Masonry
        key={`${photos.length}-${visibleCount}` /* re-init when window changes */}
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
