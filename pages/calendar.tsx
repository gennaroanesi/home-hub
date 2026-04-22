"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
import { FaPlus, FaTrash, FaArrowLeft, FaList, FaPlane } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { CityAutocomplete } from "@/components/city-autocomplete";
import { ChecklistPanel } from "@/components/checklist-panel";
import { AttachmentSection } from "@/components/attachment-section";
import { RemindersSection } from "@/components/reminders-section";
import { buildReminderDefaultsForEvent } from "@/lib/reminder-defaults";
import { cascadeDeleteRemindersFor } from "@/lib/reminder-parent";
import { TripForm, type TripFormHandle } from "@/components/trip-form";
import { TRIP_TYPE_CONFIG, type TripType, type LegMode, LEG_MODE_LABEL, LEG_MODE_EMOJI, legIsoToLocalDate } from "@/lib/trip";
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
type TripReservation = Schema["homeTripReservation"]["type"];
type Photo = Schema["homePhoto"]["type"];

type StatusKey =
  | "WORKING_HOME"
  | "WORKING_OFFICE"
  | "TRAVEL"
  | "VACATION"
  | "WEEKEND_HOLIDAY"
  | "PTO"
  | "CHOICE_DAY";

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

// Pick readable text color (black/white) for a given hex background
function contrastText(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return "#fff";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#1a1a1a" : "#fff";
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
  const [legendOpen, setLegendOpen] = useState(false);

  // Detect mobile viewport once on mount and default to day view
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
      setCurrentView(Views.DAY);
    }
  }, []);

  // Modals
  const tripModalDisclosure = useDisclosure(); // create + edit
  const eventModalDisclosure = useDisclosure(); // create + edit
  const dayStatusDisclosure = useDisclosure();
  const allTripsDisclosure = useDisclosure();

  // Day status editor state
  const [dayEditorDate, setDayEditorDate] = useState<string>("");

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
  });

  // The trip currently being edited in the modal (null = creating a new trip)
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const tripFormRef = useRef<TripFormHandle>(null);

  // All legs across all trips, used for rendering on the calendar
  const [allLegs, setAllLegs] = useState<TripLeg[]>([]);
  const [allReservations, setAllReservations] = useState<TripReservation[]>([]);
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]);
  const [allAlbums, setAllAlbums] = useState<Schema["homeAlbum"]["type"][]>([]);
  const [allAlbumPhotos, setAllAlbumPhotos] = useState<Schema["homeAlbumPhoto"]["type"][]>([]);
  const [photosUploading, setPhotosUploading] = useState(false);
  const [savingTrip, setSavingTrip] = useState(false);

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
    const [
      peopleRes,
      tripsRes,
      eventsRes,
      daysRes,
      legsRes,
      reservationsRes,
      photosRes,
      albumsRes,
      albumPhotosRes,
    ] = await Promise.all([
      client.models.homePerson.list(),
      client.models.homeTrip.list(),
      client.models.homeCalendarEvent.list(),
      client.models.homeCalendarDay.list({ limit: 1000 }),
      client.models.homeTripLeg.list({ limit: 1000 }),
      client.models.homeTripReservation.list({ limit: 1000 }),
      client.models.homePhoto.list({ limit: 1000 }),
      client.models.homeAlbum.list({ limit: 500 }),
      client.models.homeAlbumPhoto.list({ limit: 5000 }),
    ]);

    setPeople((peopleRes.data ?? []).filter((p) => p.active));
    setTrips(tripsRes.data ?? []);
    setEvents(eventsRes.data ?? []);
    setAllLegs(legsRes.data ?? []);
    setAllReservations(reservationsRes.data ?? []);
    setAllPhotos(photosRes.data ?? []);
    setAllAlbums(albumsRes.data ?? []);
    setAllAlbumPhotos(albumPhotosRes.data ?? []);

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
      // Leg times are local wall-clock at the airport stored with a fake
      // Z suffix — use legIsoToLocalDate so the viewer sees the event on
      // the grid at the HH:mm that was entered, regardless of their
      // browser timezone. (See convention note in lib/trip.ts.)
      const start = legIsoToLocalDate(leg.departAt);
      if (!start) continue;
      const end =
        legIsoToLocalDate(leg.arriveAt) ??
        new Date(start.getTime() + 60 * 60 * 1000);
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
    // Calendar event — color by assigned person(s)
    const assigned = (event.resource.event.assignedPersonIds ?? []).filter(
      (id): id is string => !!id,
    );
    const assignedPeople = assigned
      .map((id) => people.find((p) => p.id === id))
      .filter((p): p is Person => !!p);
    const householdColor = "#6b7280";
    let background: string;
    let textColor: string;
    if (assignedPeople.length === 0 || assignedPeople.length === people.length) {
      // Household (nobody assigned, or everyone assigned)
      background = householdColor;
      textColor = "#fff";
    } else if (assignedPeople.length === 1) {
      const c = assignedPeople[0].color ?? householdColor;
      background = c;
      textColor = contrastText(c);
    } else {
      // Multiple (but not all) — gradient across their colors
      const colors = assignedPeople.map((p) => p.color ?? householdColor);
      background = `linear-gradient(90deg, ${colors.join(", ")})`;
      textColor = contrastText(colors[0]);
    }
    return {
      style: {
        background,
        color: textColor,
        border: "none",
        borderRadius: "3px",
        fontSize: "0.75rem",
      },
    };
  }, [people]);

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
      openEditEvent(rbcEvent.resource.event);
    }
  }

  function openNewEvent() {
    const now = dayjs().format("YYYY-MM-DDTHH:mm");
    const later = dayjs().add(1, "hour").format("YYYY-MM-DDTHH:mm");
    setEventForm({
      id: "",
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
    eventModalDisclosure.onOpen();
  }

  function openEditEvent(event: Event) {
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
    });
    eventModalDisclosure.onOpen();
  }

  async function saveEvent(onClose: () => void) {
    if (!eventForm.title.trim() || !eventForm.startAt) {
      alert("Title and start date are required.");
      return;
    }
    // Validate dates
    const startDate = new Date(eventForm.startAt);
    if (isNaN(startDate.getTime())) {
      alert("Start date is invalid.");
      return;
    }
    let endDate: Date | null = null;
    if (eventForm.endAt) {
      endDate = new Date(eventForm.endAt);
      if (isNaN(endDate.getTime())) {
        alert("End date is invalid.");
        return;
      }
      if (endDate.getTime() < startDate.getTime()) {
        alert("End must be after start.");
        return;
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
        return;
      }
    } catch (err) {
      console.error("Save event threw:", err);
      alert(`Failed to save event: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    onClose();
    await loadAll();
  }

  async function deleteEventById(id: string) {
    if (!confirm("Delete this event?")) return;
    await cascadeDeleteRemindersFor(client, id);
    await client.models.homeCalendarEvent.delete({ id });
    eventModalDisclosure.onClose();
    await loadAll();
  }

  function openNewTrip() {
    setSelectedTrip(null);
    setPhotosUploading(false);
    tripModalDisclosure.onOpen();
  }

  function openEditTrip(trip: Trip) {
    setSelectedTrip(trip);
    setPhotosUploading(false);
    tripModalDisclosure.onOpen();
  }

  async function handleSaveTrip(onClose: () => void) {
    setSavingTrip(true);
    try {
      const saved = await tripFormRef.current?.save();
      if (saved) {
        onClose();
        await loadAll();
      }
    } finally {
      setSavingTrip(false);
    }
  }

  async function handleDeleteTrip(onClose: () => void) {
    const ok = await tripFormRef.current?.delete();
    if (ok) {
      onClose();
      await loadAll();
    }
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

  function personName(id: string): string {
    return people.find((p) => p.id === id)?.name ?? "Unknown";
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <DefaultLayout>
      <div className="max-w-7xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">Calendar</h1>
            {loading && <span className="hidden sm:inline text-xs text-default-400 animate-pulse">Loading…</span>}
          </div>
          <div className="flex gap-1 sm:gap-2 flex-shrink-0">
            {/* Mobile: icon-only buttons */}
            <Button
              size="sm"
              isIconOnly
              variant="flat"
              onPress={allTripsDisclosure.onOpen}
              className="sm:hidden"
              aria-label="All trips"
            >
              <FaList size={12} />
            </Button>
            <Button
              size="sm"
              isIconOnly
              variant="flat"
              onPress={openNewTrip}
              className="sm:hidden"
              aria-label="New trip"
            >
              <FaPlane size={12} />
            </Button>
            <Button
              size="sm"
              isIconOnly
              color="primary"
              onPress={openNewEvent}
              className="sm:hidden"
              aria-label="New event"
            >
              <FaPlus size={12} />
            </Button>

            {/* Desktop: full buttons */}
            <Button size="sm" variant="flat" startContent={<FaList size={12} />} onPress={allTripsDisclosure.onOpen} className="hidden sm:inline-flex">
              All Trips
            </Button>
            <Button size="sm" variant="flat" startContent={<FaPlus size={12} />} onPress={openNewTrip} className="hidden sm:inline-flex">
              New Trip
            </Button>
            <Button size="sm" color="primary" startContent={<FaPlus size={12} />} onPress={openNewEvent} className="hidden sm:inline-flex">
              New Event
            </Button>
          </div>
        </div>

        {/* Legend — collapsed on mobile, inline on desktop */}
        {people.length > 0 && (
          <>
            {/* Mobile: collapsible */}
            <div className="sm:hidden mb-2">
              <button
                type="button"
                className="text-xs text-default-500 underline"
                onClick={() => setLegendOpen((o) => !o)}
              >
                {legendOpen ? "Hide legend" : "Show legend"}
              </button>
              {legendOpen && (
                <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-default-500">
                  {people.map((p) => (
                    <div key={p.id} className="flex items-center gap-1">
                      <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: p.color ?? "#999" }} />
                      <span>{p.name}</span>
                    </div>
                  ))}
                  <div className="h-4 w-px bg-default-200 mx-1" />
                  {Object.entries(STATUS_CONFIG).map(([, { label, color }]) => (
                    <div key={label} className="flex items-center gap-1">
                      <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Desktop: inline */}
            <div className="hidden sm:flex flex-wrap items-center gap-4 mb-3 text-xs text-default-500">
              {people.map((p) => (
                <div key={p.id} className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: p.color ?? "#999" }} />
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
          </>
        )}

        {/* Calendar */}
        <div className="calendar-container" style={{ height: "calc(100dvh - 180px)" }}>
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

        {/* ── Event Modal (create + edit) ──────────────────────────────── */}
        <Modal isOpen={eventModalDisclosure.isOpen} onOpenChange={eventModalDisclosure.onOpenChange} size="lg">
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>{eventForm.id ? "Edit Event" : "New Event"}</ModalHeader>
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
                      <SelectItem key={p.id} textValue={p.name}>{p.name}</SelectItem>
                    ))}
                  </Select>
                  <Select
                    label="Linked trip (optional)"
                    selectedKeys={eventForm.tripId ? [eventForm.tripId] : []}
                    onChange={(e) => setEventForm((f) => ({ ...f, tripId: e.target.value }))}
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
                  {eventForm.id && (
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
                      />
                    </div>
                  )}
                </ModalBody>
                <ModalFooter>
                  {eventForm.id && (
                    <Button
                      color="danger"
                      variant="light"
                      startContent={<FaTrash size={12} />}
                      onPress={() => deleteEventById(eventForm.id)}
                    >
                      Delete
                    </Button>
                  )}
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => saveEvent(onClose)}>
                    {eventForm.id ? "Save" : "Create"}
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        {/* ── Trip Modal (create + edit) ───────────────────────────────── */}
        <Modal isOpen={tripModalDisclosure.isOpen} onOpenChange={tripModalDisclosure.onOpenChange} size="lg" scrollBehavior="inside">
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>{selectedTrip ? "Edit Trip" : "New Trip"}</ModalHeader>
                <ModalBody>
                  <TripForm
                    ref={tripFormRef}
                    trip={selectedTrip}
                    people={people}
                    allLegs={allLegs}
                    allReservations={allReservations}
                    allPhotos={allPhotos}
                    albums={allAlbums}
                    albumPhotos={allAlbumPhotos}
                    onPhotosChanged={loadAll}
                    onUploadingChange={setPhotosUploading}
                  />
                </ModalBody>
                <ModalFooter>
                  {selectedTrip && (
                    <Button
                      color="danger"
                      variant="light"
                      startContent={<FaTrash size={12} />}
                      onPress={() => handleDeleteTrip(onClose)}
                      isDisabled={photosUploading || savingTrip}
                    >
                      Delete
                    </Button>
                  )}
                  <Button variant="light" onPress={onClose} isDisabled={photosUploading || savingTrip}>
                    Cancel
                  </Button>
                  <Button
                    color="primary"
                    onPress={() => handleSaveTrip(onClose)}
                    isDisabled={photosUploading || savingTrip}
                  >
                    {photosUploading
                      ? "Uploading photos…"
                      : savingTrip
                      ? "Saving…"
                      : selectedTrip
                      ? "Save"
                      : "Create"}
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

      </div>
    </DefaultLayout>
  );
}
