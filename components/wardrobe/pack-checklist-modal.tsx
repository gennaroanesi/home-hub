// "Add to checklist" from the Trip looks packing list: pick the pieces and a
// checklist on the trip (or a new one); the add_trip_pack_to_checklist op
// writes the lines, so Janet does the same thing.

import React, { useEffect, useState } from "react";
import NextLink from "next/link";
import { generateClient } from "aws-amplify/data";
import { addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";

import { callOp } from "@/lib/ops-client";
import { listAllPages } from "@/lib/list-all";
import type { Checklist } from "@/lib/checklist";
import type { Schema } from "@/amplify/data/resource";
import type { WardrobeItem } from "./shared";

const client = generateClient<Schema>({ authMode: "userPool" });

const NEW = "__new__";

export function PackChecklistModal({
  isOpen,
  onClose,
  tripId,
  tripName,
  personId,
  personName,
  groups,
  copies,
}: {
  isOpen: boolean;
  onClose: () => void;
  tripId: string;
  tripName: string;
  personId: string;
  personName: string;
  groups: [string, WardrobeItem[]][];
  copies: (it: WardrobeItem) => number;
}) {
  const [lists, setLists] = useState<Checklist[]>([]);
  const [target, setTarget] = useState(NEW);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setPicked(new Set(groups.flatMap(([, l]) => l.map((i) => i.id))));
    setName(`Packing · ${personName}`);
    (async () => {
      const rows = await listAllPages<Checklist>(client.models.homeChecklist, {
        filter: { entityType: { eq: "TRIP" }, entityId: { eq: tripId } },
      }).catch(() => []);
      const active = rows.filter((c) => c.isArchived !== true).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      setLists(active);
      // Default to an existing packing list when there is one.
      setTarget(active.find((c) => /pack/i.test(c.name))?.id ?? active[0]?.id ?? NEW);
    })();
  }, [isOpen, tripId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const all = groups.flatMap(([, l]) => l);

  async function save() {
    setSaving(true);
    const r = await callOp(client, "add_trip_pack_to_checklist", {
      personId,
      tripId,
      itemIds: all.filter((i) => picked.has(i.id)).map((i) => i.id),
      ...(target === NEW ? { checklistName: name.trim() || undefined } : { checklistId: target }),
    });
    setSaving(false);
    if ("error" in r) {
      addToast({ title: "Couldn't add to checklist", description: r.error, color: "danger" });
      return;
    }
    const { added, skipped, checklistName } = r.result;
    addToast({
      title: `${added.length} added to ${checklistName}`,
      description: skipped.length ? `${skipped.length} already on it` : undefined,
      color: "success",
      endContent: (
        <NextLink href={`/trips/${tripId}`} className="text-sm text-primary">
          Open trip
        </NextLink>
      ),
    });
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>Add to a {tripName} checklist</ModalHeader>
        <ModalBody>
          <Select label="Checklist" selectedKeys={[target]} onChange={(e) => e.target.value && setTarget(e.target.value)}>
            {[...lists.map((c) => <SelectItem key={c.id}>{c.name}</SelectItem>), <SelectItem key={NEW}>New checklist…</SelectItem>]}
          </Select>
          {target === NEW && <Input label="Name" value={name} onValueChange={setName} />}
          <div className="flex items-center justify-between text-xs text-default-500">
            <span>
              {picked.size} of {all.length} pieces
            </span>
            <button type="button" className="text-primary" onClick={() => setPicked(picked.size === all.length ? new Set() : new Set(all.map((i) => i.id)))}>
              {picked.size === all.length ? "Select none" : "Select all"}
            </button>
          </div>
          {groups.map(([cat, list]) => (
            <div key={cat}>
              <p className="text-[11px] uppercase tracking-wider text-default-400 mb-1">{cat}</p>
              {list.map((it) => (
                <label key={it.id} className="flex items-center gap-2 py-0.5 text-sm cursor-pointer">
                  <input type="checkbox" checked={picked.has(it.id)} onChange={() => toggle(it.id)} />
                  <span>
                    {it.name}
                    {copies(it) > 1 && <span className="text-default-500"> ×{copies(it)}</span>}
                  </span>
                </label>
              ))}
            </div>
          ))}
          <p className="text-xs text-default-400">Lines already on the checklist are skipped, so you can add again after re-planning.</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" onPress={save} isLoading={saving} isDisabled={!picked.size}>
            Add {picked.size} to checklist
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
