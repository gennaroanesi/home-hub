"use client";

import React, { useState, useRef, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import {
  FaPaperclip,
  FaTrash,
  FaDownload,
  FaFilePdf,
  FaImage,
  FaFile,
  FaFileArchive,
  FaFileAudio,
  FaPlay,
  FaChevronUp,
} from "react-icons/fa";

import { photoUrl, originalPhotoUrl } from "@/lib/image-loader";
import {
  ALLOWED_ATTACHMENT_TYPES,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  attachmentKind,
  normalizeContentType,
  type AttachmentParentType,
} from "@/lib/attachment-types";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Attachment = Schema["homeAttachment"]["type"];

interface AttachmentListProps {
  parentType: AttachmentParentType;
  parentId: string;
  attachments: Attachment[];
  onChanged: () => void; // re-fetch after add/delete
  readOnly?: boolean;
}

function fileIcon(contentType: string | null | undefined) {
  switch (attachmentKind(contentType)) {
    case "image":
      return <FaImage size={14} />;
    case "pdf":
      return <FaFilePdf size={14} />;
    case "audio":
      return <FaFileAudio size={14} />;
    case "archive":
      return <FaFileArchive size={14} />;
    default:
      return <FaFile size={14} />;
  }
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// fetch() can't report upload progress; XHR can, and a phone video can
// take minutes to go up.
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`S3 upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("S3 upload failed (network)"));
    xhr.send(file);
  });
}

export function AttachmentList({
  parentType,
  parentId,
  attachments,
  onChanged,
  readOnly = false,
}: AttachmentListProps) {
  // Null when idle; otherwise which file of how many, and its progress.
  const [progress, setProgress] = useState<{ index: number; total: number; name: string; fraction: number } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");

  const uploadOne = useCallback(
    async (file: File, onProgress: (f: number) => void) => {
      const contentType = normalizeContentType(file.type, file.name);
      const allowed = ALLOWED_ATTACHMENT_TYPES[contentType];
      if (!allowed) throw new Error(`${file.name}: unsupported file type${contentType ? ` (${contentType})` : ""}`);
      const max = ATTACHMENT_MAX_BYTES[allowed.kind];
      if (file.size > max) {
        throw new Error(
          `${file.name} is too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Max for ${allowed.kind} is ${max / 1024 / 1024} MB.`,
        );
      }

      // 1. Get presigned URL
      const presignRes = await fetch("/api/attachments/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentType, parentId, filename: file.name, contentType, sizeBytes: file.size }),
      });
      if (!presignRes.ok) {
        const err = await presignRes.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to get upload URL");
      }
      const { uploadUrl, s3Key, contentType: signedType } = await presignRes.json();

      // 2. Upload directly to S3 (with the exact content type that was signed)
      await putWithProgress(uploadUrl, file, signedType ?? contentType, onProgress);

      // 3. Create the homeAttachment record
      const { errors } = await client.models.homeAttachment.create({
        parentType,
        parentId,
        s3Key,
        filename: file.name,
        contentType: signedType ?? contentType,
        sizeBytes: file.size,
        caption: caption.trim() || null,
        uploadedBy: "ui",
      });
      if (errors?.length) throw new Error(errors[0].message);
    },
    [parentType, parentId, caption],
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;

      const failures: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress({ index: i, total: files.length, name: file.name, fraction: 0 });
        try {
          await uploadOne(file, (fraction) =>
            setProgress({ index: i, total: files.length, name: file.name, fraction }),
          );
        } catch (err: any) {
          console.error("Attachment upload failed:", err);
          failures.push(err.message ?? `${file.name}: upload failed`);
        }
      }

      setProgress(null);
      if (failures.length < files.length) setCaption("");
      // Reset the file input so re-selecting the same file triggers onChange
      if (fileInputRef.current) fileInputRef.current.value = "";
      onChanged();
      if (failures.length) alert(failures.join("\n"));
    },
    [uploadOne, onChanged],
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

  return (
    <div className="space-y-2">
      {/* Existing attachments */}
      {attachments.length > 0 && (
        <div className="space-y-1.5">
          {attachments.map((att) => {
            const kind = attachmentKind(att.contentType);
            const url = originalPhotoUrl(att.s3Key);
            const expanded = expandedId === att.id;
            return (
              <div key={att.id} className="rounded-md bg-default-50 border border-default-200">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  {/* Thumbnail for images, play toggle for video, icon for others */}
                  {kind === "image" ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photoUrl(att.s3Key, 80, 70)}
                        alt={att.caption ?? att.filename}
                        className="w-10 h-10 object-cover rounded"
                      />
                    </a>
                  ) : kind === "video" ? (
                    <button
                      type="button"
                      aria-label={expanded ? "Collapse video" : "Play video"}
                      onClick={() => setExpandedId(expanded ? null : att.id)}
                      className="relative w-10 h-10 shrink-0 rounded overflow-hidden bg-default-200"
                    >
                      {/* First frame as a poster; #t nudges Safari to render one. */}
                      <video
                        src={`${url}#t=0.1`}
                        preload="metadata"
                        muted
                        playsInline
                        className="w-full h-full object-cover pointer-events-none"
                      />
                      <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
                        {expanded ? <FaChevronUp size={10} /> : <FaPlay size={10} />}
                      </span>
                    </button>
                  ) : (
                    <div className="w-10 h-10 shrink-0 flex items-center justify-center bg-default-100 rounded text-default-500">
                      {fileIcon(att.contentType)}
                    </div>
                  )}

                  {/* Filename + caption + size */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{att.caption ?? att.filename}</p>
                    <p className="text-[10px] text-default-400 truncate">
                      {att.caption ? att.filename : ""} {formatSize(att.sizeBytes)}
                    </p>
                  </div>

                  {/* Actions */}
                  <a href={url} target="_blank" rel="noopener noreferrer" download={att.filename}>
                    <Button size="sm" isIconOnly variant="light" as="span" aria-label="Download">
                      <FaDownload size={10} />
                    </Button>
                  </a>
                  {!readOnly && (
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      color="danger"
                      aria-label="Delete"
                      onPress={() => handleDelete(att)}
                    >
                      <FaTrash size={10} />
                    </Button>
                  )}
                </div>

                {kind === "audio" && (
                  <div className="px-2 pb-2">
                    <audio controls preload="none" src={url} className="w-full h-8" />
                  </div>
                )}
                {kind === "video" && expanded && (
                  <div className="px-2 pb-2">
                    <video controls autoPlay playsInline src={url} className="w-full max-h-[60vh] rounded bg-black" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Upload control */}
      {!readOnly && (
        <div className="space-y-1">
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
              isDisabled={!!progress}
              onPress={() => fileInputRef.current?.click()}
            >
              {progress ? "Uploading…" : "Attach"}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>
          {progress && (
            <div>
              <p className="text-[10px] text-default-500 truncate">
                {progress.total > 1 ? `${progress.index + 1}/${progress.total} · ` : ""}
                {progress.name} · {Math.round(progress.fraction * 100)}%
              </p>
              <div className="h-1 rounded bg-default-200 overflow-hidden">
                <div className="h-full bg-primary transition-[width]" style={{ width: `${progress.fraction * 100}%` }} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
