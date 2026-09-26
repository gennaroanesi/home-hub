"use client";

// Create / edit modal for a calendar event. Used by the Calendar page and
// the home dashboard. Form state lives here and is reset from `event`
// each time the modal opens (null = create, starting now for an hour).
// Feed-imported events render read-only.

import React, { useEffect, useState } from "react";
import { generateClient } from "aws-amplify/data";
import dayjs from "dayjs";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Checkbox } from "@heroui/checkbox";
import { Chip } from "@heroui/chip";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/modal";
import { FaTrash } from "react-icons/fa";

import { CityAutocomplete } from "@/components/city-autocomplete";
import { ChecklistPanel } from "@/components/checklist-panel";
import { AttachmentSection } from "@/components/attachment-section";
import { RemindersSection } from "@/components/reminders-section";
import { NotesSection } from "@/components/notes-section";
import { buildReminderDefaultsForEvent } from "@/lib/reminder-defaults";
import { cascadeDeleteRemindersFor } from "@/lib/reminder-parent";
import { cascadeDeleteNotesFor } from "@/lib/note-parent";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Person = Schema["homePerson"]["type"];
type Trip = Schema["homeTrip"]["type"];
type Event = Schema["homeCalendarEvent"]["type"];
type Feed = Schema["homeCalendarFeed"]["type"];

interface EventModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  event: Event | null;
  people: Person[];
  trips: Trip[];
  // Only used to label imported events with their feed.
  feeds?: Feed[];
  // Fired after a create, save or delete so the caller can reload.
  onSaved: () => void;
}

