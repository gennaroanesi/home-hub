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
import { FaPlus, FaTrash, FaArrowLeft, FaList } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { CityAutocomplete } from "@/components/city-autocomplete";
import { FreeCombobox } from "@/components/free-combobox";
import { AIRLINES } from "@/lib/airlines";
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
type TripLeg = Schema["homeTripLeg"]["type"];

type LegMode =
  | "COMMERCIAL_FLIGHT"
  | "PERSONAL_FLIGHT"
  | "CAR"
  | "TRAIN"
  | "BUS"
  | "BOAT"
  | "OTHER";

const LEG_MODE_LABEL: Record<LegMode, string> = {
  COMMERCIAL_FLIGHT: "Commercial flight",
  PERSONAL_FLIGHT: "Personal flight",
  CAR: "Car",
  TRAIN: "Train",
  BUS: "Bus",
  BOAT: "Boat",
  OTHER: "Other",
};

const LEG_MODE_EMOJI: Record<LegMode, string> = {
  COMMERCIAL_FLIGHT: "✈️",
  PERSONAL_FLIGHT: "🛩️",
  CAR: "🚗",
  TRAIN: "🚆",
  BUS: "🚌",
  BOAT: "⛵",
  OTHER: "📍",
};

// Form-side leg shape (id is empty for new legs that haven't been saved yet)
interface LegFormRow {
  id: string;
  mode: LegMode;
  departAt: string;       // datetime-local string
  arriveAt: string;
  fromCity: string;
  toCity: string;
  airline: string;
  flightNumber: string;
  aircraft: string;
  confirmationCode: string;
  url: string;
  notes: string;
  sortOrder: number;
}

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
    | { kind: "event"; event: Event }
    | { kind: "leg"; leg: TripLeg; trip: Trip };
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
  const tripModalDisclosure = useDisclosure(); // create + edit
  const newEventDisclosure = useDisclosure();
  const dayStatusDisclosure = useDisclosure();
  const eventDetailDisclosure = useDisclosure();
  const allTripsDisclosure = useDisclosure();

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
    locationLat: null as number | null,
    locationLon: null as number | null,
    locationCountry: "",
    assignedPersonIds: [] as string[],
    tripId: "",
    recurrence: "",
  });

  // Trip form (used for both create and edit)
  const [tripForm, setTripForm] = useState({
    id: "" as string, // empty = new
    name: "",
    type: "LEISURE" as TripType,
    startDate: "",
    endDate: "",
    destination: "",
    destinationLat: null as number | null,
    destinationLon: null as number | null,
    destinationCountry: "",
    notes: "",
    participantIds: [] as string[],
    legs: [] as LegFormRow[],
  });

  // All legs across all trips, used for rendering on the calendar
  const [allLegs, setAllLegs] = useState<TripLeg[]>([]);

  // Detail views
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

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
    const [peopleRes, tripsRes, eventsRes, daysRes, legsRes] = await Promise.all([
      client.models.homePerson.list(),
      client.models.homeTrip.list(),
      client.models.homeCalendarEvent.list(),
      client.models.homeCalendarDay.list({ limit: 1000 }),
      client.models.homeTripLeg.list({ limit: 1000 }),
    ]);

    setPeople((peopleRes.data ?? []).filter((p) => p.active));
    setTrips(tripsRes.data ?? []);
    setEvents(eventsRes.data ?? []);
    setAllLegs(legsRes.data ?? []);

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

    // Trip legs as timed events
    const tripById = new Map(trips.map((t) => [t.id, t]));
    for (const leg of allLegs) {
      if (!leg.departAt) continue;
      const trip = tripById.get(leg.tripId);
      if (!trip) continue;
      const start = new Date(leg.departAt);
      const end = leg.arriveAt ? new Date(leg.arriveAt) : new Date(start.getTime() + 60 * 60 * 1000);
      const mode = (leg.mode ?? "OTHER") as LegMode;
      const emoji = LEG_MODE_EMOJI[mode];
      let title = emoji;
      if (mode === "COMMERCIAL_FLIGHT" && (leg.airline || leg.flightNumber)) {
        title += ` ${leg.airline ?? ""} ${leg.flightNumber ?? ""}`.trim();
      } else if (leg.fromLocation || leg.toLocation) {
        const from = (leg.fromLocation as any)?.city ?? "";
        const to = (leg.toLocation as any)?.city ?? "";
        title += ` ${from}${from && to ? " → " : ""}${to}`;
      } else {
        title += ` ${LEG_MODE_LABEL[mode]}`;
      }
      result.push({
        title,
        start,
        end,
        allDay: false,
        resource: { kind: "leg", leg, trip },
      });
    }

    return result;
  }, [trips, events, allLegs, currentDate]);

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
    if (event.resource.kind === "leg") {
      // Use the parent trip's color so legs visually belong to their trip
      const tripType = event.resource.trip.type as TripType;
      const color = TRIP_TYPE_CONFIG[tripType]?.color ?? "#60A5FA";
      return {
        style: {
          backgroundColor: color,
          color: "#1a1a1a",
          border: "none",
          borderRadius: "3px",
          fontWeight: 600,
          fontSize: "0.7rem",
          padding: "1px 4px",
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
      openEditTrip(rbcEvent.resource.trip);
    } else if (rbcEvent.resource.kind === "leg") {
      // Clicking a leg opens the parent trip's edit modal
      openEditTrip(rbcEvent.resource.trip);
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
      locationLat: null,
      locationLon: null,
      locationCountry: "",
      assignedPersonIds: [],
      tripId: "",
      recurrence: "",
    });
    newEventDisclosure.onOpen();
  }

  async function createEvent(onClose: () => void) {
    if (!eventForm.title.trim() || !eventForm.startAt) return;
    const location =
      eventForm.location || eventForm.locationLat !== null
        ? {
            city: eventForm.location || null,
            country: eventForm.locationCountry || null,
            latitude: eventForm.locationLat,
            longitude: eventForm.locationLon,
          }
        : null;
    await client.models.homeCalendarEvent.create({
      title: eventForm.title,
      description: eventForm.description || null,
      startAt: new Date(eventForm.startAt).toISOString(),
      endAt: eventForm.endAt ? new Date(eventForm.endAt).toISOString() : null,
      isAllDay: eventForm.isAllDay,
      location,
      assignedPersonIds: eventForm.assignedPersonIds,
      tripId: eventForm.tripId || null,
      recurrence: eventForm.recurrence || null,
    });
    onClose();
    await loadAll();
  }

  function emptyLeg(sortOrder: number): LegFormRow {
    return {
      id: "",
      mode: "COMMERCIAL_FLIGHT",
      departAt: "",
      arriveAt: "",
      fromCity: "",
      toCity: "",
      airline: "",
      flightNumber: "",
      aircraft: "",
      confirmationCode: "",
      url: "",
      notes: "",
      sortOrder,
    };
  }

  function legToFormRow(leg: TripLeg): LegFormRow {
    const from = (leg.fromLocation ?? {}) as any;
    const to = (leg.toLocation ?? {}) as any;
    return {
      id: leg.id,
      mode: (leg.mode ?? "COMMERCIAL_FLIGHT") as LegMode,
      departAt: leg.departAt ? dayjs(leg.departAt).format("YYYY-MM-DDTHH:mm") : "",
      arriveAt: leg.arriveAt ? dayjs(leg.arriveAt).format("YYYY-MM-DDTHH:mm") : "",
      fromCity: from.city ?? "",
      toCity: to.city ?? "",
      airline: leg.airline ?? "",
      flightNumber: leg.flightNumber ?? "",
      aircraft: leg.aircraft ?? "",
      confirmationCode: leg.confirmationCode ?? "",
      url: leg.url ?? "",
      notes: leg.notes ?? "",
      sortOrder: leg.sortOrder ?? 0,
    };
  }

  function openNewTrip() {
    const today = dayjs().format("YYYY-MM-DD");
    setTripForm({
      id: "",
      name: "",
      type: "LEISURE",
      startDate: today,
      endDate: today,
      destination: "",
      destinationLat: null,
      destinationLon: null,
      destinationCountry: "",
      notes: "",
      participantIds: [],
      legs: [],
    });
    tripModalDisclosure.onOpen();
  }

  function openEditTrip(trip: Trip) {
    const dest = (trip.destination ?? {}) as any;
    const tripLegs = allLegs
      .filter((l) => l.tripId === trip.id)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(legToFormRow);
    setTripForm({
      id: trip.id,
      name: trip.name,
      type: (trip.type ?? "LEISURE") as TripType,
      startDate: trip.startDate,
      endDate: trip.endDate,
      destination: dest.city ?? "",
      destinationLat: dest.latitude ?? null,
      destinationLon: dest.longitude ?? null,
      destinationCountry: dest.country ?? "",
      notes: trip.notes ?? "",
      participantIds: (trip.participantIds ?? []).filter((id): id is string => !!id),
      legs: tripLegs,
    });
    tripModalDisclosure.onOpen();
  }

  async function saveTrip(onClose: () => void) {
    if (!tripForm.name.trim() || !tripForm.startDate || !tripForm.endDate) return;
    const destination =
      tripForm.destination || tripForm.destinationLat !== null
        ? {
            city: tripForm.destination || null,
            country: tripForm.destinationCountry || null,
            latitude: tripForm.destinationLat,
            longitude: tripForm.destinationLon,
          }
        : null;

    let tripId = tripForm.id;
    if (tripId) {
      await client.models.homeTrip.update({
        id: tripId,
        name: tripForm.name,
        type: tripForm.type,
        startDate: tripForm.startDate,
        endDate: tripForm.endDate,
        destination,
        notes: tripForm.notes || null,
        participantIds: tripForm.participantIds,
      });
    } else {
      const { data } = await client.models.homeTrip.create({
        name: tripForm.name,
        type: tripForm.type,
        startDate: tripForm.startDate,
        endDate: tripForm.endDate,
        destination,
        notes: tripForm.notes || null,
        participantIds: tripForm.participantIds,
      });
      tripId = data?.id ?? "";
    }

    if (tripId) {
      await syncLegs(tripId, tripForm.legs);
    }

    onClose();
    await loadAll();
  }

  // Diff form legs against existing legs and create/update/delete as needed
  async function syncLegs(tripId: string, formLegs: LegFormRow[]) {
    const existing = allLegs.filter((l) => l.tripId === tripId);
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

  async function deleteTripById(id: string) {
    if (!confirm("Delete this trip? All legs will be deleted. Days linked to it will keep their status but lose the trip link.")) return;
    // Delete legs first
    const tripLegs = allLegs.filter((l) => l.tripId === id);
    for (const leg of tripLegs) {
      await client.models.homeTripLeg.delete({ id: leg.id });
    }
    await client.models.homeTrip.delete({ id });
    tripModalDisclosure.onClose();
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
            <Button size="sm" variant="flat" startContent={<FaList size={12} />} onPress={allTripsDisclosure.onOpen}>
              All Trips
            </Button>
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

        {/* ── Trip Modal (create + edit) ───────────────────────────────── */}
        <Modal isOpen={tripModalDisclosure.isOpen} onOpenChange={tripModalDisclosure.onOpenChange} size="lg">
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>{tripForm.id ? "Edit Trip" : "New Trip"}</ModalHeader>
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
                  <CityAutocomplete
                    label="Destination"
                    placeholder="Rome, Italy"
                    value={tripForm.destination}
                    onValueChange={(v) => setTripForm((f) => ({ ...f, destination: v }))}
                    onSelect={(r) =>
                      setTripForm((f) => ({
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

                  {/* ── Legs editor ──────────────────────────────────────── */}
                  <div className="border-t border-default-200 pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium">Transportation</p>
                      <Button
                        size="sm"
                        variant="flat"
                        startContent={<FaPlus size={10} />}
                        onPress={() =>
                          setTripForm((f) => ({
                            ...f,
                            legs: [...f.legs, emptyLeg(f.legs.length)],
                          }))
                        }
                      >
                        Add leg
                      </Button>
                    </div>
                    {tripForm.legs.length === 0 && (
                      <p className="text-xs text-default-400">
                        Add flights, drives, or other segments for this trip.
                      </p>
                    )}
                    <div className="space-y-3">
                      {tripForm.legs.map((leg, idx) => {
                        const updateLeg = (patch: Partial<LegFormRow>) =>
                          setTripForm((f) => ({
                            ...f,
                            legs: f.legs.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
                          }));
                        const removeLeg = () =>
                          setTripForm((f) => ({
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
                </ModalBody>
                <ModalFooter>
                  {tripForm.id && (
                    <Button
                      color="danger"
                      variant="light"
                      startContent={<FaTrash size={12} />}
                      onPress={() => deleteTripById(tripForm.id)}
                    >
                      Delete
                    </Button>
                  )}
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => saveTrip(onClose)}>
                    {tripForm.id ? "Save" : "Create"}
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        {/* ── All Trips Modal ─────────────────────────────────────────── */}
        <Modal isOpen={allTripsDisclosure.isOpen} onOpenChange={allTripsDisclosure.onOpenChange} size="2xl">
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>All Trips ({trips.length})</ModalHeader>
                <ModalBody>
                  {trips.length === 0 ? (
                    <p className="text-center text-default-300 py-8">No trips yet</p>
                  ) : (
                    <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                      {[...trips]
                        .sort((a, b) => a.startDate.localeCompare(b.startDate))
                        .map((trip) => {
                          const tripType = trip.type as TripType;
                          const color = TRIP_TYPE_CONFIG[tripType]?.color ?? "#999";
                          const dest = (trip.destination ?? {}) as any;
                          const destStr = dest.city
                            ? dest.country
                              ? `${dest.city}, ${dest.country}`
                              : dest.city
                            : "";
                          return (
                            <button
                              key={trip.id}
                              type="button"
                              className="w-full text-left p-3 rounded-md border border-default-200 hover:bg-default-50 flex items-start gap-3"
                              onClick={() => {
                                onClose();
                                openEditTrip(trip);
                              }}
                            >
                              <div
                                className="w-2 self-stretch rounded-sm"
                                style={{ backgroundColor: color }}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-baseline justify-between gap-2">
                                  <p className="font-medium text-sm truncate">{trip.name}</p>
                                  <span className="text-xs text-default-400 flex-shrink-0">
                                    {dayjs(trip.startDate).format("MMM D")} – {dayjs(trip.endDate).format("MMM D, YYYY")}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 text-xs text-default-500 mt-0.5">
                                  <span>{TRIP_TYPE_CONFIG[tripType]?.label ?? trip.type}</span>
                                  {destStr && (
                                    <>
                                      <span>·</span>
                                      <span className="truncate">{destStr}</span>
                                    </>
                                  )}
                                  {(trip.participantIds ?? []).length > 0 && (
                                    <>
                                      <span>·</span>
                                      <span className="truncate">
                                        {(trip.participantIds ?? [])
                                          .filter((id): id is string => !!id)
                                          .map(personName)
                                          .join(", ")}
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                    </div>
                  )}
                </ModalBody>
                <ModalFooter>
                  <Button onPress={onClose}>Close</Button>
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

      </div>
    </DefaultLayout>
  );
}
