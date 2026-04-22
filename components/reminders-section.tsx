"use client";

// Drop-in reminders panel for the detail view of any "parent" entity
// (task, event, trip). Lists reminders linked via parentId + lets the
// user add, edit, pause/resume, and delete them inline via
// ReminderModal. The caller supplies `defaults` that pre-fill the
// create form so users don't have to retype name/time/person for
// context that's obvious from the parent (e.g. a task reminder pre-
// fills name=task.title, targetKind=PERSON → assignee, single item
// with firesAt=task.dueDate).

import React, { useCallback, useEffect, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Chip } from "@heroui/chip";
import { useDisclosure } from "@heroui/modal";
import { FaBell, FaPen, FaPause, FaPlay, FaPlus, FaTrash } from "react-icons/fa";

import {
  ReminderModal,
  type ReminderModalInitialValues,
  type ReminderParentType,
} from "@/components/reminder-modal";
import {
  parseItems as parseReminderItems,
  formatScheduleLabel,
} from "@/lib/reminder-schedule";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Reminder = Schema["homeReminder"]["type"];
type Person = Schema["homePerson"]["type"];

const STATUS_COLORS: Record<string, string> = {
  PENDING: "success",
  PAUSED: "warning",
  EXPIRED: "default",
  CANCELLED: "danger",
};

interface RemindersSectionProps {
  parentType: ReminderParentType;
  /** ID of the parent record. Section renders nothing when empty/missing. */
  parentId: string | null | undefined;
  people: Person[];
  /** Pre-filled values for a new reminder from this parent. */
  defaults?: ReminderModalInitialValues;
  /** Optional heading override. Defaults to "Reminders". */
  title?: string;
  /**
   * If provided and `parentId` is falsy when the user clicks
   * "Add reminder", this is called first to create the parent on the
   * fly. Return the newly-minted parentId (or null to abort). Lets
   * the section appear on create forms — user fills task/event/trip
   * fields, clicks "Add reminder", the parent is saved automatically,
   * and the reminder modal opens pre-linked.
   */
  onBeforeAdd?: () => Promise<string | null>;
}

export function RemindersSection({
  parentType,
  parentId,
  people,
  defaults,
  title = "Reminders",
  onBeforeAdd,
}: RemindersSectionProps) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Reminder | null>(null);
  // After onBeforeAdd creates the parent, the prop hasn't re-rendered
  // yet. Stash the new id here so the reminder modal we're opening
  // RIGHT NOW has something to link against.
  const [pendingParentId, setPendingParentId] = useState<string | null>(null);
  const effectiveParentId = parentId || pendingParentId;
  const modal = useDisclosure();

  const load = useCallback(async () => {
    if (!parentId) {
      setReminders([]);
      return;
    }
    setLoading(true);
    // Scoped list — the parentId secondary index makes this a targeted
    // query rather than a full scan.
    const { data } = await client.models.homeReminder.list({
      filter: { parentId: { eq: parentId } },
      limit: 100,
    });
    const sorted = [...(data ?? [])].sort(
      (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
    );
    setReminders(sorted);
    setLoading(false);
  }, [parentId]);

  useEffect(() => {
    load();
  }, [load]);

  async function openCreate() {
    // If there's no parent yet, run onBeforeAdd to mint one (e.g.
    // save the draft task / event / trip). A null return aborts.
    if (!parentId && onBeforeAdd) {
      const created = await onBeforeAdd();
      if (!created) return;
      setPendingParentId(created);
    } else if (!parentId) {
      return;
    }
    setEditing(null);
    modal.onOpen();
  }

  function openEdit(r: Reminder) {
    setEditing(r);
    modal.onOpen();
  }

  async function toggleStatus(r: Reminder) {
    if (r.status === "CANCELLED" || r.status === "EXPIRED") return;
    const next = r.status === "PAUSED" ? "PENDING" : "PAUSED";
    await client.models.homeReminder.update({ id: r.id, status: next });
    await load();
  }

  async function handleDelete(r: Reminder) {
    if (!confirm(`Delete "${r.name}"?`)) return;
    await client.models.homeReminder.delete({ id: r.id });
    setReminders((prev) => prev.filter((x) => x.id !== r.id));
  }

  // Without a parentId AND no way to mint one, show a hint only.
  // When onBeforeAdd is supplied, we can still render the full
  // section — clicking "+ Add" will save the draft parent first.
  if (!parentId && !onBeforeAdd) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium flex items-center gap-2">
            <FaBell size={12} className="text-default-500" />
            {title}
          </p>
        </div>
        <p className="text-xs text-default-400">
          Save first to add reminders.
        </p>
      </div>
    );
  }

  const createInitialValues: ReminderModalInitialValues = {
    ...defaults,
    parentType,
    parentId: effectiveParentId ?? null,
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium flex items-center gap-2">
          <FaBell size={12} className="text-default-500" />
          {title}
          {reminders.length > 0 && (
            <span className="text-xs text-default-400">({reminders.length})</span>
          )}
        </p>
        <Button
          size="sm"
          variant="flat"
          startContent={<FaPlus size={10} />}
          onPress={openCreate}
        >
          Add reminder
        </Button>
      </div>

      {loading && (
        <p className="text-xs text-default-400">Loading…</p>
      )}

      {!loading && reminders.length === 0 && (
        <p className="text-xs text-default-400">No reminders linked yet.</p>
      )}

      <div className="space-y-1.5">
        {reminders.map((r) => {
          const items = parseReminderItems(r.items);
          const personName = r.personId
            ? people.find((p) => p.id === r.personId)?.name ?? "?"
            : null;
          const nextFire = new Date(r.scheduledAt);
          return (
            <div
              key={r.id}
              className={`border border-default-200 rounded-md p-2 bg-default-50 ${
                r.status !== "PENDING" ? "opacity-70" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{r.name}</p>
                    <Chip
                      size="sm"
                      variant="flat"
                      color={STATUS_COLORS[r.status ?? "PENDING"] as any}
                    >
                      {r.status}
                    </Chip>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-default-400">
                    <span>
                      {personName ? `For ${personName}` : "Group"}
                    </span>
                    <span>·</span>
                    <span>
                      next {nextFire.toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {items.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {items.map((item) => (
                        <div key={item.id} className="text-xs text-default-600">
                          • <span className="font-medium">{item.name}</span>
                          <span className="text-default-400">
                            {" "}
                            {formatScheduleLabel({
                              firesAt: item.firesAt,
                              rrule: item.rrule,
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  {(r.status === "PENDING" || r.status === "PAUSED") && (
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      onPress={() => toggleStatus(r)}
                      title={r.status === "PAUSED" ? "Resume" : "Pause"}
                    >
                      {r.status === "PAUSED" ? <FaPlay size={10} /> : <FaPause size={10} />}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    isIconOnly
                    variant="light"
                    onPress={() => openEdit(r)}
                  >
                    <FaPen size={10} />
                  </Button>
                  <Button
                    size="sm"
                    isIconOnly
                    variant="light"
                    color="danger"
                    onPress={() => handleDelete(r)}
                  >
                    <FaTrash size={10} />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <ReminderModal
        isOpen={modal.isOpen}
        onOpenChange={modal.onOpenChange}
        people={people}
        editing={editing}
        initialValues={editing ? undefined : createInitialValues}
        onSaved={() => load()}
      />
    </div>
  );
}
