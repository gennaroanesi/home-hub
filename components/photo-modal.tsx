"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { Button } from "@heroui/button";
import { Link } from "@heroui/link";
import { Select, SelectItem } from "@heroui/select";
import { addToast } from "@heroui/react";
import { FaTrash, FaDownload, FaHeart, FaRegHeart } from "react-icons/fa";
import dayjs from "dayjs";
import { generateClient } from "aws-amplify/data";
import { photoUrl, originalPhotoUrl } from "@/lib/image-loader";
import type { Schema } from "@/amplify/data/resource";

type Photo = Schema["homePhoto"]["type"];
type PhotoFace = Schema["homePhotoFace"]["type"];
type Person = Schema["homePerson"]["type"];

// Lean shape that the photos/albums pages already load. Exposed so the
// parent can type its passthrough without importing the full Amplify
// Person type.
export type PhotoModalPerson = {
  id: string;
  name: string;
  emoji?: string | null;
  color?: string | null;
};

type BBox = { Width: number; Height: number; Left: number; Top: number };

const client = generateClient<Schema>({ authMode: "userPool" });

interface PhotoModalProps {
  photo: Photo | null;
  // People list for the inline face-assign dropdown. When omitted, the
  // assign UI still renders but the dropdown will be empty — callers should
  // pass this through whenever they have the list handy (the parent pages
  // already load it for their own filters).
  people?: PhotoModalPerson[];
  isOpen: boolean;
  onClose: () => void;
  onDelete?: () => void;
  onToggleFavorite?: (photo: Photo, next: boolean) => void;
}

