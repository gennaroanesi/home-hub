"use client";

import React, { useState, useEffect, useCallback } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
import { Checkbox } from "@heroui/checkbox";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { Select, SelectItem } from "@heroui/select";
import { FaPlus, FaTrash, FaPen, FaSync, FaArrowLeft } from "react-icons/fa";
import { RRule } from "rrule";

import DefaultLayout from "@/layouts/default";
import { AttachmentSection } from "@/components/attachment-section";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Task = Schema["homeTask"]["type"];
type Person = Schema["homePerson"]["type"];

type FilterStatus = "open" | "completed" | "all";

export default function TasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [filterPersonId, setFilterPersonId] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("open");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAssignedIds, setFormAssignedIds] = useState<string[]>([]);
  const [formDueDate, setFormDueDate] = useState("");
  const [formRecurrence, setFormRecurrence] = useState("");
  const [isCustomRecurrence, setIsCustomRecurrence] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      await getCurrentUser();
      await Promise.all([loadTasks(), loadPeople()]);
    } catch {
      router.push("/login");
    }
  }

  const loadPeople = useCallback(async () => {
    const { data } = await client.models.homePerson.list();
    setPeople((data ?? []).filter((p) => p.active));
  }, []);

  const loadTasks = useCallback(async () => {
    const { data } = await client.models.homeTask.list({ limit: 500 });
    const sorted = [...(data ?? [])].sort(
      (a, b) => new Date(a.dueDate ?? a.createdAt).getTime() - new Date(b.dueDate ?? b.createdAt).getTime()
    );
    setTasks(sorted);
  }, []);

  function getAssignedIds(task: Task): string[] {
    return (task.assignedPersonIds ?? []).filter((id): id is string => !!id);
  }

  function personLabel(ids: string[]): string {
    if (ids.length === 0) return "Household";
    const names = ids
      .map((id) => people.find((p) => p.id === id)?.name)
      .filter((n): n is string => !!n);
    if (names.length === 0) return "Household";
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  function openCreateModal() {
    setEditingTask(null);
    setFormTitle("");
    setFormDescription("");
    setFormAssignedIds([]);
    setFormDueDate("");
    setFormRecurrence("");
    setIsCustomRecurrence(false);
    onOpen();
  }

  function openEditModal(task: Task) {
    setEditingTask(task);
    setFormTitle(task.title);
    setFormDescription(task.description ?? "");
    setFormAssignedIds(getAssignedIds(task));
    setFormDueDate(task.dueDate ? task.dueDate.slice(0, 16) : "");
    setFormRecurrence(task.recurrence ?? "");
    setIsCustomRecurrence(task.recurrence ? !RECURRENCE_PRESETS.some((p) => p.value === task.recurrence) : false);
    onOpen();
  }

  async function saveTask(onClose: () => void) {
    if (!formTitle.trim()) return;

    if (editingTask) {
      await client.models.homeTask.update({
        id: editingTask.id,
        title: formTitle,
        description: formDescription || null,
        assignedPersonIds: formAssignedIds,
        dueDate: formDueDate ? new Date(formDueDate).toISOString() : null,
        recurrence: formRecurrence || null,
      });
    } else {
      await client.models.homeTask.create({
        title: formTitle,
        description: formDescription || null,
        assignedPersonIds: formAssignedIds,
        dueDate: formDueDate ? new Date(formDueDate).toISOString() : null,
        recurrence: formRecurrence || null,
        isCompleted: false,
        createdBy: "ui",
      });
    }

    onClose();
    await loadTasks();
  }

  async function toggleComplete(task: Task) {
    if (task.isCompleted) {
      // Uncomplete
      await client.models.homeTask.update({
        id: task.id,
        isCompleted: false,
        completedAt: null,
      });
    } else if (task.recurrence) {
      // Recurring task: advance due date to next occurrence instead of completing
      const nextDate = getNextOccurrenceDate(task.recurrence, task.dueDate);
      if (nextDate) {
        await client.models.homeTask.update({
          id: task.id,
          dueDate: nextDate.toISOString(),
        });
      }
    } else {
      // One-time task: mark as completed
      await client.models.homeTask.update({
        id: task.id,
        isCompleted: true,
        completedAt: new Date().toISOString(),
      });
    }
    await loadTasks();
  }

  async function deleteTask(id: string) {
    if (!confirm("Delete this task?")) return;
    await client.models.homeTask.delete({ id });
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  const filteredTasks = tasks.filter((t) => {
    if (filterPersonId !== "all") {
      const assigned = getAssignedIds(t);
      // Household tasks (empty assigned) show for everyone; otherwise must include the filtered person
      if (assigned.length > 0 && !assigned.includes(filterPersonId)) return false;
    }
    if (filterStatus === "open" && t.isCompleted) return false;
    if (filterStatus === "completed" && !t.isCompleted) return false;
    return true;
  });

  function formatDueDate(d: string | null | undefined) {
    if (!d) return null;
    const date = new Date(d);
    const now = new Date();
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return { text: `${Math.abs(diffDays)}d overdue`, color: "text-danger" };
    if (diffDays === 0) return { text: "Today", color: "text-warning" };
    if (diffDays === 1) return { text: "Tomorrow", color: "text-warning" };
    return { text: date.toLocaleDateString(), color: "text-default-400" };
  }

  function formatRecurrence(rruleStr: string): string {
    try {
      const rule = RRule.fromString(rruleStr);
      return rule.toText();
    } catch {
      return rruleStr;
    }
  }

  function getNextOccurrenceDate(rruleStr: string, dueDate?: string | null): Date | null {
    try {
      const baseRule = RRule.fromString(rruleStr);
      let dtstart = new Date();
      if (dueDate) {
        const [y, m, d] = dueDate.split("T")[0].split("-").map(Number);
        dtstart = new Date(y, m - 1, d);
      }
      const rule = new RRule({ ...baseRule.origOptions, dtstart });
      return rule.after(new Date());
    } catch {
      return null;
    }
  }

  function getNextOccurrence(rruleStr: string, dueDate?: string | null): string | null {
    const next = getNextOccurrenceDate(rruleStr, dueDate);
    return next ? next.toLocaleDateString() : null;
  }

  const RECURRENCE_PRESETS = [
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

  return (
    <DefaultLayout>
      <div className="max-w-2xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-2xl font-bold text-foreground">Tasks</h1>
          </div>
          <Button color="primary" size="sm" startContent={<FaPlus size={12} />} onPress={openCreateModal}>
            New Task
          </Button>
        </div>

        {/* Filters */}
        <div className="flex gap-2 mb-4">
          <Select
            size="sm"
            label="Person"
            selectedKeys={[filterPersonId]}
            onChange={(e) => setFilterPersonId(e.target.value)}
            className="max-w-[150px]"
          >
            <>
              <SelectItem key="all" textValue="All">All</SelectItem>
              {people.map((p) => (
                <SelectItem key={p.id} textValue={p.name}>{p.name}</SelectItem>
              )) as any}
            </>
          </Select>
          <Select
            size="sm"
            label="Status"
            selectedKeys={[filterStatus]}
            onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
            className="max-w-[150px]"
          >
            <SelectItem key="open" textValue="Open">Open</SelectItem>
            <SelectItem key="completed" textValue="Completed">Completed</SelectItem>
            <SelectItem key="all" textValue="All">All</SelectItem>
          </Select>
        </div>

        {/* Task list */}
        <div className="space-y-2">
          {filteredTasks.length === 0 && (
            <p className="text-center text-default-300 py-10">No tasks found</p>
          )}
          {filteredTasks.map((task) => {
            const due = formatDueDate(task.dueDate);
            const assigned = getAssignedIds(task);
            return (
              <Card key={task.id} className={task.isCompleted ? "opacity-60" : ""}>
                <CardBody className="flex flex-row items-center gap-3 px-4 py-3">
                  <Checkbox
                    isSelected={!!task.isCompleted}
                    onValueChange={() => toggleComplete(task)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className={`text-sm font-medium ${task.isCompleted ? "line-through text-default-400" : ""}`}>
                        {task.title}
                      </p>
                    </div>
                    {task.description && (
                      <p className="text-xs text-default-500 mt-0.5">{task.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-xs text-default-400">{personLabel(assigned)}</span>
                      {due && (
                        <span className={`text-xs ${due.color}`}>{due.text}</span>
                      )}
                      {task.recurrence && (
                        <span className="text-xs text-primary flex items-center gap-1">
                          <FaSync size={8} />
                          {formatRecurrence(task.recurrence)}
                        </span>
                      )}
                      {task.recurrence && !task.isCompleted && (() => {
                        const next = getNextOccurrence(task.recurrence!, task.dueDate);
                        return next ? (
                          <span className="text-xs text-default-400">Next: {next}</span>
                        ) : null;
                      })()}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" isIconOnly variant="light" onPress={() => openEditModal(task)}>
                      <FaPen size={12} />
                    </Button>
                    <Button size="sm" isIconOnly variant="light" color="danger" onPress={() => deleteTask(task.id)}>
                      <FaTrash size={12} />
                    </Button>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>

        {/* Create/Edit Modal */}
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
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => saveTask(onClose)}>
                    {editingTask ? "Save" : "Create"}
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>
      </div>
    </DefaultLayout>
  );
}
