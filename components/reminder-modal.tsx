"use client";

// Reusable create/edit modal for homeReminder, lifted out of
// pages/reminders.tsx so it can also be opened from a task, event, or
// trip detail view (via components/reminders-section.tsx).
//
// In create mode, `initialValues` pre-fills the form — callers use this
// to wire up context-aware defaults (e.g. a task reminder pre-fills
// parentType="TASK", parentId=task.id, a single item with firesAt set
// to the task's dueDate). In edit mode, `editing` carries the existing
// reminder and `initialValues` is ignored.

import React, { useEffect, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Switch } from "@heroui/switch";
import { Select, SelectItem } from "@heroui/select";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/modal";
import { addToast } from "@heroui/react";
import { FaPlus, FaTrash } from "react-icons/fa";

import { SchedulePicker } from "@/components/schedule-picker";
import {
  type ReminderItem,
  parseItems as parseReminderItems,
  earliestNextOccurrence,
} from "@/lib/reminder-schedule";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Reminder = Schema["homeReminder"]["type"];
type Person = Schema["homePerson"]["type"];

export type ReminderParentType = "TASK" | "EVENT" | "TRIP";

export interface ReminderModalInitialValues {
  name?: string;
  kind?: string;
  useLlm?: boolean;
  targetKind?: "PERSON" | "GROUP";
  personId?: string;
  items?: ReminderItem[];
  parentType?: ReminderParentType | null;
  parentId?: string | null;
}

interface ReminderModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  people: Person[];
  /** Existing reminder when editing; null/undefined means create. */
  editing?: Reminder | null;
  /** Pre-filled values for create mode. Ignored when `editing` is set. */
  initialValues?: ReminderModalInitialValues;
  /** Fired after a successful create/update; parent refreshes its list. */
  onSaved?: (reminderId: string) => void;
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function emptyItem(): ReminderItem {
  return { id: genId(), name: "", rrule: "" };
}

