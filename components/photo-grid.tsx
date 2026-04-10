"use client";

import React, { useState } from "react";
import dynamic from "next/dynamic";
import { photoUrl, originalPhotoUrl } from "@/lib/image-loader";
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

export function PhotoGrid({ photos, onDelete }: PhotoGridProps) {
  const [selected, setSelected] = useState<Photo | null>(null);

  if (photos.length === 0) {
    return <p className="text-center text-default-300 py-8 text-sm">No photos yet</p>;
  }

  const items = photos.map((p) => ({ ...p, onClick: (photo: Photo) => setSelected(photo) }));

  return (
    <>
      <Masonry
        key={photos.length /* force re-init when list changes */}
        items={items}
        render={PhotoCard as any}
        columnWidth={200}
        rowGutter={6}
        columnGutter={6}
      />
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
