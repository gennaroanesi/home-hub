"use client";

import React, { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { DateInput } from "./date-input";
import { Select, SelectItem } from "@heroui/select";
import { addToast } from "@heroui/react";
import { FaPlus, FaTrash, FaCalendarPlus, FaSave } from "react-icons/fa";

import { CityAutocomplete } from "@/components/city-autocomplete";
import { ChecklistPanel } from "@/components/checklist-panel";
import { RemindersSection } from "@/components/reminders-section";
import { NotesSection } from "@/components/notes-section";
import { buildReminderDefaultsForTrip } from "@/lib/reminder-defaults";
import { cascadeDeleteRemindersFor } from "@/lib/reminder-parent";
import { cascadeDeleteNotesFor } from "@/lib/note-parent";
import { tzAbbreviation } from "@/lib/timezone";
import { AttachmentSection } from "@/components/attachment-section";
import { FreeCombobox } from "@/components/free-combobox";
import { PhotoUploader } from "@/components/photo-uploader";
import { PhotoGrid } from "@/components/photo-grid";
import { AIRLINES } from "@/lib/airlines";
import {
  type Trip,
  type TripLeg,
  type TripReservation,
  type TripType,
  type LegFormRow,
  type LegMode,
  type ReservationFormRow,
  type ReservationType,
  type TripFormState,
  TRIP_TYPE_CONFIG,
  LEG_MODE_LABEL,
  LEG_MODE_EMOJI,
  RESERVATION_TYPE_LABEL,
  RESERVATION_TYPE_EMOJI,
  emptyLeg,
  emptyReservation,
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
  allReservations?: TripReservation[];
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
    allReservations = [],
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
    trip ? tripToFormState(trip, allLegs, allReservations) : newTripFormState()
  );

  // Re-initialize when the trip prop changes (e.g. switching between trips
  // in a modal, or navigating between /trips/[id] pages)
  useEffect(() => {
    setForm(trip ? tripToFormState(trip, allLegs, allReservations) : newTripFormState());
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
      await syncReservations(saved.id, form.reservations, allReservations);
      // Promote create → edit locally so subsequent actions in the
      // same modal (e.g. adding a reminder after saving) see the
      // trip's id without waiting for the parent to re-pass `trip`.
      if (!form.id) setForm((f) => ({ ...f, id: saved!.id }));
    }

    if (saved) onSaved?.(saved);
    return saved;
  }, [form, allLegs, allReservations, onSaved]);

  const deleteTrip = useCallback(async (): Promise<boolean> => {
    if (!form.id) return false;
    if (!confirm("Delete this trip? All legs and reservations will be deleted. Days linked to it will keep their status but lose the trip link.")) {
      return false;
    }
    const tripLegs = allLegs.filter((l) => l.tripId === form.id);
    for (const leg of tripLegs) {
      await client.models.homeTripLeg.delete({ id: leg.id });
    }
    const tripReservations = allReservations.filter((r) => r.tripId === form.id);
    for (const r of tripReservations) {
      await client.models.homeTripReservation.delete({ id: r.id });
    }
    await cascadeDeleteRemindersFor(client, form.id);
    await cascadeDeleteNotesFor(client, form.id);
    await client.models.homeTrip.delete({ id: form.id });
    onDeleted?.();
    return true;
  }, [form.id, allLegs, allReservations, onDeleted]);

  // ── Create calendar event from a saved reservation ────────────────────
  // Direct API call via the data client; toast on success/error. No
  // navigation — user stays in the trip form. Only enabled once the
  // reservation has been saved (has an id), since the event references
  // tripId and we need the reservation's saved fields to be authoritative.
  const createEventFromReservation = useCallback(
    async (r: ReservationFormRow) => {
      if (!r.id || !form.id) return;
      try {
        const descParts: string[] = [];
        descParts.push(RESERVATION_TYPE_LABEL[r.type]);
        if (r.confirmationCode) descParts.push(`Confirmation: ${r.confirmationCode}`);
        if (r.notes) descParts.push(r.notes);
        const description = descParts.join("\n");

        const location =
          r.city || r.country
            ? { city: r.city || null, country: r.country || null }
            : null;

        // startAt is required on homeCalendarEvent; fall back to the trip
        // start date at noon (wall-clock) if the user didn't fill it in.
        const startAt = r.startAt
          ? `${r.startAt}:00.000Z`
          : `${form.startDate}T12:00:00.000Z`;
        const endAt = r.endAt ? `${r.endAt}:00.000Z` : null;

        const { data, errors } = await client.models.homeCalendarEvent.create({
          title: r.name,
          description: description || null,
          startAt,
          endAt,
          location,
          url: r.url || null,
          tripId: form.id,
          assignedPersonIds: form.participantIds,
        });
        if (errors && errors.length > 0) {
          addToast({
            title: "Failed to create event",
            description: errors.map((e) => e.message).join(", "),
          });
          return;
        }
        addToast({
          title: "Event created",
          description: data?.title ?? r.name,
        });
      } catch (err) {
        addToast({
          title: "Failed to create event",
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [form.id, form.startDate, form.participantIds]
  );

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
          <SelectItem key={key} textValue={label}>{label}</SelectItem>
        ))}
      </Select>
      <div className="flex gap-2">
        <DateInput
          label="Start date"
          value={form.startDate}
          onChange={(v) =>
            setForm((f) => ({
              ...f,
              startDate: v,
              // Auto-advance end date if it's empty or now earlier than the
              // new start. Same UX as the calendar event end-time field.
              endDate: !f.endDate || f.endDate < v ? v : f.endDate,
            }))
          }
          isRequired
        />
        <DateInput
          label="End date"
          value={form.endDate}
          onChange={(v) => setForm((f) => ({ ...f, endDate: v }))}
          isRequired
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
          <SelectItem key={p.id} textValue={p.name}>{p.name}</SelectItem>
        ))}
      </Select>
      <Textarea
        label="Notes"
        value={form.notes}
        onValueChange={(v) => setForm((f) => ({ ...f, notes: v }))}
        minRows={2}
      />

      <div className="border-t border-default-200 pt-4">
        <RemindersSection
          parentType="TRIP"
          parentId={form.id || undefined}
          people={people}
          defaults={buildReminderDefaultsForTrip({
            name: form.name,
            startDate: form.startDate,
            participantIds: form.participantIds,
          })}
          onBeforeAdd={
            form.id
              ? undefined
              : async () => {
                  // Reuse the full trip save (header + legs + reservations)
                  // so the draft is complete before the user adds a reminder.
                  const saved = await save();
                  return saved?.id ?? null;
                }
          }
        />
      </div>

      <div className="border-t border-default-200 pt-4">
        <NotesSection
          parentType="TRIP"
          parentId={form.id || undefined}
          onBeforeAdd={
            form.id
              ? undefined
              : async () => {
                  const saved = await save();
                  return saved?.id ?? null;
                }
          }
        />
      </div>

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
                      // textValue is what HeroUI renders in the collapsed
                      // trigger — without it, Select can't extract a display
                      // string from the mixed emoji + label children and
                      // shows a blank value after selection. Same fix as
                      // the person Select in commit 541b895e.
                      <SelectItem key={m} textValue={LEG_MODE_LABEL[m]}>
                        {LEG_MODE_EMOJI[m]} {LEG_MODE_LABEL[m]}
                      </SelectItem>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    isIconOnly
                    variant="flat"
                    color="primary"
                    onPress={() => save()}
                    title="Save trip"
                  >
                    <FaSave size={10} />
                  </Button>
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
                  <CityAutocomplete
                    label="From"
                    placeholder="City"
                    value={leg.fromCity}
                    onValueChange={(v) => updateLeg({ fromCity: v })}
                    onSelect={(r) =>
                      updateLeg({
                        fromCity: r.country ? `${r.city}, ${r.country}` : r.city,
                        fromLatitude: r.latitude,
                        fromLongitude: r.longitude,
                        fromTimezone: r.timezone,
                      })
                    }
                  />
                  <CityAutocomplete
                    label="To"
                    placeholder="City"
                    value={leg.toCity}
                    onValueChange={(v) => updateLeg({ toCity: v })}
                    onSelect={(r) =>
                      updateLeg({
                        toCity: r.country ? `${r.city}, ${r.country}` : r.city,
                        toLatitude: r.latitude,
                        toLongitude: r.longitude,
                        toTimezone: r.timezone,
                      })
                    }
                  />
                </div>
                {(leg.mode === "COMMERCIAL_FLIGHT" || leg.mode === "PERSONAL_FLIGHT") && (
                  // Airport codes live on the from/to location object. We
                  // only expose the input for flight modes — for cars/trains
                  // the field is meaningless. ICAO / IATA / private field
                  // codes are all accepted; no validation.
                  <div className="flex gap-2">
                    <Input
                      size="sm"
                      label="Airport"
                      placeholder="KAUS"
                      value={leg.fromAirport}
                      onValueChange={(v) => updateLeg({ fromAirport: v })}
                    />
                    <Input
                      size="sm"
                      label="Airport"
                      placeholder="KEWR"
                      value={leg.toAirport}
                      onValueChange={(v) => updateLeg({ toAirport: v })}
                    />
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    // Show the local TZ abbreviation next to the label when
                    // it's known. Pass the actual depart datetime so DST is
                    // resolved correctly (CST vs CDT, EST vs EDT, etc).
                    label={`Depart${
                      leg.fromTimezone
                        ? ` (${tzAbbreviation(
                            leg.fromTimezone,
                            leg.departAt ? new Date(leg.departAt) : undefined
                          )})`
                        : ""
                    }`}
                    type="datetime-local"
                    value={leg.departAt}
                    onValueChange={(v) => updateLeg({ departAt: v })}
                  />
                  <Input
                    size="sm"
                    label={`Arrive${
                      leg.toTimezone
                        ? ` (${tzAbbreviation(
                            leg.toTimezone,
                            leg.arriveAt ? new Date(leg.arriveAt) : undefined
                          )})`
                        : ""
                    }`}
                    type="datetime-local"
                    value={leg.arriveAt}
                    onValueChange={(v) => updateLeg({ arriveAt: v })}
                  />
                </div>
                {leg.mode === "COMMERCIAL_FLIGHT" && (
                  // 2fr/1fr grid so the airline combobox always dominates
                  // and "American Airlines" etc. fits fully, while flight #
                  // still has room for ~6 chars. A plain flex row let the
                  // airline label collapse to "A..." at typical form widths.
                  <div className="grid grid-cols-[2fr_1fr] gap-2">
                    <FreeCombobox
                      label="Airline"
                      value={leg.airline}
                      onValueChange={(v) => updateLeg({ airline: v })}
                      options={AIRLINES}
                    />
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

      {/* ── Reservations editor ──────────────────────────────────────── */}
      <div className="border-t border-default-200 pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium">Reservations</p>
          <Button
            size="sm"
            variant="flat"
            startContent={<FaPlus size={10} />}
            onPress={() =>
              setForm((f) => ({
                ...f,
                reservations: [...f.reservations, emptyReservation(f.reservations.length)],
              }))
            }
          >
            Add reservation
          </Button>
        </div>
        {form.reservations.length === 0 && (
          <p className="text-xs text-default-400">
            Hotels, car rentals, tickets, tours, etc.
          </p>
        )}
        <div className="space-y-3">
          {form.reservations.map((res, idx) => {
            const updateRes = (patch: Partial<ReservationFormRow>) =>
              setForm((f) => ({
                ...f,
                reservations: f.reservations.map((r, i) =>
                  i === idx ? { ...r, ...patch } : r
                ),
              }));
            const removeRes = () =>
              setForm((f) => ({
                ...f,
                reservations: f.reservations.filter((_, i) => i !== idx),
              }));
            return (
              <div
                key={idx}
                className="border border-default-200 rounded-md p-3 space-y-2 bg-default-50"
              >
                <div className="flex items-center gap-2">
                  <Select
                    size="sm"
                    label="Type"
                    selectedKeys={[res.type]}
                    onChange={(e) => updateRes({ type: e.target.value as ReservationType })}
                    className="flex-1"
                  >
                    {(Object.keys(RESERVATION_TYPE_LABEL) as ReservationType[]).map((t) => (
                      // textValue required — same reason as the leg mode Select
                      // (mixed emoji + label children). See commit 541b895e.
                      <SelectItem key={t} textValue={RESERVATION_TYPE_LABEL[t]}>
                        {RESERVATION_TYPE_EMOJI[t]} {RESERVATION_TYPE_LABEL[t]}
                      </SelectItem>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    isIconOnly
                    variant="flat"
                    color="primary"
                    onPress={() => save()}
                    title="Save trip"
                  >
                    <FaSave size={10} />
                  </Button>
                  <Button
                    size="sm"
                    isIconOnly
                    variant="light"
                    color="danger"
                    onPress={removeRes}
                  >
                    <FaTrash size={10} />
                  </Button>
                </div>
                <Input
                  size="sm"
                  label="Name"
                  placeholder="Hotel Roma"
                  value={res.name}
                  onValueChange={(v) => updateRes({ name: v })}
                  isRequired
                />
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    // TZ abbrev appears in the label when the reservation's
                    // location has a resolved timezone. Uses the actual
                    // datetime so DST is handled correctly.
                    label={`Start${
                      res.timezone
                        ? ` (${tzAbbreviation(
                            res.timezone,
                            res.startAt ? new Date(res.startAt) : undefined
                          )})`
                        : ""
                    }`}
                    type="datetime-local"
                    value={res.startAt}
                    onValueChange={(v) => updateRes({ startAt: v })}
                  />
                  <Input
                    size="sm"
                    label={`End${
                      res.timezone
                        ? ` (${tzAbbreviation(
                            res.timezone,
                            res.endAt ? new Date(res.endAt) : undefined
                          )})`
                        : ""
                    }`}
                    type="datetime-local"
                    value={res.endAt}
                    onValueChange={(v) => updateRes({ endAt: v })}
                  />
                </div>
                <div className="flex gap-2">
                  <CityAutocomplete
                    label="City"
                    value={res.city}
                    onValueChange={(v) => updateRes({ city: v })}
                    onSelect={(r) =>
                      updateRes({
                        city: r.city,
                        country: r.country,
                        latitude: r.latitude,
                        longitude: r.longitude,
                        timezone: r.timezone,
                      })
                    }
                  />
                  <Input
                    size="sm"
                    label="Country"
                    value={res.country}
                    onValueChange={(v) => updateRes({ country: v })}
                  />
                </div>
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    label="Confirmation #"
                    value={res.confirmationCode}
                    onValueChange={(v) => updateRes({ confirmationCode: v })}
                  />
                  <Input
                    size="sm"
                    label="URL"
                    value={res.url}
                    onValueChange={(v) => updateRes({ url: v })}
                  />
                </div>
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    label="Cost"
                    type="number"
                    value={res.cost}
                    onValueChange={(v) => updateRes({ cost: v })}
                  />
                  <Input
                    size="sm"
                    label="Currency"
                    placeholder="USD"
                    value={res.currency}
                    onValueChange={(v) => updateRes({ currency: v })}
                    className="max-w-[6rem]"
                  />
                </div>
                <Textarea
                  size="sm"
                  label="Notes"
                  value={res.notes}
                  onValueChange={(v) => updateRes({ notes: v })}
                  minRows={1}
                />
                {res.id && (
                  <AttachmentSection
                    parentType="RESERVATION"
                    parentId={res.id}
                  />
                )}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="flat"
                    startContent={<FaCalendarPlus size={10} />}
                    onPress={() => createEventFromReservation(res)}
                    // Disabled until the reservation is saved — we need its
                    // id before creating an event that references this trip,
                    // and saving-then-creating keeps the event in sync with
                    // what the user actually persisted.
                    isDisabled={!res.id}
                  >
                    Create calendar event
                  </Button>
                </div>
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

      {/* ── Checklists (only available once the trip is saved) ────────── */}
      {form.id && (
        <ChecklistPanel entityType="TRIP" entityId={form.id} />
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

  async function toggleFavorite(photo: Photo, next: boolean) {
    try {
      await client.models.homePhoto.update({ id: photo.id, isFavorite: next });
      onPhotosChanged?.();
    } catch (err) {
      console.error("Failed to toggle favorite", err);
    }
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
          <PhotoGrid
            photos={photosForTrip}
            onDelete={deletePhoto}
            onToggleFavorite={toggleFavorite}
          />
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
    const fromLocation =
      leg.fromCity || leg.fromAirport
        ? {
            city: leg.fromCity || null,
            airportCode: leg.fromAirport || null,
            latitude: leg.fromLatitude ?? null,
            longitude: leg.fromLongitude ?? null,
            timezone: leg.fromTimezone ?? null,
          }
        : null;
    const toLocation =
      leg.toCity || leg.toAirport
        ? {
            city: leg.toCity || null,
            airportCode: leg.toAirport || null,
            latitude: leg.toLatitude ?? null,
            longitude: leg.toLongitude ?? null,
            timezone: leg.toTimezone ?? null,
          }
        : null;
    const payload = {
      tripId,
      mode: leg.mode,
      // Trip leg times are local wall-clock at the airport — never run
      // through Date(), which would reinterpret the string in the browser's
      // timezone. The datetime-local input gives us "YYYY-MM-DDTHH:mm";
      // append ":00.000Z" literally so it satisfies the AWSDateTime scalar.
      // The Z is a syntactic placeholder, not a UTC assertion.
      departAt: leg.departAt ? `${leg.departAt}:00.000Z` : null,
      arriveAt: leg.arriveAt ? `${leg.arriveAt}:00.000Z` : null,
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

// Mirror of syncLegs for reservations — diffs the form rows against the
// existing reservations, deleting removed rows and upserting the rest.
async function syncReservations(
  tripId: string,
  formRes: ReservationFormRow[],
  existingAll: TripReservation[]
) {
  const existing = existingAll.filter((r) => r.tripId === tripId);
  const formIds = new Set(formRes.map((r) => r.id).filter((id) => id !== ""));

  for (const ex of existing) {
    if (!formIds.has(ex.id)) {
      await client.models.homeTripReservation.delete({ id: ex.id });
    }
  }

  for (let i = 0; i < formRes.length; i++) {
    const r = formRes[i];
    const location =
      r.city || r.country
        ? {
            city: r.city || null,
            country: r.country || null,
            latitude: r.latitude ?? null,
            longitude: r.longitude ?? null,
            timezone: r.timezone ?? null,
          }
        : null;
    const cost = r.cost.trim() === "" ? null : Number(r.cost);
    const payload = {
      tripId,
      type: r.type,
      name: r.name,
      // Reservation times follow the SAME local-wall-clock-at-the-
      // reservation-location rule as trip leg times. Append ":00.000Z"
      // literally; the Z is a syntactic placeholder, not a UTC assertion.
      // See lib/trip.ts convention note.
      startAt: r.startAt ? `${r.startAt}:00.000Z` : null,
      endAt: r.endAt ? `${r.endAt}:00.000Z` : null,
      location,
      confirmationCode: r.confirmationCode || null,
      url: r.url || null,
      cost: cost != null && !Number.isNaN(cost) ? cost : null,
      currency: r.currency || null,
      notes: r.notes || null,
      sortOrder: i,
    };
    if (r.id) {
      await client.models.homeTripReservation.update({ id: r.id, ...payload });
    } else {
      await client.models.homeTripReservation.create(payload);
    }
  }
}