export function EventModal({
  isOpen,
  onOpenChange,
  event,
  people,
  trips,
  feeds = [],
  onSaved,
}: EventModalProps) {
  // Event form (used for both create and edit)
  const [eventForm, setEventForm] = useState({
    id: "" as string, // empty = new
    title: "",
    description: "",
    startAt: "",
    endAt: "",
    isAllDay: false,
    location: "",
    locationLat: null as number | null,
    locationLon: null as number | null,
    locationCountry: "",
    assignedPersonIds: [] as string[],
    tripId: "",
    recurrence: "",
    feedId: "" as string, // non-empty = imported; form is read-only
  });

  useEffect(() => {
    if (!isOpen) return;
    if (!event) {
      setEventForm({
        id: "",
        title: "",
        description: "",
        startAt: dayjs().format("YYYY-MM-DDTHH:mm"),
        endAt: dayjs().add(1, "hour").format("YYYY-MM-DDTHH:mm"),
        isAllDay: false,
        location: "",
        locationLat: null,
        locationLon: null,
        locationCountry: "",
        assignedPersonIds: [],
        tripId: "",
        recurrence: "",
        feedId: "",
      });
      return;
    }
    const loc = (event.location ?? {}) as any;
    setEventForm({
      id: event.id,
      title: event.title,
      description: event.description ?? "",
      startAt: dayjs(event.startAt).format("YYYY-MM-DDTHH:mm"),
      endAt: event.endAt ? dayjs(event.endAt).format("YYYY-MM-DDTHH:mm") : "",
      isAllDay: event.isAllDay ?? false,
      location: loc.city ?? "",
      locationLat: loc.latitude ?? null,
      locationLon: loc.longitude ?? null,
      locationCountry: loc.country ?? "",
      assignedPersonIds: (event.assignedPersonIds ?? []).filter((id): id is string => !!id),
      tripId: event.tripId ?? "",
      recurrence: event.recurrence ?? "",
      feedId: event.feedId ?? "",
    });
  }, [isOpen, event]);

  // Core save — creates or updates the event and returns its id.
  // Used both by the Save/Create button (saveEvent) and by the
  // RemindersSection's onBeforeAdd, which wants the id without
  // closing the modal.
  async function saveEventDraft(): Promise<string | null> {
    if (!eventForm.title.trim() || !eventForm.startAt) {
      alert("Title and start date are required.");
      return null;
    }
    const startDate = new Date(eventForm.startAt);
    if (isNaN(startDate.getTime())) {
      alert("Start date is invalid.");
      return null;
    }
    let endDate: Date | null = null;
    if (eventForm.endAt) {
      endDate = new Date(eventForm.endAt);
      if (isNaN(endDate.getTime())) {
        alert("End date is invalid.");
        return null;
      }
      if (endDate.getTime() < startDate.getTime()) {
        alert("End must be after start.");
        return null;
      }
    }
    const location =
      eventForm.location || eventForm.locationLat !== null
        ? {
            city: eventForm.location || null,
            country: eventForm.locationCountry || null,
            latitude: eventForm.locationLat,
            longitude: eventForm.locationLon,
          }
        : null;
    const payload = {
      title: eventForm.title,
      description: eventForm.description || null,
      startAt: startDate.toISOString(),
      endAt: endDate ? endDate.toISOString() : null,
      isAllDay: eventForm.isAllDay,
      location,
      assignedPersonIds: eventForm.assignedPersonIds,
      tripId: eventForm.tripId || null,
      recurrence: eventForm.recurrence || null,
    };
    try {
      const result = eventForm.id
        ? await client.models.homeCalendarEvent.update({ id: eventForm.id, ...payload })
        : await client.models.homeCalendarEvent.create(payload);
      if (result.errors && result.errors.length > 0) {
        console.error("Save event errors:", result.errors);
        alert(`Failed to save: ${result.errors.map((e) => e.message).join(", ")}`);
        return null;
      }
      const savedId = result.data?.id ?? null;
      if (savedId && !eventForm.id) {
        // Promote the form from create to edit mode so the reminders
        // section (and any follow-up saves) operate on the new row.
        setEventForm((f) => ({ ...f, id: savedId }));
      }
      return savedId;
    } catch (err) {
      console.error("Save event threw:", err);
      alert(`Failed to save event: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async function saveEvent(onClose: () => void) {
    const id = await saveEventDraft();
    if (!id) return;
    onClose();
    onSaved();
  }

  async function deleteEventById(id: string) {
    if (!confirm("Delete this event?")) return;
    await cascadeDeleteRemindersFor(client, id);
    await cascadeDeleteNotesFor(client, id);
    await client.models.homeCalendarEvent.delete({ id });
    onOpenChange(false);
    onSaved();
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg">
      <ModalContent>
        {(onClose) => {
          // Imported (feed-sourced) events render read-only: edits
          // would just be overwritten on the next ICS sync, so we
          // disable inputs and hide Save/Delete entirely. Reminders
          // panel stays available since reminders are a local-only
          // concern and can legitimately be attached to an imported
          // event ("remind me 1h before the shared Zoom call").
          const isImported = !!eventForm.feedId;
          const importedFeed = isImported
            ? feeds.find((f) => f.id === eventForm.feedId)
            : null;
          return (
          <>
            <ModalHeader className="flex items-center gap-2">
              <span>{eventForm.id ? "Edit Event" : "New Event"}</span>
              {importedFeed && (
                <Chip
                  size="sm"
                  variant="flat"
                  startContent={
                    <span
                      className="inline-block w-2 h-2 rounded-sm ml-1"
                      style={{ backgroundColor: importedFeed.color ?? "#8B5CF6" }}
                    />
                  }
                >
                  {importedFeed.name}
                </Chip>
              )}
            </ModalHeader>
            <ModalBody>
              {isImported && (
                <div className="text-xs text-default-500 bg-default-50 border border-default-200 rounded-md px-3 py-2">
                  This event comes from an external calendar feed.
                  Edits made here would be overwritten on the next
                  sync, so the fields are read-only. You can still
                  attach reminders below.
                </div>
              )}
              <Input
                label="Title"
                value={eventForm.title}
                onValueChange={(v) => setEventForm((f) => ({ ...f, title: v }))}
                isRequired
                isReadOnly={isImported}
              />
              <Textarea
                label="Description"
                value={eventForm.description}
                onValueChange={(v) => setEventForm((f) => ({ ...f, description: v }))}
                minRows={2}
                isReadOnly={isImported}
              />
              <div className="flex gap-2">
                <Input
                  label="Start"
                  type={eventForm.isAllDay ? "date" : "datetime-local"}
                  value={eventForm.isAllDay ? eventForm.startAt.slice(0, 10) : eventForm.startAt}
                  isReadOnly={isImported}
                  onValueChange={(v) =>
                    setEventForm((f) => {
                      if (!v) return { ...f, startAt: v };
                      // Auto-adjust end: maintain existing duration if valid, else default to +1h
                      const newStart = dayjs(v);
                      if (!newStart.isValid()) return { ...f, startAt: v };
                      let newEnd = f.endAt;
                      if (f.isAllDay) {
                        // For all-day, keep end >= start
                        if (!f.endAt || dayjs(f.endAt).isBefore(newStart, "day")) {
                          newEnd = newStart.format("YYYY-MM-DDTHH:mm");
                        }
                      } else {
                        const prevStart = dayjs(f.startAt);
                        const prevEnd = dayjs(f.endAt);
                        if (f.startAt && f.endAt && prevStart.isValid() && prevEnd.isValid() && prevEnd.isAfter(prevStart)) {
                          const durationMs = prevEnd.diff(prevStart);
                          newEnd = newStart.add(durationMs, "ms").format("YYYY-MM-DDTHH:mm");
                        } else {
                          newEnd = newStart.add(1, "hour").format("YYYY-MM-DDTHH:mm");
                        }
                      }
                      return { ...f, startAt: v, endAt: newEnd };
                    })
                  }
                />
                <Input
                  label="End"
                  type={eventForm.isAllDay ? "date" : "datetime-local"}
                  value={eventForm.isAllDay ? eventForm.endAt.slice(0, 10) : eventForm.endAt}
                  onValueChange={(v) => setEventForm((f) => ({ ...f, endAt: v }))}
                  isReadOnly={isImported}
                />
              </div>
              <Checkbox
                isSelected={eventForm.isAllDay}
                onValueChange={(v) => setEventForm((f) => ({ ...f, isAllDay: v }))}
                isDisabled={isImported}
              >
                All day
              </Checkbox>
              {isImported ? (
                <Input
                  label="Location"
                  value={eventForm.location}
                  isReadOnly
                />
              ) : (
                <CityAutocomplete
                  label="Location"
                  value={eventForm.location}
                  onValueChange={(v) => setEventForm((f) => ({ ...f, location: v }))}
                  onSelect={(r) =>
                    setEventForm((f) => ({
                      ...f,
                      locationLat: r.latitude,
                      locationLon: r.longitude,
                      locationCountry: r.country,
                    }))
                  }
                />
              )}
              <Select
                label="Assigned to"
                selectionMode="multiple"
                selectedKeys={new Set(eventForm.assignedPersonIds)}
                onSelectionChange={(keys) =>
                  setEventForm((f) => ({ ...f, assignedPersonIds: Array.from(keys as Set<string>) }))
                }
                description="Leave empty for household"
                isDisabled={isImported}
              >
                {people.map((p) => (
                  <SelectItem key={p.id} textValue={p.name}>{p.name}</SelectItem>
                ))}
              </Select>
              <Select
                label="Linked trip (optional)"
                selectedKeys={eventForm.tripId ? [eventForm.tripId] : []}
                onChange={(e) => setEventForm((f) => ({ ...f, tripId: e.target.value }))}
                isDisabled={isImported}
              >
                <>
                  <SelectItem key="" textValue="None">None</SelectItem>
                  {trips.map((t) => (
                    <SelectItem key={t.id} textValue={t.name}>{t.name}</SelectItem>
                  )) as any}
                </>
              </Select>
              {eventForm.id && (
                <ChecklistPanel entityType="EVENT" entityId={eventForm.id} />
              )}
              {eventForm.id && (
                <div className="mt-2">
                  <p className="text-xs font-semibold text-default-500 uppercase tracking-wide mb-1.5">
                    Attachments
                  </p>
                  <AttachmentSection
                    parentType="EVENT"
                    parentId={eventForm.id}
                  />
                </div>
              )}
              <div className="mt-2">
                <RemindersSection
                  parentType="EVENT"
                  parentId={eventForm.id}
                  people={people}
                  defaults={buildReminderDefaultsForEvent({
                    title: eventForm.title,
                    startAt: eventForm.startAt,
                    assignedPersonIds: eventForm.assignedPersonIds,
                  })}
                  onBeforeAdd={eventForm.id ? undefined : saveEventDraft}
                />
              </div>
              <div className="mt-2">
                <NotesSection
                  parentType="EVENT"
                  parentId={eventForm.id}
                  onBeforeAdd={eventForm.id ? undefined : saveEventDraft}
                />
              </div>
            </ModalBody>
            <ModalFooter>
              {eventForm.id && !isImported && (
                <Button
                  color="danger"
                  variant="light"
                  startContent={<FaTrash size={12} />}
                  onPress={() => deleteEventById(eventForm.id)}
                >
                  Delete
                </Button>
              )}
              <Button variant="light" onPress={onClose}>
                {isImported ? "Close" : "Cancel"}
              </Button>
              {!isImported && (
                <Button color="primary" onPress={() => saveEvent(onClose)}>
                  {eventForm.id ? "Save" : "Create"}
                </Button>
              )}
            </ModalFooter>
          </>
          );
        }}
      </ModalContent>
    </Modal>
  );
}
