"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Checkbox } from "@heroui/checkbox";
import { Spinner, addToast } from "@heroui/react";
import {
  FaPlus, FaTrash, FaPen, FaCheck, FaTimes, FaCopy,
  FaFileImport, FaGripVertical, FaChevronDown, FaChevronRight,
} from "react-icons/fa";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Checklist = Schema["homeChecklist"]["type"];
type ChecklistItem = Schema["homeChecklistItem"]["type"];
type EntityType = "TRIP" | "EVENT" | "BILL" | "DOCUMENT" | "TASK" | "TEMPLATE" | "OTHER";

interface ChecklistPanelProps {
  entityType: EntityType;
  entityId: string;
}

// ── Constants ────────────────────────────────────────────────────────
const UNGROUPED = "__ungrouped__";

// ── Helpers ──────────────────────────────────────────────────────────

interface SectionGroup {
  sectionId: string;       // UNGROUPED or actual section name
  sectionName: string;     // display name
  items: ChecklistItem[];
  sortOrder: number;       // for ordering sections among each other
}

/**
 * Build ordered section groups from a flat list of items.
 * Sections are ordered by the minimum sortOrder among their items,
 * with ungrouped first.
 */
function buildSectionGroups(items: ChecklistItem[], sectionOrder: string[]): SectionGroup[] {
  const map = new Map<string, ChecklistItem[]>();

  for (const item of items) {
    const key = (item as any).section || UNGROUPED;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }

  // Sort items within each group
  Array.from(map.values()).forEach((groupItems) => {
    groupItems.sort((a: ChecklistItem, b: ChecklistItem) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  });

  const groups: SectionGroup[] = [];

  // Ungrouped always first
  if (map.has(UNGROUPED)) {
    groups.push({
      sectionId: UNGROUPED,
      sectionName: "Ungrouped",
      items: map.get(UNGROUPED)!,
      sortOrder: -1,
    });
    map.delete(UNGROUPED);
  }

  // Remaining sections, ordered by sectionOrder array
  const remaining = Array.from(map.keys());
  remaining.sort((a, b) => {
    const aIdx = sectionOrder.indexOf(a);
    const bIdx = sectionOrder.indexOf(b);
    const aOrder = aIdx >= 0 ? aIdx : 9999;
    const bOrder = bIdx >= 0 ? bIdx : 9999;
    return aOrder - bOrder || a.localeCompare(b);
  });

  for (const key of remaining) {
    const idx = sectionOrder.indexOf(key);
    groups.push({
      sectionId: key,
      sectionName: key,
      items: map.get(key)!,
      sortOrder: idx >= 0 ? idx : 9999,
    });
  }

  return groups;
}

/** Derive ordered section names from items (preserving sortOrder-based ordering). */
function deriveSectionOrder(items: ChecklistItem[]): string[] {
  const map = new Map<string, number>();
  for (const item of items) {
    const sec = (item as any).section;
    if (sec) {
      const existing = map.get(sec);
      const order = item.sortOrder ?? 0;
      if (existing === undefined || order < existing) {
        map.set(sec, order);
      }
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
}

// ── Sortable Item ────────────────────────────────────────────────────

interface SortableItemProps {
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

function SortableItem({
  item, isEditing, editingText,
  onToggle, onStartEdit, onEditTextChange, onSaveEdit, onCancelEdit, onDelete,
}: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, data: { type: "item", item } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 py-1 border-b border-default-100 last:border-0"
    >
      <span
        className="text-default-300 hover:text-default-500 cursor-grab flex-shrink-0"
        {...attributes}
        {...listeners}
      >
        <FaGripVertical size={10} />
      </span>
      <Checkbox size="sm" isSelected={!!item.isDone} onValueChange={onToggle} />
      {isEditing ? (
        <form onSubmit={(e) => { e.preventDefault(); onSaveEdit(); }} className="flex gap-1 flex-1">
          <Input size="sm" value={editingText} onValueChange={onEditTextChange} autoFocus />
          <Button size="sm" type="submit" isIconOnly variant="flat"><FaCheck size={8} /></Button>
          <Button size="sm" isIconOnly variant="light" onPress={onCancelEdit}><FaTimes size={8} /></Button>
        </form>
      ) : (
        <>
          <span className={`flex-1 text-sm ${item.isDone ? "line-through text-default-400" : ""}`}>
            {item.text}
          </span>
          <Button size="sm" isIconOnly variant="light" onPress={onStartEdit}>
            <FaPen size={8} />
          </Button>
          <Button size="sm" isIconOnly variant="light" color="danger" onPress={onDelete}>
            <FaTrash size={8} />
          </Button>
        </>
      )}
    </div>
  );
}

// ── Sortable Section ─────────────────────────────────────────────────

interface SortableSectionProps {
  group: SectionGroup;
  checklistId: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  // Section management
  editingSectionName: string | null;
  editingSectionText: string;
  onStartRenameSection: () => void;
  onRenameSectionTextChange: (v: string) => void;
  onSaveRenameSection: () => void;
  onCancelRenameSection: () => void;
  onDeleteSection: () => void;
  // Item operations
  editingItemId: string | null;
  editingItemText: string;
  onToggleItem: (item: ChecklistItem) => void;
  onStartEditItem: (id: string, text: string) => void;
  onEditItemTextChange: (v: string) => void;
  onSaveEditItem: (id: string) => void;
  onCancelEditItem: () => void;
  onDeleteItem: (id: string) => void;
  // Per-section add item
  addItemText: string;
  onAddItemTextChange: (v: string) => void;
  onAddItem: () => void;
}

function SortableSection({
  group, checklistId, isCollapsed, onToggleCollapse,
  editingSectionName, editingSectionText,
  onStartRenameSection, onRenameSectionTextChange, onSaveRenameSection, onCancelRenameSection,
  onDeleteSection,
  editingItemId, editingItemText,
  onToggleItem, onStartEditItem, onEditItemTextChange, onSaveEditItem, onCancelEditItem,
  onDeleteItem,
  addItemText, onAddItemTextChange, onAddItem,
}: SortableSectionProps) {
  const isUngrouped = group.sectionId === UNGROUPED;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `section:${checklistId}:${group.sectionId}`,
    data: { type: "section", sectionId: group.sectionId, checklistId },
    disabled: isUngrouped,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const isRenaming = editingSectionName === group.sectionId;

  return (
    <div ref={setNodeRef} style={style} className="mb-2">
      {/* Section header */}
      <div className={`flex items-center gap-1 py-1 px-2 rounded ${isUngrouped ? "" : "bg-default-100"}`}>
        {!isUngrouped && (
          <span
            className="text-default-300 hover:text-default-500 cursor-grab flex-shrink-0"
            {...attributes}
            {...listeners}
          >
            <FaGripVertical size={10} />
          </span>
        )}
        <button
          type="button"
          className="flex-shrink-0 text-default-400 hover:text-default-600"
          onClick={onToggleCollapse}
        >
          {isCollapsed ? <FaChevronRight size={10} /> : <FaChevronDown size={10} />}
        </button>
        {isRenaming ? (
          <form onSubmit={(e) => { e.preventDefault(); onSaveRenameSection(); }} className="flex gap-1 flex-1">
            <Input size="sm" value={editingSectionText} onValueChange={onRenameSectionTextChange} autoFocus />
            <Button size="sm" type="submit" isIconOnly variant="flat"><FaCheck size={8} /></Button>
            <Button size="sm" isIconOnly variant="light" onPress={onCancelRenameSection}><FaTimes size={8} /></Button>
          </form>
        ) : (
          <>
            <span className="text-xs font-semibold text-default-500 uppercase tracking-wider flex-1">
              {group.sectionName}
            </span>
            {!isUngrouped && (
              <div className="flex gap-0.5">
                <Button size="sm" isIconOnly variant="light" onPress={onStartRenameSection}>
                  <FaPen size={8} />
                </Button>
                <Button size="sm" isIconOnly variant="light" color="danger" onPress={onDeleteSection}>
                  <FaTrash size={8} />
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Items */}
      {!isCollapsed && (
        <div className="pl-1">
          <div className="space-y-0">
            {group.items.map((item) => (
              <SortableItem
                key={item.id}
                item={item}
                isEditing={editingItemId === item.id}
                editingText={editingItemText}
                onToggle={() => onToggleItem(item)}
                onStartEdit={() => onStartEditItem(item.id, item.text)}
                onEditTextChange={onEditItemTextChange}
                onSaveEdit={() => onSaveEditItem(item.id)}
                onCancelEdit={onCancelEditItem}
                onDelete={() => onDeleteItem(item.id)}
              />
            ))}
          </div>

          {/* Per-section add item */}
          <form
            onSubmit={(e) => { e.preventDefault(); onAddItem(); }}
            className="flex gap-2 mt-1"
          >
            <Input
              size="sm"
              placeholder={`Add item${isUngrouped ? "" : ` to ${group.sectionName}`}...`}
              value={addItemText}
              onValueChange={onAddItemTextChange}
              className="flex-1"
            />
            <Button size="sm" type="submit" isIconOnly color="primary" variant="flat">
              <FaPlus size={10} />
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

// ── Drag overlay for items ───────────────────────────────────────────

function DragOverlayItem({ item }: { item: ChecklistItem }) {
  return (
    <div className="flex items-center gap-2 py-1 px-2 bg-white dark:bg-default-50 rounded shadow-md border border-default-200">
      <FaGripVertical size={10} className="text-default-400" />
      <Checkbox size="sm" isSelected={!!item.isDone} isReadOnly />
      <span className={`flex-1 text-sm ${item.isDone ? "line-through text-default-400" : ""}`}>
        {item.text}
      </span>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────

export function ChecklistPanel({ entityType, entityId }: ChecklistPanelProps) {
  const [loading, setLoading] = useState(true);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [itemsByChecklist, setItemsByChecklist] = useState<Record<string, ChecklistItem[]>>({});

  // Section ordering: maps checklistId -> ordered section names
  const [sectionOrders, setSectionOrders] = useState<Record<string, string[]>>({});

  // New checklist
  const [showNewChecklist, setShowNewChecklist] = useState(false);
  const [newChecklistName, setNewChecklistName] = useState("");

  // Per-section new item input: key = `${checklistId}:${sectionId}`
  const [newItemText, setNewItemText] = useState<Record<string, string>>({});

  // Inline editing
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null);
  const [editingChecklistName, setEditingChecklistName] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemText, setEditingItemText] = useState("");

  // Section editing
  const [editingSectionKey, setEditingSectionKey] = useState<string | null>(null); // `checklistId:sectionId`
  const [editingSectionText, setEditingSectionText] = useState("");

  // New section input: which checklist is showing the "add section" input
  const [addingSectionForChecklist, setAddingSectionForChecklist] = useState<string | null>(null);
  const [newSectionName, setNewSectionName] = useState("");

  // Collapsed sections: set of `${checklistId}:${sectionId}`
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  // Templates
  const [templates, setTemplates] = useState<Checklist[]>([]);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  // DnD
  const [activeItem, setActiveItem] = useState<ChecklistItem | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const loadData = useCallback(async () => {
    try {
      const { data: clData } = await client.models.homeChecklist.list({
        filter: { entityId: { eq: entityId } },
        limit: 500,
      });
      const lists = (clData ?? []).sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
      );
      setChecklists(lists);

      const grouped: Record<string, ChecklistItem[]> = {};
      const orders: Record<string, string[]> = {};
      await Promise.all(
        lists.map(async (cl) => {
          const { data: items } = await client.models.homeChecklistItem.list({
            filter: { checklistId: { eq: cl.id } },
            limit: 500,
          });
          const sorted = (items ?? []).sort(
            (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
          );
          grouped[cl.id] = sorted;
          orders[cl.id] = deriveSectionOrder(sorted);
        })
      );
      setItemsByChecklist(grouped);
      setSectionOrders(orders);
    } catch (err) {
      console.error("Checklist load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [entityId]);

  const loadTemplates = useCallback(async () => {
    try {
      const { data } = await client.models.homeChecklist.list({
        filter: { entityType: { eq: "TEMPLATE" as any } },
        limit: 500,
      });
      setTemplates((data ?? []).sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      // Table may not exist yet
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

    const { data: sourceItems } = await client.models.homeChecklistItem.list({
      filter: { checklistId: { eq: source.id } },
      limit: 500,
    });
    for (const item of (sourceItems ?? []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
      const dupPayload: Record<string, any> = {
        checklistId: newCl.id,
        text: item.text,
        isDone: false,
        sortOrder: item.sortOrder ?? 0,
      };
      const sec = (item as any).section;
      if (sec) dupPayload.section = sec;
      await (client.models.homeChecklistItem as any).create(dupPayload);
    }
    addToast({ title: "Checklist duplicated", description: `"${source.name}" added` });
    await loadData();
  }

  async function saveAsTemplate(source: Checklist) {
    await duplicateChecklist(source, "TEMPLATE" as any, "templates");
    await loadTemplates();
    addToast({ title: "Template saved", description: `"${source.name}" is now a reusable template` });
  }

  // ── Item CRUD ──────────────────────────────────────────────────────

  async function addItem(checklistId: string, section: string | null) {
    const key = `${checklistId}:${section ?? UNGROUPED}`;
    const text = (newItemText[key] ?? "").trim();
    if (!text) return;
    setNewItemText((prev) => ({ ...prev, [key]: "" }));
    const existing = itemsByChecklist[checklistId] ?? [];

    // Compute sortOrder: place after last item in same section
    const sameSection = existing.filter((i) => ((i as any).section || null) === section);
    const sortOrder = sameSection.length > 0
      ? Math.max(...sameSection.map((i) => i.sortOrder ?? 0)) + 1
      : existing.length;

    try {
      const itemPayload: Record<string, any> = {
        checklistId,
        text,
        isDone: false,
        sortOrder,
      };
      if (section) itemPayload.section = section;
      const { errors } = await (client.models.homeChecklistItem as any).create(itemPayload);
      if (errors?.length) {
        console.error("Add item failed:", errors);
        addToast({ title: "Failed to add item", description: errors[0]?.message ?? "Unknown error", color: "danger" });
        return;
      }
      await loadData();
    } catch (err) {
      console.error("Add item error:", err);
      addToast({ title: "Failed to add item", description: err instanceof Error ? err.message : String(err), color: "danger" });
    }
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

  // ── Section management ─────────────────────────────────────────────

  async function createSection(checklistId: string) {
    const name = newSectionName.trim();
    if (!name) return;
    setNewSectionName("");
    setAddingSectionForChecklist(null);

    // Add to local section order
    setSectionOrders((prev) => ({
      ...prev,
      [checklistId]: [...(prev[checklistId] ?? []), name],
    }));

    // No backend change needed — sections are implicit via item.section.
    // The section will appear empty until an item is added/moved to it.
    // But we need at least one placeholder item? No — we'll handle empty sections
    // via the sectionOrders state. The UI will render the section header even if empty.
  }

  async function renameSection(checklistId: string, oldName: string) {
    const newName = editingSectionText.trim();
    if (!newName || newName === oldName) {
      setEditingSectionKey(null);
      return;
    }
    setEditingSectionKey(null);

    const items = itemsByChecklist[checklistId] ?? [];
    const sectionItems = items.filter((i) => (i as any).section === oldName);

    // Optimistic update
    setItemsByChecklist((prev) => ({
      ...prev,
      [checklistId]: (prev[checklistId] ?? []).map((i) =>
        (i as any).section === oldName ? { ...i, section: newName } as any : i
      ),
    }));
    setSectionOrders((prev) => ({
      ...prev,
      [checklistId]: (prev[checklistId] ?? []).map((s) => s === oldName ? newName : s),
    }));

    // Persist
    for (const item of sectionItems) {
      await (client.models.homeChecklistItem as any).update({
        id: item.id,
        section: newName,
      });
    }
  }

  async function deleteSection(checklistId: string, sectionName: string) {
    const items = itemsByChecklist[checklistId] ?? [];
    const sectionItems = items.filter((i) => (i as any).section === sectionName);

    // Move items to ungrouped (null section)
    setItemsByChecklist((prev) => ({
      ...prev,
      [checklistId]: (prev[checklistId] ?? []).map((i) =>
        (i as any).section === sectionName ? { ...i, section: null } as any : i
      ),
    }));
    setSectionOrders((prev) => ({
      ...prev,
      [checklistId]: (prev[checklistId] ?? []).filter((s) => s !== sectionName),
    }));

    // Persist
    for (const item of sectionItems) {
      await (client.models.homeChecklistItem as any).update({
        id: item.id,
        section: null,
      });
    }
  }

  // ── Drag and Drop ──────────────────────────────────────────────────

  function findItemById(id: string): { item: ChecklistItem; checklistId: string } | null {
    for (const [clId, items] of Object.entries(itemsByChecklist)) {
      const item = items.find((i) => i.id === id);
      if (item) return { item, checklistId: clId };
    }
    return null;
  }

  function handleDragStart(event: DragStartEvent) {
    const { active } = event;
    const activeId = String(active.id);

    if (activeId.startsWith("section:")) {
      // Section drag — no overlay needed
      setActiveItem(null);
    } else {
      const found = findItemById(activeId);
      setActiveItem(found?.item ?? null);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveItem(null);

    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    if (activeId === overId) return;

    // Section reordering
    if (activeId.startsWith("section:") && overId.startsWith("section:")) {
      handleSectionReorder(activeId, overId);
      return;
    }

    // Item reordering
    if (!activeId.startsWith("section:")) {
      handleItemReorder(activeId, overId);
    }
  }

  function handleSectionReorder(activeId: string, overId: string) {
    // Format: section:checklistId:sectionName
    const activeParts = activeId.split(":");
    const overParts = overId.split(":");
    const checklistId = activeParts[1];
    const activeSectionId = activeParts.slice(2).join(":");
    const overSectionId = overParts.slice(2).join(":");

    if (activeSectionId === UNGROUPED || overSectionId === UNGROUPED) return;
    if (activeParts[1] !== overParts[1]) return; // different checklists

    setSectionOrders((prev) => {
      const order = [...(prev[checklistId] ?? [])];
      const fromIdx = order.indexOf(activeSectionId);
      const toIdx = order.indexOf(overSectionId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, activeSectionId);

      // Persist new sortOrder for items in reordered sections
      persistSectionReorder(checklistId, order);

      return { ...prev, [checklistId]: order };
    });
  }

  async function persistSectionReorder(checklistId: string, order: string[]) {
    const items = itemsByChecklist[checklistId] ?? [];
    // Assign sortOrder so that sections appear in order:
    // ungrouped items keep their relative order at the front,
    // then each section's items in sequence
    let sortCounter = 0;

    // Ungrouped items first
    const ungrouped = items.filter((i) => !(i as any).section).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (const item of ungrouped) {
      if (item.sortOrder !== sortCounter) {
        await (client.models.homeChecklistItem as any).update({ id: item.id, sortOrder: sortCounter });
      }
      sortCounter++;
    }

    // Then each section in order
    for (const sec of order) {
      const secItems = items.filter((i) => (i as any).section === sec).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      for (const item of secItems) {
        if (item.sortOrder !== sortCounter) {
          await (client.models.homeChecklistItem as any).update({ id: item.id, sortOrder: sortCounter });
        }
        sortCounter++;
      }
    }
  }

  function handleItemReorder(activeId: string, overId: string) {
    const activeData = findItemById(activeId);
    if (!activeData) return;

    const checklistId = activeData.checklistId;
    const items = [...(itemsByChecklist[checklistId] ?? [])];

    // Determine target section
    let targetSection: string | null = null;
    let targetIndex = -1;

    if (overId.startsWith("section:")) {
      // Dropped on a section header — add to end of that section
      const overParts = overId.split(":");
      const overSectionId = overParts.slice(2).join(":");
      targetSection = overSectionId === UNGROUPED ? null : overSectionId;
      const sameSection = items.filter((i) => ((i as any).section || null) === targetSection);
      targetIndex = sameSection.length; // end of section
    } else {
      // Dropped on an item
      const overItem = items.find((i) => i.id === overId);
      if (!overItem) return;
      targetSection = (overItem as any).section || null;
      const sameSection = items.filter((i) => ((i as any).section || null) === targetSection);
      targetIndex = sameSection.findIndex((i) => i.id === overId);
    }

    const activeItem = items.find((i) => i.id === activeId)!;
    const oldSection = (activeItem as any).section || null;

    // Remove active item from list
    const filteredItems = items.filter((i) => i.id !== activeId);

    // Build new item with updated section
    const updatedItem = { ...activeItem, section: targetSection } as any;

    // Get items in target section (without the active item)
    const targetItems = filteredItems.filter((i) => ((i as any).section || null) === targetSection);

    // Insert at the right position
    const insertIdx = Math.min(targetIndex, targetItems.length);
    targetItems.splice(insertIdx, 0, updatedItem);

    // Rebuild complete items array preserving order
    const newItems: ChecklistItem[] = [];
    const otherItems = filteredItems.filter((i) => ((i as any).section || null) !== targetSection);

    // Determine final order: ungrouped, then sections in order
    const order = sectionOrders[checklistId] ?? [];
    const allSections = [null, ...order.map((s) => s as string | null)];

    // Also add sections not in order
    for (const i of [...otherItems, ...targetItems]) {
      const sec = (i as any).section || null;
      if (sec && !allSections.includes(sec)) allSections.push(sec);
    }

    let sortCounter = 0;
    const updates: { id: string; sortOrder: number; section?: string | null }[] = [];

    for (const sec of allSections) {
      const secItems = sec === targetSection
        ? targetItems
        : filteredItems.filter((i) => ((i as any).section || null) === sec);

      for (const item of secItems) {
        const newSortOrder = sortCounter++;
        newItems.push({ ...item, sortOrder: newSortOrder } as any);

        const needsSortUpdate = item.sortOrder !== newSortOrder;
        const needsSectionUpdate = item.id === activeId && oldSection !== targetSection;

        if (needsSortUpdate || needsSectionUpdate) {
          const update: any = { id: item.id, sortOrder: newSortOrder };
          if (needsSectionUpdate) update.section = targetSection;
          updates.push(update);
        }
      }
    }

    // Optimistic update
    setItemsByChecklist((prev) => ({
      ...prev,
      [checklistId]: newItems,
    }));

    // Persist in background
    (async () => {
      for (const update of updates) {
        await (client.models.homeChecklistItem as any).update(update);
      }
    })();
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
          const order = sectionOrders[cl.id] ?? [];
          const groups = buildSectionGroups(items, order);

          // Also add empty sections from sectionOrders that have no items
          const existingSectionIds = new Set(groups.map((g) => g.sectionId));
          for (const secName of order) {
            if (!existingSectionIds.has(secName)) {
              // Find insertion position based on order
              const idx = order.indexOf(secName);
              // Insert after ungrouped + however many ordered sections come before this one
              const insertAt = (groups[0]?.sectionId === UNGROUPED ? 1 : 0) +
                order.slice(0, idx).filter((s) => existingSectionIds.has(s)).length;
              groups.splice(insertAt, 0, {
                sectionId: secName,
                sectionName: secName,
                items: [],
                sortOrder: idx,
              });
              existingSectionIds.add(secName);
            }
          }

          // If there are no ungrouped items, still show ungrouped section for adding items
          if (!existingSectionIds.has(UNGROUPED)) {
            groups.unshift({
              sectionId: UNGROUPED,
              sectionName: "Ungrouped",
              items: [],
              sortOrder: -1,
            });
          }

          const isEditingName = editingChecklistId === cl.id;
          const doneCount = items.filter((i) => i.isDone).length;

          const sectionIds = groups.map((g) => `section:${cl.id}:${g.sectionId}`);
          const allItemIds = groups.flatMap((g) => g.items.map((i) => i.id));

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

              {/* Sections with DnD */}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={[...sectionIds, ...allItemIds]} strategy={verticalListSortingStrategy}>
                  {groups.map((group) => {
                    const sectionKey = `${cl.id}:${group.sectionId}`;
                    const isCollapsed = collapsedSections.has(sectionKey);
                    const addItemKey = `${cl.id}:${group.sectionId}`;
                    const sectionForItem = group.sectionId === UNGROUPED ? null : group.sectionId;

                    return (
                      <SortableSection
                        key={group.sectionId}
                        group={group}
                        checklistId={cl.id}
                        isCollapsed={isCollapsed}
                        onToggleCollapse={() => {
                          setCollapsedSections((prev) => {
                            const next = new Set(prev);
                            if (next.has(sectionKey)) next.delete(sectionKey);
                            else next.add(sectionKey);
                            return next;
                          });
                        }}
                        editingSectionName={editingSectionKey === sectionKey ? group.sectionId : null}
                        editingSectionText={editingSectionText}
                        onStartRenameSection={() => {
                          setEditingSectionKey(sectionKey);
                          setEditingSectionText(group.sectionName);
                        }}
                        onRenameSectionTextChange={setEditingSectionText}
                        onSaveRenameSection={() => renameSection(cl.id, group.sectionId)}
                        onCancelRenameSection={() => setEditingSectionKey(null)}
                        onDeleteSection={() => deleteSection(cl.id, group.sectionId)}
                        editingItemId={editingItemId}
                        editingItemText={editingItemText}
                        onToggleItem={(item) => toggleItem(item)}
                        onStartEditItem={(id, text) => { setEditingItemId(id); setEditingItemText(text); }}
                        onEditItemTextChange={setEditingItemText}
                        onSaveEditItem={(id) => renameItem(id)}
                        onCancelEditItem={() => setEditingItemId(null)}
                        onDeleteItem={(id) => deleteItem(id)}
                        addItemText={newItemText[addItemKey] ?? ""}
                        onAddItemTextChange={(v) => setNewItemText((prev) => ({ ...prev, [addItemKey]: v }))}
                        onAddItem={() => addItem(cl.id, sectionForItem)}
                      />
                    );
                  })}
                </SortableContext>

                <DragOverlay>
                  {activeItem ? <DragOverlayItem item={activeItem} /> : null}
                </DragOverlay>
              </DndContext>

              {/* Add section */}
              {addingSectionForChecklist === cl.id ? (
                <form
                  onSubmit={(e) => { e.preventDefault(); createSection(cl.id); }}
                  className="flex gap-2 mt-2"
                >
                  <Input
                    size="sm"
                    placeholder="Section name..."
                    value={newSectionName}
                    onValueChange={setNewSectionName}
                    autoFocus
                  />
                  <Button size="sm" type="submit" color="primary" variant="flat" isIconOnly>
                    <FaCheck size={10} />
                  </Button>
                  <Button size="sm" variant="light" isIconOnly onPress={() => { setAddingSectionForChecklist(null); setNewSectionName(""); }}>
                    <FaTimes size={10} />
                  </Button>
                </form>
              ) : (
                <Button
                  size="sm"
                  variant="light"
                  startContent={<FaPlus size={10} />}
                  className="mt-1"
                  onPress={() => { setAddingSectionForChecklist(cl.id); setNewSectionName(""); }}
                >
                  Add section
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
