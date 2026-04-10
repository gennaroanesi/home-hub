"use client";

import React, { useState, useEffect, useCallback } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Checkbox } from "@heroui/checkbox";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { FaPlus, FaTrash, FaPen, FaArrowLeft, FaArchive, FaBoxOpen } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type ShoppingList = Schema["homeShoppingList"]["type"];
type ShoppingItem = Schema["homeShoppingItem"]["type"];

export default function ShoppingPage() {
  const router = useRouter();
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [itemsByList, setItemsByList] = useState<Record<string, ShoppingItem[]>>({});
  const [showArchived, setShowArchived] = useState(false);

  // Inline "add item" input state, keyed by list id
  const [newItemByList, setNewItemByList] = useState<Record<string, string>>({});

  // List modal (create/edit)
  const listModal = useDisclosure();
  const [editingList, setEditingList] = useState<ShoppingList | null>(null);
  const [formListName, setFormListName] = useState("");
  const [formListEmoji, setFormListEmoji] = useState("");

  // Item edit modal
  const itemModal = useDisclosure();
  const [editingItem, setEditingItem] = useState<ShoppingItem | null>(null);
  const [formItemName, setFormItemName] = useState("");
  const [formItemQuantity, setFormItemQuantity] = useState("");
  const [formItemNotes, setFormItemNotes] = useState("");

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      await getCurrentUser();
      await loadAll();
    } catch {
      router.push("/login");
    }
  }

  const loadAll = useCallback(async () => {
    const { data: listData } = await client.models.homeShoppingList.list();
    const sortedLists = [...(listData ?? [])].sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
    );
    setLists(sortedLists);

    const { data: itemData } = await client.models.homeShoppingItem.list({ limit: 1000 });
    const grouped: Record<string, ShoppingItem[]> = {};
    for (const item of itemData ?? []) {
      if (!grouped[item.listId]) grouped[item.listId] = [];
      grouped[item.listId].push(item);
    }
    for (const listId of Object.keys(grouped)) {
      grouped[listId].sort((a, b) => {
        if (!!a.isChecked !== !!b.isChecked) return a.isChecked ? 1 : -1;
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    }
    setItemsByList(grouped);
  }, []);

  // ── List CRUD ──────────────────────────────────────────────────────────
  function openCreateList() {
    setEditingList(null);
    setFormListName("");
    setFormListEmoji("");
    listModal.onOpen();
  }

  function openEditList(list: ShoppingList) {
    setEditingList(list);
    setFormListName(list.name);
    setFormListEmoji(list.emoji ?? "");
    listModal.onOpen();
  }

  async function saveList(onClose: () => void) {
    if (!formListName.trim()) return;
    if (editingList) {
      await client.models.homeShoppingList.update({
        id: editingList.id,
        name: formListName,
        emoji: formListEmoji || null,
      });
    } else {
      await client.models.homeShoppingList.create({
        name: formListName,
        emoji: formListEmoji || null,
        sortOrder: lists.length,
      });
    }
    onClose();
    await loadAll();
  }

  async function deleteList(list: ShoppingList) {
    const count = (itemsByList[list.id] ?? []).length;
    if (!confirm(`Delete "${list.name}"${count ? ` and its ${count} items` : ""}?`)) return;
    // Delete child items first
    for (const item of itemsByList[list.id] ?? []) {
      await client.models.homeShoppingItem.delete({ id: item.id });
    }
    await client.models.homeShoppingList.delete({ id: list.id });
    await loadAll();
  }

  async function toggleArchive(list: ShoppingList) {
    const archiving = !list.isArchived;
    await client.models.homeShoppingList.update({
      id: list.id,
      isArchived: archiving,
      archivedAt: archiving ? new Date().toISOString() : null,
    });
    await loadAll();
  }

  // ── Item CRUD ──────────────────────────────────────────────────────────
  async function addItem(listId: string) {
    const name = (newItemByList[listId] ?? "").trim();
    if (!name) return;
    setNewItemByList((prev) => ({ ...prev, [listId]: "" }));
    await client.models.homeShoppingItem.create({
      listId,
      name,
      isChecked: false,
      addedBy: "ui",
      sortOrder: (itemsByList[listId] ?? []).length,
    });
    await loadAll();
  }

  async function toggleItem(item: ShoppingItem) {
    await client.models.homeShoppingItem.update({
      id: item.id,
      isChecked: !item.isChecked,
      checkedAt: !item.isChecked ? new Date().toISOString() : null,
    });
    await loadAll();
  }

  async function deleteItem(id: string) {
    await client.models.homeShoppingItem.delete({ id });
    await loadAll();
  }

  function openEditItem(item: ShoppingItem) {
    setEditingItem(item);
    setFormItemName(item.name);
    setFormItemQuantity(item.quantity ?? "");
    setFormItemNotes(item.notes ?? "");
    itemModal.onOpen();
  }

  async function saveItem(onClose: () => void) {
    if (!editingItem || !formItemName.trim()) return;
    await client.models.homeShoppingItem.update({
      id: editingItem.id,
      name: formItemName,
      quantity: formItemQuantity || null,
      notes: formItemNotes || null,
    });
    onClose();
    await loadAll();
  }

  async function clearChecked(listId: string) {
    const checked = (itemsByList[listId] ?? []).filter((i) => i.isChecked);
    if (checked.length === 0) return;
    if (!confirm(`Remove ${checked.length} checked item${checked.length === 1 ? "" : "s"}?`)) return;
    for (const item of checked) {
      await client.models.homeShoppingItem.delete({ id: item.id });
    }
    await loadAll();
  }

  return (
    <DefaultLayout>
      <div className="max-w-2xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-2xl font-bold text-foreground">Shopping</h1>
          </div>
          <Button color="primary" size="sm" startContent={<FaPlus size={12} />} onPress={openCreateList}>
            New List
          </Button>
        </div>

        {/* Toggle */}
        <div className="flex justify-end mb-4">
          <Checkbox size="sm" isSelected={showArchived} onValueChange={setShowArchived}>
            Show archived
          </Checkbox>
        </div>

        {/* Lists */}
        {lists.length === 0 && (
          <p className="text-center text-default-300 py-10">
            No shopping lists yet. Create one to get started.
          </p>
        )}

        <div className="space-y-4">
          {lists
            .filter((l) => showArchived || !l.isArchived)
            .map((list) => {
            const items = itemsByList[list.id] ?? [];
            const uncheckedCount = items.filter((i) => !i.isChecked).length;
            const hasChecked = items.some((i) => i.isChecked);
            const createdLabel = new Date(list.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: new Date(list.createdAt).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
            });

            return (
              <Card key={list.id} className={list.isArchived ? "opacity-60" : ""}>
                <CardHeader className="flex items-start justify-between px-4 pt-4 pb-2 gap-2">
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {list.emoji && <span className="text-xl">{list.emoji}</span>}
                      <h2 className="text-lg font-semibold">{list.name}</h2>
                      {list.isArchived && (
                        <span className="text-[10px] uppercase tracking-wide text-default-400 bg-default-100 px-1.5 py-0.5 rounded">
                          Archived
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-default-400 mt-0.5">
                      <span>{uncheckedCount} to buy</span>
                      <span>·</span>
                      <span>Created {createdLabel}</span>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {hasChecked && !list.isArchived && (
                      <Button size="sm" variant="light" onPress={() => clearChecked(list.id)}>
                        Clear checked
                      </Button>
                    )}
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      onPress={() => toggleArchive(list)}
                      title={list.isArchived ? "Unarchive" : "Archive"}
                    >
                      {list.isArchived ? <FaBoxOpen size={12} /> : <FaArchive size={12} />}
                    </Button>
                    <Button size="sm" isIconOnly variant="light" onPress={() => openEditList(list)}>
                      <FaPen size={12} />
                    </Button>
                    <Button size="sm" isIconOnly variant="light" color="danger" onPress={() => deleteList(list)}>
                      <FaTrash size={12} />
                    </Button>
                  </div>
                </CardHeader>
                <CardBody className="px-4 pt-0 pb-4">
                  {/* Add item input */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      addItem(list.id);
                    }}
                    className="flex gap-2 mb-3"
                  >
                    <Input
                      size="sm"
                      placeholder="Add item…"
                      value={newItemByList[list.id] ?? ""}
                      onValueChange={(v) => setNewItemByList((prev) => ({ ...prev, [list.id]: v }))}
                    />
                    <Button size="sm" type="submit" isIconOnly color="primary" variant="flat">
                      <FaPlus size={12} />
                    </Button>
                  </form>

                  {/* Items */}
                  {items.length === 0 && (
                    <p className="text-xs text-default-300 py-2">No items</p>
                  )}
                  <div className="space-y-1">
                    {items.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 py-1.5 border-b border-default-100 last:border-0"
                      >
                        <Checkbox
                          size="sm"
                          isSelected={!!item.isChecked}
                          onValueChange={() => toggleItem(item)}
                        />
                        <div className="flex-1 min-w-0">
                          <p
                            className={`text-sm ${
                              item.isChecked ? "line-through text-default-400" : "text-foreground"
                            }`}
                          >
                            {item.name}
                            {item.quantity && (
                              <span className="text-xs text-default-400 ml-2">{item.quantity}</span>
                            )}
                          </p>
                          {item.notes && (
                            <p className="text-xs text-default-500">{item.notes}</p>
                          )}
                        </div>
                        <Button size="sm" isIconOnly variant="light" onPress={() => openEditItem(item)}>
                          <FaPen size={10} />
                        </Button>
                        <Button
                          size="sm"
                          isIconOnly
                          variant="light"
                          color="danger"
                          onPress={() => deleteItem(item.id)}
                        >
                          <FaTrash size={10} />
                        </Button>
                      </div>
                    ))}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>

        {/* List modal */}
        <Modal isOpen={listModal.isOpen} onOpenChange={listModal.onOpenChange}>
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>{editingList ? "Edit List" : "New List"}</ModalHeader>
                <ModalBody>
                  <Input
                    label="Name"
                    value={formListName}
                    onValueChange={setFormListName}
                    isRequired
                    placeholder="Supermarket, Home Depot, …"
                  />
                  <Input
                    label="Emoji (optional)"
                    value={formListEmoji}
                    onValueChange={setFormListEmoji}
                    placeholder="🛒"
                  />
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => saveList(onClose)}>
                    {editingList ? "Save" : "Create"}
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        {/* Item edit modal */}
        <Modal isOpen={itemModal.isOpen} onOpenChange={itemModal.onOpenChange}>
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>Edit Item</ModalHeader>
                <ModalBody>
                  <Input label="Name" value={formItemName} onValueChange={setFormItemName} isRequired />
                  <Input
                    label="Quantity"
                    value={formItemQuantity}
                    onValueChange={setFormItemQuantity}
                    placeholder="2, 1 lb, 500g…"
                  />
                  <Input label="Notes" value={formItemNotes} onValueChange={setFormItemNotes} />
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => saveItem(onClose)}>Save</Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>
      </div>
    </DefaultLayout>
  );
}
