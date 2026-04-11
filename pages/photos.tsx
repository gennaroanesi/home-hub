"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
type Person = Schema["homePerson"]["type"];
type PhotoFace = Schema["homePhotoFace"]["type"];

const ALL = "all";
const UNFILED = "unfiled";

// Walk `nextToken` until the full model is loaded. Amplify's `.list` caps
// a single request at 1 MB (AppSync DynamoDB resolver limit) regardless of
// the `limit` you pass, so anything over a few hundred rows silently
// truncates unless you paginate. We keep calling the fetcher with the
// previous page's nextToken until it comes back null.
async function listAllPages<T>(
  fetcher: (nextToken: string | null) => Promise<{ data?: T[] | null; nextToken?: string | null }>
): Promise<T[]> {
  const collected: T[] = [];
  let token: string | null = null;
  do {
    const res = await fetcher(token);
    collected.push(...(res.data ?? []));
    token = res.nextToken ?? null;
  } while (token);
  return collected;
}

// A date filter input that renders truly empty when cleared. HeroUI's
// Input with type="date" and value="" shows today's date as a ghost
// placeholder on Chrome/Safari macOS, which looks like a bug. We work
// around it by rendering type="text" with an empty value when the field
// is both blank AND not focused — swapping to type="date" the moment
// the user focuses so the native date picker opens normally. Clear
// button lives in endContent and visible only when there's a value.
function DateFilterInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const showAsDate = !!value || focused;

  return (
    <Input
      size="sm"
      type={showAsDate ? "date" : "text"}
      label={label}
      placeholder=" "
      value={value}
      onValueChange={onChange}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className="max-w-[160px]"
      endContent={
        value ? (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()} date`}
            className="text-default-400 hover:text-default-600"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
          >
            <FaTimes size={12} />
          </button>
        ) : null
      }
    />
  );
}

export default function PhotosPage() {
  const router = useRouter();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumPhotos, setAlbumPhotos] = useState<AlbumPhoto[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [photoFaces, setPhotoFaces] = useState<PhotoFace[]>([]);
  const [filterAlbumId, setFilterAlbumId] = useState<string>(ALL);
  const [filterPersonId, setFilterPersonId] = useState<string>(ALL);
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

  // Initialize filters from URL query params EXACTLY ONCE when the router
  // is first ready. This effect must NOT re-run on every router.query
  // change — `router.query` is a fresh object reference on every render,
  // so depending on it made the effect fire continuously and rewrite state
  // from a stale URL. Symptom: clicking Clear reset state for one render,
  // then the effect ran again with the still-unchanged URL and put the
  // old filters right back.
  const didInitFromUrl = useRef(false);
  useEffect(() => {
    if (!router.isReady) return;
    if (didInitFromUrl.current) return;
    didInitFromUrl.current = true;
    const { album, from, to, favorites, person } = router.query;
    if (typeof album === "string") setFilterAlbumId(album);
    if (typeof from === "string") setFromDate(from);
    if (typeof to === "string") setToDate(to);
    if (favorites === "1") setFavoritesOnly(true);
    if (typeof person === "string") setFilterPersonId(person);
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
    // Paginate through every model we display — Amplify's `.list({ limit })`
    // is a single-page cap, not a total cap, and AppSync's DynamoDB
    // resolver has a hard 1 MB response size. Passing limit: 1000 on
    // homePhoto stopped somewhere around page 1 for photos with enough
    // EXIF metadata, which silently capped the page's photo list to a
    // subset of what DynamoDB actually contains. Same story for the
    // join + face tables. The loop below follows nextToken until the
    // full model is loaded.
    const allPhotos = await listAllPages(
      (token) => client.models.homePhoto.list({ limit: 1000, nextToken: token })
    );
    const allAlbums = await listAllPages(
      (token) => client.models.homeAlbum.list({ limit: 500, nextToken: token })
    );
    const allJoins = await listAllPages(
      (token) => client.models.homeAlbumPhoto.list({ limit: 1000, nextToken: token })
    );
    const allPeople = await listAllPages(
      (token) => client.models.homePerson.list({ limit: 100, nextToken: token })
    );
    // homePhotoFace is loaded with a soft failure: when the model isn't
    // deployed yet (e.g. between schema bump and ampx sandbox redeploy),
    // we don't want it to take down the whole photos page.
    const allFaces = await listAllPages<PhotoFace>(
      (token) =>
        (client.models.homePhotoFace?.list({ limit: 1000, nextToken: token }) ??
          Promise.resolve({ data: [] as PhotoFace[], nextToken: null })) as any
    ).catch((err) => {
      console.warn("homePhotoFace not available yet:", err);
      return [] as PhotoFace[];
    });

    setPhotos(
      allPhotos.sort((a, b) => {
        const aDate = a.takenAt ?? a.createdAt;
        const bDate = b.takenAt ?? b.createdAt;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      })
    );
    setAlbums(allAlbums.sort((a, b) => a.name.localeCompare(b.name)));
    setAlbumPhotos(allJoins);
    setPeople(allPeople.sort((a, b) => a.name.localeCompare(b.name)));
    setPhotoFaces(allFaces);
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

  // Build personId → Set<photoId> for the person filter
  const personToPhotos = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const f of photoFaces) {
      if (!f.personId) continue;
      if (!map.has(f.personId)) map.set(f.personId, new Set());
      map.get(f.personId)!.add(f.photoId);
    }
    return map;
  }, [photoFaces]);

  const filtered = useMemo(() => {
    let result = photos;

    if (filterAlbumId === UNFILED) {
      result = result.filter((p) => !photoToAlbums.has(p.id) || photoToAlbums.get(p.id)!.size === 0);
    } else if (filterAlbumId !== ALL) {
      result = result.filter((p) => photoToAlbums.get(p.id)?.has(filterAlbumId));
    }

    if (filterPersonId !== ALL) {
      const set = personToPhotos.get(filterPersonId);
      result = set ? result.filter((p) => set.has(p.id)) : [];
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
  }, [photos, filterAlbumId, filterPersonId, fromDate, toDate, favoritesOnly, photoToAlbums, personToPhotos]);

  function clearFilters() {
    setFilterAlbumId(ALL);
    setFilterPersonId(ALL);
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

  const hasActiveFilters = filterAlbumId !== ALL || filterPersonId !== ALL || fromDate || toDate || favoritesOnly;
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
          {people.length > 0 && (
            <Select
              size="sm"
              label="Person"
              selectedKeys={[filterPersonId]}
              onChange={(e) => setFilterPersonId(e.target.value || ALL)}
              className="max-w-[200px]"
            >
              <>
                <SelectItem key={ALL} textValue="Anyone">
                  Anyone
                </SelectItem>
                {people.map((p) => (
                  // textValue is what HeroUI renders in the collapsed
                  // trigger — without it, the Select shows a blank value
                  // after selection because it can't extract a display
                  // string from the mixed emoji + name children.
                  <SelectItem key={p.id} textValue={p.name}>
                    {p.emoji ? `${p.emoji} ` : ""}
                    {p.name}
                  </SelectItem>
                )) as any}
              </>
            </Select>
          )}
          {/*
            Date inputs render as type="date" only when they have a value.
            When empty, we swap to type="text" with a placeholder so the
            browser's native date picker doesn't render today's date as a
            ghost placeholder — which it does on Chrome/Safari on macOS
            when value="" and the label is floating. On first focus we
            flip back to type="date" so the native picker opens. This is
            the simplest way to get a truly-empty visual state with the
            native date input.
          */}
          <DateFilterInput label="From" value={fromDate} onChange={setFromDate} />
          <DateFilterInput label="To" value={toDate} onChange={setToDate} />
          <Button
            variant={favoritesOnly ? "solid" : "flat"}
            color={favoritesOnly ? "danger" : "default"}
            startContent={favoritesOnly ? <FaHeart size={14} /> : <FaRegHeart size={14} />}
            onPress={() => setFavoritesOnly((v) => !v)}
            className="h-12"
          >
            Favorites
          </Button>
          {hasActiveFilters && (
            <Button variant="light" onPress={clearFilters} className="h-12">
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
