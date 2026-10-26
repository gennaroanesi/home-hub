// Per-person closet settings: which categories show (and in what order)
// and the style brief the outfit suggester follows.

import React, { useEffect, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { FaArrowDown, FaArrowUp, FaTimes } from "react-icons/fa";

import { CATEGORY_PRESETS } from "@/lib/wardrobe";
import type { Schema } from "@/amplify/data/resource";
import { uploadWardrobePhotos, type WardrobeProfile } from "./shared";
import { photoUrl } from "@/lib/image-loader";
import { wardrobeTryOnAvailable, wardrobeTryOnSetupMessage } from "@/lib/wardrobe-capabilities";

const client = generateClient<Schema>({ authMode: "userPool" });

export function ProfileModal({
  isOpen,
  onClose,
  personId,
  personName,
  profile,
  categories,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  personId: string;
  personName: string;
  profile: WardrobeProfile | null;
  categories: string[];
  onSaved: () => void;
}) {
  const [cats, setCats] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [fitNotes, setFitNotes] = useState("");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setCats(categories);
    setNotes(profile?.styleNotes ?? "");
    setPhotos((profile?.referenceImageKeys ?? []).filter((key): key is string => !!key));
    setFitNotes(profile?.fitNotes ?? "");
    setCustom("");
  }, [isOpen, profile, categories]);

  const add = (c: string) => {
    const v = c.trim();
    if (v && !cats.some((x) => x.toLowerCase() === v.toLowerCase())) setCats((p) => [...p, v]);
  };
  const move = (i: number, d: number) =>
    setCats((p) => {
      const j = i + d;
      if (j < 0 || j >= p.length) return p;
      const n = p.slice();
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  async function save() {
    setSaving(true);
    try {
      const body = { personId, categories: cats, styleNotes: notes.trim() || null, ...(wardrobeTryOnAvailable ? { referenceImageKeys: photos, fitNotes: fitNotes.trim() || null } : {}) };
      const r = profile
        ? await client.models.homeWardrobeProfile.update({ id: profile.id, ...body })
        : await client.models.homeWardrobeProfile.create(body);
      if (r.errors?.length) throw new Error(r.errors[0].message);
      onSaved();
      onClose();
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside" classNames={{ base: "max-sm:m-0 max-sm:rounded-b-none max-sm:max-h-[92dvh]" }}>
      <ModalContent>
        <ModalHeader>{personName}&apos;s closet settings</ModalHeader>
        <ModalBody className="gap-4">
          {!wardrobeTryOnAvailable && <p role="status" className="text-sm text-default-500">{wardrobeTryOnSetupMessage}</p>}
          {wardrobeTryOnAvailable && <section className="flex flex-col gap-3">
            <div>
              <p className="font-medium">Try-on reference photos</p>
              <p className="text-sm text-default-500">Add a well-lit full-body photo in a neutral pose. You can add a side or face reference too. The first photo is the default. Photos are sent to OpenAI when you request a new preview.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {photos.map((key, index) => (
                <div key={key} className="w-24 flex flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoUrl(key, 240)} alt={`Reference ${index + 1}`} className="w-24 h-32 object-cover rounded-lg" />
                  {index === 0 ? <span className="text-xs text-primary">Default photo</span> : <Button size="sm" variant="light" onPress={() => setPhotos(p => [key, ...p.filter(k => k !== key)])}>Use as default</Button>}
                  <Button size="sm" variant="light" color="danger" onPress={() => setPhotos(p => p.filter(k => k !== key))}>Remove</Button>
                </div>
              ))}
            </div>
            {photos.length < 3 && <label className="text-sm">
              {uploading ? "Uploading…" : "Add reference photos (up to 3, JPEG/PNG/WebP, 10 MB each)"}
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={uploading || saving} className="block mt-2" onChange={async e => {
                const files = Array.from(e.target.files ?? []).slice(0, 3 - photos.length);
                e.target.value = "";
                if (files.some(f => !["image/jpeg", "image/png", "image/webp"].includes(f.type) || f.size > 10 * 1024 * 1024)) {
                  addToast({ title: "Use JPEG, PNG or WebP photos under 10 MB", color: "warning" }); return;
                }
                setUploading(true);
                try { const keys = await uploadWardrobePhotos(files); setPhotos(p => [...p, ...keys].slice(0, 3)); }
                finally { setUploading(false); }
              }} />
            </label>}
            <Textarea label="Fit preferences" placeholder="Relaxed trousers; shirts usually tucked in…" value={fitNotes} onValueChange={setFitNotes} maxLength={2000} minRows={2} />
          </section>}
          <div>
            <p className="text-sm font-medium mb-2">Categories</p>
            <div className="flex flex-col gap-1">
              {cats.map((c, i) => (
                <div key={c} className="flex items-center gap-2 px-2 py-1 rounded-md bg-default-100">
                  <span className="flex-1 text-sm">{c}</span>
                  <Button isIconOnly size="sm" variant="light" aria-label="Move up" onPress={() => move(i, -1)}>
                    <FaArrowUp size={10} />
                  </Button>
                  <Button isIconOnly size="sm" variant="light" aria-label="Move down" onPress={() => move(i, 1)}>
                    <FaArrowDown size={10} />
                  </Button>
                  <Button isIconOnly size="sm" variant="light" color="danger" aria-label="Remove" onPress={() => setCats((p) => p.filter((x) => x !== c))}>
                    <FaTimes size={10} />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {CATEGORY_PRESETS.filter((p) => !cats.some((c) => c.toLowerCase() === p.toLowerCase())).map((p) => (
                <button key={p} type="button" onClick={() => add(p)} className="px-2.5 py-0.5 rounded-full text-xs bg-default-100 text-default-600 hover:bg-primary-100">
                  + {p}
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              <Input size="sm" placeholder="Custom category" value={custom} onValueChange={setCustom} onKeyDown={(e) => { if (e.key === "Enter") { add(custom); setCustom(""); } }} />
              <Button size="sm" variant="flat" onPress={() => { add(custom); setCustom(""); }}>
                Add
              </Button>
            </div>
            <p className="text-xs text-default-400 mt-2">Removing a category doesn&apos;t delete its items; they still show under their old category.</p>
          </div>
          <Textarea
            label="Style brief"
            description="The outfit suggester follows this: palettes you like, rules, things to avoid."
            placeholder="Old-money British leaning. Earth tones, navy, grey, olive. No black on top. Sneakers OK at the office."
            value={notes}
            onValueChange={setNotes}
            minRows={4}
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" onPress={save} isLoading={saving} isDisabled={uploading}>
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
