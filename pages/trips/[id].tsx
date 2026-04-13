"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { FaArrowLeft, FaTrash } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { TripForm, type TripFormHandle } from "@/components/trip-form";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Trip = Schema["homeTrip"]["type"];
type TripLeg = Schema["homeTripLeg"]["type"];
type TripReservation = Schema["homeTripReservation"]["type"];
type Photo = Schema["homePhoto"]["type"];
type Person = Schema["homePerson"]["type"];
type Album = Schema["homeAlbum"]["type"];
type AlbumPhoto = Schema["homeAlbumPhoto"]["type"];

export default function TripDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const isNew = id === "new";

  const tripFormRef = useRef<TripFormHandle>(null);

  const [trip, setTrip] = useState<Trip | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [allLegs, setAllLegs] = useState<TripLeg[]>([]);
  const [allReservations, setAllReservations] = useState<TripReservation[]>([]);
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumPhotos, setAlbumPhotos] = useState<AlbumPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [photosUploading, setPhotosUploading] = useState(false);
  const [saving, setSaving] = useState(false);

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
    setLoading(true);
    const [peopleRes, legsRes, reservationsRes, photosRes, albumsRes, albumPhotosRes] =
      await Promise.all([
        client.models.homePerson.list(),
        client.models.homeTripLeg.list({ limit: 1000 }),
        client.models.homeTripReservation.list({ limit: 1000 }),
        client.models.homePhoto.list({ limit: 1000 }),
        client.models.homeAlbum.list({ limit: 500 }),
        client.models.homeAlbumPhoto.list({ limit: 5000 }),
      ]);
    setPeople((peopleRes.data ?? []).filter((p) => p.active));
    setAllLegs(legsRes.data ?? []);
    setAllReservations(reservationsRes.data ?? []);
    setAllPhotos(photosRes.data ?? []);
    setAlbums(albumsRes.data ?? []);
    setAlbumPhotos(albumPhotosRes.data ?? []);

    if (typeof id === "string" && id !== "new") {
      const { data } = await client.models.homeTrip.get({ id });
      setTrip(data ?? null);
    } else {
      setTrip(null);
    }
    setLoading(false);
  }, [id]);

  async function handleSave() {
    setSaving(true);
    try {
      const saved = await tripFormRef.current?.save();
      if (saved) {
        if (isNew) {
          // Navigate to the new trip's permanent URL
          router.replace(`/trips/${saved.id}`);
        } else {
          await loadAll();
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const ok = await tripFormRef.current?.delete();
    if (ok) router.push("/trips");
  }

  if (loading) {
    return (
      <DefaultLayout>
        <div className="max-w-4xl mx-auto px-4 py-10 text-center text-default-400">Loading…</div>
      </DefaultLayout>
    );
  }

  if (!isNew && !trip) {
    return (
      <DefaultLayout>
        <div className="max-w-4xl mx-auto px-4 py-10">
          <div className="flex items-center gap-2 mb-4">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/trips")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-xl font-bold">Trip not found</h1>
          </div>
          <p className="text-sm text-default-400">
            This trip may have been deleted or the link is broken.
          </p>
        </div>
      </DefaultLayout>
    );
  }

  return (
    <DefaultLayout>
      <div className="max-w-4xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/trips")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">
              {isNew ? "New Trip" : trip?.name}
            </h1>
          </div>
          <div className="flex gap-2">
            {!isNew && (
              <Button
                size="sm"
                color="danger"
                variant="light"
                startContent={<FaTrash size={12} />}
                onPress={handleDelete}
                isDisabled={photosUploading || saving}
              >
                Delete
              </Button>
            )}
            <Button
              size="sm"
              color="primary"
              onPress={handleSave}
              isDisabled={photosUploading || saving}
            >
              {photosUploading
                ? "Uploading photos…"
                : saving
                ? "Saving…"
                : isNew
                ? "Create"
                : "Save"}
            </Button>
          </div>
        </div>

        <TripForm
          ref={tripFormRef}
          trip={trip}
          people={people}
          allLegs={allLegs}
          allReservations={allReservations}
          allPhotos={allPhotos}
          albums={albums}
          albumPhotos={albumPhotos}
          onPhotosChanged={loadAll}
          onUploadingChange={setPhotosUploading}
        />

      </div>
    </DefaultLayout>
  );
}
