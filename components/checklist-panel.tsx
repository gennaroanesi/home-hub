"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Checkbox } from "@heroui/checkbox";
import { Select, SelectItem } from "@heroui/select";
import { Spinner, addToast } from "@heroui/react";
import { FaPlus, FaTrash, FaPen, FaCheck, FaTimes, FaCopy, FaFileImport } from "react-icons/fa";

import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Checklist = Schema["homeChecklist"]["type"];
type ChecklistItem = Schema["homeChecklistItem"]["type"];
type EntityType = "TRIP" | "EVENT" | "BILL" | "DOCUMENT" | "TASK" | "TEMPLATE" | "OTHER";

interface ChecklistPanelProps {
  entityType: EntityType;
  entityId: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Group items by section, preserving sort order within each group. */
function groupBySection(items: ChecklistItem[]): { section: string | null; items: ChecklistItem[] }[] {
  const map = new Map<string | null, ChecklistItem[]>();
  for (const item of items) {
    const key = (item as any).section || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  // Ungrouped (null) first, then alphabetical sections
  const groups: { section: string | null; items: ChecklistItem[] }[] = [];
  if (map.has(null)) groups.push({ section: null, items: map.get(null)! });
  const sorted = Array.from(map.entries()).filter(([k]) => k !== null).sort((a, b) => a[0]!.localeCompare(b[0]!));
  for (const [key, items] of sorted) {
    groups.push({ section: key, items });
  }
  return groups;
}

// ── Component ──────────────────────────────────────────────────────────

export function ChecklistPanel({ entityType, entityId }: ChecklistPanelProps) {
  const [loading, setLoading] = useState(true);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [itemsByChecklist, setItemsByChecklist] = useState<Record<string, ChecklistItem[]>>({});

  // New checklist
  const [showNewChecklist, setShowNewChecklist] = useState(false);
  const [newChecklistName, setNewChecklistName] = useState("");

  // Per-checklist new item input
  const [newItemText, setNewItemText] = useState<Record<string, string>>({});
  const [newItemSection, setNewItemSection] = useState<Record<string, string>>({});

  // Inline editing
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null);
  const [editingChecklistName, setEditingChecklistName] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemText, setEditingItemText] = useState("");

  // Templates (for "from template" picker)
  const [templates, setTemplates] = useState<Checklist[]>([]);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  // Duplicate modal
  const [duplicatingChecklist, setDuplicatingChecklist] = useState<Checklist | null>(null);