export function PhotoModal({
  photo,
  people,
  isOpen,
  onClose,
  onDelete,
  onToggleFavorite,
}: PhotoModalProps) {
  const [faces, setFaces] = useState<PhotoFace[]>([]);
  const [peopleById, setPeopleById] = useState<Record<string, Person>>({});
  // Per-face assign state. pendingAssign maps face.id → selected personId,
  // busy flags the face while its 3-step enrollment flow is in flight.
  const [pendingAssign, setPendingAssign] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Local optimistic favorite state — the modal renders the icon from this
  // so the heart flips instantly on click without waiting for the parent to
  // re-render. Reset whenever the modal opens against a new photo.
  const [isFavorite, setIsFavorite] = useState<boolean>(false);

  useEffect(() => {
    setIsFavorite(!!photo?.isFavorite);
  }, [photo?.id, photo?.isFavorite]);

  // Loads the face rows for this photo + hydrates `peopleById` for any
  // already-matched faces. Extracted into a ref-stable callback so the
  // assign flow can re-invoke it after enrollment to flip a row from
  // unmatched to matched without a full modal reload.
  const loadFaces = useCallback(async (photoId: string) => {
    try {
      // Generic list+filter rather than the auto-generated
      // listHomePhotoFaceByPhotoId index query — the latter silently
      // fails on lowercase-named models due to a filter type casing
      // mismatch between client and server (see
      // feedback_amplify_listbyfield_lowercase_bug memory).
      const res = await client.models.homePhotoFace.list({
        filter: { photoId: { eq: photoId } },
      });
      const rows = res.data ?? [];
      setFaces(rows);

      // Fetch the people referenced by matched faces (deduped)
      const personIds = Array.from(
        new Set(rows.map((r) => r.personId).filter((id): id is string => !!id))
      );
      const map: Record<string, Person> = {};
      await Promise.all(
        personIds.map(async (id) => {
          const r = await client.models.homePerson.get({ id });
          if (r.data) map[id] = r.data;
        })
      );
      setPeopleById((prev) => ({ ...prev, ...map }));
    } catch (err) {
      console.error("Failed to load faces for photo:", err);
    }
  }, []);

  useEffect(() => {
    if (!photo || !isOpen) {
      setFaces([]);
      setPeopleById({});
      setPendingAssign({});
      setBusy({});
      return;
    }
    loadFaces(photo.id);
  }, [photo, isOpen, loadFaces]);

  // Parse `exifData` — Amplify Gen 2 JSON fields come back as strings that
  // need JSON.parse(), but defensively handle both shapes (some code paths
  // return an already-parsed object). Fall back to {} on parse failure so
  // a single garbage field doesn't break the metadata panel.
  const exif = useMemo<Record<string, unknown>>(() => {
    if (!photo?.exifData) return {};
    const raw = photo.exifData as unknown;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    if (typeof raw === "object" && raw !== null) {
      return raw as Record<string, unknown>;
    }
    return {};
  }, [photo?.exifData]);

  if (!photo) return null;

  async function assignFace(face: PhotoFace) {
    const personId = pendingAssign[face.id];
    if (!personId) return;
    if (!face.rekognitionFaceId) {
      addToast({
        title: "Can't assign",
        description: "This face has no Rekognition id.",
      });
      return;
    }
    if (!photo) return;
    setBusy((b) => ({ ...b, [face.id]: true }));
    try {
      // 1. Create a homePersonFace row linking the face id to this person.
      //    Future photos containing this person will match via SearchFaces.
      await client.models.homePersonFace.create({
        personId,
        rekognitionFaceId: face.rekognitionFaceId,
        enrolledFromPhotoId: photo.id,
        confidence: face.similarity ?? null,
      });
      // 2. Mark this specific homePhotoFace row as belonging to that person.
      await client.models.homePhotoFace.update({
        id: face.id,
        personId,
      });
      // 3. Fire the retroactive match in the background. The lambda gates
      //    on MIN_ENROLLMENTS internally so under-threshold persons return
      //    SKIPPED cheaply. Fire-and-forget — don't block the UI.
      (client.mutations as unknown as {
        retroactiveFaceMatch: (input: { personId: string }) => Promise<unknown>;
      }).retroactiveFaceMatch({ personId }).catch(console.error);

      // Refetch the face list so the row flips to matched without a full
      // modal reload. Clear the pending selection for this face too.
      setPendingAssign((m) => {
        const next = { ...m };
        delete next[face.id];
        return next;
      });
      await loadFaces(photo.id);

      const person = people?.find((p) => p.id === personId);
      addToast({
        title: "Face assigned",
        description: `Tagged as ${person?.name ?? "person"}.`,
      });
    } catch (err) {
      console.error("Failed to assign face:", err);
      addToast({
        title: "Failed to assign face",
        description: err instanceof Error ? err.message : "See console for details.",
      });
    } finally {
      setBusy((b) => ({ ...b, [face.id]: false }));
    }
  }

  // Only show the Faces section if there's anything useful to render —
  // i.e. at least one face that's either matched or assignable.
  const renderableFaces = faces.filter(
    (f) => !!f.personId || !!f.rekognitionFaceId
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="full" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex justify-between items-center gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{photo.originalFilename}</p>
            {photo.takenAt && (
              <p className="text-xs text-default-400">
                {dayjs(photo.takenAt).format("MMM D, YYYY h:mm A")}
              </p>
            )}
          </div>
        </ModalHeader>
        <ModalBody className="flex flex-col items-center justify-start p-2 gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl(photo.s3key, 1600, 85)}
            alt={photo.originalFilename ?? photo.id}
            className="max-w-full max-h-[75vh] object-contain"
          />

          {renderableFaces.length > 0 && (
            <section className="w-full max-w-3xl px-2">
              <h3 className="text-xs uppercase tracking-wide text-default-500 mb-2">
                Faces ({renderableFaces.length})
              </h3>
              <div className="flex flex-col gap-2">
                {renderableFaces.map((face) => (
                  <FaceRow
                    key={face.id}
                    face={face}
                    photo={photo}
                    matchedPerson={
                      face.personId ? peopleById[face.personId] ?? null : null
                    }
                    people={people ?? []}
                    pending={pendingAssign[face.id] ?? ""}
                    onPendingChange={(id) =>
                      setPendingAssign((m) => ({ ...m, [face.id]: id }))
                    }
                    onAssign={() => assignFace(face)}
                    busy={!!busy[face.id]}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="w-full max-w-3xl px-2">
            <details className="group">
              <summary className="cursor-pointer text-xs uppercase tracking-wide text-default-500 select-none">
                Details
              </summary>
              <div className="mt-3">
                <MetadataPanel photo={photo} exif={exif} />
              </div>
            </details>
          </section>
        </ModalBody>
        <ModalFooter>
          {onDelete && (
            <Button
              color="danger"
              variant="light"
              startContent={<FaTrash size={12} />}
              onPress={() => {
                if (confirm("Delete this photo?")) onDelete();
              }}
            >
              Delete
            </Button>
          )}
          {onToggleFavorite && (
            <Button
              variant="flat"
              startContent={
                isFavorite ? (
                  <FaHeart size={12} className="text-red-500" />
                ) : (
                  <FaRegHeart size={12} />
                )
              }
              onPress={() => {
                const next = !isFavorite;
                setIsFavorite(next);
                onToggleFavorite(photo, next);
              }}
            >
              {isFavorite ? "Unfavorite" : "Favorite"}
            </Button>
          )}
          <Button
            as={Link}
            href={originalPhotoUrl(photo.s3key)}
            target="_blank"
            variant="flat"
            startContent={<FaDownload size={12} />}
          >
            Download original
          </Button>
          <Button onPress={onClose}>Close</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── FaceRow ────────────────────────────────────────────────────────────
// One row in the Faces list. Renders the crop on the left, then either:
//   • the matched person's emoji + name (read-only), or
//   • a Select populated from the passed `people` array with an Assign button.
function FaceRow({
  face,
  photo,
  matchedPerson,
  people,
  pending,
  onPendingChange,
  onAssign,
  busy,
}: {
  face: PhotoFace;
  photo: Photo;
  matchedPerson: Person | null;
  people: PhotoModalPerson[];
  pending: string;
  onPendingChange: (personId: string) => void;
  onAssign: () => void;
  busy: boolean;
}) {
  // boundingBox is `a.json()` in the schema → AWSJSON → the Data client
  // returns it as a JSON-encoded string. Parse defensively in case some
  // code path hands us an already-parsed object.
  const box = useMemo<BBox | null>(() => {
    const raw = face.boundingBox;
    if (!raw) return null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as BBox;
      } catch {
        return null;
      }
    }
    return raw as unknown as BBox;
  }, [face.boundingBox]);

  return (
    <div className="flex items-center gap-3">
      {box ? (
        <FaceCrop photo={photo} box={box} size={56} />
      ) : (
        <div className="w-14 h-14 rounded-md bg-default-100 shrink-0" />
      )}

      {matchedPerson ? (
        <div className="text-sm text-default-500 flex items-center gap-1">
          {matchedPerson.emoji ? <span>{matchedPerson.emoji}</span> : null}
          <span>{matchedPerson.name}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Select
            size="sm"
            aria-label="Assign face to person"
            placeholder="Assign to…"
            className="max-w-[220px]"
            selectedKeys={pending ? [pending] : []}
            onSelectionChange={(keys) => {
              const id = Array.from(keys)[0] as string | undefined;
              onPendingChange(id ?? "");
            }}
            isDisabled={busy || people.length === 0}
          >
            {people.map((p) => (
              <SelectItem key={p.id} textValue={p.name}>
                {p.emoji ? `${p.emoji} ` : ""}
                {p.name}
              </SelectItem>
            ))}
          </Select>
          <Button
            size="sm"
            variant="flat"
            color="primary"
            isDisabled={!pending || busy}
            isLoading={busy}
            onPress={onAssign}
          >
            Assign
          </Button>
        </div>
      )}
    </div>
  );
}

// ── FaceCrop ───────────────────────────────────────────────────────────
// Math mirrored from pages/admin/faces.tsx so the crop looks identical
// to the admin enrollment UI. Uses CSS background sizing to render just
// the face portion of the source photo.
function FaceCrop({
  photo,
  box,
  size,
}: {
  photo: Photo;
  box: BBox;
  size: number;
}) {
  const aspect = photo.width && photo.height ? photo.width / photo.height : 4 / 3;

  // Render width is chosen so the face's bbox occupies `size` pixels wide,
  // with a small zoom-out factor so the face isn't right at the edge.
  const padding = 0.85;
  const imgWidth = (size / box.Width) * padding;
  const imgHeight = imgWidth / aspect;

  const faceCenterX = (box.Left + box.Width / 2) * imgWidth;
  const faceCenterY = (box.Top + box.Height / 2) * imgHeight;
  const left = size / 2 - faceCenterX;
  const top = size / 2 - faceCenterY;

  const requestedWidth = Math.min(2000, Math.max(400, Math.ceil(imgWidth)));

  return (
    <div
      className="rounded-md shrink-0"
      style={{
        width: size,
        height: size,
        position: "relative",
        overflow: "hidden",
        background: "#222",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl(photo.s3key, requestedWidth)}
        alt=""
        style={{
          position: "absolute",
          width: imgWidth,
          height: imgHeight,
          left,
          top,
          maxWidth: "none",
        }}
      />
    </div>
  );
}

// ── MetadataPanel ──────────────────────────────────────────────────────
// Two-column grid of photo/exif metadata. Only renders rows where the
// underlying value is present, so photos with sparse EXIF don't show
// a wall of "null" entries.
function MetadataPanel({
  photo,
  exif,
}: {
  photo: Photo;
  exif: Record<string, unknown>;
}) {
  const rows: Array<{ label: string; value: React.ReactNode }> = [];

  // 1. Taken at
  if (photo.takenAt) {
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(photo.takenAt));
    const offset = typeof exif.OffsetTimeOriginal === "string"
      ? (exif.OffsetTimeOriginal as string)
      : null;
    rows.push({
      label: "Taken at",
      value: offset ? `${formatted} (UTC${offset})` : formatted,
    });
  }

  // 2. Camera (make + model)
  const make = typeof exif.Make === "string" ? (exif.Make as string).trim() : "";
  const model = typeof exif.Model === "string" ? (exif.Model as string).trim() : "";
  const camera = [make, model].filter(Boolean).join(" ").trim();
  if (camera) rows.push({ label: "Camera", value: camera });

  // 3. Lens
  const lens = typeof exif.LensModel === "string" ? (exif.LensModel as string).trim() : "";
  if (lens) rows.push({ label: "Lens", value: lens });

  // 4. Exposure — ExifReader already pre-formats most of these as human
  // strings (e.g. FNumber="f/1.8", FocalLength="24 mm"). If the value
  // already contains the label we render verbatim, otherwise we prepend
  // it. When in doubt, render verbatim.
  const parts: string[] = [];
  const fNumber = asString(exif.FNumber);
  if (fNumber) parts.push(fNumber.includes("f/") ? fNumber : `f/${fNumber}`);
  const exposureTime = asString(exif.ExposureTime);
  if (exposureTime) parts.push(exposureTime.endsWith("s") ? exposureTime : `${exposureTime}s`);
  const iso = asString(exif.ISOSpeedRatings);
  if (iso) parts.push(iso.toLowerCase().includes("iso") ? iso : `ISO ${iso}`);
  const focal = asString(exif.FocalLength);
  if (focal) parts.push(focal);
  if (parts.length > 0) {
    rows.push({ label: "Exposure", value: parts.join(" · ") });
  }

  // 5. Dimensions
  if (photo.width && photo.height) {
    rows.push({
      label: "Dimensions",
      value: `${photo.width} \u00D7 ${photo.height}`,
    });
  }

  // 6. File size
  if (typeof photo.sizeBytes === "number" && photo.sizeBytes > 0) {
    rows.push({ label: "File size", value: humanFileSize(photo.sizeBytes) });
  }

  // 7. Content type
  if (photo.contentType) {
    rows.push({ label: "Type", value: photo.contentType });
  }

  // 8. Location
  if (
    typeof photo.latitude === "number" &&
    typeof photo.longitude === "number" &&
    Number.isFinite(photo.latitude) &&
    Number.isFinite(photo.longitude)
  ) {
    const lat = photo.latitude;
    const lon = photo.longitude;
    let text = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    if (typeof photo.altitude === "number" && Number.isFinite(photo.altitude)) {
      text += ` \u00B7 ${Math.round(photo.altitude)}m`;
    }
    rows.push({
      label: "Location",
      value: (
        <a
          href={`https://www.google.com/maps?q=${lat},${lon}`}
          target="_blank"
          rel="noopener"
          className="underline hover:text-primary"
        >
          {text}
        </a>
      ),
    });
  }

  // 9. File
  if (photo.originalFilename) {
    rows.push({ label: "File", value: photo.originalFilename });
  }

  // 10. Uploaded by
  if (photo.uploadedBy) {
    rows.push({ label: "Uploaded by", value: photo.uploadedBy });
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-default-400">No metadata recorded for this photo.</p>
    );
  }

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map((row) => (
        <React.Fragment key={row.label}>
          <dt className="text-default-500">{row.label}</dt>
          <dd className="text-default-800 break-words">{row.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function humanFileSize(b: number): string {
  return b < 1024
    ? `${b} B`
    : b < 1024 * 1024
      ? `${(b / 1024).toFixed(1)} KB`
      : `${(b / 1024 / 1024).toFixed(1)} MB`;
}
