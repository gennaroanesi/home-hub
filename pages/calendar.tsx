"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Calendar, dayjsLocalizer, Views, View } from "react-big-calendar";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { RRule } from "rrule";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Checkbox } from "@heroui/checkbox";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { FaPlus, FaTrash, FaArrowLeft } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import type { Schema } from "@/amplify/data/resource";

import "react-big-calendar/lib/css/react-big-calendar.css";

dayjs.extend(utc);
dayjs.extend(timezone);

const localizer = dayjsLocalizer(dayjs);
const client = generateClient<Schema>({ authMode: "userPool" });

// ── Types ────────────────────────────────────────────────────────────────────

type Person = Schema["homePerson"]["type"];
type Trip = Schema["homeTrip"]["type"];
type Event = Schema["homeCalendarEvent"]["type"];
type Day = Schema["homeCalendarDay"]["type"];

type StatusKey =
  | "WORKING_HOME"
  | "WORKING_OFFICE"
  | "TRAVEL"
  | "VACATION"
  | "WEEKEND_HOLIDAY"
  | "PTO"
  | "CHOICE_DAY";

type TripType = "LEISURE" | "WORK" | "FLYING" | "FAMILY";

interface RbcEvent {
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  resource:
    | { kind: "trip"; trip: Trip }
    | { kind: "event"; event: Event };
}

// ── Config ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<StatusKey, { label: string; color: string }> = {
  WORKING_HOME: { label: "Working (home)", color: "#3a5068" },
  WORKING_OFFICE: { label: "Working (office)", color: "#2a5a45" },
  TRAVEL: { label: "Travel", color: "#DEBA02" },
  VACATION: { label: "Vacation", color: "#d4675a" },
  WEEKEND_HOLIDAY: { label: "Weekend/Holiday", color: "#7ab87a" },
  PTO: { label: "PTO", color: "#8b5cf6" },
  CHOICE_DAY: { label: "Choice Day", color: "#ec4899" },
};

const TRIP_TYPE_CONFIG: Record<TripType, { label: string; color: string }> = {
  LEISURE: { label: "Leisure", color: "#DEBA02" },
  WORK: { label: "Work", color: "#587D71" },
  FLYING: { label: "Flying", color: "#60A5FA" },
  FAMILY: { label: "Family", color: "#EC4899" },
};

