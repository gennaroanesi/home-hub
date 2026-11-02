// Add, rename, nest and delete inventory categories. All the rules live in
// the ops (lib/ops/inventory.ts); this is only the form.

import React, { useMemo, useState } from "react";
import { addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { FaPen, FaPlus, FaTrash } from "react-icons/fa";

import { CATEGORY_DETAIL_TYPES, CATEGORY_DETAIL_TYPE_LABELS, categoryAndDescendants, categoryTree, type CategoryDetailType, type CategoryLike } from "@/lib/inventory";
import { callOp } from "@/lib/ops-client";

type Draft = { id: string | null; name: string; parentId: string; detailType: string };

export function CategoryManager({
  isOpen,
  onClose,
  client,
  categories,
  items,
  onChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  client: unknown;
  categories: CategoryLike[];
  items: { categoryId?: string | null }[];
  onChanged: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string; moveTo: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tree = useMemo(() => categoryTree(categories), [categories]);

  const count = (id: string) => {
    const ids = categoryAndDescendants(id, categories);
    return items.filter((i) => i.categoryId && ids.has(i.categoryId)).length;
  };
  const directCount = (id: string) => items.filter((i) => i.categoryId === id).length;

  function failed(title: string, description: string) {
    addToast({ title, description, color: "danger" });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    const r = await callOp(client, "save_inventory_category", {
      ...(draft.id ? { categoryId: draft.id } : {}),
      name: draft.name,
      parentId: draft.parentId || null,
      detailType: (draft.detailType as CategoryDetailType) || null,
    });
    setBusy(false);
    if ("error" in r) return failed("Couldn't save", r.error);
    setDraft(null);
    await onChanged();
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    const r = await callOp(client, "delete_inventory_category", {
      categoryId: removing.id,
      ...(removing.moveTo ? { moveToCategoryId: removing.moveTo } : {}),
    });
    setBusy(false);
    if ("error" in r) return failed("Couldn't delete", r.error);
    addToast({ title: `Deleted ${r.result.deleted}`, description: r.result.itemsMoved ? `${r.result.itemsMoved} moved` : undefined, color: "success" });
    setRemoving(null);
    await onChanged();
  }

  const parentChoices = draft
    ? tree.filter((n) => !draft.id || !categoryAndDescendants(draft.id, categories).has(n.category.id))
    : [];
  const inherited = draft?.parentId ? tree.find((n) => n.category.id === draft.parentId)?.detailType : null;
  const removingNode = removing ? tree.find((n) => n.category.id === removing.id) : undefined;
  const needsTarget = !!removing && !removingNode?.category.parentId && directCount(removing.id) > 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>Categories</ModalHeader>
        <ModalBody className="gap-3">
          {tree.length === 0 && <p className="text-sm text-default-400">No categories yet.</p>}
          <div className="divide-y divide-default-100">
            {tree.map((n) => (
              <div key={n.category.id} className="flex items-center gap-2 py-1.5" style={{ paddingLeft: n.depth * 20 }}>
                <span className="text-sm flex-1 min-w-0 truncate">{n.category.name}</span>
                <span className="text-xs text-default-400 tabular-nums">{count(n.category.id)}</span>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={`Add a subcategory to ${n.category.name}`}
                  onPress={() => {
                    setRemoving(null);
                    setDraft({ id: null, name: "", parentId: n.category.id, detailType: "" });
                  }}
                >
                  <FaPlus size={10} />
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={`Edit ${n.category.name}`}
                  onPress={() => {
                    setRemoving(null);
                    setDraft({ id: n.category.id, name: n.category.name, parentId: n.category.parentId ?? "", detailType: n.category.detailType ?? "" });
                  }}
                >
                  <FaPen size={10} />
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  color="danger"
                  aria-label={`Delete ${n.category.name}`}
                  onPress={() => {
                    setDraft(null);
                    setRemoving({ id: n.category.id, name: n.category.name, moveTo: "" });
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
                  <SelectItem key={n.category.id}>{n.path}</SelectItem>
                ))}
              </Select>
              <Select
                label="Extra fields"
                size="sm"
                placeholder={inherited ? `Same as parent: ${CATEGORY_DETAIL_TYPE_LABELS[inherited]}` : "None"}
                selectedKeys={draft.detailType ? [draft.detailType] : []}
                onChange={(e) => setDraft({ ...draft, detailType: e.target.value })}
              >
                {CATEGORY_DETAIL_TYPES.map((t) => (
                  <SelectItem key={t}>{CATEGORY_DETAIL_TYPE_LABELS[t]}</SelectItem>
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
                Delete <span className="font-medium">{removing.name}</span>? Its subcategories move up one level.
                {directCount(removing.id) > 0 && ` Its ${directCount(removing.id)} item${directCount(removing.id) === 1 ? "" : "s"} move to:`}
              </p>
              {directCount(removing.id) > 0 && (
                <Select
                  label="Move items to"
                  size="sm"
                  placeholder={needsTarget ? "Choose a category" : "Its parent"}
                  selectedKeys={removing.moveTo ? [removing.moveTo] : []}
                  onChange={(e) => setRemoving({ ...removing, moveTo: e.target.value })}
                >
                  {tree
                    .filter((n) => n.category.id !== removing.id)
                    .map((n) => (
                      <SelectItem key={n.category.id}>{n.path}</SelectItem>
                    ))}
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
              setDraft({ id: null, name: "", parentId: "", detailType: "" });
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
