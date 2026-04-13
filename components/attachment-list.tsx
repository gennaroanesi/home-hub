"use client";

import React, { useState, useRef, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { FaPaperclip, FaTrash, FaDownload, FaFilePdf, FaImage, FaFile } from "react-icons/fa";

import { photoUrl, originalPhotoUrl } from "@/lib/image-loader";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Attachment = Schema["homeAttachment"]["type"];
type ParentType = "TRIP" | "TRIP_LEG" | "RESERVATION" | "EVENT" | "TASK" | "BILL";

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

const ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "application/pdf",
].join(",");

interface AttachmentListProps {
  parentType: ParentType;
  parentId: string;
  attachments: Attachment[];
  onChanged: () => void; // re-fetch after add/delete
  readOnly?: boolean;
}

function fileIcon(contentType: string | null | undefined) {
  if (!contentType) return <FaFile size={14} />;
  if (contentType.startsWith("image/")) return <FaImage size={14} />;
  if (contentType === "application/pdf") return <FaFilePdf size={14} />;
  return <FaFile size={14} />;
}

function isImage(contentType: string | null | undefined): boolean {
  return !!contentType?.startsWith("image/");
}

export function AttachmentList({
  parentType,
  parentId,
  attachments,
  onChanged,
  readOnly = false,
}: AttachmentListProps) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (file.size > MAX_SIZE_BYTES) {
        alert(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 25 MB.`);
        return;
      }

      setUploading(true);
      try {
        // 1. Get presigned URL
        const presignRes = await fetch("/api/attachments/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentType,
            parentId,
            filename: file.name,
            contentType: file.type,
          }),
        });
        if (!presignRes.ok) {
          const err = await presignRes.json();
          throw new Error(err.error ?? "Failed to get upload URL");
        }
        const { uploadUrl, s3Key } = await presignRes.json();

        // 2. Upload directly to S3
        const uploadRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!uploadRes.ok) throw new Error("S3 upload failed");

        // 3. Create the homeAttachment record
        await client.models.homeAttachment.create({
          parentType,
          parentId,
          s3Key,
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          caption: caption.trim() || null,
          uploadedBy: "ui",
        });

        setCaption("");
        onChanged();
      } catch (err: any) {
        console.error("Attachment upload failed:", err);
        alert(err.message ?? "Upload failed");
      } finally {
        setUploading(false);
        // Reset the file input so re-selecting the same file triggers onChange
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [parentType, parentId, caption, onChanged]
  );

  async function handleDelete(attachment: Attachment) {
    if (!confirm(`Delete "${attachment.caption || attachment.filename}"?`)) return;
    try {
      await client.models.homeAttachment.delete({ id: attachment.id });
      onChanged();
    } catch (err) {
      console.error("Failed to delete attachment:", err);
    }
    // Note: we don't delete the S3 object — orphaned files are cheap and
    // keeping them avoids needing S3 permissions on the frontend. A cleanup
    // sweep can be added later if storage becomes a concern.
  }

  function formatSize(bytes: number | null | undefined): string {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="space-y-2">
      {/* Existing attachments */}
      {attachments.length > 0 && (
        <div className="space-y-1.5">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-default-50 border border-default-200"
            >
              {/* Thumbnail for images, icon for others */}
              {isImage(att.contentType) ? (
                <a
                  href={originalPhotoUrl(att.s3Key)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoUrl(att.s3Key, 80, 70)}
                    alt={att.caption ?? att.filename}
                    className="w-10 h-10 object-cover rounded"
                  />
                </a>
              ) : (
                <div className="w-10 h-10 flex items-center justify-center bg-default-100 rounded text-default-500">
                  {fileIcon(att.contentType)}
                </div>
              )}

              {/* Filename + caption + size */}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">
                  {att.caption ?? att.filename}
                </p>
                <p className="text-[10px] text-default-400 truncate">
                  {att.caption ? att.filename : ""}{" "}
                  {formatSize(att.sizeBytes)}
                </p>
              </div>

              {/* Actions */}
              <a
                href={originalPhotoUrl(att.s3Key)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button size="sm" isIconOnly variant="light" as="span">
                  <FaDownload size={10} />
                </Button>
              </a>
              {!readOnly && (
                <Button
                  size="sm"
                  isIconOnly
                  variant="light"
                  color="danger"
                  onPress={() => handleDelete(att)}
                >
                  <FaTrash size={10} />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Upload control */}
      {!readOnly && (
        <div className="flex gap-2 items-end">
          <Input
            size="sm"
            placeholder="Caption (optional)"
            value={caption}
            onValueChange={setCaption}
            className="flex-1"
          />
          <Button
            size="sm"
            variant="flat"
            startContent={<FaPaperclip size={12} />}
            isDisabled={uploading}
            onPress={() => fileInputRef.current?.click()}
          >
            {uploading ? "Uploading…" : "Attach"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>
      )}
    </div>
  );
}