  const loadData = useCallback(async () => {
    try {
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
    } catch (err) {
      // Table may not exist yet (sandbox not redeployed after schema
      // change). Fail gracefully — show empty state instead of spinning.
      console.error("Checklist load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [entityId]);

  // Load templates once (entityType=TEMPLATE)
  const loadTemplates = useCallback(async () => {
    try {
      const { data } = await client.models.homeChecklist.listhomeChecklistByEntityType(
        { entityType: "TEMPLATE" as any },
      );
      setTemplates((data ?? []).sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      // Table may not exist yet — templates just won't show.
    }
  }, []);

  useEffect(() => {
    loadData();
    if (entityType !== "TEMPLATE") loadTemplates();
  }, [loadData, loadTemplates, entityType]);

  // ── Checklist CRUD ─────────────────────────────────────────────────

  async function createChecklist() {
    const name = newChecklistName.trim();
    if (!name) return;
    setNewChecklistName("");
    setShowNewChecklist(false);
    try {
      const { errors } = await client.models.homeChecklist.create({
        entityType: entityType as any,
        entityId,
        name,
        sortOrder: checklists.length,
      });
      if (errors?.length) {
        console.error("Create checklist failed:", errors);
        addToast({ title: "Failed to create checklist", description: errors[0]?.message ?? "Unknown error", color: "danger" });
        return;
      }
      await loadData();
    } catch (err) {
      console.error("Create checklist error:", err);
      addToast({ title: "Failed to create checklist", description: err instanceof Error ? err.message : String(err), color: "danger" });
    }
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
    for (const item of items) {
      await client.models.homeChecklistItem.delete({ id: item.id });
    }
    await client.models.homeChecklist.delete({ id: cl.id });
    await loadData();
  }

  /**
   * Duplicate a checklist (with all items, isDone reset to false) and
   * attach it to the current entity. If sourceChecklist belongs to a
   * different entity (e.g. a template), this effectively "imports" it.
   */
  async function duplicateChecklist(source: Checklist, targetEntityType?: EntityType, targetEntityId?: string) {
    const eType = targetEntityType ?? entityType;
    const eId = targetEntityId ?? entityId;
    const { data: newCl } = await client.models.homeChecklist.create({
      entityType: eType as any,
      entityId: eId,
      name: source.name,
      sortOrder: checklists.length,
    });
    if (!newCl) return;

    // Fetch source items
    const { data: sourceItems } = await client.models.homeChecklistItem.listhomeChecklistItemByChecklistId(
      { checklistId: source.id },
    );
    for (const item of (sourceItems ?? []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
      await (client.models.homeChecklistItem as any).create({
        checklistId: newCl.id,
        text: item.text,
        section: (item as any).section,
        isDone: false,
        sortOrder: item.sortOrder ?? 0,
      });
    }
    addToast({ title: "Checklist duplicated", description: `"${source.name}" added` });
    await loadData();
  }

  /** Save a checklist as a template (duplicate to TEMPLATE entity space). */
  async function saveAsTemplate(source: Checklist) {
    await duplicateChecklist(source, "TEMPLATE" as any, "templates");
    await loadTemplates();
    addToast({ title: "Template saved", description: `"${source.name}" is now a reusable template` });
  }

  // ── Item CRUD ──────────────────────────────────────────────────────

  async function addItem(checklistId: string) {
    const text = (newItemText[checklistId] ?? "").trim();
    if (!text) return;
    const section = (newItemSection[checklistId] ?? "").trim() || null;
    setNewItemText((prev) => ({ ...prev, [checklistId]: "" }));
    const existing = itemsByChecklist[checklistId] ?? [];
    await (client.models.homeChecklistItem as any).create({
      checklistId,
      text,
      section,
      isDone: false,
      sortOrder: existing.length,
    });
    await loadData();
  }

  async function toggleItem(item: ChecklistItem) {
    const nowDone = !item.isDone;
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

  // ── Existing sections for autocomplete ────────────────────────────

  /** Unique section names across all items in the current checklist. */
  function sectionsForChecklist(checklistId: string): string[] {
    const items = itemsByChecklist[checklistId] ?? [];
    const set = new Set(items.map((i) => (i as any).section).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }

  // ── Render ─────────────────────────────────────────────────────────

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
        <div className="flex gap-1">
          {/* From template button */}
          {entityType !== "TEMPLATE" && templates.length > 0 && (
            <Button
              size="sm"
              variant="flat"
              startContent={<FaFileImport size={10} />}
              onPress={() => setShowTemplatePicker(!showTemplatePicker)}
            >
              From template
            </Button>
          )}
          <Button
            size="sm"
            variant="flat"
            startContent={<FaPlus size={10} />}
            onPress={() => setShowNewChecklist(true)}
          >
            Add checklist
          </Button>
        </div>
      </div>

      {/* Template picker */}
      {showTemplatePicker && (
        <div className="mb-3 border border-default-200 rounded-md p-3 bg-default-50">
          <p className="text-xs text-default-500 mb-2">Pick a template to import:</p>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant="flat"
                onPress={async () => {
                  await duplicateChecklist(t);
                  setShowTemplatePicker(false);
                }}
              >
                {t.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* New checklist input */}
      {showNewChecklist && (
        <form
          onSubmit={(e) => { e.preventDefault(); createChecklist(); }}
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
          <Button size="sm" variant="light" isIconOnly onPress={() => { setShowNewChecklist(false); setNewChecklistName(""); }}>
            <FaTimes size={10} />
          </Button>
        </form>
      )}

      {/* Empty state */}
      {checklists.length === 0 && !showNewChecklist && (
        <p className="text-xs text-default-400 py-2">
          No checklists yet. Add one{templates.length > 0 ? " or import from a template" : ""} to get started.
        </p>
      )}

      {/* Checklists */}
      <div className="space-y-3">
        {checklists.map((cl) => {
          const items = itemsByChecklist[cl.id] ?? [];
          const groups = groupBySection(items);
          const isEditingName = editingChecklistId === cl.id;
          const doneCount = items.filter((i) => i.isDone).length;
          const sections = sectionsForChecklist(cl.id);

          return (
            <div key={cl.id} className="border border-default-200 rounded-md p-3 bg-default-50">
              {/* Checklist header */}
              <div className="flex items-center justify-between mb-2">
                {isEditingName ? (
                  <form onSubmit={(e) => { e.preventDefault(); renameChecklist(cl.id); }} className="flex gap-1 flex-1">
                    <Input size="sm" value={editingChecklistName} onValueChange={setEditingChecklistName} autoFocus />
                    <Button size="sm" type="submit" isIconOnly variant="flat"><FaCheck size={10} /></Button>
                    <Button size="sm" isIconOnly variant="light" onPress={() => setEditingChecklistId(null)}><FaTimes size={10} /></Button>
                  </form>
                ) : (
                  <>
                    <div>
                      <p className="text-sm font-medium">{cl.name}</p>
                      {items.length > 0 && (
                        <p className="text-xs text-default-400">{doneCount}/{items.length} done</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" isIconOnly variant="light" title="Duplicate" onPress={() => duplicateChecklist(cl)}>
                        <FaCopy size={10} />
                      </Button>
                      {entityType !== "TEMPLATE" && (
                        <Button size="sm" isIconOnly variant="light" title="Save as template" onPress={() => saveAsTemplate(cl)}>
                          <FaFileImport size={10} />
                        </Button>
                      )}
                      <Button size="sm" isIconOnly variant="light" onPress={() => { setEditingChecklistId(cl.id); setEditingChecklistName(cl.name); }}>
                        <FaPen size={10} />
                      </Button>
                      <Button size="sm" isIconOnly variant="light" color="danger" onPress={() => deleteChecklist(cl)}>
                        <FaTrash size={10} />
                      </Button>
                    </div>
                  </>
                )}
              </div>

              {/* Items grouped by section */}
              {groups.map((group) => (
                <div key={group.section ?? "__none__"} className="mb-2">
                  {group.section && (
                    <p className="text-xs font-semibold text-default-500 uppercase tracking-wider mt-2 mb-1">
                      {group.section}
                    </p>
                  )}
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const isEditingItem = editingItemId === item.id;
                      return (
                        <div key={item.id} className="flex items-center gap-2 py-1 border-b border-default-100 last:border-0">
                          <Checkbox size="sm" isSelected={!!item.isDone} onValueChange={() => toggleItem(item)} />
                          {isEditingItem ? (
                            <form onSubmit={(e) => { e.preventDefault(); renameItem(item.id); }} className="flex gap-1 flex-1">
                              <Input size="sm" value={editingItemText} onValueChange={setEditingItemText} autoFocus />
                              <Button size="sm" type="submit" isIconOnly variant="flat"><FaCheck size={8} /></Button>
                              <Button size="sm" isIconOnly variant="light" onPress={() => setEditingItemId(null)}><FaTimes size={8} /></Button>
                            </form>
                          ) : (
                            <>
                              <span className={`flex-1 text-sm ${item.isDone ? "line-through text-default-400" : ""}`}>
                                {item.text}
                              </span>
                              <Button size="sm" isIconOnly variant="light" onPress={() => { setEditingItemId(item.id); setEditingItemText(item.text); }}>
                                <FaPen size={8} />
                              </Button>
                              <Button size="sm" isIconOnly variant="light" color="danger" onPress={() => deleteItem(item.id)}>
                                <FaTrash size={8} />
                              </Button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Add item input with optional section */}
              <form
                onSubmit={(e) => { e.preventDefault(); addItem(cl.id); }}
                className="flex gap-2 mt-2"
              >
                <Input
                  size="sm"
                  placeholder="Add item..."
                  value={newItemText[cl.id] ?? ""}
                  onValueChange={(v) => setNewItemText((prev) => ({ ...prev, [cl.id]: v }))}
                  className="flex-1"
                />
                {sections.length > 0 && (
                  <Input
                    size="sm"
                    placeholder="Section"
                    value={newItemSection[cl.id] ?? ""}
                    onValueChange={(v) => setNewItemSection((prev) => ({ ...prev, [cl.id]: v }))}
                    className="max-w-[120px]"
                    list={`sections-${cl.id}`}
                  />
                )}
                {sections.length > 0 && (
                  <datalist id={`sections-${cl.id}`}>
                    {sections.map((s) => <option key={s} value={s} />)}
                  </datalist>
                )}
                <Button size="sm" type="submit" isIconOnly color="primary" variant="flat">
                  <FaPlus size={10} />
                </Button>
              </form>
              {sections.length === 0 && items.length > 0 && (
                <p className="text-xs text-default-400 mt-1">
                  Tip: add a section name when adding items to group them (e.g. &quot;Clothes&quot;, &quot;Gear&quot;)
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
