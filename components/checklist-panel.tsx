"use client";

// Checklists attached to one entity (a trip, event, document, pregnancy)
// or the templates. Each list is a compact card (name, progress, one "⋯"
// menu) that opens to its items; a list with sections opens as a board,
// one column per section, scrolling sideways. Open lists are remembered
// per browser. Templates have their own tab on /checklists
// (?tab=templates&open=<id>); a list made from one links back to it.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import NextLink from "next/link";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Checkbox } from "@heroui/checkbox";
import { Chip } from "@heroui/chip";
import { Popover, PopoverContent, PopoverTrigger } from "@heroui/popover";
import { Dropdown, DropdownItem, DropdownMenu, DropdownSection, DropdownTrigger, Spinner, addToast } from "@heroui/react";
import { FaPlus, FaTrash, FaCheck, FaTimes, FaFileImport, FaGripVertical, FaChevronDown, FaChevronRight, FaEllipsisH } from "react-icons/fa";
import {
  DndContext,
  closestCorners,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, horizontalListSortingStrategy, verticalListSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { Schema } from "@/amplify/data/resource";
import {
  AUTO_ATTACH_HINT,
  AUTO_ATTACH_LABEL,
  TEMPLATE_ENTITY_ID,
  UNGROUPED,
  archivePatch,
  buildSectionGroups,
  copyChecklist,
  deriveSectionOrder,
  matchesArchiveFilter,
  progress,
  type ArchiveFilter,
  type Checklist,
  type ChecklistItem,
  type EntityType,
  type SectionGroup,
} from "@/lib/checklist";

/* eslint-disable @typescript-eslint/no-explicit-any */

const client = generateClient<Schema>({ authMode: "userPool" });

/** Where the templates are edited. */
export function templatesHref(openId?: string | null): string {
  return `/checklists?tab=templates${openId ? `&open=${openId}` : ""}`;
}

const OPEN_KEY = "checklists:open";
function readOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
function writeOpen(s: Set<string>) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...s].slice(-200)));
  } catch {
    /* private mode */
  }
}

interface ChecklistPanelProps {
  entityType: EntityType;
  entityId: string;
  // Which checklists to render. Detail pages omit it and see everything;
  // the Checklists page passes its Active / Archived tab.
  archiveFilter?: ArchiveFilter;
  // Fired after a checklist is archived/unarchived so a parent list can
  // re-derive which entities belong under the current filter.
  onArchiveChange?: () => void;
  /** Open this checklist (and scroll to it) on load. */
  openId?: string | null;
  /** Hide the "Checklists" heading (a page that has its own). */
  bare?: boolean;
  /** "From template" / "Add checklist" (default on; off where the page offers its own). */
  actions?: boolean;
}

// ── Items ────────────────────────────────────────────────────────────

interface ItemRowProps {
  item: ChecklistItem;
  isEditing: boolean;
  editingText: string;
  onToggle: () => void;
  onStartEdit: () => void;
  onEditTextChange: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}

function SortableItem({ item, isEditing, editingText, onToggle, onStartEdit, onEditTextChange, onSaveEdit, onCancelEdit, onDelete }: ItemRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, data: { type: "item", item } });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  return (
    <div ref={setNodeRef} style={style} className="group flex items-center gap-1.5 py-1 rounded hover:bg-default-50">
      <span
        // Always shown (an iPad with a trackpad "hovers", so hover-only grips
        // stayed hidden), dark enough to see, with a finger-sized target.
        className="text-default-500 hover:text-default-700 group-hover:text-default-600 cursor-grab active:cursor-grabbing flex-shrink-0 touch-none p-1.5 -my-1 -ml-1.5 rounded hover:bg-default-200"
        aria-label="Drag to move"
        title="Drag to move"
        {...attributes}
        {...listeners}
      >
        <FaGripVertical size={13} />
      </span>
      <Checkbox size="sm" isSelected={!!item.isDone} onValueChange={onToggle} aria-label={item.text} />
      {isEditing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSaveEdit();
          }}
          className="flex gap-1 flex-1"
        >
          <Input size="sm" value={editingText} onValueChange={onEditTextChange} autoFocus onKeyDown={(e) => e.key === "Escape" && onCancelEdit()} />
          <Button size="sm" type="submit" isIconOnly variant="flat" aria-label="Save">
            <FaCheck size={8} />
          </Button>
        </form>
      ) : (
        <>
          <button type="button" title="Click to edit" onClick={onStartEdit} className={`flex-1 text-left text-sm min-w-0 break-words ${item.isDone ? "line-through text-default-400" : ""}`}>
            {item.text}
          </button>
          <button type="button" aria-label="Delete item" onClick={onDelete} className="text-default-300 hover:text-danger flex-shrink-0 opacity-0 group-hover:opacity-100 px-1">
            <FaTrash size={10} />
          </button>
        </>
      )}
    </div>
  );
}

