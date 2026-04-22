"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Switch } from "@heroui/switch";
import { Select, SelectItem } from "@heroui/select";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import {
  FaArrowLeft,
  FaPlus,
  FaTrash,
  FaPen,
  FaPause,
  FaPlay,
  FaBell,
  FaUsers,
  FaUser,
} from "react-icons/fa";

import { addToast } from "@heroui/react";

import DefaultLayout from "@/layouts/default";
import { SchedulePicker } from "@/components/schedule-picker";
import {
  type ReminderItem as SharedReminderItem,
  parseItems as parseReminderItems,
  earliestNextOccurrence,
  formatScheduleLabel,
} from "@/lib/reminder-schedule";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Reminder = Schema["homeReminder"]["type"];
type Person = Schema["homePerson"]["type"];
type ReminderItem = SharedReminderItem;

/** Generate a stable-ish id client-side. Mirrors what the agent handler does. */
function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function emptyItem(): ReminderItem {
  return { id: genId(), name: "", rrule: "" };
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "success",
  PAUSED: "warning",
  EXPIRED: "default",
  CANCELLED: "danger",
};

export default function RemindersPage() {
  const router = useRouter();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);

  const modal = useDisclosure();
  const [editing, setEditing] = useState<Reminder | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formKind, setFormKind] = useState("");
  const [formUseLlm, setFormUseLlm] = useState(true);
  const [formTargetKind, setFormTargetKind] = useState<"GROUP" | "PERSON">("GROUP");
  const [formPersonId, setFormPersonId] = useState<string>("");
  const [formItems, setFormItems] = useState<ReminderItem[]>([emptyItem()]);

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
    setLoading(true);
    const [remRes, peopleRes] = await Promise.all([
      client.models.homeReminder.list({ limit: 200 }),
      client.models.homePerson.list(),
    ]);
    const sorted = [...(remRes.data ?? [])].sort(
      (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
    );
    setReminders(sorted);
    setPeople((peopleRes.data ?? []).filter((p) => p.active));
    setLoading(false);
  }, []);

  function openCreate() {
    setEditing(null);
    setFormName("");
    setFormKind("");
    setFormUseLlm(true);
    setFormTargetKind("GROUP");
    setFormPersonId("");
    setFormItems([emptyItem()]);
    modal.onOpen();
  }

  function openEdit(r: Reminder) {
    setEditing(r);
    setFormName(r.name);
    setFormKind(r.kind ?? "");
    setFormUseLlm(r.useLlm !== false);
    setFormTargetKind((r.targetKind as "GROUP" | "PERSON") ?? "GROUP");
    setFormPersonId(r.personId ?? "");
    const items = parseReminderItems(r.items);
    setFormItems(items.length > 0 ? items : [emptyItem()]);
    modal.onOpen();
  }

  async function save(onClose: () => void) {
    // Validate up front with visible feedback so nothing fails silently.
    if (!formName.trim()) {
      addToast({ title: "Name is required", color: "warning" });
      return;
    }
    if (formItems.length === 0) {
      addToast({ title: "Add at least one item", color: "warning" });
      return;
    }

    // Filter out empty items (no name). Each remaining item must also have
    // a schedule set — either firesAt or rrule.
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
      // a.json() fields require a pre-stringified value — passing a plain
      // array yields "Variable 'items' has an invalid value" at the AppSync
      // wire level. Same gotcha as homeDevice.lastState and
      // homePhotoFace.boundingBox. See sanitizeForAWSJSON in the sweep.
      items: JSON.stringify(cleanItems) as any,
      useLlm: formUseLlm,
      targetKind: formTargetKind,
      personId: formTargetKind === "PERSON" ? formPersonId || null : null,
      groupJid: null,
      kind: formKind.trim() || null,
    };

    try {
      if (editing) {
        const { errors } = await client.models.homeReminder.update({
          id: editing.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
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
        const { errors } = await client.models.homeReminder.create({
          ...payload,
          scheduledAt: earliest.toISOString(),
          status: "PENDING",
          createdBy: "ui",
        });
        if (errors?.length) throw new Error(errors[0].message);
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
    await loadAll();
  }

  async function toggleStatus(r: Reminder) {
    if (r.status === "CANCELLED" || r.status === "EXPIRED") return;
    const next = r.status === "PAUSED" ? "PENDING" : "PAUSED";
    await client.models.homeReminder.update({ id: r.id, status: next });
    await loadAll();
  }

  async function handleDelete(r: Reminder) {
    if (!confirm(`Delete "${r.name}"?`)) return;
    await client.models.homeReminder.delete({ id: r.id });
    setReminders((prev) => prev.filter((x) => x.id !== r.id));
  }

  const visibleReminders = useMemo(() => {
    if (showInactive) return reminders;
    return reminders.filter(
      (r) => r.status === "PENDING" || r.status === "PAUSED"
    );
  }, [reminders, showInactive]);

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-2xl font-bold">Reminders</h1>
          </div>
          <Button color="primary" size="sm" startContent={<FaPlus size={12} />} onPress={openCreate}>
            New Reminder
          </Button>
        </div>

        <div className="flex justify-end mb-4">
          <Switch size="sm" isSelected={showInactive} onValueChange={setShowInactive}>
            <span className="text-xs text-default-500">Show cancelled / expired</span>
          </Switch>
        </div>

        {loading && <p className="text-center text-default-400 py-6">Loading…</p>}

        {!loading && visibleReminders.length === 0 && (
          <Card>
            <CardBody className="px-4 py-10 text-center">
              <p className="text-sm text-default-500 mb-2">No active reminders.</p>
              <p className="text-xs text-default-400">
                Create one here, or ask Janet: "remind us every morning at 8am to take our vitamins".
              </p>
            </CardBody>
          </Card>
        )}

        <div className="space-y-2">
          {visibleReminders.map((r) => {
            const items = parseReminderItems(r.items);
            const personName = r.personId
              ? people.find((p) => p.id === r.personId)?.name ?? "?"
              : null;
            const nextFire = new Date(r.scheduledAt);
            return (
              <Card key={r.id} className={r.status !== "PENDING" ? "opacity-70" : ""}>
                <CardHeader className="flex items-start justify-between px-4 pt-3 pb-1 gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <FaBell size={12} className="text-default-500" />
                      <p className="text-sm font-semibold truncate">{r.name}</p>
                      {r.kind && (
                        <Chip size="sm" variant="flat">
                          {r.kind}
                        </Chip>
                      )}
                      <Chip
                        size="sm"
                        variant="flat"
                        color={STATUS_COLORS[r.status ?? "PENDING"] as any}
                      >
                        {r.status}
                      </Chip>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-default-400">
                      {r.targetKind === "PERSON" ? (
                        <span className="flex items-center gap-1">
                          <FaUser size={10} /> {personName}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <FaUsers size={10} /> Group
                        </span>
                      )}
                      <span>·</span>
                      <span>
                        {items.length} item{items.length === 1 ? "" : "s"}
                      </span>
                      <span>·</span>
                      <span>
                        next: {nextFire.toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                      {r.useLlm && (
                        <>
                          <span>·</span>
                          <span className="text-primary-500">LLM</span>
                        </>
                      )}
                    </div>
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
                    <Button size="sm" isIconOnly variant="light" onPress={() => openEdit(r)}>
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
                </CardHeader>
                <CardBody className="px-4 pt-0 pb-3">
                  <div className="space-y-0.5">
                    {items.map((item) => (
                      <div key={item.id} className="text-xs text-default-600">
                        •{" "}
                        <span className="font-medium">{item.name}</span>
                        {item.notes && (
                          <span className="text-default-400"> — {item.notes}</span>
                        )}
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
                </CardBody>
              </Card>
            );
          })}
        </div>

        {/* Create/Edit Modal */}
        <Modal isOpen={modal.isOpen} onOpenChange={modal.onOpenChange} size="2xl" scrollBehavior="inside">
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
                      onChange={(e) => setFormTargetKind(e.target.value as "GROUP" | "PERSON")}
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

                  <Switch size="sm" isSelected={formUseLlm} onValueChange={setFormUseLlm}>
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
      </div>
    </DefaultLayout>
  );
}

