"use client";

import React, { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Checkbox } from "@heroui/checkbox";
import { Spinner } from "@heroui/react";
import { FaPlus, FaTrash, FaPen, FaCheck, FaTimes } from "react-icons/fa";

import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Checklist = Schema["homeChecklist"]["type"];
type ChecklistItem = Schema["homeChecklistItem"]["type"];

interface ChecklistPanelProps {
  entityType: "TRIP" | "EVENT" | "BILL" | "DOCUMENT" | "TASK" | "OTHER";
  entityId: string;
}

export function ChecklistPanel({ entityType, entityId }: ChecklistPanelProps) {
  const [loading, setLoading] = useState(true);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [itemsByChecklist, setItemsByChecklist] = useState<Record<string, ChecklistItem[]>>({});

  // New checklist input
  const [showNewChecklist, setShowNewChecklist] = useState(false);
  const [newChecklistName, setNewChecklistName] = useState("");

  // Per-checklist new item input
  const [newItemText, setNewItemText] = useState<Record<string, string>>({});

  // Inline editing state
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null);
  const [editingChecklistName, setEditingChecklistName] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemText, setEditingItemText] = useState("");

  const loadData = useCallback(async () => {
    const { data: clData } = await client.models.homeChecklist.listhomeChecklistByEntityId(
      { entityId },
    );
    const lists = (clData ?? []).sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
    );
    setChecklists(lists);

    const grouped: Record<string, ChecklistItem[]> = {};
    await Promise.all(
      lists.map(async (cl) => {
        const { data: items } = await client.models.homeChecklistItem.listhomeChecklistItemByChecklistId(
          { checklistId: cl.id },
        );
        grouped[cl.id] = (items ?? []).sort(
          (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
        );
      })
    );
    setItemsByChecklist(grouped);
    setLoading(false);
  }, [entityId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Checklist CRUD ──────────────────────────────────────────────────────

  async function createChecklist() {
    const name = newChecklistName.trim();
    if (!name) return;
    setNewChecklistName("");
    setShowNewChecklist(false);
    await client.models.homeChecklist.create({
      entityType,
      entityId,
      name,
      sortOrder: checklists.length,
    });
    await loadData();
  }

  async function renameChecklist(id: string) {
    const name = editingChecklistName.trim();
    if (!name) return;
    setEditingChecklistId(null);
    await client.models.homeChecklist.update({ id, name });
    await loadData();
  }

  async function deleteChecklist(cl: Checklist) {
    const items = itemsByChecklist[cl.id] ?? [];
    if (!confirm(`Delete "${cl.name}"${items.length ? ` and its ${items.length} items` : ""}?`))
      return;
    // Delete items first
    for (const item of items) {
      await client.models.homeChecklistItem.delete({ id: item.id });
    }
    await client.models.homeChecklist.delete({ id: cl.id });
    await loadData();
  }

  // ── Item CRUD ───────────────────────────────────────────────────────────

  async function addItem(checklistId: string) {
    const text = (newItemText[checklistId] ?? "").trim();
    if (!text) return;
    setNewItemText((prev) => ({ ...prev, [checklistId]: "" }));
    const existing = itemsByChecklist[checklistId] ?? [];
    await client.models.homeChecklistItem.create({
      checklistId,
      text,
      isDone: false,
      sortOrder: existing.length,
    });
    await loadData();
  }

  async function toggleItem(item: ChecklistItem) {
    const nowDone = !item.isDone;
    // Optimistic update
    setItemsByChecklist((prev) => ({
      ...prev,
      [item.checklistId]: (prev[item.checklistId] ?? []).map((i) =>
        i.id === item.id ? { ...i, isDone: nowDone, doneAt: nowDone ? new Date().toISOString() : null } : i
      ),
    }));
    await client.models.homeChecklistItem.update({
      id: item.id,
      isDone: nowDone,
      doneAt: nowDone ? new Date().toISOString() : null,
    });
  }

  async function renameItem(id: string) {
    const text = editingItemText.trim();
    if (!text) return;
    setEditingItemId(null);
    await client.models.homeChecklistItem.update({ id, text });
    await loadData();
  }

  async function deleteItem(id: string) {
    await client.models.homeChecklistItem.delete({ id });
    await loadData();
  }

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="py-4 flex justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div className="border-t border-default-200 pt-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium">Checklists</p>
        <Button
          size="sm"
          variant="flat"
          startContent={<FaPlus size={10} />}
          onPress={() => setShowNewChecklist(true)}
        >
          Add checklist
        </Button>
      </div>

      {/* New checklist input */}
      {showNewChecklist && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createChecklist();
          }}
          className="flex gap-2 mb-3"
        >
          <Input
            size="sm"
            placeholder="Checklist name..."
            value={newChecklistName}
            onValueChange={setNewChecklistName}
            autoFocus
          />
          <Button size="sm" type="submit" color="primary" variant="flat" isIconOnly>
            <FaCheck size={10} />
          </Button>
          <Button
            size="sm"
            variant="light"
            isIconOnly
            onPress={() => {
              setShowNewChecklist(false);
              setNewChecklistName("");
            }}
          >
            <FaTimes size={10} />
          </Button>
        </form>
      )}

      {/* Empty state */}
      {checklists.length === 0 && !showNewChecklist && (
        <p className="text-xs text-default-400 py-2">
          No checklists yet. Add one to get started.
        </p>
      )}

      {/* Checklists */}
      <div className="space-y-3">
        {checklists.map((cl) => {
          const items = itemsByChecklist[cl.id] ?? [];
          const isEditingName = editingChecklistId === cl.id;

          return (
            <div
              key={cl.id}
              className="border border-default-200 rounded-md p-3 bg-default-50"
            >
              {/* Checklist header */}
              <div className="flex items-center justify-between mb-2">
                {isEditingName ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      renameChecklist(cl.id);
                    }}
                    className="flex gap-1 flex-1"
                  >
                    <Input
                      size="sm"
                      value={editingChecklistName}
                      onValueChange={setEditingChecklistName}
                      autoFocus
                    />
                    <Button size="sm" type="submit" isIconOnly variant="flat">
                      <FaCheck size={10} />
                    </Button>
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      onPress={() => setEditingChecklistId(null)}
                    >
                      <FaTimes size={10} />
                    </Button>
                  </form>
                ) : (
                  <>
                    <p className="text-sm font-medium">{cl.name}</p>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        isIconOnly
                        variant="light"
                        onPress={() => {
                          setEditingChecklistId(cl.id);
                          setEditingChecklistName(cl.name);
                        }}
                      >
                        <FaPen size={10} />
                      </Button>
                      <Button
                        size="sm"
                        isIconOnly
                        variant="light"
                        color="danger"
                        onPress={() => deleteChecklist(cl)}
                      >
                        <FaTrash size={10} />
                      </Button>
                    </div>
                  </>
                )}
              </div>

              {/* Items */}
              <div className="space-y-1">
                {items.map((item) => {
                  const isEditingItem = editingItemId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-2 py-1 border-b border-default-100 last:border-0"
                    >
                      <Checkbox
                        size="sm"
                        isSelected={!!item.isDone}
                        onValueChange={() => toggleItem(item)}
                      />
                      {isEditingItem ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            renameItem(item.id);
                          }}
                          className="flex gap-1 flex-1"
                        >
                          <Input
                            size="sm"
                            value={editingItemText}
                            onValueChange={setEditingItemText}
                            autoFocus
                          />
                          <Button size="sm" type="submit" isIconOnly variant="flat">
                            <FaCheck size={8} />
                          </Button>
                          <Button
                            size="sm"
                            isIconOnly
                            variant="light"
                            onPress={() => setEditingItemId(null)}
                          >
                            <FaTimes size={8} />
                          </Button>
                        </form>
                      ) : (
                        <>
                          <span
                            className={`flex-1 text-sm ${
                              item.isDone ? "line-through text-default-400" : ""
                            }`}
                          >
                            {item.text}
                          </span>
                          <Button
                            size="sm"
                            isIconOnly
                            variant="light"
                            onPress={() => {
                              setEditingItemId(item.id);
                              setEditingItemText(item.text);
                            }}
                          >
                            <FaPen size={8} />
                          </Button>
                          <Button
                            size="sm"
                            isIconOnly
                            variant="light"
                            color="danger"
                            onPress={() => deleteItem(item.id)}
                          >
                            <FaTrash size={8} />
                          </Button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add item input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addItem(cl.id);
                }}
                className="flex gap-2 mt-2"
              >
                <Input
                  size="sm"
                  placeholder="Add item..."
                  value={newItemText[cl.id] ?? ""}
                  onValueChange={(v) =>
                    setNewItemText((prev) => ({ ...prev, [cl.id]: v }))
                  }
                />
                <Button size="sm" type="submit" isIconOnly color="primary" variant="flat">
                  <FaPlus size={10} />
                </Button>
              </form>
            </div>
          );
        })}
      </div>
    </div>
  );
}