const STATUS_KEYS: StatusKey[] = [
  "WORKING_HOME",
  "WORKING_OFFICE",
  "TRAVEL",
  "VACATION",
  "PTO",
  "CHOICE_DAY",
  "WEEKEND_HOLIDAY",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function dateKey(d: Date | string): string {
  return dayjs(d).format("YYYY-MM-DD");
}

function isWeekend(d: Date | string): boolean {
  const day = dayjs(d).day();
  return day === 0 || day === 6;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [days, setDays] = useState<Map<string, Day[]>>(new Map()); // dateStr → Day[] (one per person)
  const [currentDate, setCurrentDate] = useState(new Date());
  const [currentView, setCurrentView] = useState<View>(Views.WEEK);
  const [loading, setLoading] = useState(true);

  // Modals
  const newEventDisclosure = useDisclosure();
  const newTripDisclosure = useDisclosure();
  const dayStatusDisclosure = useDisclosure();
  const eventDetailDisclosure = useDisclosure();
  const tripDetailDisclosure = useDisclosure();

  // Day status editor state
  const [dayEditorDate, setDayEditorDate] = useState<string>("");

  // New event form
  const [eventForm, setEventForm] = useState({
    title: "",
    description: "",
    startAt: "",
    endAt: "",
    isAllDay: false,
    location: "",
    assignedPersonIds: [] as string[],
    tripId: "",
    recurrence: "",
  });

  // New trip form
  const [tripForm, setTripForm] = useState({
    name: "",
    type: "LEISURE" as TripType,
    startDate: "",
    endDate: "",
    destination: "",
    notes: "",
    participantIds: [] as string[],
  });

  // Detail views
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);

  // ── Auth + data load ──────────────────────────────────────────────────────

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

  async function loadAll() {
    setLoading(true);
    const [peopleRes, tripsRes, eventsRes, daysRes] = await Promise.all([
      client.models.homePerson.list(),
      client.models.homeTrip.list(),
      client.models.homeCalendarEvent.list(),
      client.models.homeCalendarDay.list({ limit: 1000 }),
    ]);

    setPeople((peopleRes.data ?? []).filter((p) => p.active));
    setTrips(tripsRes.data ?? []);
    setEvents(eventsRes.data ?? []);

    const dayMap = new Map<string, Day[]>();
    for (const d of daysRes.data ?? []) {
      const key = d.date;
      if (!dayMap.has(key)) dayMap.set(key, []);
      dayMap.get(key)!.push(d);
    }
    setDays(dayMap);
    setLoading(false);
  }

  // ── Build RBC events ──────────────────────────────────────────────────────

  const rbcEvents = useMemo<RbcEvent[]>(() => {
    const result: RbcEvent[] = [];

    // Trips as all-day banners
    for (const trip of trips) {
      result.push({
        title: trip.name,
        start: dayjs(trip.startDate).toDate(),
        end: dayjs(trip.endDate).add(1, "day").toDate(), // exclusive
        allDay: true,
        resource: { kind: "trip", trip },
      });
    }

    // Events
    for (const event of events) {
      if (event.recurrence) {
        // Expand recurring event for a ± 2-month window around currentDate
        try {
          const rule = new RRule({
            ...RRule.fromString(event.recurrence).origOptions,
            dtstart: new Date(event.startAt),
          });
          const from = dayjs(currentDate).subtract(2, "month").toDate();
          const to = dayjs(currentDate).add(2, "month").toDate();
          const occurrences = rule.between(from, to, true);
          const duration = event.endAt
            ? new Date(event.endAt).getTime() - new Date(event.startAt).getTime()
            : 60 * 60 * 1000;

          for (const occ of occurrences) {
            result.push({
              title: event.title,
              start: occ,
              end: new Date(occ.getTime() + duration),
              allDay: event.isAllDay ?? false,
              resource: { kind: "event", event },
            });
          }
        } catch {
          // Fall back to single occurrence
          result.push({
            title: event.title,
            start: new Date(event.startAt),
            end: event.endAt ? new Date(event.endAt) : new Date(new Date(event.startAt).getTime() + 60 * 60 * 1000),
            allDay: event.isAllDay ?? false,
            resource: { kind: "event", event },
          });
        }
      } else {
        result.push({
          title: event.title,
          start: new Date(event.startAt),
          end: event.endAt ? new Date(event.endAt) : new Date(new Date(event.startAt).getTime() + 60 * 60 * 1000),
          allDay: event.isAllDay ?? false,
          resource: { kind: "event", event },
        });
      }
    }

    return result;
  }, [trips, events, currentDate]);

  // ── Day status helpers ────────────────────────────────────────────────────

  function statusFor(date: Date, personId: string): StatusKey | null {
    const key = dateKey(date);
    const dayRecords = days.get(key) ?? [];
    const record = dayRecords.find((d) => d.personId === personId);
    if (record?.status) return record.status as StatusKey;
    // Fallback: weekends
    if (isWeekend(date)) return "WEEKEND_HOLIDAY";
    return null;
  }

  // Custom day cell wrapper: renders one stripe per person at the top
  const DateCellWrapper: React.ComponentType<any> = useCallback(
    ({ children, value }) => {
      const stripes = people.map((person) => {
        const status = statusFor(value, person.id);
        const color = status ? STATUS_CONFIG[status].color : "transparent";
        return (
          <div
            key={person.id}
            style={{
              backgroundColor: color,
              flex: 1,
              minHeight: "4px",
            }}
            title={status ? `${person.name}: ${STATUS_CONFIG[status].label}` : person.name}
          />
        );
      });

      return (
        <div className="rbc-day-bg" style={{ display: "flex", flexDirection: "column", position: "relative" }}>
          <div style={{ display: "flex", width: "100%", gap: "2px", padding: "2px" }}>
            {stripes}
          </div>
          {children}
        </div>
      );
    },
    [people, days]
  );

  // ── Event styling ─────────────────────────────────────────────────────────

  const eventPropGetter = useCallback((event: RbcEvent) => {
    if (event.resource.kind === "trip") {
      const tripType = event.resource.trip.type as TripType;
      const color = TRIP_TYPE_CONFIG[tripType]?.color ?? "#BCABAE";
      return {
        style: {
          backgroundColor: color,
          color: "#1a1a1a",
          border: "none",
          borderRadius: "3px",
          fontWeight: 600,
          fontSize: "0.75rem",
          padding: "1px 6px",
        },
      };
    }
    return {
      style: {
        backgroundColor: "#6b7280",
        color: "#fff",
        border: "none",
        borderRadius: "3px",
        fontSize: "0.75rem",
      },
    };
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleSelectSlot({ start }: { start: Date; end: Date }) {
    // Click a day (month view) → open status editor
    setDayEditorDate(dateKey(start));
    dayStatusDisclosure.onOpen();
  }

  function handleSelectEvent(rbcEvent: RbcEvent) {
    if (rbcEvent.resource.kind === "trip") {
      setSelectedTrip(rbcEvent.resource.trip);
      tripDetailDisclosure.onOpen();
    } else {
      setSelectedEvent(rbcEvent.resource.event);
      eventDetailDisclosure.onOpen();
    }
  }

  function openNewEvent() {
    const now = dayjs().format("YYYY-MM-DDTHH:mm");
    const later = dayjs().add(1, "hour").format("YYYY-MM-DDTHH:mm");
    setEventForm({
      title: "",
      description: "",
      startAt: now,
      endAt: later,
      isAllDay: false,
      location: "",
      assignedPersonIds: [],
      tripId: "",
      recurrence: "",
    });
    newEventDisclosure.onOpen();
  }

  async function createEvent(onClose: () => void) {
    if (!eventForm.title.trim() || !eventForm.startAt) return;
    await client.models.homeCalendarEvent.create({
      title: eventForm.title,
      description: eventForm.description || null,
      startAt: new Date(eventForm.startAt).toISOString(),
      endAt: eventForm.endAt ? new Date(eventForm.endAt).toISOString() : null,
      isAllDay: eventForm.isAllDay,
      location: eventForm.location ? { city: eventForm.location } : null,
      assignedPersonIds: eventForm.assignedPersonIds,
      tripId: eventForm.tripId || null,
      recurrence: eventForm.recurrence || null,
    });
    onClose();
    await loadAll();
  }

  function openNewTrip() {
    const today = dayjs().format("YYYY-MM-DD");
    setTripForm({
      name: "",
      type: "LEISURE",
      startDate: today,
      endDate: today,
      destination: "",
      notes: "",
      participantIds: [],
    });
    newTripDisclosure.onOpen();
  }

  async function createTrip(onClose: () => void) {
    if (!tripForm.name.trim() || !tripForm.startDate || !tripForm.endDate) return;
    await client.models.homeTrip.create({
      name: tripForm.name,
      type: tripForm.type,
      startDate: tripForm.startDate,
      endDate: tripForm.endDate,
      destination: tripForm.destination ? { city: tripForm.destination } : null,
      notes: tripForm.notes || null,
      participantIds: tripForm.participantIds,
    });
    onClose();
    await loadAll();
  }

  async function setDayStatus(personId: string, status: StatusKey | null) {
    const existing = (days.get(dayEditorDate) ?? []).find((d) => d.personId === personId);
    if (existing) {
      if (status === null) {
        await client.models.homeCalendarDay.delete({ id: existing.id });
      } else {
        await client.models.homeCalendarDay.update({
          id: existing.id,
          status,
        });
      }
    } else if (status !== null) {
      await client.models.homeCalendarDay.create({
        date: dayEditorDate,
        personId,
        status,
      });
    }
    await loadAll();
  }

  async function deleteEvent() {
    if (!selectedEvent) return;
    if (!confirm("Delete this event?")) return;
    await client.models.homeCalendarEvent.delete({ id: selectedEvent.id });
    setSelectedEvent(null);
    eventDetailDisclosure.onClose();
    await loadAll();
  }

  async function deleteTrip() {
    if (!selectedTrip) return;
    if (!confirm("Delete this trip? Days linked to it will keep their status but lose the trip link.")) return;
    await client.models.homeTrip.delete({ id: selectedTrip.id });
    setSelectedTrip(null);
    tripDetailDisclosure.onClose();
    await loadAll();
  }

  function personName(id: string): string {
    return people.find((p) => p.id === id)?.name ?? "Unknown";
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <DefaultLayout>
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
            {loading && <span className="text-xs text-default-400 animate-pulse">Loading…</span>}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="flat" startContent={<FaPlus size={12} />} onPress={openNewTrip}>
              New Trip
            </Button>
            <Button size="sm" color="primary" startContent={<FaPlus size={12} />} onPress={openNewEvent}>
              New Event
            </Button>
          </div>
        </div>

        {/* Legend */}
        {people.length > 0 && (
          <div className="flex flex-wrap items-center gap-4 mb-3 text-xs text-default-500">
            {people.map((p) => (
              <div key={p.id} className="flex items-center gap-1.5">
                <div
                  className="w-3 h-3 rounded-sm"
                  style={{ backgroundColor: p.color ?? "#999" }}
                />
                <span>{p.name}</span>
              </div>
            ))}
            <div className="h-4 w-px bg-default-200 mx-1" />
            {Object.entries(STATUS_CONFIG).map(([, { label, color }]) => (
              <div key={label} className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Calendar */}
        <div style={{ height: "calc(100vh - 220px)" }}>
          <Calendar
            localizer={localizer}
            events={rbcEvents}
            startAccessor="start"
            endAccessor="end"
            defaultView={Views.WEEK}
            view={currentView}
            onView={setCurrentView}
            views={[Views.MONTH, Views.WEEK, Views.DAY]}
            date={currentDate}
            onNavigate={setCurrentDate}
            selectable
            onSelectSlot={handleSelectSlot}
            onSelectEvent={handleSelectEvent}
            eventPropGetter={eventPropGetter}
            components={{ dateCellWrapper: DateCellWrapper }}
          />
        </div>

        {/* ── New Event Modal ──────────────────────────────────────────── */}
        <Modal isOpen={newEventDisclosure.isOpen} onOpenChange={newEventDisclosure.onOpenChange} size="lg">
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>New Event</ModalHeader>
                <ModalBody>
                  <Input
                    label="Title"
                    value={eventForm.title}
                    onValueChange={(v) => setEventForm((f) => ({ ...f, title: v }))}
                    isRequired
                  />
                  <Textarea
                    label="Description"
                    value={eventForm.description}
                    onValueChange={(v) => setEventForm((f) => ({ ...f, description: v }))}
                    minRows={2}
                  />
                  <div className="flex gap-2">
                    <Input
                      label="Start"
                      type={eventForm.isAllDay ? "date" : "datetime-local"}
                      value={eventForm.isAllDay ? eventForm.startAt.slice(0, 10) : eventForm.startAt}
                      onValueChange={(v) => setEventForm((f) => ({ ...f, startAt: v }))}
                    />
                    <Input
                      label="End"
                      type={eventForm.isAllDay ? "date" : "datetime-local"}
                      value={eventForm.isAllDay ? eventForm.endAt.slice(0, 10) : eventForm.endAt}
                      onValueChange={(v) => setEventForm((f) => ({ ...f, endAt: v }))}
                    />
                  </div>
                  <Checkbox
                    isSelected={eventForm.isAllDay}
                    onValueChange={(v) => setEventForm((f) => ({ ...f, isAllDay: v }))}
                  >
                    All day
                  </Checkbox>
                  <Input
                    label="Location"
                    value={eventForm.location}
                    onValueChange={(v) => setEventForm((f) => ({ ...f, location: v }))}
                  />
                  <Select
                    label="Assigned to"
                    selectionMode="multiple"
                    selectedKeys={new Set(eventForm.assignedPersonIds)}
                    onSelectionChange={(keys) =>
                      setEventForm((f) => ({ ...f, assignedPersonIds: Array.from(keys as Set<string>) }))
                    }
                    description="Leave empty for household"
                  >
                    {people.map((p) => (
                      <SelectItem key={p.id}>{p.name}</SelectItem>
                    ))}
                  </Select>
                  <Select
                    label="Linked trip (optional)"
                    selectedKeys={eventForm.tripId ? [eventForm.tripId] : []}
                    onChange={(e) => setEventForm((f) => ({ ...f, tripId: e.target.value }))}
                  >
                    <>
                      <SelectItem key="">None</SelectItem>
                      {trips.map((t) => (
                        <SelectItem key={t.id}>{t.name}</SelectItem>
                      )) as any}
                    </>
                  </Select>
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => createEvent(onClose)}>Create</Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        {/* ── New Trip Modal ───────────────────────────────────────────── */}
        <Modal isOpen={newTripDisclosure.isOpen} onOpenChange={newTripDisclosure.onOpenChange} size="lg">
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>New Trip</ModalHeader>
                <ModalBody>
                  <Input
                    label="Name"
                    value={tripForm.name}
                    onValueChange={(v) => setTripForm((f) => ({ ...f, name: v }))}
                    placeholder="Italy 2026"
                    isRequired
                  />
                  <Select
                    label="Type"
                    selectedKeys={[tripForm.type]}
                    onChange={(e) => setTripForm((f) => ({ ...f, type: e.target.value as TripType }))}
                  >
                    {Object.entries(TRIP_TYPE_CONFIG).map(([key, { label }]) => (
                      <SelectItem key={key}>{label}</SelectItem>
                    ))}
                  </Select>
                  <div className="flex gap-2">
                    <Input
                      label="Start date"
                      type="date"
                      value={tripForm.startDate}
                      onValueChange={(v) => setTripForm((f) => ({ ...f, startDate: v }))}
                    />
                    <Input
                      label="End date"
                      type="date"
                      value={tripForm.endDate}
                      onValueChange={(v) => setTripForm((f) => ({ ...f, endDate: v }))}
                    />
                  </div>
                  <Input
                    label="Destination"
                    value={tripForm.destination}
                    onValueChange={(v) => setTripForm((f) => ({ ...f, destination: v }))}
                    placeholder="Rome, Italy"
                  />
                  <Select
                    label="Participants"
                    selectionMode="multiple"
                    selectedKeys={new Set(tripForm.participantIds)}
                    onSelectionChange={(keys) =>
                      setTripForm((f) => ({ ...f, participantIds: Array.from(keys as Set<string>) }))
                    }
                  >
                    {people.map((p) => (
                      <SelectItem key={p.id}>{p.name}</SelectItem>
                    ))}
                  </Select>
                  <Textarea
                    label="Notes"
                    value={tripForm.notes}
                    onValueChange={(v) => setTripForm((f) => ({ ...f, notes: v }))}
                    minRows={2}
                  />
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => createTrip(onClose)}>Create</Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        {/* ── Day Status Editor ───────────────────────────────────────── */}
        <Modal isOpen={dayStatusDisclosure.isOpen} onOpenChange={dayStatusDisclosure.onOpenChange}>
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>
                  {dayEditorDate ? dayjs(dayEditorDate).format("dddd, MMM D, YYYY") : ""}
                </ModalHeader>
                <ModalBody>
                  {people.map((person) => {
                    const existing = (days.get(dayEditorDate) ?? []).find((d) => d.personId === person.id);
                    const current = existing?.status as StatusKey | undefined;
                    return (
                      <div key={person.id} className="mb-3">
                        <label className="text-sm font-medium mb-1 block">{person.name}</label>
                        <div className="flex flex-wrap gap-1.5">
                          <Button
                            size="sm"
                            variant={!current ? "solid" : "flat"}
                            onPress={() => setDayStatus(person.id, null)}
                          >
                            —
                          </Button>
                          {STATUS_KEYS.map((key) => (
                            <Button
                              key={key}
                              size="sm"
                              variant={current === key ? "solid" : "flat"}
                              style={
                                current === key
                                  ? { backgroundColor: STATUS_CONFIG[key].color, color: "#fff" }
                                  : {}
                              }
                              onPress={() => setDayStatus(person.id, key)}
                            >
                              {STATUS_CONFIG[key].label}
                            </Button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </ModalBody>
                <ModalFooter>
                  <Button color="primary" onPress={onClose}>Done</Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        {/* ── Event Detail Modal ──────────────────────────────────────── */}
        <Modal isOpen={eventDetailDisclosure.isOpen} onOpenChange={eventDetailDisclosure.onOpenChange}>
          <ModalContent>
            {(onClose) => selectedEvent && (
              <>
                <ModalHeader>{selectedEvent.title}</ModalHeader>
                <ModalBody>
                  {selectedEvent.description && (
                    <p className="text-sm text-default-600">{selectedEvent.description}</p>
                  )}
                  <p className="text-sm">
                    <span className="text-default-400">When: </span>
                    {dayjs(selectedEvent.startAt).format("MMM D, YYYY h:mm A")}
                    {selectedEvent.endAt && ` – ${dayjs(selectedEvent.endAt).format("h:mm A")}`}
                  </p>
                  {selectedEvent.location && (selectedEvent.location as any).city && (
                    <p className="text-sm">
                      <span className="text-default-400">Where: </span>
                      {(selectedEvent.location as any).city}
                    </p>
                  )}
                  {(selectedEvent.assignedPersonIds ?? []).length > 0 && (
                    <p className="text-sm">
                      <span className="text-default-400">Who: </span>
                      {(selectedEvent.assignedPersonIds ?? [])
                        .filter((id): id is string => !!id)
                        .map(personName)
                        .join(", ")}
                    </p>
                  )}
                </ModalBody>
                <ModalFooter>
                  <Button color="danger" variant="light" startContent={<FaTrash size={12} />} onPress={deleteEvent}>
                    Delete
                  </Button>
                  <Button onPress={onClose}>Close</Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        {/* ── Trip Detail Modal ───────────────────────────────────────── */}
        <Modal isOpen={tripDetailDisclosure.isOpen} onOpenChange={tripDetailDisclosure.onOpenChange}>
          <ModalContent>
            {(onClose) => selectedTrip && (
              <>
                <ModalHeader>{selectedTrip.name}</ModalHeader>
                <ModalBody>
                  <p className="text-sm">
                    <span className="text-default-400">Type: </span>
                    {TRIP_TYPE_CONFIG[selectedTrip.type as TripType]?.label ?? selectedTrip.type}
                  </p>
                  <p className="text-sm">
                    <span className="text-default-400">When: </span>
                    {dayjs(selectedTrip.startDate).format("MMM D")} – {dayjs(selectedTrip.endDate).format("MMM D, YYYY")}
                  </p>
                  {selectedTrip.destination && (selectedTrip.destination as any).city && (
                    <p className="text-sm">
                      <span className="text-default-400">Where: </span>
                      {(selectedTrip.destination as any).city}
                    </p>
                  )}
                  {(selectedTrip.participantIds ?? []).length > 0 && (
                    <p className="text-sm">
                      <span className="text-default-400">Who: </span>
                      {(selectedTrip.participantIds ?? [])
                        .filter((id): id is string => !!id)
                        .map(personName)
                        .join(", ")}
                    </p>
                  )}
                  {selectedTrip.notes && (
                    <p className="text-sm text-default-600">{selectedTrip.notes}</p>
                  )}
                </ModalBody>
                <ModalFooter>
                  <Button color="danger" variant="light" startContent={<FaTrash size={12} />} onPress={deleteTrip}>
                    Delete
                  </Button>
                  <Button onPress={onClose}>Close</Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>
      </div>
    </DefaultLayout>
  );
}
