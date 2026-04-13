"use client";

import React, { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";

import { AttachmentList } from "@/components/attachment-list";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Attachment = Schema["homeAttachment"]["type"];
type ParentType = "TRIP" | "TRIP_LEG" | "RESERVATION" | "EVENT" | "TASK" | "BILL";

interface AttachmentSectionProps {
  parentType: ParentType;
  parentId: string;
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
  readOnly,
}: AttachmentSectionProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const load = useCallback(async () => {
    try {
      const { data } = await client.models.homeAttachment.list({
        filter: { parentId: { eq: parentId } },
        limit: 200,
      });
      setAttachments(
        (data ?? []).sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        )
      );
    } catch {
      setAttachments([]);
    }
  }, [parentId]);

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
