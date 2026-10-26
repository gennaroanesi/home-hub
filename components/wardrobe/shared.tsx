// Small pieces shared by the /wardrobe page and its modals.

import React, { useState } from "react";
import { addToast } from "@heroui/react";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa";

import { photoUrl } from "@/lib/image-loader";
import { imagesOf, WARDROBE_STATUS_LABELS, type WardrobeStatus } from "@/lib/wardrobe";
import type { Schema } from "@/amplify/data/resource";

export type WardrobeItem = Schema["homeWardrobeItem"]["type"];
export type WardrobeLook = Schema["homeWardrobeLook"]["type"];
export type WardrobeProfile = Schema["homeWardrobeProfile"]["type"];

export const STATUS_CHIP: Record<WardrobeStatus, string> = {
  KEEP: "bg-primary-100 text-primary-700",
  NEW: "bg-success-100 text-success-700",
  TAILOR: "bg-warning-100 text-warning-700",
  RETIRE: "bg-danger-100 text-danger-700",
  WISHLIST: "border border-dashed border-primary-400 text-primary-600",
};

export function StatusChip({ status }: { status?: string | null }) {
  const s = (status ?? "KEEP") as WardrobeStatus;
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${STATUS_CHIP[s] ?? STATUS_CHIP.KEEP}`}>
      {WARDROBE_STATUS_LABELS[s] ?? s}
    </span>
  );
}

export function Swatch({ hex, size = 12 }: { hex?: string | null; size?: number }) {
  return (
    <span
      className="inline-block rounded-sm border border-default-300 shrink-0"
      style={{
        width: size,
        height: size,
        background: hex || "repeating-linear-gradient(135deg,#ddd 0 3px,#f5f5f5 3px 6px)",
      }}
    />
  );
}

/** Product photo with prev/next arrows when an item has several. */
export function PhotoCarousel({
  item,
  width = 480,
  className = "",
  fit = "cover",
}: {
  item: Pick<WardrobeItem, "imageKeys" | "name" | "colorHex">;
  width?: number;
  className?: string;
  fit?: "cover" | "contain";
}) {
  const keys = imagesOf(item);
  const [idx, setIdx] = useState(0);
  const k = keys[Math.min(idx, keys.length - 1)];
  if (!k) {
    return (
      <div
        className={`flex items-center justify-center text-[10px] uppercase tracking-wider text-default-400 ${className}`}
        style={{ background: item.colorHex ? `${item.colorHex}33` : undefined }}
      >
        No photo
      </div>
    );
  }
  const step = (d: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setIdx((i) => (i + d + keys.length) % keys.length);
  };
  return (
    <div className={`relative group bg-white ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl(k, width)}
        alt={item.name ?? ""}
        loading="lazy"
        className={`w-full h-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
      />
      {keys.length > 1 && (
        <>
          <span
            role="button"
            aria-label="Previous photo"
            onClick={step(-1)}
            className="absolute left-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/85 text-default-700 flex items-center justify-center opacity-100 md:opacity-0 group-hover:opacity-100"
          >
            <FaChevronLeft size={10} />
          </span>
          <span
            role="button"
            aria-label="Next photo"
            onClick={step(1)}
            className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/85 text-default-700 flex items-center justify-center opacity-100 md:opacity-0 group-hover:opacity-100"
          >
            <FaChevronRight size={10} />
          </span>
          <span className="absolute right-2 bottom-2 text-[10px] font-mono bg-black/70 text-white rounded-full px-2">
            {Math.min(idx, keys.length - 1) + 1}/{keys.length}
          </span>
        </>
      )}
    </div>
  );
}

/** Presign → PUT straight to S3 under home/wardrobe/ → return the keys. */
export async function uploadWardrobePhotos(files: File[]): Promise<string[]> {
  const keys: string[] = [];
  for (const file of files) {
    const contentType = file.type || "image/jpeg";
    try {
      const urlRes = await fetch("/api/documents/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType, prefix: "wardrobe" }),
      });
      if (!urlRes.ok) {
        const err = await urlRes.json().catch(() => ({}));
        throw new Error(err.error ?? `Upload URL failed: ${urlRes.status}`);
      }
      const { uploadUrl, s3key } = await urlRes.json();
      const putRes = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
      keys.push(s3key);
    } catch (err: any) {
      addToast({ title: `Couldn't upload ${file.name}`, description: err?.message ?? String(err), color: "danger" });
    }
  }
  return keys;
}
