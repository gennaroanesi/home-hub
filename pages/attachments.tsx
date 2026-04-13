"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import {
  FaArrowLeft,
  FaDownload,
  FaTrash,
  FaFilePdf,
  FaImage,
  FaFile,
  FaSearch,
} from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { photoUrl, originalPhotoUrl } from "@/lib/image-loader";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Attachment = Schema["homeAttachment"]["type"];

const ALL = "all";

/** Friendly labels for parent types. */
const PARENT_TYPE_LABELS: Record<string, string> = {
  TRIP: "Trip",
  TRIP_LEG: "Trip Leg",
  RESERVATION: "Reservation",
  EVENT: "Event",
  TASK: "Task",
  BILL: "Bill",
};

const PARENT_TYPE_COLORS: Record<string, string> = {
  TRIP: "primary",
  TRIP_LEG: "primary",
  RESERVATION: "secondary",
  EVENT: "success",
  TASK: "warning",
  BILL: "danger",
};

function fileIcon(contentType: string | null | undefined) {
  if (!contentType) return <FaFile size={14} />;
  if (contentType.startsWith("image/")) return <FaImage size={14} />;
  if (contentType === "application/pdf") return <FaFilePdf size={14} />;
  return <FaFile size={14} />;
}

function isImage(contentType: string | null | undefined): boolean {
  return !!contentType?.startsWith("image/");
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Info about a parent entity for display. */
interface ParentInfo {
  type: string;
  name: string;
  href?: string; // link to the detail page
}

export default function AttachmentsPage() {
  const router = useRouter();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [parentMap, setParentMap] = useState<Record<string, ParentInfo>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState(ALL);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      await getCurrentUser();
      await loadAll();
    } catch {
      router.push("/login");
    }
  }

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch attachments + all potential parent entities in parallel
      const [
        attachRes,
        tripsRes,
        legsRes,
        reservationsRes,
        eventsRes,
        tasksRes,
        billsRes,
      ] = await Promise.all([
        client.models.homeAttachment.list({ limit: 1000 }),
        client.models.homeTrip.list({ limit: 500 }),
        client.models.homeTripLeg.list({ limit: 1000 }),
        client.models.homeTripReservation.list({ limit: 1000 }),
        client.models.homeCalendarEvent.list({ limit: 1000 }),
        client.models.homeTask.list({ limit: 1000 }),
        client.models.homeBill.list({ limit: 500 }),
      ]);

      setAttachments(
        (attachRes.data ?? []).sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
      );

      // Build a lookup: parentId → { type, name, href }
      const map: Record<string, ParentInfo> = {};

      // Build a trip name lookup for legs and reservations
      const tripNameById = new Map(
        (tripsRes.data ?? []).map((t) => [t.id, t.name])
      );

      for (const t of tripsRes.data ?? []) {
        map[t.id] = { type: "Trip", name: t.name, href: `/trips/${t.id}` };
      }
      for (const l of legsRes.data ?? []) {
        const tripName = tripNameById.get(l.tripId) ?? "Unknown trip";
        const legLabel = [l.flightNumber, l.airline].filter(Boolean).join(" ") || l.mode || "Leg";
        map[l.id] = {
          type: "Trip Leg",
          name: `${tripName} — ${legLabel}`,
          href: `/trips/${l.tripId}`,
        };
      }
      for (const r of reservationsRes.data ?? []) {
        const tripName = tripNameById.get(r.tripId) ?? "Unknown trip";
        map[r.id] = {
          type: "Reservation",
          name: `${tripName} — ${r.name}`,
          href: `/trips/${r.tripId}`,
        };
      }
      for (const e of eventsRes.data ?? []) {
        map[e.id] = { type: "Event", name: e.title, href: "/calendar" };
      }
      for (const t of tasksRes.data ?? []) {
        map[t.id] = { type: "Task", name: t.title, href: "/tasks" };
      }
      for (const b of billsRes.data ?? []) {
        map[b.id] = { type: "Bill", name: b.name };
      }

      setParentMap(map);
    } catch (err) {
      console.error("Failed to load attachments:", err);
    }
    setLoading(false);
  }, []);

  async function handleDelete(att: Attachment) {
    if (!confirm(`Delete "${att.caption || att.filename}"?`)) return;
    try {
      await client.models.homeAttachment.delete({ id: att.id });
      setAttachments((prev) => prev.filter((a) => a.id !== att.id));
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  }

  const filtered = useMemo(() => {
    let result = attachments;

    if (filterType !== ALL) {
      result = result.filter((a) => a.parentType === filterType);
    }

    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter((a) => {
        const parent = parentMap[a.parentId];
        const haystack = [
          a.filename,
          a.caption,
          a.contentType,
          parent?.name,
          parent?.type,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    return result;
  }, [attachments, filterType, search, parentMap]);

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Attachments</h1>
              <p className="text-xs text-default-400">
                {filtered.length} of {attachments.length} files
              </p>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-2 mb-4 flex-wrap">
          <Input
            size="sm"
            placeholder="Search by filename, caption, or parent name…"
            value={search}
            onValueChange={setSearch}
            startContent={<FaSearch size={12} className="text-default-400" />}
            className="flex-1 min-w-[200px]"
            isClearable
            onClear={() => setSearch("")}
          />
          <Select
            size="sm"
            label="Type"
            selectedKeys={[filterType]}
            onChange={(e) => setFilterType(e.target.value || ALL)}
            className="max-w-[160px]"
          >
            <>
              <SelectItem key={ALL}>All types</SelectItem>
              {Object.entries(PARENT_TYPE_LABELS).map(([key, label]) => (
                <SelectItem key={key}>{label}</SelectItem>
              )) as any}
            </>
          </Select>
        </div>

        {/* List */}
        {loading && (
          <p className="text-center text-default-400 py-10">Loading…</p>
        )}

        {!loading && filtered.length === 0 && (
          <Card>
            <CardBody className="px-4 py-10 text-center">
              <p className="text-sm text-default-500">
                {attachments.length === 0
                  ? "No attachments yet. Upload files from trips, tasks, or calendar events."
                  : "No attachments match your search."}
              </p>
            </CardBody>
          </Card>
        )}

        <div className="space-y-2">
          {filtered.map((att) => {
            const parent = parentMap[att.parentId];
            return (
              <Card key={att.id}>
                <CardBody className="flex flex-row items-center gap-3 px-4 py-3">
                  {/* Thumbnail / icon */}
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
                        className="w-12 h-12 object-cover rounded"
                      />
                    </a>
                  ) : (
                    <div className="w-12 h-12 flex items-center justify-center bg-default-100 rounded text-default-500 shrink-0">
                      {fileIcon(att.contentType)}
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {att.caption ?? att.filename}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {parent && (
                        <Chip
                          size="sm"
                          variant="flat"
                          color={PARENT_TYPE_COLORS[att.parentType ?? ""] as any}
                          className="cursor-pointer"
                          onClick={() => parent.href && router.push(parent.href)}
                        >
                          {parent.name}
                        </Chip>
                      )}
                      <span className="text-[10px] text-default-400">
                        {att.caption ? att.filename : ""}{" "}
                        {formatSize(att.sizeBytes)}
                      </span>
                    </div>
                    <p className="text-[10px] text-default-300 mt-0.5">
                      {new Date(att.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                      {att.uploadedBy ? ` · ${att.uploadedBy}` : ""}
                    </p>
                  </div>

                  {/* Actions */}
                  <a
                    href={originalPhotoUrl(att.s3Key)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button size="sm" isIconOnly variant="light" as="span">
                      <FaDownload size={12} />
                    </Button>
                  </a>
                  <Button
                    size="sm"
                    isIconOnly
                    variant="light"
                    color="danger"
                    onPress={() => handleDelete(att)}
                  >
                    <FaTrash size={12} />
                  </Button>
                </CardBody>
              </Card>
            );
          })}
        </div>
      </div>
    </DefaultLayout>
  );
}
