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
  FaFileArchive,
  FaFileAudio,
  FaFileVideo,
  FaSearch,
} from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { photoUrl, originalPhotoUrl } from "@/lib/image-loader";
import { attachmentKind } from "@/lib/attachment-types";
import { listAllPages } from "@/lib/list-all";
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
  VISIT: "Medical visit",
  LAB_RESULT: "Lab result",
  CARE_ITEM: "Care item",
  PREGNANCY: "Pregnancy",
  PERSON: "Person",
  PET: "Pet",
  PET_MEDICATION: "Pet medication",
  PET_VACCINE: "Pet vaccine",
};

const PARENT_TYPE_COLORS: Record<string, string> = {
  TRIP: "primary",
  TRIP_LEG: "primary",
  RESERVATION: "secondary",
  EVENT: "success",
  TASK: "warning",
  BILL: "danger",
  VISIT: "success",
  LAB_RESULT: "success",
  CARE_ITEM: "success",
  PREGNANCY: "success",
  PERSON: "default",
  PET: "secondary",
  PET_MEDICATION: "secondary",
  PET_VACCINE: "secondary",
};

function fileIcon(contentType: string | null | undefined) {
  switch (attachmentKind(contentType)) {
    case "image":
      return <FaImage size={14} />;
    case "pdf":
      return <FaFilePdf size={14} />;
    case "video":
      return <FaFileVideo size={14} />;
    case "audio":
      return <FaFileAudio size={14} />;
    case "archive":
      return <FaFileArchive size={14} />;
    default:
      return <FaFile size={14} />;
  }
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
      // Fetch attachments + all potential parent entities in parallel.
      // Paged — a single .list() silently truncates at the 1 MB page.
      const [
        attachRows,
        trips,
        legs,
        reservations,
        events,
        tasks,
        bills,
        visits,
        labs,
        careItems,
        pregnancies,
        people,
        pets,
        petMeds,
        petVaccines,
      ] = await Promise.all([
        listAllPages<Attachment>(client.models.homeAttachment),
        listAllPages<Schema["homeTrip"]["type"]>(client.models.homeTrip),
        listAllPages<Schema["homeTripLeg"]["type"]>(client.models.homeTripLeg),
        listAllPages<Schema["homeTripReservation"]["type"]>(client.models.homeTripReservation),
        listAllPages<Schema["homeCalendarEvent"]["type"]>(client.models.homeCalendarEvent),
        listAllPages<Schema["homeTask"]["type"]>(client.models.homeTask),
        listAllPages<Schema["homeBill"]["type"]>(client.models.homeBill),
        listAllPages<Schema["homeMedicalVisit"]["type"]>(client.models.homeMedicalVisit),
        listAllPages<Schema["homeLabResult"]["type"]>(client.models.homeLabResult),
        listAllPages<Schema["homeCareItem"]["type"]>(client.models.homeCareItem),
        listAllPages<Schema["homePregnancy"]["type"]>(client.models.homePregnancy),
        listAllPages<Schema["homePerson"]["type"]>(client.models.homePerson),
        listAllPages<Schema["homePet"]["type"]>(client.models.homePet),
        listAllPages<Schema["homePetMedication"]["type"]>(client.models.homePetMedication),
        listAllPages<Schema["homePetVaccine"]["type"]>(client.models.homePetVaccine),
      ]);

      setAttachments(
        attachRows.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
      );

      // Build a lookup: parentId → { type, name, href }
      const map: Record<string, ParentInfo> = {};

      // Build a trip name lookup for legs and reservations
      const tripNameById = new Map(trips.map((t) => [t.id, t.name]));
      const personNameById = new Map(people.map((p) => [p.id, p.name]));
      const petNameById = new Map(pets.map((p) => [p.id, p.name]));

      for (const t of trips) {
        map[t.id] = { type: "Trip", name: t.name, href: `/trips/${t.id}` };
      }
      for (const l of legs) {
        const tripName = tripNameById.get(l.tripId) ?? "Unknown trip";
        const legLabel = [l.flightNumber, l.airline].filter(Boolean).join(" ") || l.mode || "Leg";
        map[l.id] = {
          type: "Trip Leg",
          name: `${tripName} — ${legLabel}`,
          href: `/trips/${l.tripId}`,
        };
      }
      for (const r of reservations) {
        const tripName = tripNameById.get(r.tripId) ?? "Unknown trip";
        map[r.id] = {
          type: "Reservation",
          name: `${tripName} — ${r.name}`,
          href: `/trips/${r.tripId}`,
        };
      }
      for (const e of events) {
        map[e.id] = { type: "Event", name: e.title, href: "/calendar" };
      }
      for (const t of tasks) {
        map[t.id] = { type: "Task", name: t.title, href: "/tasks" };
      }
      for (const b of bills) {
        map[b.id] = { type: "Bill", name: b.name };
      }
      for (const v of visits) {
        const date = new Date(v.visitAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        map[v.id] = {
          type: "Medical visit",
          name: `${v.title || (v.kind ? v.kind.charAt(0) + v.kind.slice(1).toLowerCase().replace("_", " ") : "Visit")} — ${date}`,
          href: "/health",
        };
      }
      for (const l of labs) {
        map[l.id] = { type: "Lab result", name: l.panel || l.testName, href: "/health" };
      }
      for (const c of careItems) {
        map[c.id] = { type: "Care item", name: c.title, href: "/health" };
      }
      for (const p of pregnancies) {
        map[p.id] = { type: "Pregnancy", name: `${personNameById.get(p.personId) ?? ""} pregnancy`.trim(), href: "/health" };
      }
      for (const p of people) {
        map[p.id] = { type: "Person", name: p.name };
      }
      for (const p of pets) {
        map[p.id] = { type: "Pet", name: p.name };
      }
      for (const m of petMeds) {
        map[m.id] = { type: "Pet medication", name: `${petNameById.get(m.petId) ?? "Pet"} — ${m.name}` };
      }
      for (const v of petVaccines) {
        map[v.id] = { type: "Pet vaccine", name: `${petNameById.get(v.petId) ?? "Pet"} — ${v.name}` };
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