function DragOverlayItem({ item }: { item: ChecklistItem }) {
  return (
    <div className="flex items-center gap-2 py-1 px-2 bg-white dark:bg-default-50 rounded shadow-md border border-default-200">
      <FaGripVertical size={10} className="text-default-400" />
      <Checkbox size="sm" isSelected={!!item.isDone} isReadOnly />
      <span className={`flex-1 text-sm ${item.isDone ? "line-through text-default-400" : ""}`}>{item.text}</span>
    </div>
  );
}

function AddItemForm({ placeholder, value, onChange, onAdd }: { placeholder: string; value: string; onChange: (v: string) => void; onAdd: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdd();
      }}
      className="flex gap-1 mt-1"
    >
      <Input size="sm" variant="bordered" placeholder={placeholder} value={value} onValueChange={onChange} className="flex-1" />
      <Button size="sm" type="submit" isIconOnly color="primary" variant="flat" aria-label="Add item" isDisabled={!value.trim()}>
        <FaPlus size={10} />
      </Button>
    </form>
  );
}

// ── Section column ───────────────────────────────────────────────────

interface ColumnProps {
  group: SectionGroup;
  checklistId: string;
  /** Lists without sections render as one plain column. */
  single: boolean;
  renaming: boolean;
  renameText: string;
  onStartRename: () => void;
  onRenameTextChange: (v: string) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
  item: (i: ChecklistItem) => ItemRowProps;
  addText: string;
  onAddTextChange: (v: string) => void;
  onAdd: () => void;
}

