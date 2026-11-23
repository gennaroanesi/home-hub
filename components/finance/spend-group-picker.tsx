"use client";

// Spend group select for transaction editors, with "New group…" at the
// end: a small form that creates the group (save_finance_spend_group) and
// picks it, so tagging a charge for a new trip doesn't mean leaving the
// editor for /finance/groups.

import React, { useState } from "react";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast } from "@heroui/react";

import { financeClient } from "@/components/finance/client";
import { callOp } from "@/lib/ops-client";
import { EMPTY_SPEND_GROUP, SPEND_GROUP_KINDS, SPEND_GROUP_KIND_LABELS, spendGroupFields, type SpendGroupDraft, type SpendGroupKind } from "@/lib/finance/spend-groups";

/* eslint-disable @typescript-eslint/no-explicit-any */

const NEW = "__new_group";

export function SpendGroupPicker({
  label = "Spend group",
  value,
  onChange,
  groups,
  leading,
  onCreated,
}: {
  label?: string;
  /** A group id or one of `leading`'s ids. */
  value: string;
  onChange: (v: string) => void;
  groups: Array<{ id: string; name: string }>;
  /** Choices above the groups ("None", "Leave unchanged"). */
  leading: Array<{ id: string; name: string }>;
  /** A group was created (and picked): refresh whatever lists groups. */
  onCreated?: (group: { id: string; name: string }) => void;
}) {
  // Created here, until the caller's list has it.
  const [made, setMade] = useState<Array<{ id: string; name: string }>>([]);
  const [creating, setCreating] = useState(false);
  const all = [...groups, ...made.filter((m) => !groups.some((g) => g.id === m.id))];
  return (
    <>
      <Select
        label={label}
        selectedKeys={[value]}
        onChange={(e) => {
          if (e.target.value === NEW) setCreating(true);
          else if (e.target.value) onChange(e.target.value);
        }}
      >
        {[...leading, ...all, { id: NEW, name: "+ New group…" }].map((g) => (
          <SelectItem key={g.id} className={g.id === NEW ? "text-primary" : undefined}>
            {g.name}
          </SelectItem>
        ))}
      </Select>
      {creating && (
        <NewSpendGroupModal
          onClose={() => setCreating(false)}
          onCreated={(g) => {
            setCreating(false);
            setMade((m) => [...m, g]);
            onChange(g.id);
            onCreated?.(g);
          }}
        />
      )}
    </>
  );
}

function NewSpendGroupModal({ onClose, onCreated }: { onClose: () => void; onCreated: (g: { id: string; name: string }) => void }) {
  const [draft, setDraft] = useState<SpendGroupDraft>(EMPTY_SPEND_GROUP);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<SpendGroupDraft>) => setDraft((d) => ({ ...d, ...p }));

  async function save() {
    const checked = spendGroupFields(draft);
    if ("error" in checked) return addToast({ title: checked.error, color: "warning" });
    setSaving(true);
    const r = await callOp(financeClient, "save_finance_spend_group", checked.fields as any);
    setSaving(false);
    if ("error" in r) return addToast({ title: "Couldn't create the group", description: r.error, color: "danger" });
    addToast({ title: `Created “${r.result.group.name}”`, color: "success" });
    onCreated(r.result.group);
  }

  return (
    <Modal isOpen onClose={onClose} size="md">
      <ModalContent>
        <ModalHeader>New spend group</ModalHeader>
        <ModalBody className="gap-3">
          <p className="text-xs text-default-500">A trip, a project, an event: what&apos;s tagged with it counts here instead of against the monthly budget.</p>
          <Input label="Name" value={draft.name} onValueChange={(v) => set({ name: v })} autoFocus isRequired onKeyDown={(e) => e.key === "Enter" && save()} />
          <Select label="Kind" selectedKeys={[draft.kind]} onChange={(e) => e.target.value && set({ kind: e.target.value as SpendGroupKind })}>
            {SPEND_GROUP_KINDS.map((k) => (
              <SelectItem key={k}>{SPEND_GROUP_KIND_LABELS[k]}</SelectItem>
            ))}
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Input label="Start (optional)" type="date" placeholder=" " value={draft.startDate} onValueChange={(v) => set({ startDate: v })} />
            <Input label="End (optional)" type="date" placeholder=" " value={draft.endDate} onValueChange={(v) => set({ endDate: v })} />
          </div>
          <Input label="Budget (optional)" type="number" inputMode="decimal" min={0} startContent={<span className="text-default-400 text-sm">$</span>} value={draft.budget} onValueChange={(v) => set({ budget: v })} />
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" onPress={save} isLoading={saving}>
            Create
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
