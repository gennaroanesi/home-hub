"use client";

import React, { useState, useRef, useEffect } from "react";
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
  // Notifies the parent when a batch starts (true) and finishes (false).
  // Useful for disabling Save buttons while uploads are in flight.
  onUploadingChange?: (uploading: boolean) => void;
  // "button"  → just the button (default, used in headers)
  // "dropzone" → big visible drop zone with a button inside
  variant?: "button" | "dropzone";
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

// Slim EXIF down to a small JSON object before storing. ExifReader's full
// output is huge (often 100+ KB) because it includes embedded thumbnails
// and per-tag metadata, which blows past AppSync's 256 KB resolver limit.
// We only keep tags that are actually useful for display/filtering.
const EXIF_KEEP_FIELDS: string[] = [
  "DateTimeOriginal",
  "OffsetTimeOriginal",
  "Make",
  "Model",
  "LensModel",
  "FocalLength",
  "FNumber",
  "ExposureTime",
  "ISOSpeedRatings",
  "Orientation",
  "GPSLatitude",
  "GPSLongitude",
  "GPSLatitudeRef",
  "GPSLongitudeRef",
  "GPSAltitude",
];

function slimExif(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of EXIF_KEEP_FIELDS) {
    const tag = raw[key];
    if (tag && typeof tag === "object" && "description" in tag) {
      out[key] = String(tag.description);
    }
  }
  return out;
}

interface ExifGps {
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
}

// Extract decimal-degree GPS coordinates from ExifReader output. ExifReader
// provides a friendly `description` field that's already in decimal degrees,
// but it's always positive — the sign comes from GPSLatitudeRef ("N"/"S")
// and GPSLongitudeRef ("E"/"W").
function extractGps(raw: any): ExifGps {
  const result: ExifGps = { latitude: null, longitude: null, altitude: null };
  if (!raw || typeof raw !== "object") return result;

  const latTag = raw.GPSLatitude;
  const lonTag = raw.GPSLongitude;
  const latRef = raw.GPSLatitudeRef?.value?.[0] ?? raw.GPSLatitudeRef?.description;
  const lonRef = raw.GPSLongitudeRef?.value?.[0] ?? raw.GPSLongitudeRef?.description;

  if (latTag?.description !== undefined) {
    const num = parseFloat(String(latTag.description));
    if (!Number.isNaN(num)) {
      result.latitude = latRef === "S" ? -Math.abs(num) : Math.abs(num);
    }
  }
  if (lonTag?.description !== undefined) {
    const num = parseFloat(String(lonTag.description));
    if (!Number.isNaN(num)) {
      result.longitude = lonRef === "W" ? -Math.abs(num) : Math.abs(num);
    }
  }
  const altTag = raw.GPSAltitude;
  if (altTag?.description !== undefined) {
    const num = parseFloat(String(altTag.description));
    if (!Number.isNaN(num)) result.altitude = num;
  }

  return result;
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

export function PhotoUploader({
  tripId,
  uploadedBy,
  onUploaded,
  onUploadingChange,
  variant = "button",
}: PhotoUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    onUploadingChange?.(uploading);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploading]);

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
      const slimmed = slimExif(exif);
      const gps = extractGps(exif);
      const { data, errors } = await client.models.homePhoto.create({
        s3key,
        originalFilename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        width: dimensions.width || null,
        height: dimensions.height || null,
        takenAt,
        latitude: gps.latitude,
        longitude: gps.longitude,
        altitude: gps.altitude,
        exifData: Object.keys(slimmed).length > 0 ? JSON.stringify(slimmed) : null,
        tripId: tripId ?? null,
        uploadedBy: uploadedBy ?? null,
      });
      if (errors && errors.length > 0) {
        console.error("homePhoto.create errors", errors);
        throw new Error(errors[0].message ?? "Failed to register photo");
      }
      if (!data) {
        throw new Error("Photo registration returned no data");
      }

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
    console.log(`[PhotoUploader] handleFiles received ${arr.length} file(s):`, arr.map((f) => f.name));
    setUploading(true);
    // Append to existing progress (not replace) so previous batches stay visible
    const startIdx = progress.length;
    setProgress((prev) => [
      ...prev,
      ...arr.map((f) => ({ filename: f.name, status: "pending" as const })),
    ]);

    // Upload in parallel, max 3 at a time to avoid overwhelming bandwidth
    const concurrency = 3;
    let idx = 0;
    async function worker() {
      while (idx < arr.length) {
        const current = idx++;
        const slot = startIdx + current;
        await uploadFile(arr[current], (s) => {
          setProgress((prev) => {
            const next = [...prev];
            next[slot] = s;
            return next;
          });
        });
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    setUploading(false);
    // Reset the file input so re-selecting the same files still fires change
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!isDragging) setIsDragging(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) handleFiles(files);
  }

  const hiddenInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      onChange={(e) => handleFiles(e.target.files)}
    />
  );

  const progressList = progress.length > 0 && (
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
  );

  if (variant === "dropzone") {
    return (
      <div>
        {hiddenInput}
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-md px-6 py-8 text-center cursor-pointer transition-colors ${
            isDragging
              ? "border-primary bg-primary/10"
              : "border-default-300 hover:border-default-400 bg-default-50"
          }`}
        >
          <FaUpload size={20} className="mx-auto text-default-400 mb-2" />
          <p className="text-sm text-default-600">
            {uploading ? "Uploading…" : "Drag photos here or click to select"}
          </p>
          <p className="text-xs text-default-400 mt-1">JPEG, PNG, HEIC, WebP — multiple files OK</p>
        </div>
        {progressList}
      </div>
    );
  }

  // Default "button" variant — drag-and-drop is also wired so the user can
  // drop on the button if they want. The wrapping div has no extra styling
  // so it doesn't disturb existing headers.
  return (
    <div onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {hiddenInput}
      <Button
        size="sm"
        variant="flat"
        startContent={<FaUpload size={12} />}
        onPress={() => fileInputRef.current?.click()}
        isDisabled={uploading}
        className={isDragging ? "ring-2 ring-primary" : ""}
      >
        {uploading ? "Uploading…" : "Upload photos"}
      </Button>
      {progressList}
    </div>
  );
}
