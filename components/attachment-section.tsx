"use client";

import React, { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";

import { AttachmentList } from "@/components/attachment-list";
import { listAllPages } from "@/lib/list-all";
import type { AttachmentParentType } from "@/lib/attachment-types";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Attachment = Schema["homeAttachment"]["type"];

interface AttachmentSectionProps {
  parentType: AttachmentParentType;
  /** Uploads attach here. */
  parentId: string;
  /**
   * Also list attachments hanging off these parents (e.g. every row of a
   * lab panel, where uploads land on the first row).
   */
  alsoListParentIds?: string[];
  readOnly?: boolean;
}

/**
 * Self-loading attachment section. Fetches its own attachment list on
 * mount and after any add/delete. Drop this into any detail view
 * without the parent needing to manage attachment state.
 */
export function AttachmentSection({
  parentType,
  parentId,
  alsoListParentIds,
  readOnly,
}: AttachmentSectionProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const parentKey = [parentId, ...(alsoListParentIds ?? [])].join(",");

  const load = useCallback(async () => {
    const ids = Array.from(new Set(parentKey.split(",")));
    try {
      // Paged scan, not `limit` — `limit` is the scan page size, so a
      // filtered list with a limit silently misses rows once the table
      // (which also holds every WhatsApp message attachment) grows.
      const rows = await listAllPages<Attachment>(client.models.homeAttachment, {
        filter: ids.length === 1
          ? { parentId: { eq: ids[0] } }
          : { or: ids.map((id) => ({ parentId: { eq: id } })) },
      });
      setAttachments(
        rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
      );
    } catch {
      setAttachments([]);
    }
  }, [parentKey]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AttachmentList
      parentType={parentType}
      parentId={parentId}
      attachments={attachments}
      onChanged={load}
      readOnly={readOnly}
    />
  );
}
