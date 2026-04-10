"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Select, SelectItem } from "@heroui/select";
import { FaArrowLeft } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { PhotoGrid } from "@/components/photo-grid";
import { PhotoUploader } from "@/components/photo-uploader";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Photo = Schema["homePhoto"]["type"];
type Trip = Schema["homeTrip"]["type"];

export default function PhotosPage() {
  const router = useRouter();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [filterTripId, setFilterTripId] = useState<string>("all");
  const [loading, setLoading] = useState(true);

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
    const [photosRes, tripsRes] = await Promise.all([
      client.models.homePhoto.list({ limit: 500 }),
      client.models.homeTrip.list(),
    ]);
    setPhotos(
      (photosRes.data ?? []).sort((a, b) => {
        const aDate = a.takenAt ?? a.createdAt;
        const bDate = b.takenAt ?? b.createdAt;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      })
    );
    setTrips((tripsRes.data ?? []).sort((a, b) => b.startDate.localeCompare(a.startDate)));
    setLoading(false);
  }, []);

  const filtered = useMemo(() => {
    if (filterTripId === "all") return photos;
    if (filterTripId === "none") return photos.filter((p) => !p.tripId);
    return photos.filter((p) => p.tripId === filterTripId);
  }, [photos, filterTripId]);

  async function deletePhoto(photo: Photo) {
    // Delete the database record; the S3 object is orphaned and can be
    // cleaned up later with a sweep job. Keeping it simple for now.
    await client.models.homePhoto.delete({ id: photo.id });
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
  }

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
          <PhotoUploader
            tripId={filterTripId !== "all" && filterTripId !== "none" ? filterTripId : undefined}
            onUploaded={loadAll}
          />
        </div>

        <div className="mb-3">
          <Select
            size="sm"
            label="Trip"
            selectedKeys={[filterTripId]}
            onChange={(e) => setFilterTripId(e.target.value)}
            className="max-w-[250px]"
          >
            <>
              <SelectItem key="all">All photos</SelectItem>
              <SelectItem key="none">Not linked to a trip</SelectItem>
              {trips.map((t) => (
                <SelectItem key={t.id}>{t.name}</SelectItem>
              )) as any}
            </>
          </Select>
          <p className="text-xs text-default-400 mt-1">
            {filtered.length} photo{filtered.length === 1 ? "" : "s"}
          </p>
        </div>

        <PhotoGrid photos={filtered} onDelete={deletePhoto} />
      </div>
    </DefaultLayout>
  );
}