export function ReminderModal({
  isOpen,
  onOpenChange,
  people,
  editing,
  initialValues,
  onSaved,
}: ReminderModalProps) {
  const [formName, setFormName] = useState("");
  const [formKind, setFormKind] = useState("");
  const [formUseLlm, setFormUseLlm] = useState(true);
  const [formTargetKind, setFormTargetKind] = useState<"GROUP" | "PERSON">("GROUP");
  const [formPersonId, setFormPersonId] = useState<string>("");
  const [formItems, setFormItems] = useState<ReminderItem[]>([emptyItem()]);
  // Parent context is stamped on create and preserved on update. Not
  // editable from the form itself — the parent view owns the link.
  const [parentType, setParentType] = useState<ReminderParentType | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (editing) {
      setFormName(editing.name);
      setFormKind(editing.kind ?? "");
      setFormUseLlm(editing.useLlm !== false);
      setFormTargetKind((editing.targetKind as "GROUP" | "PERSON") ?? "GROUP");
      setFormPersonId(editing.personId ?? "");
      const items = parseReminderItems(editing.items);
      setFormItems(items.length > 0 ? items : [emptyItem()]);
      setParentType(
        (editing.parentType as ReminderParentType | null | undefined) ?? null
      );
      setParentId(editing.parentId ?? null);
    } else {
      setFormName(initialValues?.name ?? "");
      setFormKind(initialValues?.kind ?? "");
      setFormUseLlm(initialValues?.useLlm ?? true);
      setFormTargetKind(initialValues?.targetKind ?? "GROUP");
      setFormPersonId(initialValues?.personId ?? "");
      setFormItems(
        initialValues?.items && initialValues.items.length > 0
          ? initialValues.items
          : [emptyItem()]
      );
      setParentType(initialValues?.parentType ?? null);
      setParentId(initialValues?.parentId ?? null);
    }
  }, [isOpen, editing, initialValues]);

  async function save(onClose: () => void) {
    if (!formName.trim()) {
      addToast({ title: "Name is required", color: "warning" });
      return;
    }
    if (formItems.length === 0) {
      addToast({ title: "Add at least one item", color: "warning" });
      return;
    }

    const cleanItems = formItems
      .filter((i) => i.name.trim())
      .map((i) => ({
        id: i.id,
        name: i.name.trim(),
        ...(i.notes ? { notes: i.notes } : {}),
        ...(i.firesAt ? { firesAt: new Date(i.firesAt).toISOString() } : {}),
        ...(i.rrule ? { rrule: i.rrule } : {}),
        ...(i.startDate ? { startDate: i.startDate } : {}),
        ...(i.endDate ? { endDate: i.endDate } : {}),
        ...(i.lastFiredAt ? { lastFiredAt: i.lastFiredAt } : {}),
      }));

    if (cleanItems.length === 0) {
      addToast({ title: "Each item needs a name", color: "warning" });
      return;
    }

    const missingSchedule = cleanItems.find(
      (i) => !(i as any).firesAt && !(i as any).rrule
    );
    if (missingSchedule) {
      addToast({
        title: `Item "${missingSchedule.name}" is missing a schedule`,
        description: "Pick a schedule (Once, Daily, Weekly, etc.) for each item",
        color: "warning",
      });
      return;
    }

    if (formTargetKind === "PERSON" && !formPersonId) {
      addToast({
        title: "Pick a person",
        description: 'Target is set to "Person" but no person is selected',
        color: "warning",
      });
      return;
    }

    const payload = {
      name: formName.trim(),
      // AWSJSON field — MUST be pre-stringified, see
      // feedback_awsjson_stringify memory.
      items: JSON.stringify(cleanItems) as any,
      useLlm: formUseLlm,
      targetKind: formTargetKind,
      personId: formTargetKind === "PERSON" ? formPersonId || null : null,
      groupJid: null,
      kind: formKind.trim() || null,
      parentType: parentType ?? null,
      parentId: parentId ?? null,
    };

    let savedId: string | null = null;
    try {
      if (editing) {
        const { data, errors } = await client.models.homeReminder.update({
          id: editing.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
        savedId = data?.id ?? editing.id;
      } else {
        const now = new Date();
        const earliest = earliestNextOccurrence(cleanItems, now);
        if (!earliest) {
          addToast({
            title: "Couldn't compute a valid schedule",
            description:
              "All items have a schedule set, but none produced a future fire time. Check start/end dates and RRULE.",
            color: "danger",
          });
          return;
        }
        const { data, errors } = await client.models.homeReminder.create({
          ...payload,
          scheduledAt: earliest.toISOString(),
          status: "PENDING",
          createdBy: "ui",
        });
        if (errors?.length) throw new Error(errors[0].message);
        savedId = data?.id ?? null;
      }
    } catch (err: any) {
      console.error("Failed to save reminder:", err);
      addToast({
        title: "Save failed",
        description: err?.message ?? String(err),
        color: "danger",
      });
      return;
    }

    addToast({
      title: editing ? "Reminder updated" : "Reminder created",
      color: "success",
    });
    onClose();
    if (savedId) onSaved?.(savedId);
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="2xl"
      scrollBehavior="inside"
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{editing ? "Edit Reminder" : "New Reminder"}</ModalHeader>
            <ModalBody>
              <Input
                label="Name"
                placeholder="Daily supplements, Pick up kids, …"
                value={formName}
                onValueChange={setFormName}
                isRequired
              />
              <Input
                label="Kind (optional tag)"
                placeholder="medication, chore, adhoc…"
                value={formKind}
                onValueChange={setFormKind}
              />

              <div className="flex gap-2">
                <Select
                  label="Target"
                  selectedKeys={[formTargetKind]}
                  onChange={(e) =>
                    setFormTargetKind(e.target.value as "GROUP" | "PERSON")
                  }
                  className="max-w-[150px]"
                >
                  <SelectItem key="GROUP">Group</SelectItem>
                  <SelectItem key="PERSON">Person</SelectItem>
                </Select>
                {formTargetKind === "PERSON" && (
                  <Select
                    label="Person"
                    selectedKeys={formPersonId ? [formPersonId] : []}
                    onChange={(e) => setFormPersonId(e.target.value)}
                    className="flex-1"
                  >
                    {people.map((p) => (
                      <SelectItem key={p.id}>{p.name}</SelectItem>
                    ))}
                  </Select>
                )}
              </div>

              <Switch
                size="sm"
                isSelected={formUseLlm}
                onValueChange={setFormUseLlm}
              >
                <span className="text-xs">
                  LLM compose (Haiku writes each message, varies wording)
                </span>
              </Switch>

              <div className="flex items-center justify-between mt-2">
                <p className="text-sm font-medium">Items</p>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<FaPlus size={10} />}
                  onPress={() => setFormItems((prev) => [...prev, emptyItem()])}
                >
                  Add item
                </Button>
              </div>
              <div className="space-y-2">
                {formItems.map((item, idx) => {
                  const update = (patch: Partial<ReminderItem>) =>
                    setFormItems((prev) =>
                      prev.map((i, j) => (j === idx ? { ...i, ...patch } : i))
                    );
                  const remove = () =>
                    setFormItems((prev) => prev.filter((_, j) => j !== idx));
                  return (
                    <div
                      key={item.id}
                      className="border border-default-200 rounded-md p-2 space-y-2 bg-default-50"
                    >
                      <div className="flex gap-2">
                        <Input
                          size="sm"
                          label="Item name"
                          placeholder="Vitamin B12, Oxycodone 5mg, …"
                          value={item.name}
                          onValueChange={(v) => update({ name: v })}
                          isRequired
                          className="flex-1"
                        />
                        {formItems.length > 1 && (
                          <Button
                            size="sm"
                            isIconOnly
                            variant="light"
                            color="danger"
                            onPress={remove}
                          >
                            <FaTrash size={10} />
                          </Button>
                        )}
                      </div>
                      <Input
                        size="sm"
                        label="Notes (optional)"
                        placeholder="take with food"
                        value={item.notes ?? ""}
                        onValueChange={(v) => update({ notes: v || null })}
                      />
                      <SchedulePicker
                        value={{ firesAt: item.firesAt, rrule: item.rrule }}
                        onChange={(next) =>
                          update({
                            firesAt: next.firesAt ?? null,
                            rrule: next.rrule ?? null,
                          })
                        }
                      />
                      <div className="flex gap-2">
                        <Input
                          size="sm"
                          label="Start date (optional)"
                          type="date"
                          placeholder=" "
                          value={item.startDate ?? ""}
                          onValueChange={(v) => update({ startDate: v || null })}
                        />
                        <Input
                          size="sm"
                          label="End date (optional)"
                          type="date"
                          placeholder=" "
                          value={item.endDate ?? ""}
                          onValueChange={(v) => update({ endDate: v || null })}
                          description="Used for time-limited Rx"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button color="primary" onPress={() => save(onClose)}>
                {editing ? "Save" : "Create"}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
