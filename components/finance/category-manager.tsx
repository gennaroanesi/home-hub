// Add, rename, nest and delete finance categories: the inventory Categories
// window (components/inventory/category-manager.tsx) for the finance tree.
// The rules live in the ops (save_finance_category / delete_finance_category,
// lib/finance/category-tree.ts): a rename or move rewrites the category on
// every transaction, rule, budget line, schedule and invoice that uses it.

import React, { useCallback, useEffect, useState } from "react";
import { addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { FaPen, FaPlus, FaTrash } from "react-icons/fa";

import { financeClient } from "@/components/finance/client";
import { callOp } from "@/lib/ops-client";

type Node = { id: string; name: string; parentId: string | null; path: string; depth: number; transactions?: number };
type Draft = { id: string | null; name: string; parentId: string };
type Removing = { id: string; name: string; moveTo: string };
const UNCATEGORIZE = "__none";

function descendants(id: string, nodes: Node[]): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of nodes) if (n.parentId && out.has(n.parentId) && !out.has(n.id)) (out.add(n.id), (grew = true));
  }
  return out;
}

function rewrittenNote(r: { transactions: number; rules: number; budgetLines: number; schedules: number; invoices: number } | null | undefined): string | undefined {
  if (!r) return undefined;
  const parts = [
    [r.transactions, "transaction"],
    [r.rules, "rule"],
    [r.budgetLines, "budget line"],
    [r.schedules, "scheduled transaction"],
    [r.invoices, "invoice"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  return parts.length ? `Updated ${parts.join(", ")}` : undefined;
}

export function FinanceCategoryManager({ isOpen, onClose, onChanged }: { isOpen: boolean; onClose: () => void; onChanged?: () => void | Promise<void> }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await callOp(financeClient, "list_finance_categories", { withCounts: true });
    setLoading(false);
    if ("error" in r) return void addToast({ title: "Couldn't load categories", description: r.error, color: "danger" });
    setNodes(r.result.tree as Node[]);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setDraft(null);
      setRemoving(null);
      void load();
    }
  }, [isOpen, load]);

  const count = (id: string) => {
    const ids = descendants(id, nodes);
    return nodes.filter((n) => ids.has(n.id)).reduce((s, n) => s + (n.transactions ?? 0), 0);
  };
  const directCount = (id: string) => nodes.find((n) => n.id === id)?.transactions ?? 0;

  async function changed() {
    await load();
    await onChanged?.();
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    const r = await callOp(financeClient, "save_finance_category", {
      ...(draft.id ? { categoryId: draft.id } : {}),
      name: draft.name,
      parentId: draft.parentId || null,
    });
    setBusy(false);
    if ("error" in r) return void addToast({ title: "Couldn't save", description: r.error, color: "danger" });
    if (r.result.renamedFrom) addToast({ title: `${r.result.renamedFrom} → ${r.result.category.path}`, description: rewrittenNote(r.result.rewritten), color: "success" });
    setDraft(null);
    await changed();
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    const r = await callOp(financeClient, "delete_finance_category", {
      categoryId: removing.id,
      ...(removing.moveTo === UNCATEGORIZE ? { uncategorize: true } : removing.moveTo ? { moveToCategoryId: removing.moveTo } : {}),
    });
    setBusy(false);
    if ("error" in r) return void addToast({ title: "Couldn't delete", description: r.error, color: "danger" });
    addToast({ title: `Deleted ${r.result.deleted}`, description: rewrittenNote(r.result.rewritten), color: "success" });
    setRemoving(null);
    await changed();
  }

  const parentChoices = draft ? nodes.filter((n) => !draft.id || !descendants(draft.id, nodes).has(n.id)) : [];
  const removingNode = removing ? nodes.find((n) => n.id === removing.id) : undefined;
  const needsTarget = !!removingNode && !removingNode.parentId && directCount(removingNode.id) > 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span>Categories</span>
          <span className="text-xs font-normal text-default-500">Renaming or moving one updates every transaction, rule and budget line that uses it.</span>
        </ModalHeader>
        <ModalBody className="gap-3">
          {loading && nodes.length === 0 && <p className="text-sm text-default-400">Loading…</p>}
          {!loading && nodes.length === 0 && <p className="text-sm text-default-400">No categories yet.</p>}
          <div className="divide-y divide-default-100">
            {nodes.map((n) => (
              <div key={n.id} className="flex items-center gap-2 py-1.5" style={{ paddingLeft: n.depth * 20 }}>
                <span className="text-sm flex-1 min-w-0 truncate">{n.name}</span>
                <span className="text-xs text-default-400 tabular-nums" title="Transactions, sub-categories included">
                  {count(n.id)}
                </span>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={`Add a sub-category to ${n.name}`}
                  onPress={() => {
                    setRemoving(null);
                    setDraft({ id: null, name: "", parentId: n.id });
                  }}
                >
                  <FaPlus size={10} />
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={`Edit ${n.name}`}
                  onPress={() => {
                    setRemoving(null);
                    setDraft({ id: n.id, name: n.name, parentId: n.parentId ?? "" });
                  }}
                >
                  <FaPen size={10} />
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  color="danger"
                  aria-label={`Delete ${n.name}`}
                  onPress={() => {
                    setDraft(null);
                    setRemoving({ id: n.id, name: n.path, moveTo: "" });
                  }}
                >
                  <FaTrash size={10} />
                </Button>
              </div>
            ))}
          </div>

          {draft && (
            <div className="flex flex-col gap-2 rounded-md border border-default-200 p-3">
              <p className="text-sm font-medium">{draft.id ? "Edit category" : "New category"}</p>
              <Input label="Name" size="sm" autoFocus value={draft.name} onValueChange={(name) => setDraft({ ...draft, name })} />
              <Select
                label="Inside"
                size="sm"
                placeholder="Top level"
                selectedKeys={draft.parentId ? [draft.parentId] : []}
                onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}
              >
                {parentChoices.map((n) => (
                  <SelectItem key={n.id}>{n.path}</SelectItem>
                ))}
              </Select>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="light" onPress={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button size="sm" color="primary" isLoading={busy} onPress={save}>
                  Save
                </Button>
              </div>
            </div>
          )}

          {removing && (
            <div className="flex flex-col gap-2 rounded-md border border-danger-200 p-3">
              <p className="text-sm">
                Delete <span className="font-medium">{removing.name}</span>? Its sub-categories move up one level.
                {directCount(removing.id) > 0 && ` Its ${directCount(removing.id)} transaction${directCount(removing.id) === 1 ? "" : "s"} (and any rules or budget lines) move to:`}
              </p>
              {directCount(removing.id) > 0 && (
                <Select
                  label="Move them to"
                  size="sm"
                  placeholder={needsTarget ? "Choose a category" : "Its parent"}
                  selectedKeys={removing.moveTo ? [removing.moveTo] : []}
                  onChange={(e) => setRemoving({ ...removing, moveTo: e.target.value })}
                >
                  {[
                    ...nodes.filter((n) => !descendants(removing.id, nodes).has(n.id)).map((n) => <SelectItem key={n.id}>{n.path}</SelectItem>),
                    <SelectItem key={UNCATEGORIZE}>Uncategorized</SelectItem>,
                  ]}
                </Select>
              )}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="light" onPress={() => setRemoving(null)}>
                  Cancel
                </Button>
                <Button size="sm" color="danger" isLoading={busy} isDisabled={needsTarget && !removing.moveTo} onPress={remove}>
                  Delete
                </Button>
              </div>
            </div>
          )}
        </ModalBody>
        <ModalFooter className="justify-between">
          <Button
            size="sm"
            variant="flat"
            startContent={<FaPlus size={10} />}
            onPress={() => {
              setRemoving(null);
              setDraft({ id: null, name: "", parentId: "" });
            }}
          >
            New category
          </Button>
          <Button size="sm" variant="light" onPress={onClose}>
            Close
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
