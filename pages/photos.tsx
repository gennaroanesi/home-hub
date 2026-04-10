"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { FaArrowLeft, FaTrash, FaCheckSquare, FaTimes, FaFolderPlus, FaHeart, FaRegHeart } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { PhotoGrid } from "@/components/photo-grid";
import { PhotoUploader } from "@/components/photo-uploader";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Photo = Schema["homePhoto"]["type"];
type Album = Schema["homeAlbum"]["type"];
type AlbumPhoto = Schema["homeAlbumPhoto"]["type"];

const ALL = "all";
const UNFILED = "unfiled";

export default function PhotosPage() {
  const router = useRouter();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumPhotos, setAlbumPhotos] = useState<AlbumPhoto[]>([]);
  const [filterAlbumId, setFilterAlbumId] = useState<string>(ALL);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [loading, setLoading] = useState(true);

  // Multi-select state
  const [selectionEnabled, setSelectionEnabled] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Bulk-edit modal state
  const bulkAddDisclosure = useDisclosure();
  const [bulkTargetAlbumId, setBulkTargetAlbumId] = useState<string>("");

  // Initialize filters from URL query params
  // (?album=ID&from=YYYY-MM-DD&to=YYYY-MM-DD&favorites=1)
  useEffect(() => {
    if (!router.isReady) return;
    const { album, from, to, favorites } = router.query;
    if (typeof album === "string") setFilterAlbumId(album);
    if (typeof from === "string") setFromDate(from);
    if (typeof to === "string") setToDate(to);
    if (favorites === "1") setFavoritesOnly(true);
  }, [router.isReady, router.query]);

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
        await loadAll();
      } catch {
        router.push("/login");
      }
    })();
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [photosRes, albumsRes, joinRes] = await Promise.all([
      client.models.homePhoto.list({ limit: 1000 }),
      client.models.homeAlbum.list({ limit: 500 }),
      client.models.homeAlbumPhoto.list({ limit: 5000 }),
    ]);
    setPhotos(
      (photosRes.data ?? []).sort((a, b) => {
        const aDate = a.takenAt ?? a.createdAt;
        const bDate = b.takenAt ?? b.createdAt;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      })
    );
    setAlbums((albumsRes.data ?? []).sort((a, b) => a.name.localeCompare(b.name)));
    setAlbumPhotos(joinRes.data ?? []);
    setLoading(false);
  }, []);

  // Build photoId → Set<albumId> for quick membership lookups
  const photoToAlbums = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const ap of albumPhotos) {
      if (!map.has(ap.photoId)) map.set(ap.photoId, new Set());
      map.get(ap.photoId)!.add(ap.albumId);
    }
    return map;
  }, [albumPhotos]);

  const filtered = useMemo(() => {
    let result = photos;

    if (filterAlbumId === UNFILED) {
      result = result.filter((p) => !photoToAlbums.has(p.id) || photoToAlbums.get(p.id)!.size === 0);
    } else if (filterAlbumId !== ALL) {
      result = result.filter((p) => photoToAlbums.get(p.id)?.has(filterAlbumId));
    }

    if (favoritesOnly) {
      result = result.filter((p) => p.isFavorite);
    }

    if (fromDate) {
      const fromMs = new Date(fromDate).getTime();
      result = result.filter((p) => {
        const t = new Date(p.takenAt ?? p.createdAt).getTime();
        return t >= fromMs;
      });
    }
    if (toDate) {
      const toMs = new Date(`${toDate}T23:59:59.999`).getTime();
      result = result.filter((p) => {
        const t = new Date(p.takenAt ?? p.createdAt).getTime();
        return t <= toMs;
      });
    }

    return result;
  }, [photos, filterAlbumId, fromDate, toDate, favoritesOnly, photoToAlbums]);

  function clearFilters() {
    setFilterAlbumId(ALL);
    setFromDate("");
    setToDate("");
    setFavoritesOnly(false);
    router.replace("/photos", undefined, { shallow: true });
  }

  async function toggleFavorite(photo: Photo, next: boolean) {
    // Optimistic update
    setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, isFavorite: next } : p)));
    try {
      await client.models.homePhoto.update({ id: photo.id, isFavorite: next });
    } catch (err) {
      console.error("Failed to toggle favorite", err);
      // Revert
      setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, isFavorite: !next } : p)));
    }
  }

  function toggleSelectionMode() {
    setSelectionEnabled((on) => {
      if (on) setSelectedIds(new Set());
      return !on;
    });
  }

  function selectAllVisible() {
    setSelectedIds(new Set(filtered.map((p) => p.id)));
  }

  async function deletePhoto(photo: Photo) {
    // Also delete any album-photo join rows for this photo
    const joins = albumPhotos.filter((ap) => ap.photoId === photo.id);
    for (const j of joins) {
      await client.models.homeAlbumPhoto.delete({ id: j.id });
    }
    await client.models.homePhoto.delete({ id: photo.id });
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    setAlbumPhotos((prev) => prev.filter((ap) => ap.photoId !== photo.id));
  }

  async function bulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} photo${selectedIds.size === 1 ? "" : "s"}?`)) return;
    for (const id of Array.from(selectedIds)) {
      const photo = photos.find((p) => p.id === id);
      if (photo) await deletePhoto(photo);
    }
    setSelectedIds(new Set());
  }

  function openBulkAddToAlbum() {
    setBulkTargetAlbumId(albums[0]?.id ?? "");
    bulkAddDisclosure.onOpen();
  }

  async function bulkAddToAlbum(onClose: () => void) {
    if (!bulkTargetAlbumId || selectedIds.size === 0) return;
    // Skip photos that already belong to this album
    const existing = new Set(
      albumPhotos
        .filter((ap) => ap.albumId === bulkTargetAlbumId)
        .map((ap) => ap.photoId)
    );
    for (const photoId of Array.from(selectedIds)) {
      if (existing.has(photoId)) continue;
      await client.models.homeAlbumPhoto.create({
        albumId: bulkTargetAlbumId,
        photoId,
        sortOrder: 0,
      });
    }
    onClose();
    setSelectedIds(new Set());
    await loadAll();
  }

  async function bulkRemoveFromAlbum() {
    if (filterAlbumId === ALL || filterAlbumId === UNFILED) return;
    if (selectedIds.size === 0) return;
    if (!confirm(`Remove ${selectedIds.size} photo(s) from this album?`)) return;
    const toRemove = albumPhotos.filter(
      (ap) => ap.albumId === filterAlbumId && selectedIds.has(ap.photoId)
    );
    for (const ap of toRemove) {
      await client.models.homeAlbumPhoto.delete({ id: ap.id });
    }
    setSelectedIds(new Set());
    await loadAll();
  }

  const hasActiveFilters = filterAlbumId !== ALL || fromDate || toDate || favoritesOnly;
  const isAlbumFilter = filterAlbumId !== ALL && filterAlbumId !== UNFILED;

  return (
    <DefaultLayout>
      <div className="max-w-7xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">Photos</h1>
            {loading && (
              <span className="hidden sm:inline text-xs text-default-400 animate-pulse">Loading…</span>
            )}
          </div>
          <Button
            size="sm"
            variant={selectionEnabled ? "solid" : "flat"}
            color={selectionEnabled ? "primary" : "default"}
            startContent={selectionEnabled ? <FaTimes size={12} /> : <FaCheckSquare size={12} />}
            onPress={toggleSelectionMode}
          >
            {selectionEnabled ? "Cancel" : "Select"}
          </Button>
        </div>

        {/* Selection toolbar */}
        {selectionEnabled && (
          <div className="flex flex-wrap items-center gap-2 mb-3 p-3 bg-default-100 rounded-md">
            <span className="text-sm font-medium">
              {selectedIds.size} selected
            </span>
            <Button size="sm" variant="light" onPress={selectAllVisible}>
              Select all ({filtered.length})
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="flat"
              startContent={<FaFolderPlus size={12} />}
              onPress={openBulkAddToAlbum}
              isDisabled={selectedIds.size === 0 || albums.length === 0}
            >
              Add to album
            </Button>
            {isAlbumFilter && (
              <Button
                size="sm"
                variant="flat"
                onPress={bulkRemoveFromAlbum}
                isDisabled={selectedIds.size === 0}
              >
                Remove from album
              </Button>
            )}
            <Button
              size="sm"
              variant="flat"
              color="danger"
              startContent={<FaTrash size={12} />}
              onPress={bulkDelete}
              isDisabled={selectedIds.size === 0}
            >
              Delete
            </Button>
          </div>
        )}

        {/* Upload */}
        {!selectionEnabled && (
          <div className="mb-4">
            <PhotoUploader
              variant="dropzone"
              albumId={isAlbumFilter ? filterAlbumId : undefined}
              onUploaded={loadAll}
            />
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-3 items-end">
          <Select
            size="sm"
            label="Album"
            selectedKeys={[filterAlbumId]}
            onChange={(e) => setFilterAlbumId(e.target.value)}
            className="max-w-[200px]"
          >
            <>
              <SelectItem key={ALL}>All photos</SelectItem>
              <SelectItem key={UNFILED}>Unfiled</SelectItem>
              {albums.map((a) => (
                <SelectItem key={a.id}>{a.name}</SelectItem>
              )) as any}
            </>
          </Select>
          <Input
            size="sm"
            type="date"
            label="From"
            value={fromDate}
            onValueChange={setFromDate}
            className="max-w-[160px]"
          />
          <Input
            size="sm"
            type="date"
            label="To"
            value={toDate}
            onValueChange={setToDate}
            className="max-w-[160px]"
          />
          <Button
            size="sm"
            variant={favoritesOnly ? "solid" : "flat"}
            color={favoritesOnly ? "danger" : "default"}
            startContent={favoritesOnly ? <FaHeart size={12} /> : <FaRegHeart size={12} />}
            onPress={() => setFavoritesOnly((v) => !v)}
          >
            Favorites
          </Button>
          {hasActiveFilters && (
            <Button size="sm" variant="light" onPress={clearFilters}>
              Clear
            </Button>
          )}
        </div>
        <p className="text-xs text-default-400 mb-3">
          {filtered.length} photo{filtered.length === 1 ? "" : "s"}
        </p>

        <PhotoGrid
          photos={filtered}
          onDelete={selectionEnabled ? undefined : deletePhoto}
          selectionEnabled={selectionEnabled}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onToggleFavorite={selectionEnabled ? undefined : toggleFavorite}
        />

        {/* Bulk add to album modal */}
        <Modal isOpen={bulkAddDisclosure.isOpen} onOpenChange={bulkAddDisclosure.onOpenChange}>
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>
                  Add {selectedIds.size} photo{selectedIds.size === 1 ? "" : "s"} to album
                </ModalHeader>
                <ModalBody>
                  <Select
                    label="Album"
                    selectedKeys={[bulkTargetAlbumId]}
                    onChange={(e) => setBulkTargetAlbumId(e.target.value)}
                  >
                    {albums.map((a) => (
                      <SelectItem key={a.id}>{a.name}</SelectItem>
                    ))}
                  </Select>
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button
                    color="primary"
                    onPress={() => bulkAddToAlbum(onClose)}
                    isDisabled={!bulkTargetAlbumId}
                  >
                    Add
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