function SectionColumn({ group, checklistId, single, renaming, renameText, onStartRename, onRenameTextChange, onSaveRename, onCancelRename, onDelete, item, addText, onAddTextChange, onAdd }: ColumnProps) {
  const isUngrouped = group.sectionId === UNGROUPED;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `section:${checklistId}:${group.sectionId}`,
    data: { type: "section", sectionId: group.sectionId, checklistId },
    // General stays put but still takes drops (moving an item out of a section).
    disabled: isUngrouped ? { draggable: true, droppable: false } : false,
  });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const p = progress(group.items);
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={single ? "max-w-xl" : "w-64 shrink-0 snap-start rounded-lg bg-default-100/70 dark:bg-default-100 p-2 flex flex-col self-start max-h-[32rem]"}
    >
      {!single && (
        <div className="flex items-center gap-1 mb-1 px-0.5">
          {!isUngrouped && (
            <span
              className="text-default-500 hover:text-default-700 cursor-grab active:cursor-grabbing flex-shrink-0 touch-none p-1.5 -m-1.5 rounded hover:bg-default-200"
              aria-label="Drag section"
              title="Drag section"
              {...attributes}
              {...listeners}
            >
              <FaGripVertical size={13} />
            </span>
          )}
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSaveRename();
              }}
              className="flex gap-1 flex-1"
            >
              <Input size="sm" value={renameText} onValueChange={onRenameTextChange} autoFocus onKeyDown={(e) => e.key === "Escape" && onCancelRename()} />
              <Button size="sm" type="submit" isIconOnly variant="flat" aria-label="Save">
                <FaCheck size={8} />
              </Button>
            </form>
          ) : (
            <>
              <span className="text-xs font-semibold text-default-600 uppercase tracking-wider flex-1 truncate">{group.sectionName}</span>
              <span className="text-[11px] text-default-400 tabular-nums">{p.total ? `${p.done}/${p.total}` : ""}</span>
              {!isUngrouped && (
                <Dropdown placement="bottom-end">
                  <DropdownTrigger>
                    <Button size="sm" isIconOnly variant="light" className="min-w-6 w-6 h-6" aria-label="Section actions">
                      <FaEllipsisH size={10} />
                    </Button>
                  </DropdownTrigger>
                  <DropdownMenu aria-label="Section actions" onAction={(k) => (k === "rename" ? onStartRename() : onDelete())}>
                    <DropdownItem key="rename">Rename section</DropdownItem>
                    <DropdownItem key="delete" className="text-danger" color="danger" description="Its items stay, under General">
                      Remove section
                    </DropdownItem>
                  </DropdownMenu>
                </Dropdown>
              )}
            </>
          )}
        </div>
      )}
      <div className={single ? "" : "overflow-y-auto min-h-[2rem]"}>
        <SortableContext items={group.items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          {group.items.map((i) => (
            <SortableItem key={i.id} {...item(i)} />
          ))}
        </SortableContext>
      </div>
      <AddItemForm placeholder={isUngrouped ? "Add item…" : `Add to ${group.sectionName}…`} value={addText} onChange={onAddTextChange} onAdd={onAdd} />
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────

export function ChecklistPanel({ entityType, entityId, archiveFilter = "ALL", onArchiveChange, openId, bare, actions = true }: ChecklistPanelProps) {
  const isTemplates = entityType === "TEMPLATE";
  const [loading, setLoading] = useState(true);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [itemsByChecklist, setItemsByChecklist] = useState<Record<string, ChecklistItem[]>>({});
  // Section ordering: checklistId -> ordered section names (incl. empty new ones).
  const [sectionOrders, setSectionOrders] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());

  const [showNewChecklist, setShowNewChecklist] = useState(false);
  const [newChecklistName, setNewChecklistName] = useState("");
  // Per-section new item input: key = `${checklistId}:${sectionId}`
  const [newItemText, setNewItemText] = useState<Record<string, string>>({});
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null);
  const [editingChecklistName, setEditingChecklistName] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemText, setEditingItemText] = useState("");
  const [editingSectionKey, setEditingSectionKey] = useState<string | null>(null); // `checklistId:sectionId`
  const [editingSectionText, setEditingSectionText] = useState("");
  const [addingSectionFor, setAddingSectionFor] = useState<string | null>(null);
  const [newSectionName, setNewSectionName] = useState("");
  const [templates, setTemplates] = useState<Checklist[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  // Move checklist to another entity
  const [movingChecklistId, setMovingChecklistId] = useState<string | null>(null);
  const [moveEntityType, setMoveEntityType] = useState<string>("TRIP");
  const [moveEntityId, setMoveEntityId] = useState<string>("");
  const [moveEntityOptions, setMoveEntityOptions] = useState<{ id: string; label: string }[]>([]);
  const [loadingMoveEntities, setLoadingMoveEntities] = useState(false);

  const [activeItem, setActiveItem] = useState<ChecklistItem | null>(null);
  // Mouse drags after 5px; touch (iPad, phone browsers) after a short press, so
  // a swipe still scrolls the board and the page. The grips are touch-none so
  // the browser doesn't take the gesture for a scroll mid-drag.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    const s = readOpen();
    if (openId) s.add(openId);
    setOpen(s);
  }, [openId]);

  function toggleOpen(id: string, force?: boolean) {
    setOpen((prev) => {
      const next = new Set(prev);
      const want = force ?? !next.has(id);
      if (want) next.add(id);
      else next.delete(id);
      const stored = readOpen();
      if (want) stored.add(id);
      else stored.delete(id);
      writeOpen(stored);
      return next;
    });
  }

  const loadData = useCallback(async () => {
    try {
      const { data: clData } = await client.models.homeChecklist.list({ filter: { entityId: { eq: entityId } }, limit: 500 });
      const lists = (clData ?? []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
      setChecklists(lists);
      const grouped: Record<string, ChecklistItem[]> = {};
      await Promise.all(
        lists.map(async (cl) => {
          const { data: items } = await client.models.homeChecklistItem.list({ filter: { checklistId: { eq: cl.id } }, limit: 500 });
          grouped[cl.id] = (items ?? []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        }),
      );
      setItemsByChecklist(grouped);
      // Keep empty sections added this session; take the rest from the items.
      setSectionOrders((prev) => {
        const next: Record<string, string[]> = {};
        for (const cl of lists) {
          const derived = deriveSectionOrder(grouped[cl.id] ?? []);
          const extra = (prev[cl.id] ?? []).filter((s) => !derived.includes(s));
          next[cl.id] = [...derived, ...extra];
        }
        return next;
      });
    } catch (err) {
      console.error("Checklist load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [entityId]);

  const loadTemplates = useCallback(async () => {
    try {
      const { data } = await client.models.homeChecklist.list({ filter: { entityType: { eq: "TEMPLATE" as any } }, limit: 500 });
      setTemplates((data ?? []).filter((t) => t.isArchived !== true).sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      /* none yet */
    }
  }, []);

  useEffect(() => {
    loadData();
    if (!isTemplates) loadTemplates();
  }, [loadData, loadTemplates, isTemplates]);

  // Scroll the list asked for into view once it's there.
  useEffect(() => {
    if (!openId || loading) return;
    document.getElementById(`checklist-${openId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openId, loading]);

  // ── Checklist CRUD ─────────────────────────────────────────────────

  async function createChecklist() {
    const name = newChecklistName.trim();
    if (!name) return;
    setNewChecklistName("");
    setShowNewChecklist(false);
    const { data, errors } = await client.models.homeChecklist.create({ entityType: entityType as any, entityId, name, sortOrder: checklists.length });
    if (errors?.length || !data) return addToast({ title: "Couldn't create the checklist", description: errors?.[0]?.message, color: "danger" });
    toggleOpen(data.id, true);
    await loadData();
  }

  async function renameChecklist(id: string) {
    const name = editingChecklistName.trim();
    setEditingChecklistId(null);
    if (!name) return;
    await client.models.homeChecklist.update({ id, name });
    await loadData();
  }

  async function deleteChecklist(cl: Checklist) {
    const items = itemsByChecklist[cl.id] ?? [];
    if (!confirm(`Delete "${cl.name}"${items.length ? ` and its ${items.length} items` : ""}?`)) return;
    for (const item of items) await client.models.homeChecklistItem.delete({ id: item.id });
    await client.models.homeChecklist.delete({ id: cl.id });
    await loadData();
  }

  async function toggleArchiveChecklist(cl: Checklist) {
    await client.models.homeChecklist.update({ id: cl.id, ...archivePatch(cl.isArchived !== true) });
    await loadData();
    onArchiveChange?.();
  }

  async function toggleAutoAttachTrips(cl: Checklist) {
    const next = !(cl.autoAttachTrips === true);
    await client.models.homeChecklist.update({ id: cl.id, autoAttachTrips: next });
    addToast({ title: next ? AUTO_ATTACH_LABEL : "No longer added to trips", description: next ? AUTO_ATTACH_HINT : `Trips that already have "${cl.name}" keep their copy` });
    await loadData();
  }

  async function copyHere(source: Checklist, target: { entityType: EntityType; entityId: string }, toastTitle: string) {
    try {
      const copy = await copyChecklist(client, source, { ...target, sortOrder: checklists.length });
      addToast({ title: toastTitle, description: `"${copy.name}" added` });
      if (target.entityId === entityId) toggleOpen(copy.id, true);
      await loadData();
    } catch (e) {
      addToast({ title: "Couldn't copy it", description: e instanceof Error ? e.message : String(e), color: "danger" });
    }
  }

  // ── Move checklist to entity ────────────────────────────────────────

  const MOVE_TYPE_LABELS: Record<string, string> = { TRIP: "Trip", EVENT: "Event", TASK: "Task", DOCUMENT: "Document" };
  const MOVE_TYPES = ["TRIP", "EVENT", "TASK", "DOCUMENT"];

  async function loadMoveEntities(type: string) {
    setLoadingMoveEntities(true);
    setMoveEntityOptions([]);
    setMoveEntityId("");
    const modelMap: Record<string, { model: string; field: string }> = {
      TRIP: { model: "homeTrip", field: "name" },
      EVENT: { model: "homeCalendarEvent", field: "title" },
      TASK: { model: "homeTask", field: "title" },
      DOCUMENT: { model: "homeDocument", field: "title" },
    };
    const cfg = modelMap[type];
    if (cfg) {
      try {
        const { data } = await (client.models as any)[cfg.model].list({ limit: 500 });
        setMoveEntityOptions(((data ?? []) as any[]).map((d: any) => ({ id: d.id, label: d[cfg.field] ?? d.id })).sort((a: any, b: any) => a.label.localeCompare(b.label)));
      } catch {
        /* ignore */
      }
    }
    setLoadingMoveEntities(false);
  }

  async function moveChecklist(clId: string) {
    if (!moveEntityId || !moveEntityType) return;
    try {
      await client.models.homeChecklist.update({ id: clId, entityType: moveEntityType as any, entityId: moveEntityId });
      setMovingChecklistId(null);
      addToast({ title: "Checklist moved" });
      await loadData();
    } catch (err) {
      console.error("Move failed:", err);
      addToast({ title: "Failed to move checklist", color: "danger" });
    }
  }

  // ── Item CRUD ──────────────────────────────────────────────────────

  async function addItem(checklistId: string, section: string | null) {
    const key = `${checklistId}:${section ?? UNGROUPED}`;
    const text = (newItemText[key] ?? "").trim();
    if (!text) return;
    setNewItemText((prev) => ({ ...prev, [key]: "" }));
    const existing = itemsByChecklist[checklistId] ?? [];
    const sameSection = existing.filter((i) => (i.section || null) === section);
    const sortOrder = sameSection.length > 0 ? Math.max(...sameSection.map((i) => i.sortOrder ?? 0)) + 1 : existing.length;
    const payload: Record<string, any> = { checklistId, text, isDone: false, sortOrder };
    if (section) payload.section = section;
    const { errors } = await (client.models.homeChecklistItem as any).create(payload);
    if (errors?.length) return addToast({ title: "Failed to add item", description: errors[0]?.message ?? "Unknown error", color: "danger" });
    await loadData();
  }

  async function toggleItem(item: ChecklistItem) {
    const nowDone = !item.isDone;
    const doneAt = nowDone ? new Date().toISOString() : null;
    setItemsByChecklist((prev) => ({ ...prev, [item.checklistId]: (prev[item.checklistId] ?? []).map((i) => (i.id === item.id ? { ...i, isDone: nowDone, doneAt } : i)) }));
    await client.models.homeChecklistItem.update({ id: item.id, isDone: nowDone, doneAt });
  }

  async function renameItem(id: string) {
    const text = editingItemText.trim();
    setEditingItemId(null);
    if (!text) return;
    await client.models.homeChecklistItem.update({ id, text });
    await loadData();
  }

  async function deleteItem(id: string) {
    await client.models.homeChecklistItem.delete({ id });
    await loadData();
  }

  // ── Sections (implicit: item.section) ──────────────────────────────

  function createSection(checklistId: string) {
    const name = newSectionName.trim();
    setNewSectionName("");
    setAddingSectionFor(null);
    if (!name) return;
    // Shows as an empty column until an item is added or dragged into it.
    setSectionOrders((prev) => ({ ...prev, [checklistId]: [...(prev[checklistId] ?? []).filter((s) => s !== name), name] }));
  }

  async function renameSection(checklistId: string, oldName: string) {
    const newName = editingSectionText.trim();
    setEditingSectionKey(null);
    if (!newName || newName === oldName) return;
    const sectionItems = (itemsByChecklist[checklistId] ?? []).filter((i) => i.section === oldName);
    setItemsByChecklist((prev) => ({ ...prev, [checklistId]: (prev[checklistId] ?? []).map((i) => (i.section === oldName ? { ...i, section: newName } : i)) }));
    setSectionOrders((prev) => ({ ...prev, [checklistId]: (prev[checklistId] ?? []).map((s) => (s === oldName ? newName : s)) }));
    for (const item of sectionItems) await (client.models.homeChecklistItem as any).update({ id: item.id, section: newName });
  }

  async function deleteSection(checklistId: string, sectionName: string) {
    const sectionItems = (itemsByChecklist[checklistId] ?? []).filter((i) => i.section === sectionName);
    setItemsByChecklist((prev) => ({ ...prev, [checklistId]: (prev[checklistId] ?? []).map((i) => (i.section === sectionName ? { ...i, section: null } : i)) }));
    setSectionOrders((prev) => ({ ...prev, [checklistId]: (prev[checklistId] ?? []).filter((s) => s !== sectionName) }));
    for (const item of sectionItems) await (client.models.homeChecklistItem as any).update({ id: item.id, section: null });
  }

  // ── Drag and drop ──────────────────────────────────────────────────

  function findItemById(id: string): { item: ChecklistItem; checklistId: string } | null {
    for (const [clId, items] of Object.entries(itemsByChecklist)) {
      const item = items.find((i) => i.id === id);
      if (item) return { item, checklistId: clId };
    }
    return null;
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    setActiveItem(id.startsWith("section:") ? null : (findItemById(id)?.item ?? null));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveItem(null);
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;
    if (activeId.startsWith("section:")) {
      if (overId.startsWith("section:")) handleSectionReorder(activeId, overId);
      return;
    }
    handleItemReorder(activeId, overId);
  }

  function handleSectionReorder(activeId: string, overId: string) {
    // Format: section:checklistId:sectionName
    const a = activeId.split(":");
    const o = overId.split(":");
    const checklistId = a[1];
    const from = a.slice(2).join(":");
    const to = o.slice(2).join(":");
    if (from === UNGROUPED || to === UNGROUPED || a[1] !== o[1]) return;
    setSectionOrders((prev) => {
      const order = [...(prev[checklistId] ?? [])];
      const fromIdx = order.indexOf(from);
      const toIdx = order.indexOf(to);
      if (fromIdx < 0 || toIdx < 0) return prev;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, from);
      void persistSectionReorder(checklistId, order);
      return { ...prev, [checklistId]: order };
    });
  }

  async function persistSectionReorder(checklistId: string, order: string[]) {
    const items = itemsByChecklist[checklistId] ?? [];
    let n = 0;
    const bySort = (x: ChecklistItem, y: ChecklistItem) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0);
    for (const sec of [null, ...order]) {
      for (const item of items.filter((i) => (i.section || null) === sec).sort(bySort)) {
        if (item.sortOrder !== n) await (client.models.homeChecklistItem as any).update({ id: item.id, sortOrder: n });
        n++;
      }
    }
  }

  function handleItemReorder(activeId: string, overId: string) {
    const activeData = findItemById(activeId);
    if (!activeData) return;
    const checklistId = activeData.checklistId;
    const items = [...(itemsByChecklist[checklistId] ?? [])];
    const secOf = (i: ChecklistItem) => i.section || null;

    let targetSection: string | null;
    let targetIndex: number;
    if (overId.startsWith("section:")) {
      // Dropped on a column (an empty one, or its header): to its end.
      const parts = overId.split(":");
      if (parts[1] !== checklistId) return;
      const sec = parts.slice(2).join(":");
      targetSection = sec === UNGROUPED ? null : sec;
      targetIndex = items.filter((i) => secOf(i) === targetSection).length;
    } else {
      const overItem = items.find((i) => i.id === overId);
      if (!overItem) return; // another checklist
      targetSection = secOf(overItem);
      targetIndex = items.filter((i) => secOf(i) === targetSection).findIndex((i) => i.id === overId);
    }

    const moving = items.find((i) => i.id === activeId)!;
    const oldSection = secOf(moving);
    const rest = items.filter((i) => i.id !== activeId);
    const targetItems = rest.filter((i) => secOf(i) === targetSection);
    targetItems.splice(Math.min(targetIndex, targetItems.length), 0, { ...moving, section: targetSection });

    const order = sectionOrders[checklistId] ?? [];
    const allSections: (string | null)[] = [null, ...order];
    for (const i of rest) if (secOf(i) && !allSections.includes(secOf(i))) allSections.push(secOf(i));
    if (targetSection && !allSections.includes(targetSection)) allSections.push(targetSection);

    let n = 0;
    const newItems: ChecklistItem[] = [];
    const updates: { id: string; sortOrder: number; section?: string | null }[] = [];
    for (const sec of allSections) {
      for (const item of sec === targetSection ? targetItems : rest.filter((i) => secOf(i) === sec)) {
        const sortOrder = n++;
        newItems.push({ ...item, sortOrder });
        const moved = item.id === activeId && oldSection !== targetSection;
        if (item.sortOrder !== sortOrder || moved) updates.push({ id: item.id, sortOrder, ...(moved ? { section: targetSection } : {}) });
      }
    }
    setItemsByChecklist((prev) => ({ ...prev, [checklistId]: newItems }));
    void (async () => {
      for (const u of updates) await (client.models.homeChecklistItem as any).update(u);
    })();
  }

  // ── Render ─────────────────────────────────────────────────────────

  const visibleChecklists = useMemo(() => checklists.filter((cl) => matchesArchiveFilter(cl, archiveFilter)), [checklists, archiveFilter]);

  if (loading) {
    return (
      <div className="py-4 flex justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  const fromTemplate = !isTemplates && (
    <Popover isOpen={templatePickerOpen} onOpenChange={setTemplatePickerOpen} placement="bottom-end">
      <PopoverTrigger>
        <Button size="sm" variant="flat" startContent={<FaFileImport size={10} />}>
          From template
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-2 w-64">
        <div className="w-full flex flex-col gap-0.5">
          {templates.length === 0 && <span className="text-xs text-default-500 px-2 py-1">No templates yet.</span>}
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              className="text-left text-sm px-2 py-1.5 rounded-md hover:bg-default-100"
              onClick={async () => {
                setTemplatePickerOpen(false);
                await copyHere(t, { entityType, entityId }, "Added from template");
              }}
            >
              {t.name}
              {t.autoAttachTrips === true && <span className="block text-[11px] text-default-400">{AUTO_ATTACH_LABEL.toLowerCase()}</span>}
            </button>
          ))}
          <NextLink href={templatesHref()} className="text-xs text-primary px-2 py-1.5 border-t border-default-100 mt-1 hover:underline">
            Edit templates ›
          </NextLink>
        </div>
      </PopoverContent>
    </Popover>
  );

  return (
    <div className={bare ? "" : "border-t border-default-200 pt-4"}>
      {(!bare || actions) && (
        <div className={`flex items-center gap-2 mb-2 ${bare ? "justify-end" : "justify-between"}`}>
          {!bare && <p className="text-sm font-medium">Checklists</p>}
          {actions && (
            <div className="flex gap-1">
              {fromTemplate}
              <Button size="sm" variant="flat" startContent={<FaPlus size={10} />} onPress={() => setShowNewChecklist(true)}>
                {isTemplates ? "New template" : "Add checklist"}
              </Button>
            </div>
          )}
        </div>
      )}

      {showNewChecklist && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createChecklist();
          }}
          className="flex gap-2 mb-3"
        >
          <Input size="sm" placeholder={isTemplates ? "Template name (Pre-trip, Packing…)" : "Checklist name…"} value={newChecklistName} onValueChange={setNewChecklistName} autoFocus />
          <Button size="sm" type="submit" color="primary" variant="flat" isIconOnly aria-label="Create">
            <FaCheck size={10} />
          </Button>
          <Button
            size="sm"
            variant="light"
            isIconOnly
            aria-label="Cancel"
            onPress={() => {
              setShowNewChecklist(false);
              setNewChecklistName("");
            }}
          >
            <FaTimes size={10} />
          </Button>
        </form>
      )}

      {checklists.length === 0 && !showNewChecklist && (
        <p className="text-xs text-default-400 py-2">{isTemplates ? "No templates yet." : `No checklists yet. Add one${templates.length > 0 ? " or start from a template" : ""}.`}</p>
      )}
      {checklists.length > 0 && visibleChecklists.length === 0 && !showNewChecklist && (
        <p className="text-xs text-default-400 py-2">No {archiveFilter === "ARCHIVED" ? "archived" : "active"} checklists here.</p>
      )}

      <div className="flex flex-col gap-2">
        {visibleChecklists.map((cl) => {
          const items = itemsByChecklist[cl.id] ?? [];
          const order = sectionOrders[cl.id] ?? [];
          const groups = buildSectionGroups(items, order);
          // Empty sections added this session get their column too.
          const have = new Set(groups.map((g) => g.sectionId));
          for (const [idx, name] of order.entries()) if (!have.has(name)) groups.push({ sectionId: name, sectionName: name, items: [], sortOrder: idx });
          groups.sort((a, b) => a.sortOrder - b.sortOrder);
          const hasSections = groups.some((g) => g.sectionId !== UNGROUPED);
          // The General column: when something is in it, when there's nothing
          // else, and while an item of this list is being dragged (so it can be
          // dropped back out of a section).
          const draggingHere = !!activeItem && activeItem.checklistId === cl.id;
          const columns = groups
            .filter((g) => g.sectionId !== UNGROUPED || g.items.length > 0 || !hasSections || draggingHere)
            .map((g) => (g.sectionId === UNGROUPED ? { ...g, sectionName: "General" } : g));
          if (!columns.length || (draggingHere && !columns.some((g) => g.sectionId === UNGROUPED))) {
            columns.unshift({ sectionId: UNGROUPED, sectionName: "General", items: [], sortOrder: -1 });
          }
          const p = progress(items);
          const isOpen = open.has(cl.id);
          const archived = cl.isArchived === true;

          const itemProps = (i: ChecklistItem): ItemRowProps => ({
            item: i,
            isEditing: editingItemId === i.id,
            editingText: editingItemText,
            onToggle: () => void toggleItem(i),
            onStartEdit: () => {
              setEditingItemId(i.id);
              setEditingItemText(i.text);
            },
            onEditTextChange: setEditingItemText,
            onSaveEdit: () => void renameItem(i.id),
            onCancelEdit: () => setEditingItemId(null),
            onDelete: () => void deleteItem(i.id),
          });

          const menu = (
            <Dropdown placement="bottom-end">
              <DropdownTrigger>
                <Button size="sm" isIconOnly variant="light" aria-label="Checklist actions">
                  <FaEllipsisH size={12} />
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label="Checklist actions"
                onAction={(k) => {
                  if (k === "rename") {
                    setEditingChecklistId(cl.id);
                    setEditingChecklistName(cl.name);
                  } else if (k === "duplicate") void copyHere(cl, { entityType: (cl.entityType ?? entityType) as EntityType, entityId }, "Duplicated");
                  else if (k === "move") {
                    setMovingChecklistId(cl.id);
                    setMoveEntityType("TRIP");
                    void loadMoveEntities("TRIP");
                    toggleOpen(cl.id, true);
                  } else if (k === "save-template") void copyHere(cl, { entityType: "TEMPLATE", entityId: TEMPLATE_ENTITY_ID }, "Saved as a template").then(loadTemplates);
                  else if (k === "auto") void toggleAutoAttachTrips(cl);
                  else if (k === "archive") void toggleArchiveChecklist(cl);
                  else if (k === "delete") void deleteChecklist(cl);
                }}
              >
                <DropdownSection showDivider>
                  <DropdownItem key="rename">Rename</DropdownItem>
                  <DropdownItem key="duplicate" description="A fresh, unchecked copy here">
                    Duplicate
                  </DropdownItem>
                  {!isTemplates ? (
                    <DropdownItem key="move" description="Attach it to another trip, event…">
                      Move to…
                    </DropdownItem>
                  ) : null}
                  {!isTemplates ? (
                    <DropdownItem key="save-template" description="Reuse it on other trips">
                      Save as template
                    </DropdownItem>
                  ) : null}
                  {!isTemplates && cl.sourceTemplateId ? (
                    <DropdownItem key="edit-template" href={templatesHref(cl.sourceTemplateId)} as={NextLink} description="Changes apply to future copies">
                      Edit its template
                    </DropdownItem>
                  ) : null}
                  {isTemplates ? (
                    <DropdownItem key="auto" description={AUTO_ATTACH_HINT}>
                      {cl.autoAttachTrips === true ? "Stop adding to every trip" : "Add to every trip"}
                    </DropdownItem>
                  ) : null}
                </DropdownSection>
                <DropdownSection>
                  <DropdownItem key="archive">{archived ? "Unarchive" : "Archive"}</DropdownItem>
                  <DropdownItem key="delete" className="text-danger" color="danger">
                    Delete
                  </DropdownItem>
                </DropdownSection>
              </DropdownMenu>
            </Dropdown>
          );

          return (
            <div key={cl.id} id={`checklist-${cl.id}`} className={`border border-default-200 rounded-lg bg-content1 ${archived ? "opacity-70" : ""}`}>
              {/* Header: click to open / close */}
              <div className="flex items-center gap-2 px-3 py-2">
                {editingChecklistId === cl.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void renameChecklist(cl.id);
                    }}
                    className="flex gap-1 flex-1"
                  >
                    <Input size="sm" value={editingChecklistName} onValueChange={setEditingChecklistName} autoFocus onKeyDown={(e) => e.key === "Escape" && setEditingChecklistId(null)} />
                    <Button size="sm" type="submit" isIconOnly variant="flat" aria-label="Save">
                      <FaCheck size={10} />
                    </Button>
                  </form>
                ) : (
                  <button type="button" className="flex-1 min-w-0 flex items-center gap-2 text-left" onClick={() => toggleOpen(cl.id)} aria-expanded={isOpen}>
                    {isOpen ? <FaChevronDown size={10} className="text-default-400 shrink-0" /> : <FaChevronRight size={10} className="text-default-400 shrink-0" />}
                    <span className="text-sm font-medium truncate">{cl.name}</span>
                    {archived && (
                      <Chip size="sm" variant="flat" className="h-5">
                        Archived
                      </Chip>
                    )}
                    {isTemplates && cl.autoAttachTrips === true && (
                      <Chip size="sm" variant="flat" color="primary" className="h-5" title={AUTO_ATTACH_HINT}>
                        {AUTO_ATTACH_LABEL}
                      </Chip>
                    )}
                  </button>
                )}
                {p.total > 0 && (
                  <span className="flex items-center gap-2 shrink-0" title={`${p.done} of ${p.total} done`}>
                    <span className="hidden sm:block w-20 h-1.5 rounded-full bg-default-200 overflow-hidden">
                      <span className={`block h-full ${p.done === p.total ? "bg-success" : "bg-primary"}`} style={{ width: `${p.pct}%` }} />
                    </span>
                    <span className="text-xs text-default-500 tabular-nums">
                      {p.done}/{p.total}
                    </span>
                  </span>
                )}
                {menu}
              </div>

              {isOpen && (
                <div className="px-3 pb-3">
                  {movingChecklistId === cl.id && (
                    <div className="mb-3 border border-default-200 rounded-md p-3 bg-default-50 flex flex-wrap gap-2 items-center">
                      <span className="text-xs font-medium">Move to</span>
                      <select
                        className="text-sm border border-default-300 rounded px-2 py-1 bg-white dark:bg-default-100"
                        value={moveEntityType}
                        onChange={(e) => {
                          setMoveEntityType(e.target.value);
                          void loadMoveEntities(e.target.value);
                        }}
                      >
                        {MOVE_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {MOVE_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                      <select
                        className="text-sm border border-default-300 rounded px-2 py-1 bg-white dark:bg-default-100 flex-1 min-w-[10rem]"
                        value={moveEntityId}
                        onChange={(e) => setMoveEntityId(e.target.value)}
                        disabled={loadingMoveEntities || moveEntityOptions.length === 0}
                      >
                        <option value="">{loadingMoveEntities ? "Loading…" : "Select…"}</option>
                        {moveEntityOptions.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <Button size="sm" color="primary" variant="flat" isDisabled={!moveEntityId} onPress={() => void moveChecklist(cl.id)}>
                        Move
                      </Button>
                      <Button size="sm" variant="light" onPress={() => setMovingChecklistId(null)}>
                        Cancel
                      </Button>
                    </div>
                  )}

                  <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                    <div className={hasSections ? "flex gap-3 overflow-x-auto pb-2 snap-x" : ""}>
                      <SortableContext items={columns.map((g) => `section:${cl.id}:${g.sectionId}`)} strategy={horizontalListSortingStrategy}>
                        {columns.map((group) => {
                          const key = `${cl.id}:${group.sectionId}`;
                          const section = group.sectionId === UNGROUPED ? null : group.sectionId;
                          return (
                            <SectionColumn
                              key={group.sectionId}
                              group={group}
                              checklistId={cl.id}
                              single={!hasSections}
                              renaming={editingSectionKey === key}
                              renameText={editingSectionText}
                              onStartRename={() => {
                                setEditingSectionKey(key);
                                setEditingSectionText(group.sectionName);
                              }}
                              onRenameTextChange={setEditingSectionText}
                              onSaveRename={() => void renameSection(cl.id, group.sectionId)}
                              onCancelRename={() => setEditingSectionKey(null)}
                              onDelete={() => void deleteSection(cl.id, group.sectionId)}
                              item={itemProps}
                              addText={newItemText[key] ?? ""}
                              onAddTextChange={(v) => setNewItemText((prev) => ({ ...prev, [key]: v }))}
                              onAdd={() => void addItem(cl.id, section)}
                            />
                          );
                        })}
                      </SortableContext>
                      {/* Add a section: the board's last column (a plain button on a list without sections). */}
                      <div className={hasSections ? "w-56 shrink-0 self-start" : "mt-2"}>
                        {addingSectionFor === cl.id ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              createSection(cl.id);
                            }}
                            className="flex gap-1"
                          >
                            <Input size="sm" placeholder="Section name (Carry-on…)" value={newSectionName} onValueChange={setNewSectionName} autoFocus onKeyDown={(e) => e.key === "Escape" && setAddingSectionFor(null)} />
                            <Button size="sm" type="submit" color="primary" variant="flat" isIconOnly aria-label="Add section">
                              <FaCheck size={10} />
                            </Button>
                          </form>
                        ) : (
                          <Button
                            size="sm"
                            variant={hasSections ? "bordered" : "light"}
                            className={hasSections ? "w-full border-dashed" : ""}
                            startContent={<FaPlus size={10} />}
                            onPress={() => {
                              setAddingSectionFor(cl.id);
                              setNewSectionName("");
                            }}
                          >
                            {hasSections ? "Add section" : "Group into sections"}
                          </Button>
                        )}
                      </div>
                    </div>
                    <DragOverlay>{activeItem ? <DragOverlayItem item={activeItem} /> : null}</DragOverlay>
                  </DndContext>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
