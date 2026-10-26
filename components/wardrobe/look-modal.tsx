// Build or edit a look: title, occasion, palette, note, and the pieces,
// picked from the person's wearable items (wishlist items allowed, so a
// look can show what it'll be once something's bought).

import React, { useEffect, useMemo, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";

import { photoUrl } from "@/lib/image-loader";
import { mainImage } from "@/lib/wardrobe";
import type { Schema } from "@/amplify/data/resource";
import { Swatch, type WardrobeItem, type WardrobeLook } from "./shared";

const client = generateClient<Schema>({ authMode: "userPool" });

export interface LookDraft {
  title: string;
  palette?: string | null;
  occasion?: string | null;
  note?: string | null;
  itemIds: string[];
  source?: "MANUAL" | "SUGGESTED" | "IMPORTED";
}

export function LookModal({
  isOpen,
  onClose,
  editing,
  draft,
  ownerPersonId,
  items,
  categories,
  nextSortOrder,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  editing: WardrobeLook | null;
  draft?: LookDraft | null;
  ownerPersonId: string;
  items: WardrobeItem[];
  categories: string[];
  nextSortOrder: number;
  onSaved: () => void;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [cat, setCat] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const src = editing ?? draft;
    setF({
      title: src?.title ?? "",
      palette: src?.palette ?? "",
      occasion: src?.occasion ?? "",
      note: src?.note ?? "",
    });
    setPicked(((src?.itemIds ?? []) as (string | null)[]).filter((x): x is string => !!x));
    setCat(categories[0] ?? "");
  }, [isOpen, editing, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const choices = items.filter((i) => i.status !== "RETIRE" && (!cat || i.category === cat));
  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function save() {
    if (!f.title.trim() || picked.length < 2) {
      addToast({ title: "Add a title and at least two pieces", color: "warning" });
      return;
    }
    setSaving(true);
    try {
      const body = {
        ownerPersonId,
        title: f.title.trim(),
        palette: f.palette.trim() || null,
        occasion: f.occasion.trim() || null,
        note: f.note.trim() || null,
        itemIds: picked,
      };
      const r = editing
        ? await client.models.homeWardrobeLook.update({ id: editing.id, ...body })
        : await client.models.homeWardrobeLook.create({ ...body, source: draft?.source ?? "MANUAL", sortOrder: nextSortOrder });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      addToast({ title: "Look saved", color: "success" });
      onSaved();
      onClose();
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editing || !confirm(`Delete the look "${editing.title}"?`)) return;
    const { errors } = await client.models.homeWardrobeLook.delete({ id: editing.id });
    if (errors?.length) {
      addToast({ title: "Delete failed", description: errors[0].message, color: "danger" });
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{editing ? "Edit look" : "New look"}</ModalHeader>
        <ModalBody className="gap-3">
          <Input label="Title" value={f.title ?? ""} onValueChange={set("title")} isRequired />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Input label="Occasion" value={f.occasion ?? ""} onValueChange={set("occasion")} placeholder="Office, weekend, golf…" />
            <Input label="Palette" value={f.palette ?? ""} onValueChange={set("palette")} placeholder="Navy + grey" />
          </div>
          <Textarea label="Why it works" value={f.note ?? ""} onValueChange={set("note")} minRows={2} />

          <div>
            <p className="text-xs uppercase tracking-wider text-default-400 mb-2">Pieces ({picked.length})</p>
            <div className="flex flex-wrap gap-2 min-h-[64px]">
              {picked.map((id) => {
                const it = byId.get(id);
                if (!it) return null;
                const k = mainImage(it);
                return (
                  <button key={id} type="button" onClick={() => toggle(id)} className="w-16 text-left" title="Remove from look">
                    <div className="w-16 h-20 rounded-md overflow-hidden border border-default-200 bg-white">
                      {k ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photoUrl(k, 160)} alt="" className="w-full h-full object-contain" />
                      ) : (
                        <div className="w-full h-full" style={{ background: it.colorHex ?? undefined }} />
                      )}
                    </div>
                    <p className="text-[10px] leading-tight mt-1 line-clamp-2">{it.name}</p>
                  </button>
                );
              })}
            </div>
          </div>

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
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {choices.map((it) => {
              const on = picked.includes(it.id);
              const k = mainImage(it);
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => toggle(it.id)}
                  className={`text-left rounded-md border-2 p-1 ${on ? "border-primary" : "border-transparent"}`}
                >
                  <div className="aspect-[3/4] rounded overflow-hidden bg-white border border-default-200">
                    {k ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photoUrl(k, 200)} alt="" loading="lazy" className="w-full h-full object-contain" />
                    ) : (
                      <div className="w-full h-full" style={{ background: it.colorHex ?? undefined }} />
                    )}
                  </div>
                  <p className="text-[11px] leading-tight mt-1 line-clamp-2 flex items-start gap-1">
                    <Swatch hex={it.colorHex} size={9} />
                    <span>{it.name}</span>
                  </p>
                  {it.status === "WISHLIST" && <p className="text-[10px] text-primary-600">Wishlist</p>}
                </button>
              );
            })}
          </div>
        </ModalBody>
        <ModalFooter className="justify-between">
          {editing ? (
            <Button color="danger" variant="light" onPress={remove}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="light" onPress={onClose}>
              Cancel
            </Button>
            <Button color="primary" onPress={save} isLoading={saving}>
              Save look
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
