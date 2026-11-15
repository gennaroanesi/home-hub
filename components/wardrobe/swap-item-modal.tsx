// Trip looks: replace one packed piece with a specific closet item, in the
// packing list and every look that wore it, without going through the model
// (swapTripPlanItem in lib/wardrobe-trip.ts). Starts on the piece's own
// category; a search looks across the whole closet.

import React, { useEffect, useMemo, useState } from "react";
import { Input } from "@heroui/input";
import { Modal, ModalBody, ModalContent, ModalHeader } from "@heroui/modal";

import { photoUrl } from "@/lib/image-loader";
import { mainImage } from "@/lib/wardrobe";
import { SHEET_MODAL_CLASSES, Swatch, type WardrobeItem } from "./shared";

export function SwapItemModal({
  isOpen,
  onClose,
  item,
  items,
  packIds,
  onPick,
  busy,
}: {
  isOpen: boolean;
  onClose: () => void;
  item: WardrobeItem | null; // the piece being replaced
  items: WardrobeItem[]; // the person's wearable closet
  packIds: string[]; // already on the packing list (shown, flagged)
  onPick: (to: WardrobeItem) => void;
  busy: boolean;
}) {
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setCat(item?.category ?? "");
    setQ("");
  }, [isOpen, item]);

  const categories = useMemo(() => Array.from(new Set(items.map((i) => i.category))).sort(), [items]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const choices = items.filter((i) => {
    if (i.id === item?.id) return false;
    if (words.length) {
      const hay = [i.brand, i.name, i.color, i.category].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    }
    return !cat || i.category === cat;
  });

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside" placement="bottom-center" classNames={SHEET_MODAL_CLASSES}>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span>Replace {item ? [item.brand, item.name].filter(Boolean).join(" ") : "piece"}</span>
          <span className="text-xs font-normal text-default-500">Swapped in the packing list and in every look that wears it. Saved looks keep it; open them to change.</span>
        </ModalHeader>
        <ModalBody className="pb-5 gap-3">
          <Input size="sm" aria-label="Search the closet" placeholder="Search the whole closet…" value={q} onValueChange={setQ} isClearable onClear={() => setQ("")} />
          {!words.length && (
            <div className="flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCat(c)}
                  className={`px-2.5 py-0.5 rounded-full text-xs ${cat === c ? "bg-primary text-primary-foreground" : "bg-default-100 text-default-600"}`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          {choices.length === 0 && <p className="text-sm text-default-500">Nothing else here.</p>}
          <div className={`grid grid-cols-3 sm:grid-cols-5 gap-2 ${busy ? "opacity-50 pointer-events-none" : ""}`}>
            {choices.map((it) => {
              const k = mainImage(it);
              const packed = packIds.includes(it.id);
              return (
                <button key={it.id} type="button" onClick={() => onPick(it)} className="text-left rounded-md border-2 border-transparent hover:border-primary p-1">
                  <div className="relative aspect-[3/4] rounded overflow-hidden bg-white border border-default-200">
                    {k ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photoUrl(k, 200)} alt="" loading="lazy" className="w-full h-full object-contain" />
                    ) : (
                      <div className="w-full h-full" style={{ background: it.colorHex ?? undefined }} />
                    )}
                    {packed && (
                      <span className="absolute left-1 top-1 text-[9px] font-semibold bg-success-100 text-success-700 border border-success-300 rounded-full px-1.5">Packed</span>
                    )}
                  </div>
                  <p className="text-[11px] leading-tight mt-1 line-clamp-2 flex items-start gap-1">
                    <Swatch hex={it.colorHex} size={9} />
                    <span>
                      {it.brand ? <span className="text-default-500">{it.brand} </span> : null}
                      {it.name}
                    </span>
                  </p>
                </button>
              );
            })}
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
