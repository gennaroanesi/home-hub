"use client";

// Notes for the week on /week: rendered markdown, edited in place (click the
// text or "Edit"), with its own Save. Saving goes through set_week_notes, so
// it never touches the "reviewed" mark; mount with key={weekStart} so a
// half-typed draft is dropped when the week changes.

import React, { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@heroui/button";
import { FaPen } from "react-icons/fa";

import { Markdown } from "@/components/markdown";

// The editor touches `window` on import; client-only like NoteModal.
const MDEditor = dynamic(() => import("@uiw/react-md-editor"), {
  ssr: false,
  loading: () => <div className="h-40 bg-default-100 rounded-md animate-pulse" />,
});

export function WeekNotes({ value, onSave }: { value: string; onSave: (notes: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null); // null = viewing
  const [busy, setBusy] = useState(false);
  const editing = draft !== null;
  const dirty = editing && draft !== value;

  const save = async () => {
    if (draft === null) return;
    if (!dirty) return setDraft(null);
    setBusy(true);
    const ok = await onSave(draft);
    setBusy(false);
    if (ok) setDraft(null);
  };

  if (editing) {
    return (
      <div
        className="flex-1 min-w-0 flex flex-col gap-2"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
          }
        }}
      >
        <span className="text-xs text-default-500">Notes for the week</span>
        <div data-color-mode="light">
          <MDEditor value={draft} onChange={(v) => setDraft(v ?? "")} height={220} preview="edit" autoFocus autoFocusEnd />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-default-400 mr-auto">Markdown · ⌘↩ saves, Esc cancels</span>
          <Button size="sm" variant="light" onPress={() => setDraft(null)} isDisabled={busy}>
            Cancel
          </Button>
          <Button size="sm" color="primary" isDisabled={!dirty} isLoading={busy} onPress={save}>
            Save notes
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-default-500">Notes for the week</span>
        <Button size="sm" variant="light" className="h-7 min-w-0 px-2 text-xs" startContent={<FaPen className="text-[10px]" />} onPress={() => setDraft(value)}>
          {value ? "Edit" : "Add notes"}
        </Button>
      </div>
      {value ? (
        <div
          role="button"
          tabIndex={0}
          title="Click to edit"
          onClick={() => setDraft(value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setDraft(value);
          }}
          className="cursor-text rounded-md -mx-2 px-2 py-1 hover:bg-default-100"
        >
          <Markdown content={value} />
        </div>
      ) : (
        <button type="button" onClick={() => setDraft("")} className="text-sm text-default-400 text-left px-0 py-1">
          Cris drives Thursday; book Dolce for Wednesday…
        </button>
      )}
    </div>
  );
}
