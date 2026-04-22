"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Switch } from "@heroui/switch";
import { useDisclosure } from "@heroui/modal";
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
  FaLink,
} from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { ReminderModal } from "@/components/reminder-modal";
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

const PARENT_LABELS: Record<string, string> = {
  TASK: "Task",
  EVENT: "Event",
  TRIP: "Trip",
};

export default function RemindersPage() {
  const router = useRouter();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);

  const modal = useDisclosure();
  const [editing, setEditing] = useState<Reminder | null>(null);

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
            const parentLabel = r.parentType ? PARENT_LABELS[r.parentType] : null;
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
                      {parentLabel && (
                        <Chip
                          size="sm"
                          variant="flat"
                          color="primary"
                          startContent={<FaLink size={8} className="ml-1" />}
                        >
                          {parentLabel}
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

        <ReminderModal
          isOpen={modal.isOpen}
          onOpenChange={modal.onOpenChange}
          people={people}
          editing={editing}
          onSaved={() => loadAll()}
        />
      </div>
    </DefaultLayout>
  );
}
