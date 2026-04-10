"use client";

import React, { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { FaPlus, FaTrash } from "react-icons/fa";

import { CityAutocomplete } from "@/components/city-autocomplete";
import { FreeCombobox } from "@/components/free-combobox";
import { PhotoUploader } from "@/components/photo-uploader";
import { PhotoGrid } from "@/components/photo-grid";
import { AIRLINES } from "@/lib/airlines";
import {
  type Trip,
  type TripLeg,
  type TripType,
  type LegFormRow,
  type LegMode,
  type TripFormState,
  TRIP_TYPE_CONFIG,
  LEG_MODE_LABEL,
  LEG_MODE_EMOJI,
  emptyLeg,
  newTripFormState,
  tripToFormState,
} from "@/lib/trip";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Person = Schema["homePerson"]["type"];
type Photo = Schema["homePhoto"]["type"];
type Album = Schema["homeAlbum"]["type"];
type AlbumPhoto = Schema["homeAlbumPhoto"]["type"];

export interface TripFormProps {
  // null/undefined → new trip; otherwise the trip to edit
  trip?: Trip | null;
  // Reference data — passed in by the parent so it can come from a single
  // shared loadAll() and be reused across the page/modal.
  people: Person[];
  allLegs: TripLeg[];
  allPhotos: Photo[];
  albums: Album[];
  albumPhotos: AlbumPhoto[];
  // Callbacks fired after the form mutates the database. The parent
  // typically calls its own loadAll() in here to refresh state.
  onSaved?: (trip: Trip) => void;
  onDeleted?: () => void;
  onPhotosChanged?: () => void;
  // Notifies the parent when a photo upload is in flight, so the parent
  // can disable Save / Cancel buttons. The parent passes these props
  // because the actual Save/Cancel buttons live outside this component
  // (in a modal footer or a page header).
  onUploadingChange?: (uploading: boolean) => void;
  // Whether to show the photos section. Defaults to true for existing
  // trips, false for new ones (since you need a tripId to upload).
  showPhotos?: boolean;
}

/**
 * Imperative API exposed via ref so the parent can trigger save/delete.
 * (Avoids leaking the entire TripFormState into the parent.)
 */
export interface TripFormHandle {
  save: () => Promise<Trip | null>;
  delete: () => Promise<boolean>;
  isDirty: () => boolean;
}

export const TripForm = React.forwardRef<TripFormHandle, TripFormProps>(function TripForm(
  {
    trip,
    people,
    allLegs,
    allPhotos,
    albums,
    albumPhotos,
    onSaved,
    onDeleted,
    onPhotosChanged,
    onUploadingChange,
    showPhotos = true,
  },
  ref
) {
  const [form, setForm] = useState<TripFormState>(() =>
    trip ? tripToFormState(trip, allLegs) : newTripFormState()
  );

  // Re-initialize when the trip prop changes (e.g. switching between trips
  // in a modal, or navigating between /trips/[id] pages)
  useEffect(() => {
    setForm(trip ? tripToFormState(trip, allLegs) : newTripFormState());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id]);

  // ── Save / delete ────────────────────────────────────────────────────────

  const save = useCallback(async (): Promise<Trip | null> => {
    if (!form.name.trim() || !form.startDate || !form.endDate) return null;

    const destination =
      form.destination || form.destinationLat !== null
        ? {
            city: form.destination || null,
            country: form.destinationCountry || null,
            latitude: form.destinationLat,
            longitude: form.destinationLon,
          }
        : null;

    let saved: Trip | null = null;
    if (form.id) {
      const { data } = await client.models.homeTrip.update({
        id: form.id,
        name: form.name,
        type: form.type,
        startDate: form.startDate,
        endDate: form.endDate,
        destination,
        notes: form.notes || null,
        participantIds: form.participantIds,
      });
      saved = (data as Trip) ?? null;
    } else {
      const { data } = await client.models.homeTrip.create({
        name: form.name,
        type: form.type,
        startDate: form.startDate,
        endDate: form.endDate,
        destination,
        notes: form.notes || null,
        participantIds: form.participantIds,
      });
      saved = (data as Trip) ?? null;
    }

    if (saved?.id) {
      await syncLegs(saved.id, form.legs, allLegs);
    }

    if (saved) onSaved?.(saved);
    return saved;
  }, [form, allLegs, onSaved]);

  const deleteTrip = useCallback(async (): Promise<boolean> => {
    if (!form.id) return false;
    if (!confirm("Delete this trip? All legs will be deleted. Days linked to it will keep their status but lose the trip link.")) {
      return false;
    }
    const tripLegs = allLegs.filter((l) => l.tripId === form.id);
    for (const leg of tripLegs) {
      await client.models.homeTripLeg.delete({ id: leg.id });
    }
    await client.models.homeTrip.delete({ id: form.id });
    onDeleted?.();
    return true;
  }, [form.id, allLegs, onDeleted]);

  React.useImperativeHandle(
    ref,
    () => ({
      save,
      delete: deleteTrip,
      isDirty: () => true, // simple heuristic — could compare against original
    }),
    [save, deleteTrip]
  );

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      <Input
        label="Name"
        value={form.name}
        onValueChange={(v) => setForm((f) => ({ ...f, name: v }))}
        placeholder="Italy 2026"
        isRequired
      />
      <Select
        label="Type"
        selectedKeys={[form.type]}
        onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as TripType }))}
      >
        {Object.entries(TRIP_TYPE_CONFIG).map(([key, { label }]) => (
          <SelectItem key={key}>{label}</SelectItem>
        ))}
      </Select>
      <div className="flex gap-2">
        <Input
          label="Start date"
          type="date"
          value={form.startDate}
          onValueChange={(v) => setForm((f) => ({ ...f, startDate: v }))}
        />
        <Input
          label="End date"
          type="date"
          value={form.endDate}
          onValueChange={(v) => setForm((f) => ({ ...f, endDate: v }))}
        />
      </div>
      <CityAutocomplete
        label="Destination"
        placeholder="Rome, Italy"
        value={form.destination}
        onValueChange={(v) => setForm((f) => ({ ...f, destination: v }))}
        onSelect={(r) =>
          setForm((f) => ({
            ...f,
            destinationLat: r.latitude,
            destinationLon: r.longitude,
            destinationCountry: r.country,
          }))
        }
      />
      <Select
        label="Participants"
        selectionMode="multiple"
        selectedKeys={new Set(form.participantIds)}
        onSelectionChange={(keys) =>
          setForm((f) => ({ ...f, participantIds: Array.from(keys as Set<string>) }))
        }
      >
        {people.map((p) => (
          <SelectItem key={p.id}>{p.name}</SelectItem>
        ))}
      </Select>
      <Textarea
        label="Notes"
        value={form.notes}
        onValueChange={(v) => setForm((f) => ({ ...f, notes: v }))}
        minRows={2}
      />

      {/* ── Legs editor ────────────────────────────────────────────────── */}
      <div className="border-t border-default-200 pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium">Transportation</p>
          <Button
            size="sm"
            variant="flat"
            startContent={<FaPlus size={10} />}
            onPress={() =>
              setForm((f) => ({
                ...f,
                legs: [...f.legs, emptyLeg(f.legs.length)],
              }))
            }
          >
            Add leg
          </Button>
        </div>
        {form.legs.length === 0 && (
          <p className="text-xs text-default-400">
            Add flights, drives, or other segments for this trip.
          </p>
        )}
        <div className="space-y-3">
          {form.legs.map((leg, idx) => {
            const updateLeg = (patch: Partial<LegFormRow>) =>
              setForm((f) => ({
                ...f,
                legs: f.legs.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
              }));
            const removeLeg = () =>
              setForm((f) => ({
                ...f,
                legs: f.legs.filter((_, i) => i !== idx),
              }));
            return (
              <div
                key={idx}
                className="border border-default-200 rounded-md p-3 space-y-2 bg-default-50"
              >
                <div className="flex items-center gap-2">
                  <Select
                    size="sm"
                    label="Mode"
                    selectedKeys={[leg.mode]}
                    onChange={(e) => updateLeg({ mode: e.target.value as LegMode })}
                    className="flex-1"
                  >
                    {(Object.keys(LEG_MODE_LABEL) as LegMode[]).map((m) => (
                      <SelectItem key={m}>
                        {LEG_MODE_EMOJI[m]} {LEG_MODE_LABEL[m]}
                      </SelectItem>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    isIconOnly
                    variant="light"
                    color="danger"
                    onPress={removeLeg}
                  >
                    <FaTrash size={10} />
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    label="From"
                    placeholder="City"
                    value={leg.fromCity}
                    onValueChange={(v) => updateLeg({ fromCity: v })}
                  />
                  <Input
                    size="sm"
                    label="To"
                    placeholder="City"
                    value={leg.toCity}
                    onValueChange={(v) => updateLeg({ toCity: v })}
                  />
                </div>
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    label="Depart"
                    type="datetime-local"
                    value={leg.departAt}
                    onValueChange={(v) => updateLeg({ departAt: v })}
                  />
                  <Input
                    size="sm"
                    label="Arrive"
                    type="datetime-local"
                    value={leg.arriveAt}
                    onValueChange={(v) => updateLeg({ arriveAt: v })}
                  />
                </div>
                {leg.mode === "COMMERCIAL_FLIGHT" && (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <FreeCombobox
                        label="Airline"
                        value={leg.airline}
                        onValueChange={(v) => updateLeg({ airline: v })}
                        options={AIRLINES}
                      />
                    </div>
                    <Input
                      size="sm"
                      label="Flight #"
                      placeholder="DL123"
                      value={leg.flightNumber}
                      onValueChange={(v) => updateLeg({ flightNumber: v })}
                    />
                  </div>
                )}
                {leg.mode === "PERSONAL_FLIGHT" && (
                  <Input
                    size="sm"
                    label="Aircraft tail #"
                    placeholder="N12345"
                    value={leg.aircraft}
                    onValueChange={(v) => updateLeg({ aircraft: v })}
                  />
                )}
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    label="Confirmation #"
                    value={leg.confirmationCode}
                    onValueChange={(v) => updateLeg({ confirmationCode: v })}
                  />
                  <Input
                    size="sm"
                    label="URL"
                    value={leg.url}
                    onValueChange={(v) => updateLeg({ url: v })}
                  />
                </div>
                <Textarea
                  size="sm"
                  label="Notes"
                  value={leg.notes}
                  onValueChange={(v) => updateLeg({ notes: v })}
                  minRows={1}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Photos (only available once the trip is saved) ──────────────── */}
      {showPhotos && form.id && (
        <TripPhotosSection
          tripId={form.id}
          tripName={form.name}
          allPhotos={allPhotos}
          albums={albums}
          albumPhotos={albumPhotos}
          onPhotosChanged={onPhotosChanged}
          onUploadingChange={onUploadingChange}
        />
      )}
    </div>
  );
});

// Photos section: shows photos from any album linked to this trip and
// uploads to the trip's primary album (auto-creates one on first upload).
function TripPhotosSection({
  tripId,
  tripName,
  allPhotos,
  albums,
  albumPhotos,
  onPhotosChanged,
  onUploadingChange,
}: {
  tripId: string;
  tripName: string;
  allPhotos: Photo[];
  albums: Album[];
  albumPhotos: AlbumPhoto[];
  onPhotosChanged?: () => void;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  // Find albums whose tripIds includes this trip
  const linkedAlbums = albums.filter((a) =>
    (a.tripIds ?? []).filter((id): id is string => !!id).includes(tripId)
  );

  // The primary album is the first linked album by createdAt (oldest first
  // so the most "established" album is the upload target)
  const primaryAlbum =
    [...linkedAlbums].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )[0] ?? null;

  // All photos that belong to any linked album
  const linkedPhotoIds = new Set(
    albumPhotos
      .filter((ap) => linkedAlbums.some((la) => la.id === ap.albumId))
      .map((ap) => ap.photoId)
  );
  const photosForTrip = allPhotos
    .filter((p) => linkedPhotoIds.has(p.id))
    .sort((a, b) => {
      const aDate = a.takenAt ?? a.createdAt;
      const bDate = b.takenAt ?? b.createdAt;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });

  async function createAlbumForTrip() {
    const name = tripName.trim() || "Trip photos";
    await client.models.homeAlbum.create({
      name,
      tripIds: [tripId],
    });
    onPhotosChanged?.();
  }

  async function deletePhoto(photo: Photo) {
    // Delete all join rows then the photo
    const joins = await client.models.homeAlbumPhoto.list({
      filter: { photoId: { eq: photo.id } },
      limit: 100,
    });
    for (const j of joins.data ?? []) {
      await client.models.homeAlbumPhoto.delete({ id: j.id });
    }
    await client.models.homePhoto.delete({ id: photo.id });
    onPhotosChanged?.();
  }

  return (
    <div className="border-t border-default-200 pt-4">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-sm font-medium">Photos</p>
        {linkedAlbums.length > 0 && (
          <p className="text-xs text-default-400">
            From {linkedAlbums.length} album{linkedAlbums.length === 1 ? "" : "s"}
          </p>
        )}
      </div>
      {primaryAlbum ? (
        <>
          <div className="mb-3">
            <PhotoUploader
              variant="dropzone"
              albumId={primaryAlbum.id}
              onUploaded={onPhotosChanged}
              onUploadingChange={onUploadingChange}
            />
          </div>
          <PhotoGrid photos={photosForTrip} onDelete={deletePhoto} />
        </>
      ) : (
        <div className="border border-dashed border-default-300 rounded-md p-6 text-center bg-default-50">
          <p className="text-sm text-default-500 mb-3">
            No album linked to this trip yet.
          </p>
          <Button size="sm" color="primary" onPress={createAlbumForTrip}>
            Create album for this trip
          </Button>
        </div>
      )}
    </div>
  );
}

// Helper used by save() — diffs the form's leg list against existing legs
async function syncLegs(tripId: string, formLegs: LegFormRow[], existingAll: TripLeg[]) {
  const existing = existingAll.filter((l) => l.tripId === tripId);
  const formIds = new Set(formLegs.map((l) => l.id).filter((id) => id !== ""));

  // Delete legs that are no longer in the form
  for (const ex of existing) {
    if (!formIds.has(ex.id)) {
      await client.models.homeTripLeg.delete({ id: ex.id });
    }
  }

  // Create or update each form leg
  for (let i = 0; i < formLegs.length; i++) {
    const leg = formLegs[i];
    const fromLocation = leg.fromCity ? { city: leg.fromCity } : null;
    const toLocation = leg.toCity ? { city: leg.toCity } : null;
    const payload = {
      tripId,
      mode: leg.mode,
      departAt: leg.departAt ? new Date(leg.departAt).toISOString() : null,
      arriveAt: leg.arriveAt ? new Date(leg.arriveAt).toISOString() : null,
      fromLocation,
      toLocation,
      airline: leg.airline || null,
      flightNumber: leg.flightNumber || null,
      aircraft: leg.aircraft || null,
      confirmationCode: leg.confirmationCode || null,
      url: leg.url || null,
      notes: leg.notes || null,
      sortOrder: i,
    };
    if (leg.id) {
      await client.models.homeTripLeg.update({ id: leg.id, ...payload });
    } else {
      await client.models.homeTripLeg.create(payload);
    }
  }
}
