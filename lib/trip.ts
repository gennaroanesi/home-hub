// Shared types, config, and helpers used by both the calendar trip modal
// and the dedicated /trips pages.

import dayjs from "dayjs";
import type { Schema } from "@/amplify/data/resource";

export type Trip = Schema["homeTrip"]["type"];
export type TripLeg = Schema["homeTripLeg"]["type"];

export type TripType = "LEISURE" | "WORK" | "FLYING" | "FAMILY";

export const TRIP_TYPE_CONFIG: Record<TripType, { label: string; color: string }> = {
  LEISURE: { label: "Leisure", color: "#DEBA02" },
  WORK: { label: "Work", color: "#587D71" },
  FLYING: { label: "Flying", color: "#60A5FA" },
  FAMILY: { label: "Family", color: "#EC4899" },
};

export type LegMode =
  | "COMMERCIAL_FLIGHT"
  | "PERSONAL_FLIGHT"
  | "CAR"
  | "TRAIN"
  | "BUS"
  | "BOAT"
  | "OTHER";

export const LEG_MODE_LABEL: Record<LegMode, string> = {
  COMMERCIAL_FLIGHT: "Commercial flight",
  PERSONAL_FLIGHT: "Personal flight",
  CAR: "Car",
  TRAIN: "Train",
  BUS: "Bus",
  BOAT: "Boat",
  OTHER: "Other",
};

export const LEG_MODE_EMOJI: Record<LegMode, string> = {
  COMMERCIAL_FLIGHT: "✈️",
  PERSONAL_FLIGHT: "🛩️",
  CAR: "🚗",
  TRAIN: "🚆",
  BUS: "🚌",
  BOAT: "⛵",
  OTHER: "📍",
};

// Form-side leg shape (id is empty for new legs that haven't been saved yet)
export interface LegFormRow {
  id: string;
  mode: LegMode;
  departAt: string; // datetime-local string
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

export interface TripFormState {
  id: string; // empty = new
  name: string;
  type: TripType;
  startDate: string;
  endDate: string;
  destination: string;
  destinationLat: number | null;
  destinationLon: number | null;
  destinationCountry: string;
  notes: string;
  participantIds: string[];
  legs: LegFormRow[];
}

export function emptyLeg(sortOrder: number): LegFormRow {
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

export function legToFormRow(leg: TripLeg): LegFormRow {
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

export function newTripFormState(): TripFormState {
  const today = dayjs().format("YYYY-MM-DD");
  return {
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
  };
}

export function tripToFormState(trip: Trip, allLegs: TripLeg[]): TripFormState {
  const dest = (trip.destination ?? {}) as any;
  const tripLegs = allLegs
    .filter((l) => l.tripId === trip.id)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(legToFormRow);
  return {
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
  };
}
