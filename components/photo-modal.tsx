"use client";

import React, { useEffect, useState } from "react";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { Button } from "@heroui/button";
import { Link } from "@heroui/link";
import { Chip } from "@heroui/chip";
import { FaTrash, FaDownload, FaUser, FaHeart, FaRegHeart } from "react-icons/fa";
import dayjs from "dayjs";
import { generateClient } from "aws-amplify/data";
import { photoUrl, originalPhotoUrl } from "@/lib/image-loader";
import type { Schema } from "@/amplify/data/resource";

type Photo = Schema["homePhoto"]["type"];
type PhotoFace = Schema["homePhotoFace"]["type"];
type Person = Schema["homePerson"]["type"];

const client = generateClient<Schema>({ authMode: "userPool" });

interface PhotoModalProps {
  photo: Photo | null;
  isOpen: boolean;
  onClose: () => void;
  onDelete?: () => void;
  onToggleFavorite?: (photo: Photo, next: boolean) => void;
}

export function PhotoModal({
  photo,
  isOpen,
  onClose,
  onDelete,
  onToggleFavorite,
}: PhotoModalProps) {
  const [faces, setFaces] = useState<PhotoFace[]>([]);
  const [peopleById, setPeopleById] = useState<Record<string, Person>>({});
  // Local optimistic favorite state — the modal renders the icon from this
  // so the heart flips instantly on click without waiting for the parent to
  // re-render. Reset whenever the modal opens against a new photo.
  const [isFavorite, setIsFavorite] = useState<boolean>(false);

  useEffect(() => {
    setIsFavorite(!!photo?.isFavorite);
  }, [photo?.id, photo?.isFavorite]);

  useEffect(() => {
    if (!photo || !isOpen) {
      setFaces([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await client.models.homePhotoFace.listhomePhotoFaceByPhotoId({
          photoId: photo.id,
        });
        if (cancelled) return;
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
        if (!cancelled) setPeopleById(map);
      } catch (err) {
        console.error("Failed to load faces for photo:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photo, isOpen]);

  if (!photo) return null;

  const matchedFaces = faces.filter((f) => f.personId);
  const unmatchedCount = faces.length - matchedFaces.length;

  // Dedupe people — a single person can appear multiple times if they
  // were detected via two different enrolled faces.
  const peopleInPhoto = Array.from(
    new Map(
      matchedFaces
        .map((f) => peopleById[f.personId!])
        .filter((p): p is Person => !!p)
        .map((p) => [p.id, p])
    ).values()
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
        <ModalBody className="flex flex-col items-center justify-start p-2 gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl(photo.s3key, 1600, 85)}
            alt={photo.originalFilename ?? photo.id}
            className="max-w-full max-h-[75vh] object-contain"
          />
          {(peopleInPhoto.length > 0 || unmatchedCount > 0) && (
            <div className="w-full max-w-3xl flex flex-wrap items-center gap-2 px-2">
              <FaUser size={12} className="text-default-400" />
              {peopleInPhoto.map((p) => (
                <Chip
                  key={p.id}
                  size="sm"
                  variant="flat"
                  style={{
                    backgroundColor: p.color ?? undefined,
                    color: p.color ? "#fff" : undefined,
                  }}
                >
                  {p.emoji ? `${p.emoji} ` : ""}
                  {p.name}
                </Chip>
              ))}
              {unmatchedCount > 0 && (
                <Chip size="sm" variant="flat" color="default">
                  +{unmatchedCount} unidentified
                </Chip>
              )}
            </div>
          )}
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
