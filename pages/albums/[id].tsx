"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { FaArrowLeft, FaTrash, FaPen, FaCheckSquare, FaTimes } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { PhotoGrid } from "@/components/photo-grid";
import { PhotoUploader } from "@/components/photo-uploader";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Album = Schema["homeAlbum"]["type"];
type AlbumPhoto = Schema["homeAlbumPhoto"]["type"];
type Photo = Schema["homePhoto"]["type"];
type Trip = Schema["homeTrip"]["type"];

export default function AlbumDetailPage() {
  const router = useRouter();
  const { id } = router.query;

  const [album, setAlbum] = useState<Album | null>(null);
  const [albumPhotos, setAlbumPhotos] = useState<AlbumPhoto[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [photosUploading, setPhotosUploading] = useState(false);

  // Multi-select
  const [selectionEnabled, setSelectionEnabled] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Edit album modal
  const editDisclosure = useDisclosure();
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTripIds, setEditTripIds] = useState<string[]>([]);

  useEffect(() => {
    if (!router.isReady) return;
    (async () => {
      try {
        await getCurrentUser();
        await loadAll();
      } catch {
        router.push("/login");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, id]);

  const loadAll = useCallback(async () => {
    if (typeof id !== "string") return;
    setLoading(true);
    const [albumRes, joinRes, photosRes, tripsRes] = await Promise.all([
      client.models.homeAlbum.get({ id }),
      client.models.homeAlbumPhoto.list({ filter: { albumId: { eq: id } }, limit: 5000 }),
      client.models.homePhoto.list({ limit: 1000 }),
      client.models.homeTrip.list({ limit: 500 }),
    ]);
    setAlbum(albumRes.data ?? null);
    setAlbumPhotos(joinRes.data ?? []);
    setPhotos(photosRes.data ?? []);
    setTrips((tripsRes.data ?? []).sort((a, b) => b.startDate.localeCompare(a.startDate)));
    setLoading(false);
  }, [id]);

  // Photos in this album, sorted by takenAt (newest first)
  const albumPhotosList = useMemo(() => {
    const photoIds = new Set(albumPhotos.map((ap) => ap.photoId));
    const list = photos.filter((p) => photoIds.has(p.id));
    return list.sort((a, b) => {
      const aDate = a.takenAt ?? a.createdAt;
      const bDate = b.takenAt ?? b.createdAt;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });
  }, [photos, albumPhotos]);

  function openEdit() {
    if (!album) return;
    setEditName(album.name);
    setEditDescription(album.description ?? "");
    setEditTripIds((album.tripIds ?? []).filter((id): id is string => !!id));
    editDisclosure.onOpen();
  }

  async function saveEdit(onClose: () => void) {
    if (!album || !editName.trim()) return;
    await client.models.homeAlbum.update({
      id: album.id,
      name: editName.trim(),
      description: editDescription.trim() || null,
      tripIds: editTripIds,
    });
    onClose();
    await loadAll();
  }

  async function deleteAlbum() {
    if (!album) return;
    if (!confirm(`Delete album "${album.name}"? Photos will not be deleted; they'll just become unfiled.`)) return;
    // Delete all join rows first
    for (const ap of albumPhotos) {
      await client.models.homeAlbumPhoto.delete({ id: ap.id });
    }
    await client.models.homeAlbum.delete({ id: album.id });
    router.push("/albums");
  }

  async function deletePhotoFromEverywhere(photo: Photo) {
    // Delete all join rows for this photo, then the photo itself
    const joins = await client.models.homeAlbumPhoto.list({
      filter: { photoId: { eq: photo.id } },
      limit: 100,
    });
    for (const j of joins.data ?? []) {
      await client.models.homeAlbumPhoto.delete({ id: j.id });
    }
    await client.models.homePhoto.delete({ id: photo.id });
    await loadAll();
  }

  async function removeFromAlbum(photoIds: string[]) {
    const toRemove = albumPhotos.filter((ap) => photoIds.includes(ap.photoId));
    for (const ap of toRemove) {
      await client.models.homeAlbumPhoto.delete({ id: ap.id });
    }
  }

  async function toggleFavorite(photo: Photo, next: boolean) {
    setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, isFavorite: next } : p)));
    try {
      await client.models.homePhoto.update({ id: photo.id, isFavorite: next });
    } catch (err) {
      console.error("Failed to toggle favorite", err);
      setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, isFavorite: !next } : p)));
    }
  }

  function toggleSelectionMode() {
    setSelectionEnabled((on) => {
      if (on) setSelectedIds(new Set());
      return !on;
    });
  }

  async function bulkRemove() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Remove ${selectedIds.size} photo(s) from this album?`)) return;
    await removeFromAlbum(Array.from(selectedIds));
    setSelectedIds(new Set());
    await loadAll();
  }

  async function bulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Permanently delete ${selectedIds.size} photo(s)? This cannot be undone.`)) return;
    for (const id of Array.from(selectedIds)) {
      const p = photos.find((p) => p.id === id);
      if (p) await deletePhotoFromEverywhere(p);
    }
    setSelectedIds(new Set());
  }

  if (loading) {
    return (
      <DefaultLayout>
        <div className="max-w-6xl mx-auto px-4 py-10 text-center text-default-400">Loading…</div>
      </DefaultLayout>
    );
  }

  if (!album) {
    return (
      <DefaultLayout>
        <div className="max-w-6xl mx-auto px-4 py-10">
          <div className="flex items-center gap-2 mb-4">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/albums")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-xl font-bold">Album not found</h1>
          </div>
        </div>
      </DefaultLayout>
    );
  }

  return (
    <DefaultLayout>
      <div className="max-w-6xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/albums")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">{album.name}</h1>
          </div>
          <div className="flex gap-1 sm:gap-2">
            <Button
              size="sm"
              variant={selectionEnabled ? "solid" : "flat"}
              color={selectionEnabled ? "primary" : "default"}
              startContent={selectionEnabled ? <FaTimes size={12} /> : <FaCheckSquare size={12} />}
              onPress={toggleSelectionMode}
            >
              {selectionEnabled ? "Cancel" : "Select"}
            </Button>
            <Button size="sm" variant="flat" startContent={<FaPen size={12} />} onPress={openEdit}>
              Edit
            </Button>
            <Button
              size="sm"
              color="danger"
              variant="light"
              startContent={<FaTrash size={12} />}
              onPress={deleteAlbum}
            >
              Delete
            </Button>
          </div>
        </div>
        {album.description && (
          <p className="text-sm text-default-500 mb-3">{album.description}</p>
        )}
        <p className="text-xs text-default-400 mb-4">
          {albumPhotosList.length} photo{albumPhotosList.length === 1 ? "" : "s"}
        </p>

        {/* Selection toolbar */}
        {selectionEnabled && (
          <div className="flex flex-wrap items-center gap-2 mb-3 p-3 bg-default-100 rounded-md">
            <span className="text-sm font-medium">{selectedIds.size} selected</span>
            <Button
              size="sm"
              variant="light"
              onPress={() => setSelectedIds(new Set(albumPhotosList.map((p) => p.id)))}
            >
              Select all ({albumPhotosList.length})
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="flat"
              onPress={bulkRemove}
              isDisabled={selectedIds.size === 0}
            >
              Remove from album
            </Button>
            <Button
              size="sm"
              variant="flat"
              color="danger"
              startContent={<FaTrash size={12} />}
              onPress={bulkDelete}
              isDisabled={selectedIds.size === 0}
            >
              Delete photos
            </Button>
          </div>
        )}

        {/* Upload */}
        {!selectionEnabled && (
          <div className="mb-4">
            <PhotoUploader
              variant="dropzone"
              albumId={album.id}
              onUploaded={loadAll}
              onUploadingChange={setPhotosUploading}
            />
          </div>
        )}

        <PhotoGrid
          photos={albumPhotosList}
          onDelete={selectionEnabled ? undefined : deletePhotoFromEverywhere}
          selectionEnabled={selectionEnabled}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onToggleFavorite={selectionEnabled ? undefined : toggleFavorite}
        />

        {/* Edit modal */}
        <Modal isOpen={editDisclosure.isOpen} onOpenChange={editDisclosure.onOpenChange}>
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>Edit Album</ModalHeader>
                <ModalBody>
                  <Input
                    label="Name"
                    value={editName}
                    onValueChange={setEditName}
                    isRequired
                  />
                  <Textarea
                    label="Description"
                    value={editDescription}
                    onValueChange={setEditDescription}
                    minRows={2}
                  />
                  <Select
                    label="Linked trips"
                    selectionMode="multiple"
                    selectedKeys={new Set(editTripIds)}
                    onSelectionChange={(keys) =>
                      setEditTripIds(Array.from(keys as Set<string>))
                    }
                    description="Trips that should surface this album on their detail page"
                  >
                    {trips.map((t) => (
                      <SelectItem key={t.id}>{t.name}</SelectItem>
                    ))}
                  </Select>
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => saveEdit(onClose)}>
                    Save
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>
      </div>
    </DefaultLayout>
  );
}
