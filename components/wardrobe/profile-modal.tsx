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
import type { WardrobeProfile } from "./shared";

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

  useEffect(() => {
    if (!isOpen) return;
    setCats(categories);
    setNotes(profile?.styleNotes ?? "");
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
      const body = { personId, categories: cats, styleNotes: notes.trim() || null };
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
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{personName}&apos;s closet settings</ModalHeader>
        <ModalBody className="gap-4">
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
          <Button color="primary" onPress={save} isLoading={saving}>
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
