// Add / edit one wardrobe item, including its photo gallery (first photo
// is the main one shown on cards and in looks).

import React, { useEffect, useRef, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { FaCamera, FaStar, FaTrash } from "react-icons/fa";

import { photoUrl } from "@/lib/image-loader";
import {
  FORMALITIES,
  FORMALITY_LABELS,
  SEASONS,
  SEASON_LABELS,
  WARDROBE_STATUSES,
  WARDROBE_STATUS_LABELS,
  imagesOf,
  makeMain,
} from "@/lib/wardrobe";
import type { Schema } from "@/amplify/data/resource";
import { uploadWardrobePhotos, type WardrobeItem } from "./shared";

const client = generateClient<Schema>({ authMode: "userPool" });

const TEXT_FIELDS = ["name", "brand", "color", "size", "fabric", "fit", "styleCode", "url", "notes"] as const;

export function ItemModal({
  isOpen,
  onClose,
  editing,
  ownerPersonId,
  categories,
  defaultCategory,
  defaultStatus,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  editing: WardrobeItem | null;
  ownerPersonId: string;
  categories: string[];
  defaultCategory?: string;
  defaultStatus?: string;
  onSaved: () => void;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const e = editing;
    const next: Record<string, string> = {
      category: e?.category ?? defaultCategory ?? categories[0] ?? "Tops",
      status: e?.status ?? defaultStatus ?? "KEEP",
      season: e?.season ?? "ALL",
      formality: e?.formality ?? "",
      colorHex: e?.colorHex ?? "",
      price: e?.price != null ? String(e.price) : "",
    };
    for (const k of TEXT_FIELDS) next[k] = (e?.[k] as string | null | undefined) ?? "";
    setF(next);
    setPhotos(e ? imagesOf(e) : []);
    setSel(0);
  }, [isOpen, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    const keys = await uploadWardrobePhotos(Array.from(files));
    if (keys.length) {
      setSel(photos.length);
      setPhotos((p) => [...p, ...keys]);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function save() {
    if (!f.name?.trim()) {
      addToast({ title: "Give it a name", color: "warning" });
      return;
    }
    setSaving(true);
    try {
      const str = (k: string) => (f[k]?.trim() ? f[k].trim() : null);
      const price = f.price?.trim() ? Number(f.price) : null;
      const body = {
        ownerPersonId,
        category: f.category || categories[0] || "Tops",
        name: f.name.trim(),
        brand: str("brand"),
        color: str("color"),
        colorHex: str("colorHex"),
        size: str("size"),
        fabric: str("fabric"),
        fit: str("fit"),
        styleCode: str("styleCode"),
        url: str("url"),
        notes: str("notes"),
        price: price != null && !Number.isNaN(price) ? price : null,
        status: (f.status || "KEEP") as WardrobeItem["status"],
        season: (f.season || "ALL") as WardrobeItem["season"],
        formality: (f.formality || null) as WardrobeItem["formality"],
        imageKeys: photos,
      };
      const r = editing
        ? await client.models.homeWardrobeItem.update({ id: editing.id, ...body })
        : await client.models.homeWardrobeItem.create(body);
      if (r.errors?.length) throw new Error(r.errors[0].message);
      addToast({ title: editing ? "Saved" : "Added", color: "success" });
      onSaved();
      onClose();
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editing || !confirm(`Delete "${editing.name}"? Looks that use it keep the others.`)) return;
    setSaving(true);
    try {
      const { errors } = await client.models.homeWardrobeItem.delete({ id: editing.id });
      if (errors?.length) throw new Error(errors[0].message);
      onSaved();
      onClose();
    } catch (err: any) {
      addToast({ title: "Delete failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  const current = photos[Math.min(sel, photos.length - 1)];
  const cats = categories.includes(f.category) || !f.category ? categories : [...categories, f.category];

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside" classNames={{ base: "max-sm:m-0 max-sm:rounded-b-none max-sm:max-h-[92dvh]" }}>
      <ModalContent>
        <ModalHeader>{editing ? "Edit item" : "Add item"}</ModalHeader>
        <ModalBody className="gap-3">
          {/* Gallery */}
          <div className="flex flex-col gap-2">
            <div className="aspect-[4/3] rounded-lg overflow-hidden bg-white border border-default-200 flex items-center justify-center">
              {current ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoUrl(current, 900)} alt="" className="w-full h-full object-contain" />
              ) : (
                <span className="text-xs uppercase tracking-wider text-default-400">No photo yet</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {photos.map((k, n) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSel(n)}
                  className={`relative w-14 h-14 rounded-md overflow-hidden border-2 ${n === sel ? "border-primary" : "border-transparent"}`}
                  aria-label={`Photo ${n + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoUrl(k, 120)} alt="" className="w-full h-full object-cover" />
                  {n === 0 && (
                    <span className="absolute left-0.5 top-0.5 text-[9px] font-semibold bg-primary text-primary-foreground rounded px-1">
                      Main
                    </span>
                  )}
                </button>
              ))}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => addPhotos(e.target.files)}
              />
              <Button size="sm" variant="flat" startContent={<FaCamera size={11} />} isLoading={uploading} onPress={() => fileRef.current?.click()}>
                Add photos
              </Button>
              {current && sel > 0 && (
                <Button size="sm" variant="light" startContent={<FaStar size={11} />} onPress={() => { setPhotos((p) => makeMain(p, sel)); setSel(0); }}>
                  Make main
                </Button>
              )}
              {current && (
                <Button
                  size="sm"
                  variant="light"
                  color="danger"
                  startContent={<FaTrash size={10} />}
                  onPress={() => { setPhotos((p) => p.filter((_, n) => n !== sel)); setSel((s) => Math.max(0, s - 1)); }}
                >
                  Remove photo
                </Button>
              )}
            </div>
          </div>

          <Input label="Name" value={f.name ?? ""} onValueChange={set("name")} isRequired autoFocus={!editing} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Select label="Category" selectedKeys={f.category ? [f.category] : []} onChange={(e) => e.target.value && set("category")(e.target.value)}>
              {cats.map((c) => (
                <SelectItem key={c}>{c}</SelectItem>
              ))}
            </Select>
            <Select label="Status" selectedKeys={f.status ? [f.status] : []} onChange={(e) => e.target.value && set("status")(e.target.value)}>
              {WARDROBE_STATUSES.map((s) => (
                <SelectItem key={s}>{WARDROBE_STATUS_LABELS[s]}</SelectItem>
              ))}
            </Select>
            <Input label="Brand" value={f.brand ?? ""} onValueChange={set("brand")} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
            <Input label="Color" value={f.color ?? ""} onValueChange={set("color")} placeholder="Navy, sage suede…" />
            <label className="flex items-center gap-2 text-sm text-default-600 h-14 px-3 rounded-medium bg-default-100">
              <input
                type="color"
                value={f.colorHex || "#888888"}
                onChange={(e) => set("colorHex")(e.target.value)}
                className="w-8 h-8 rounded border-0 bg-transparent p-0 cursor-pointer"
                aria-label="Swatch"
              />
              <span>{f.colorHex || "Swatch"}</span>
              {f.colorHex && (
                <button type="button" className="ml-auto text-xs text-default-400" onClick={() => set("colorHex")("")}>
                  Clear
                </button>
              )}
            </label>
            <Input label="Size" value={f.size ?? ""} onValueChange={set("size")} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Input label="Fabric" value={f.fabric ?? ""} onValueChange={set("fabric")} />
            <Input label="Fit" value={f.fit ?? ""} onValueChange={set("fit")} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Select label="Season" selectedKeys={f.season ? [f.season] : []} onChange={(e) => e.target.value && set("season")(e.target.value)}>
              {SEASONS.map((s) => (
                <SelectItem key={s}>{SEASON_LABELS[s]}</SelectItem>
              ))}
            </Select>
            <Select label="Formality" selectedKeys={f.formality ? [f.formality] : []} onChange={(e) => set("formality")(e.target.value)}>
              {FORMALITIES.map((s) => (
                <SelectItem key={s}>{FORMALITY_LABELS[s]}</SelectItem>
              ))}
            </Select>
            <Input label={f.status === "WISHLIST" ? "Price (expected)" : "Price paid"} type="number" value={f.price ?? ""} onValueChange={set("price")} startContent={<span className="text-default-400 text-sm">$</span>} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Input label="Style code" value={f.styleCode ?? ""} onValueChange={set("styleCode")} />
            <Input label="Link" value={f.url ?? ""} onValueChange={set("url")} placeholder="https://…" />
          </div>
          <Textarea label="Notes" value={f.notes ?? ""} onValueChange={set("notes")} minRows={2} />
        </ModalBody>
        <ModalFooter className="justify-between">
          {editing ? (
            <Button color="danger" variant="light" onPress={remove} isDisabled={saving}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="light" onPress={onClose}>
              Cancel
            </Button>
            <Button color="primary" onPress={save} isLoading={saving} isDisabled={uploading}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
