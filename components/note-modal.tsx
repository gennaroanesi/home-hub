"use client";

// Create / edit modal for homeNote rows. Wraps @uiw/react-md-editor.
// The editor is SSR-incompatible (touches `window` on import), so we
// load it via next/dynamic with ssr:false. CSS is imported globally
// in pages/_app.tsx.
//
// Same prop shape as ReminderModal: takes `parentType` + `parentId`
// for create mode, or `editing` for edit mode. Multi-note per parent
// is the default — caller renders one modal and reopens it as needed.
// When both parentType and parentId are omitted in create mode the
// note is saved standalone (used by the /notes page).

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/modal";
import { addToast } from "@heroui/react";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Note = Schema["homeNote"]["type"];
export type NoteParentType = "TASK" | "EVENT" | "TRIP";

// Editor is client-only — its `window` references break SSR
// hydration if imported at module scope.
const MDEditor = dynamic(() => import("@uiw/react-md-editor"), {
  ssr: false,
  loading: () => <div className="h-40 bg-default-100 rounded-md animate-pulse" />,
});

interface NoteModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required when creating a new note. Ignored when editing. */
  parentType?: NoteParentType;
  parentId?: string;
  /** Existing note when editing; null/undefined means create. */
  editing?: Note | null;
  /** Fired after a successful create/update; parent refreshes its list. */
  onSaved?: (noteId: string) => void;
}

export function NoteModal({
  isOpen,
  onOpenChange,
  parentType,
  parentId,
  editing,
  onSaved,
}: NoteModalProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    if (editing) {
      setTitle(editing.title ?? "");
      setContent(editing.content ?? "");
    } else {
      setTitle("");
      setContent("");
    }
  }, [isOpen, editing]);

  async function save(onClose: () => void) {
    if (!content.trim()) {
      addToast({ title: "Note can't be empty", color: "warning" });
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const { errors } = await client.models.homeNote.update({
          id: editing.id,
          title: title.trim() || null,
          content,
        });
        if (errors?.length) throw new Error(errors[0].message);
        addToast({ title: "Note updated", color: "success" });
        onClose();
        onSaved?.(editing.id);
      } else {
        // Standalone notes (no parent) are allowed — both fields stay null.
        // When linking, both parentType and parentId must come together.
        if ((parentType && !parentId) || (!parentType && parentId)) {
          throw new Error("parentType and parentId must be provided together");
        }
        const { data, errors } = await client.models.homeNote.create({
          parentType: parentType ?? null,
          parentId: parentId ?? null,
          title: title.trim() || null,
          content,
          createdBy: "ui",
        });
        if (errors?.length) throw new Error(errors[0].message);
        addToast({ title: "Note saved", color: "success" });
        onClose();
        if (data?.id) onSaved?.(data.id);
      }
    } catch (err: any) {
      addToast({
        title: "Save failed",
        description: err?.message ?? String(err),
        color: "danger",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="3xl"
      scrollBehavior="inside"
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{editing ? "Edit note" : "New note"}</ModalHeader>
            <ModalBody>
              <Input
                label="Title (optional)"
                placeholder="WiFi password, packing list, …"
                value={title}
                onValueChange={setTitle}
              />
              <div data-color-mode="light">
                <MDEditor
                  value={content}
                  onChange={(v) => setContent(v ?? "")}
                  height={360}
                  preview="edit"
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button
                color="primary"
                isLoading={saving}
                onPress={() => save(onClose)}
              >
                {editing ? "Save" : "Create"}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
