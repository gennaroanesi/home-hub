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
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { useDisclosure } from "@heroui/modal";
import {
  FaArrowLeft,
  FaPen,
  FaPlus,
  FaSearch,
  FaStickyNote,
  FaTrash,
} from "react-icons/fa";

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
  const [filter, setFilter] = useState<"ALL" | NoteParentType | "STANDALONE">(
    "ALL"
  );
  const [search, setSearch] = useState("");
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
    let result = notes;
    if (filter === "STANDALONE") {
      result = result.filter((n) => !n.parentType || !n.parentId);
    } else if (filter !== "ALL") {
      result = result.filter((n) => n.parentType === filter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter((n) => {
        const ptype = n.parentType as NoteParentType | null;
        const parentName = ptype && n.parentId ? parentLabel(n) : "";
        const haystack = [n.title, n.content, parentName]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, filter, search, parents]);

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

  function openCreate() {
    setEditing(null);
    modal.onOpen();
  }

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4 gap-2">
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
                {filtered.length} of {notes.length} notes
              </p>
            </div>
          </div>
          <Button
            size="sm"
            color="primary"
            startContent={<FaPlus size={10} />}
            onPress={openCreate}
          >
            Add note
          </Button>
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          <Input
            size="sm"
            placeholder="Search by title, content, or parent…"
            value={search}
            onValueChange={setSearch}
            startContent={<FaSearch size={12} className="text-default-400" />}
            className="flex-1 min-w-[200px]"
            isClearable
            onClear={() => setSearch("")}
          />
          <Select
            label="Filter"
            size="sm"
            selectedKeys={[filter]}
            onChange={(e) =>
              setFilter(
                (e.target.value || "ALL") as "ALL" | NoteParentType | "STANDALONE"
              )
            }
            className="max-w-[160px]"
          >
            <SelectItem key="ALL">All</SelectItem>
            <SelectItem key="STANDALONE">Standalone</SelectItem>
            <SelectItem key="TASK">Tasks</SelectItem>
            <SelectItem key="EVENT">Events</SelectItem>
            <SelectItem key="TRIP">Trips</SelectItem>
          </Select>
        </div>

        {loading && <p className="text-center text-default-400 py-6">Loading…</p>}

        {!loading && filtered.length === 0 && (
          <Card>
            <CardBody className="text-center py-10 text-default-500">
              <p className="text-sm">
                {notes.length === 0 ? "No notes yet." : "No notes match your search."}
              </p>
              {notes.length === 0 && (
                <p className="text-xs text-default-400 mt-1">
                  Tap "Add note" above, or open a task / event / trip and add one
                  there.
                </p>
              )}
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
