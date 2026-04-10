"use client";

import React, { useState, useRef } from "react";
import { generateClient } from "aws-amplify/data";
import ExifReader from "exifreader";
import { Button } from "@heroui/button";
import { FaUpload } from "react-icons/fa";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

interface PhotoUploaderProps {
  tripId?: string;
  uploadedBy?: string;
  onUploaded?: () => void; // called after each photo is registered
}

interface UploadProgress {
  filename: string;
  status: "pending" | "uploading" | "registering" | "done" | "error";
  error?: string;
}

function parseExifDate(dateString?: string, tzOffset = 0): string | null {
  if (!dateString) return null;
  try {
    const parts = dateString.split(/\D/).map((p) => parseInt(p, 10));
    const [y, mo, d, h, mi, s] = parts;
    const utcMs = Date.UTC(y, mo - 1, d, h - tzOffset, mi, s);
    return new Date(utcMs).toISOString();
  } catch {
    return null;
  }
}

async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image dimensions"));
    };
    img.src = url;
  });
}

export function PhotoUploader({ tripId, uploadedBy, onUploaded }: PhotoUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [uploading, setUploading] = useState(false);

  async function uploadFile(file: File, setStatus: (s: UploadProgress) => void) {
    try {
      setStatus({ filename: file.name, status: "uploading" });

      // 1. Extract EXIF + dimensions client-side
      let exif: any = {};
      let takenAt: string | null = null;
      try {
        const buffer = await file.arrayBuffer();
        exif = ExifReader.load(buffer);
        takenAt = parseExifDate(
          (exif.DateTimeOriginal as any)?.description,
          parseInt((exif.OffsetTimeOriginal as any)?.description ?? "0", 10)
        );
      } catch {
        // HEIC or unsupported — continue without EXIF
      }
      let dimensions = { width: 0, height: 0 };
      try {
        dimensions = await readImageDimensions(file);
      } catch {
        // HEIC can't be displayed by the browser for dimension extraction;
        // the CloudFront loader will still serve them fine
      }

      // 2. Get presigned upload URL
      const urlRes = await fetch("/api/photos/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: file.type, tripId }),
      });
      if (!urlRes.ok) throw new Error(`Upload URL error: ${urlRes.status}`);
      const { uploadUrl, s3key } = await urlRes.json();

      // 3. PUT the file directly to S3
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error(`S3 upload failed: ${putRes.status}`);

      setStatus({ filename: file.name, status: "registering" });

      // 4. Register the photo record via Amplify data client
      await client.models.homePhoto.create({
        s3key,
        originalFilename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        width: dimensions.width || null,
        height: dimensions.height || null,
        takenAt,
        exifData: Object.keys(exif).length > 0 ? JSON.stringify(exif) : null,
        tripId: tripId ?? null,
        uploadedBy: uploadedBy ?? null,
      });

      setStatus({ filename: file.name, status: "done" });
      onUploaded?.();
    } catch (err: any) {
      setStatus({
        filename: file.name,
        status: "error",
        error: err?.message ?? "Unknown error",
      });
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    setUploading(true);
    setProgress(arr.map((f) => ({ filename: f.name, status: "pending" })));

    // Upload in parallel, max 3 at a time to avoid overwhelming bandwidth
    const concurrency = 3;
    let idx = 0;
    async function worker() {
      while (idx < arr.length) {
        const current = idx++;
        await uploadFile(arr[current], (s) => {
          setProgress((prev) => {
            const next = [...prev];
            next[current] = s;
            return next;
          });
        });
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    setUploading(false);
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <Button
        size="sm"
        variant="flat"
        startContent={<FaUpload size={12} />}
        onPress={() => fileInputRef.current?.click()}
        isDisabled={uploading}
      >
        {uploading ? "Uploading…" : "Upload photos"}
      </Button>

      {progress.length > 0 && (
        <div className="mt-3 space-y-1 text-xs">
          {progress.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className={
                  p.status === "done"
                    ? "text-success"
                    : p.status === "error"
                    ? "text-danger"
                    : "text-default-500"
                }
              >
                {p.status === "done"
                  ? "✓"
                  : p.status === "error"
                  ? "✕"
                  : p.status === "pending"
                  ? "…"
                  : "↑"}
              </span>
              <span className="truncate flex-1">{p.filename}</span>
              {p.error && <span className="text-danger">{p.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
