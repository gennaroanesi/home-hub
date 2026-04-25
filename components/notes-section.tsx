"use client";

// Drop-in notes panel for the detail view of a task / event / trip.
// Mirrors the RemindersSection pattern: takes parentType + parentId,
// lists notes linked via parentId, opens NoteModal for create/edit/
// delete. Multi-note per parent.
//
// When `parentId` is null/undefined (e.g. a brand-new task before
// first save), an `onBeforeAdd` callback can provision the parent
// inline before the note modal opens — same convention RemindersSection
// uses.

import React, { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { useDisclosure } from "@heroui/modal";
import { FaPen, FaPlus, FaStickyNote, FaTrash } from "react-icons/fa";

import { NoteModal, type NoteParentType } from "@/components/note-modal";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Note = Schema["homeNote"]["type"];

// Markdown renderer is ESM-only and pulls in highlight.js — load it
// client-side only and keep it out of the SSR bundle.
const Markdown = dynamic(() => import("@uiw/react-markdown-preview"), {
  ssr: false,
  loading: () => null,
});

interface NotesSectionProps {
  parentType: NoteParentType;
  /** ID of the parent record. */
  parentId: string | null | undefined;
  /** Optional heading override. Defaults to "Notes". */
  title?: string;
  /**
   * If `parentId` is falsy when "+ Add" is clicked, this callback is
   * invoked to mint the parent record on the fly. Returns the new id
   * (or null to abort). Lets the section appear on create forms.
   */
  onBeforeAdd?: () => Promise<string | null>;
}

export function NotesSection({
  parentType,
  parentId,
  title = "Notes",
  onBeforeAdd,
}: NotesSectionProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Note | null>(null);
  // Stash a freshly-minted parentId from onBeforeAdd so the modal we're
  // about to open knows what to link against — the parent prop won't
  // re-render synchronously.
  const [pendingParentId, setPendingParentId] = useState<string | null>(null);
  const effectiveParentId = parentId || pendingParentId;
  const modal = useDisclosure();

  const load = useCallback(async () => {
    if (!parentId) {
      setNotes([]);
      return;
    }
    setLoading(true);
    const { data } = await client.models.homeNote.list({
      filter: { parentId: { eq: parentId } },
    });
    const sorted = [...(data ?? [])].sort(
      (a, b) =>
        new Date(b.updatedAt ?? b.createdAt).getTime() -
        new Date(a.updatedAt ?? a.createdAt).getTime()
    );
    setNotes(sorted);
    setLoading(false);
  }, [parentId]);

  useEffect(() => {
    load();
  }, [load]);

  async function openCreate() {
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

  function openEdit(n: Note) {
    setEditing(n);
    modal.onOpen();
  }

  async function handleDelete(n: Note) {
    if (!confirm("Delete this note?")) return;
    await client.models.homeNote.delete({ id: n.id });
    setNotes((prev) => prev.filter((x) => x.id !== n.id));
  }

  if (!parentId && !onBeforeAdd) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium flex items-center gap-2">
          <FaStickyNote size={12} className="text-default-500" />
          {title}
        </p>
        <p className="text-xs text-default-400">Save first to add notes.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium flex items-center gap-2">
          <FaStickyNote size={12} className="text-default-500" />
          {title}
          {notes.length > 0 && (
            <span className="text-xs text-default-400">({notes.length})</span>
          )}
        </p>
        <Button
          size="sm"
          variant="flat"
          startContent={<FaPlus size={10} />}
          onPress={openCreate}
        >
          Add note
        </Button>
      </div>

      {loading && <p className="text-xs text-default-400">Loading…</p>}
      {!loading && notes.length === 0 && (
        <p className="text-xs text-default-400">No notes yet.</p>
      )}

      <div className="space-y-2">
        {notes.map((n) => (
          <div
            key={n.id}
            className="border border-default-200 rounded-md p-3 bg-default-50"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                {n.title && (
                  <p className="text-sm font-medium truncate">{n.title}</p>
                )}
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
            </div>
            <div data-color-mode="light" className="text-sm">
              <Markdown source={n.content ?? ""} />
            </div>
          </div>
        ))}
      </div>

      <NoteModal
        isOpen={modal.isOpen}
        onOpenChange={modal.onOpenChange}
        parentType={parentType}
        parentId={effectiveParentId ?? undefined}
        editing={editing}
        onSaved={() => load()}
      />
    </div>
  );
}
