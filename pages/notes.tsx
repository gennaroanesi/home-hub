"use client";

// Standalone /notes page. Lists every homeNote across the household,
// most-recently-edited first, with a parent-type filter. Click a note
// to edit; click the parent badge to jump to the parent record. Mirrors
// /attachments and /reminders in look/structure.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Select, SelectItem } from "@heroui/select";
import { useDisclosure } from "@heroui/modal";
import { FaArrowLeft, FaPen, FaStickyNote, FaTrash } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { NoteModal, type NoteParentType } from "@/components/note-modal";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Note = Schema["homeNote"]["type"];

const Markdown = dynamic(() => import("@uiw/react-markdown-preview"), {
  ssr: false,
  loading: () => null,
});

// Parent-type filter labels + colors. Mirrors the linked-parent chip on
// /reminders so users see consistent badges across pages.
const PARENT_LABELS: Record<NoteParentType, string> = {
  TASK: "Task",
  EVENT: "Event",
  TRIP: "Trip",
};
const PARENT_COLORS: Record<NoteParentType, "primary" | "secondary" | "warning"> = {
  TASK: "primary",
  EVENT: "secondary",
  TRIP: "warning",
};

interface ParentLookup {
  // parentId → human label (task title, event title, trip name)
  task: Map<string, string>;
  event: Map<string, string>;
  trip: Map<string, string>;
}

export default function NotesPage() {
  const router = useRouter();
  const [notes, setNotes] = useState<Note[]>([]);
  const [parents, setParents] = useState<ParentLookup>({
    task: new Map(),
    event: new Map(),
    trip: new Map(),
  });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"ALL" | NoteParentType>("ALL");
  const [editing, setEditing] = useState<Note | null>(null);
  const modal = useDisclosure();

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
        await loadAll();
      } catch {
        router.push("/login");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    // Pull notes + the three parent collections in parallel so we can
    // resolve parent labels without N round-trips.
    const [notesRes, tasksRes, eventsRes, tripsRes] = await Promise.all([
      client.models.homeNote.list(),
      client.models.homeTask.list(),
      client.models.homeCalendarEvent.list(),
      client.models.homeTrip.list(),
    ]);
    const sorted = [...(notesRes.data ?? [])].sort(
      (a, b) =>
        new Date(b.updatedAt ?? b.createdAt).getTime() -
        new Date(a.updatedAt ?? a.createdAt).getTime()
    );
    setNotes(sorted);
    setParents({
      task: new Map((tasksRes.data ?? []).map((t) => [t.id, t.title])),
      event: new Map((eventsRes.data ?? []).map((e) => [e.id, e.title])),
      trip: new Map((tripsRes.data ?? []).map((t) => [t.id, t.name])),
    });
    setLoading(false);
  }, []);

  const filtered = useMemo(() => {
    if (filter === "ALL") return notes;
    return notes.filter((n) => n.parentType === filter);
  }, [notes, filter]);

  function parentLabel(n: Note): string {
    if (!n.parentType || !n.parentId) return "—";
    const map = parents[n.parentType.toLowerCase() as keyof ParentLookup];
    return map?.get(n.parentId) ?? "(unknown)";
  }

  async function handleDelete(n: Note) {
    if (!confirm("Delete this note?")) return;
    await client.models.homeNote.delete({ id: n.id });
    setNotes((prev) => prev.filter((x) => x.id !== n.id));
  }

  function openEdit(n: Note) {
    setEditing(n);
    modal.onOpen();
  }

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <FaStickyNote className="text-default-500" />
                Notes
              </h1>
              <p className="text-xs text-default-500">
                Markdown notes attached to tasks, events, and trips.
              </p>
            </div>
          </div>
          <Select
            label="Filter"
            size="sm"
            selectedKeys={[filter]}
            onChange={(e) => setFilter(e.target.value as "ALL" | NoteParentType)}
            className="max-w-[140px]"
          >
            <SelectItem key="ALL">All</SelectItem>
            <SelectItem key="TASK">Tasks</SelectItem>
            <SelectItem key="EVENT">Events</SelectItem>
            <SelectItem key="TRIP">Trips</SelectItem>
          </Select>
        </div>

        {loading && <p className="text-center text-default-400 py-6">Loading…</p>}

        {!loading && filtered.length === 0 && (
          <Card>
            <CardBody className="text-center py-10 text-default-500">
              <p className="text-sm">No notes yet.</p>
              <p className="text-xs text-default-400 mt-1">
                Open a task, event, or trip and tap "Add note" to start.
              </p>
            </CardBody>
          </Card>
        )}

        <div className="space-y-2">
          {filtered.map((n) => {
            const ptype = n.parentType as NoteParentType | null;
            return (
              <Card key={n.id}>
                <CardHeader className="flex items-start justify-between px-4 pt-3 pb-1 gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {n.title && (
                        <p className="text-sm font-semibold truncate">{n.title}</p>
                      )}
                      {ptype && (
                        <Chip
                          size="sm"
                          variant="flat"
                          color={PARENT_COLORS[ptype]}
                        >
                          {PARENT_LABELS[ptype]}: {parentLabel(n)}
                        </Chip>
                      )}
                    </div>
                    <p className="text-xs text-default-400 mt-0.5">
                      Updated{" "}
                      {new Date(n.updatedAt ?? n.createdAt).toLocaleString(
                        undefined,
                        {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        }
                      )}
                    </p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      onPress={() => openEdit(n)}
                    >
                      <FaPen size={10} />
                    </Button>
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      color="danger"
                      onPress={() => handleDelete(n)}
                    >
                      <FaTrash size={10} />
                    </Button>
                  </div>
                </CardHeader>
                <CardBody className="px-4 pt-0 pb-3">
                  <div data-color-mode="light" className="text-sm">
                    <Markdown source={n.content ?? ""} />
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>

        <NoteModal
          isOpen={modal.isOpen}
          onOpenChange={modal.onOpenChange}
          editing={editing}
          onSaved={() => loadAll()}
        />
      </div>
    </DefaultLayout>
  );
}
