"use client";

// Create / edit modal for a task. Used by the Tasks page and the home
// dashboard. Form state lives here and is reset from `task` each time
// the modal opens (null = create).

import React, { useEffect, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { addToast } from "@heroui/react";
import { Input } from "@heroui/input";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/modal";
import { Select, SelectItem } from "@heroui/select";
import dayjs from "dayjs";

import { AttachmentSection } from "@/components/attachment-section";
import { RemindersSection } from "@/components/reminders-section";
import { NotesSection } from "@/components/notes-section";
import { buildReminderDefaultsForTask } from "@/lib/reminder-defaults";
import { resolveCurrentPerson } from "@/lib/current-person";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Task = Schema["homeTask"]["type"];
type Person = Schema["homePerson"]["type"];

export const RECURRENCE_PRESETS = [
  { label: "None", value: "" },
  { label: "Daily", value: "RRULE:FREQ=DAILY" },
  { label: "Every weekday", value: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { label: "Weekly", value: "RRULE:FREQ=WEEKLY" },
  { label: "Biweekly", value: "RRULE:FREQ=WEEKLY;INTERVAL=2" },
  { label: "Monthly (same date)", value: "RRULE:FREQ=MONTHLY" },
  { label: "Monthly (1st)", value: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1" },
  { label: "Monthly (15th)", value: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15" },
  { label: "Quarterly", value: "RRULE:FREQ=MONTHLY;INTERVAL=3" },
  { label: "Yearly", value: "RRULE:FREQ=YEARLY" },
  { label: "Custom...", value: "__custom__" },
];

interface TaskModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
  people: Person[];
  // Fired after a create, save or skip so the caller can reload.
  onSaved: () => void;
}

export function TaskModal({ isOpen, onOpenChange, task, people, onSaved }: TaskModalProps) {
  const [editingTask, setEditingTask] = useState<Task | null>(task);
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAssignedIds, setFormAssignedIds] = useState<string[]>([]);
  const [formDueDate, setFormDueDate] = useState("");
  const [formRecurrence, setFormRecurrence] = useState("");
  const [isCustomRecurrence, setIsCustomRecurrence] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setEditingTask(task);
    setFormTitle(task?.title ?? "");
    setFormDescription(task?.description ?? "");
    setFormAssignedIds((task?.assignedPersonIds ?? []).filter((id): id is string => !!id));
    setFormDueDate(task?.dueDate ? dayjs(task.dueDate).format("YYYY-MM-DDTHH:mm") : "");
    setFormRecurrence(task?.recurrence ?? "");
    setIsCustomRecurrence(
      task?.recurrence ? !RECURRENCE_PRESETS.some((p) => p.value === task.recurrence) : false,
    );
  }, [isOpen, task]);

  // Save the current form state as a task, promoting the modal from
  // create-mode to edit-mode if it wasn't already. Returns the saved
  // task's id. Used by saveTask (the main Save/Create button) and by
  // RemindersSection's onBeforeAdd so the user can add a reminder
  // without first saving manually.
  async function saveTaskDraft(): Promise<string | null> {
    if (!formTitle.trim()) return null;

    if (editingTask) {
      await client.models.homeTask.update({
        id: editingTask.id,
        title: formTitle,
        description: formDescription || null,
        assignedPersonIds: formAssignedIds,
        dueDate: formDueDate ? new Date(formDueDate).toISOString() : null,
        recurrence: formRecurrence || null,
      });
      return editingTask.id;
    }
    const { data } = await client.models.homeTask.create({
      title: formTitle,
      description: formDescription || null,
      assignedPersonIds: formAssignedIds,
      dueDate: formDueDate ? new Date(formDueDate).toISOString() : null,
      recurrence: formRecurrence || null,
      isCompleted: false,
      createdBy: "ui",
    });
    if (data) setEditingTask(data);
    return data?.id ?? null;
  }

  async function saveTask(onClose: () => void) {
    const id = await saveTaskDraft();
    if (!id) return;
    onClose();
    onSaved();
  }

  async function skipOccurrence(t: Task, onClose: () => void) {
    try {
      const me = await resolveCurrentPerson(client);
      const { data: result, errors } =
        await client.mutations.taskOccurrenceAction({
          action: "SKIP",
          taskId: t.id,
          byPersonId: me?.id ?? null,
        });
      if (errors?.length) throw new Error(errors[0].message);
      if (result && !result.ok) {
        throw new Error(result.message ?? "rejected");
      }
      addToast({
        title: "Occurrence skipped",
        description: "Next cycle scheduled",
        color: "default",
      });
      onSaved();
      onClose();
    } catch (err: any) {
      addToast({
        title: "Skip failed",
        description: err?.message ?? String(err),
        color: "danger",
      });
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{editingTask ? "Edit Task" : "New Task"}</ModalHeader>
            <ModalBody>
              <Input
                label="Title"
                value={formTitle}
                onValueChange={setFormTitle}
                isRequired
                autoFocus={!editingTask}
              />
              <Input
                label="Description"
                value={formDescription}
                onValueChange={setFormDescription}
              />
              <Select
                label="Assigned to"
                selectionMode="multiple"
                selectedKeys={new Set(formAssignedIds)}
                onSelectionChange={(keys) => setFormAssignedIds(Array.from(keys as Set<string>))}
                description="Leave empty for household"
              >
                {people.map((p) => (
                  <SelectItem key={p.id} textValue={p.name}>{p.name}</SelectItem>
                ))}
              </Select>
              <Input
                label="Due date"
                type="datetime-local"
                placeholder=" "
                value={formDueDate}
                onValueChange={setFormDueDate}
              />
              <Select
                label="Recurrence"
                selectedKeys={[isCustomRecurrence ? "__custom__" : formRecurrence]}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setIsCustomRecurrence(true);
                    setFormRecurrence("RRULE:FREQ=MONTHLY;BYMONTHDAY=");
                  } else {
                    setIsCustomRecurrence(false);
                    setFormRecurrence(e.target.value);
                  }
                }}
              >
                {RECURRENCE_PRESETS.map((p) => (
                  <SelectItem key={p.value} textValue={p.label}>{p.label}</SelectItem>
                ))}
              </Select>
              {isCustomRecurrence && (
                <Input
                  label="Custom RRULE"
                  value={formRecurrence}
                  onValueChange={setFormRecurrence}
                  placeholder="RRULE:FREQ=MONTHLY;BYMONTHDAY=1"
                  description="e.g. BYMONTHDAY=1 for 1st of month, BYDAY=MO for every Monday"
                />
              )}
              {editingTask && (
                <div className="mt-2">
                  <p className="text-xs font-semibold text-default-500 uppercase tracking-wide mb-1.5">
                    Attachments
                  </p>
                  <AttachmentSection
                    parentType="TASK"
                    parentId={editingTask.id}
                  />
                </div>
              )}
              <div className="mt-2">
                <RemindersSection
                  parentType="TASK"
                  parentId={editingTask?.id}
                  people={people}
                  defaults={buildReminderDefaultsForTask({
                    title: formTitle || editingTask?.title || "",
                    dueDate: formDueDate || editingTask?.dueDate,
                    assignedPersonIds: formAssignedIds,
                  })}
                  onBeforeAdd={editingTask ? undefined : saveTaskDraft}
                />
              </div>
              <div className="mt-2">
                <NotesSection
                  parentType="TASK"
                  parentId={editingTask?.id}
                  onBeforeAdd={editingTask ? undefined : saveTaskDraft}
                />
              </div>
            </ModalBody>
            <ModalFooter>
              {editingTask?.recurrence && !editingTask.isCompleted && (
                <Button
                  variant="light"
                  onPress={() => skipOccurrence(editingTask, onClose)}
                >
                  Skip occurrence
                </Button>
              )}
              <Button variant="light" onPress={onClose}>Cancel</Button>
              <Button color="primary" onPress={() => saveTask(onClose)}>
                {editingTask ? "Save" : "Create"}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
