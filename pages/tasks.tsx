"use client";

import React, { useState, useEffect, useCallback } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { addToast, Spinner } from "@heroui/react";
import { Input } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
import { Checkbox } from "@heroui/checkbox";
import { useDisclosure } from "@heroui/modal";
import { Select, SelectItem } from "@heroui/select";
import { FaPlus, FaTrash, FaPen, FaSync, FaArrowLeft } from "react-icons/fa";
import { RRule } from "rrule";

import DefaultLayout from "@/layouts/default";
import { TaskModal } from "@/components/task-modal";
import { cascadeDeleteRemindersFor } from "@/lib/reminder-parent";
import { cascadeDeleteNotesFor } from "@/lib/note-parent";
import { toggleTaskCompleted } from "@/lib/task-actions";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Task = Schema["homeTask"]["type"];
type Person = Schema["homePerson"]["type"];

type FilterStatus = "open" | "completed" | "all";

export default function TasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lastClosedAt, setLastClosedAt] = useState<Record<string, string>>({});
  const [pendingIds, setPendingIds] = useState<Record<string, boolean>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [filterPersonId, setFilterPersonId] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("open");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();

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
    const [tasksRes, occRes] = await Promise.all([
      client.models.homeTask.list({ limit: 500 }),
      client.models.homeTaskOccurrence.list({ limit: 500 }),
    ]);
    const sorted = [...(tasksRes.data ?? [])].sort(
      (a, b) => new Date(a.dueDate ?? a.createdAt).getTime() - new Date(b.dueDate ?? b.createdAt).getTime()
    );
    const lastByTask: Record<string, string> = {};
    for (const o of occRes.data ?? []) {
      const ts = o.completedAt ?? o.skippedAt;
      if (!ts) continue;
      const prev = lastByTask[o.taskId];
      if (!prev || ts > prev) lastByTask[o.taskId] = ts;
    }
    setTasks(sorted);
    setLastClosedAt(lastByTask);
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
    onOpen();
  }

  function openEditModal(task: Task) {
    setEditingTask(task);
    onOpen();
  }

  async function toggleComplete(task: Task) {
    if (pendingIds[task.id]) return;
    setPendingIds((prev) => ({ ...prev, [task.id]: true }));
    try {
      const { title, description } = await toggleTaskCompleted(client, task);
      addToast({ title, description, color: task.isCompleted ? "default" : "success" });
      await loadTasks();
    } catch (err: any) {
      addToast({
        title: "Update failed",
        description: err?.message ?? String(err),
        color: "danger",
      });
    } finally {
      setPendingIds((prev) => {
        const { [task.id]: _gone, ...rest } = prev;
        return rest;
      });
    }
  }

  async function deleteTask(id: string) {
    if (!confirm("Delete this task?")) return;
    await cascadeDeleteRemindersFor(client, id);
    await cascadeDeleteNotesFor(client, id);
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
    // Compare calendar days, not absolute time — so 9pm today is "Today",
    // not "Tomorrow" (Math.ceil on an absolute-time diff bumps anything
    // past the current moment up by a day).
    const date = new Date(d);
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dayStart.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

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

  function formatLastDone(iso: string): string {
    const d = new Date(iso);
    const diffMin = Math.round((Date.now() - d.getTime()) / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.round(diffHr / 24);
    if (diffDays === 1) return "yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
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
                  {pendingIds[task.id] ? (
                    <div className="w-6 h-6 flex items-center justify-center">
                      <Spinner size="sm" />
                    </div>
                  ) : (
                    <Checkbox
                      isSelected={!!task.isCompleted}
                      onValueChange={() => toggleComplete(task)}
                    />
                  )}
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
                      {task.recurrence && lastClosedAt[task.id] && (
                        <span className="text-xs text-default-400">
                          Last done {formatLastDone(lastClosedAt[task.id]!)}
                        </span>
                      )}
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

        <TaskModal
          isOpen={isOpen}
          onOpenChange={onOpenChange}
          task={editingTask}
          people={people}
          onSaved={loadTasks}
        />
      </div>
    </DefaultLayout>
  );
}
