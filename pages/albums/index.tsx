"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { FaArrowLeft, FaPlus, FaImages } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { photoUrl } from "@/lib/image-loader";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Album = Schema["homeAlbum"]["type"];
type AlbumPhoto = Schema["homeAlbumPhoto"]["type"];
type Photo = Schema["homePhoto"]["type"];

export default function AlbumsPage() {
  const router = useRouter();
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumPhotos, setAlbumPhotos] = useState<AlbumPhoto[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);

  // Create album modal
  const createDisclosure = useDisclosure();
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");

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
    const [albumsRes, joinRes, photosRes] = await Promise.all([
      client.models.homeAlbum.list({ limit: 500 }),
      client.models.homeAlbumPhoto.list({ limit: 5000 }),
      client.models.homePhoto.list({ limit: 1000 }),
    ]);
    setAlbums(
      (albumsRes.data ?? []).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    );
    setAlbumPhotos(joinRes.data ?? []);
    setPhotos(photosRes.data ?? []);
    setLoading(false);
  }, []);

  // photoCount and coverPhoto helpers
  const albumPhotoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ap of albumPhotos) {
      counts.set(ap.albumId, (counts.get(ap.albumId) ?? 0) + 1);
    }
    return counts;
  }, [albumPhotos]);

  function coverPhotoFor(album: Album): Photo | null {
    if (album.coverPhotoId) {
      const explicit = photos.find((p) => p.id === album.coverPhotoId);
      if (explicit) return explicit;
    }
    // Fallback: first photo in the album by sortOrder/createdAt
    const ids = albumPhotos
      .filter((ap) => ap.albumId === album.id)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (const ap of ids) {
      const p = photos.find((p) => p.id === ap.photoId);
      if (p) return p;
    }
    return null;
  }

  function openCreate() {
    setNewName("");
    setNewDescription("");
    createDisclosure.onOpen();
  }

  async function createAlbum(onClose: () => void) {
    if (!newName.trim()) return;
    const { data } = await client.models.homeAlbum.create({
      name: newName.trim(),
      description: newDescription.trim() || null,
    });
    onClose();
    if (data) router.push(`/albums/${data.id}`);
  }

  return (
    <DefaultLayout>
      <div className="max-w-6xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        <div className="flex items-center justify-between mb-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">Albums</h1>
            {loading && (
              <span className="hidden sm:inline text-xs text-default-400 animate-pulse">Loading…</span>
            )}
          </div>
          <Button size="sm" color="primary" startContent={<FaPlus size={12} />} onPress={openCreate}>
            New Album
          </Button>
        </div>

        {albums.length === 0 && !loading && (
          <p className="text-center text-default-300 py-10 text-sm">
            No albums yet. Create one to start organizing your photos.
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {albums.map((album) => {
            const cover = coverPhotoFor(album);
            const count = albumPhotoCounts.get(album.id) ?? 0;
            return (
              <NextLink key={album.id} href={`/albums/${album.id}`} className="block">
                <div className="rounded-md overflow-hidden bg-default-100 hover:bg-default-200 transition-colors">
                  <div className="aspect-square bg-default-200 relative">
                    {cover ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photoUrl(cover.s3key, 400, 70)}
                        alt={album.name}
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-default-400">
                        <FaImages size={32} />
                      </div>
                    )}
                  </div>
                  <div className="p-2">
                    <p className="text-sm font-medium truncate">{album.name}</p>
                    <p className="text-xs text-default-400">
                      {count} photo{count === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
              </NextLink>
            );
          })}
        </div>

        {/* Create modal */}
        <Modal isOpen={createDisclosure.isOpen} onOpenChange={createDisclosure.onOpenChange}>
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>New Album</ModalHeader>
                <ModalBody>
                  <Input
                    label="Name"
                    value={newName}
                    onValueChange={setNewName}
                    isRequired
                    placeholder="Italy 2026"
                  />
                  <Textarea
                    label="Description"
                    value={newDescription}
                    onValueChange={setNewDescription}
                    minRows={2}
                  />
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => createAlbum(onClose)}>
                    Create
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
