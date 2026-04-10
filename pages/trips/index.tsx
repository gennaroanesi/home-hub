"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import NextLink from "next/link";
import dayjs from "dayjs";
import { Button } from "@heroui/button";
import { Select, SelectItem } from "@heroui/select";
import { Card, CardBody } from "@heroui/card";
import { FaArrowLeft, FaPlus, FaImages, FaPlane } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { TRIP_TYPE_CONFIG, type TripType } from "@/lib/trip";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Trip = Schema["homeTrip"]["type"];
type TripLeg = Schema["homeTripLeg"]["type"];
type Photo = Schema["homePhoto"]["type"];
type Person = Schema["homePerson"]["type"];

type FilterMode = "upcoming" | "past" | "all";

export default function TripsListPage() {
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [legs, setLegs] = useState<TripLeg[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterMode>("upcoming");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [personFilter, setPersonFilter] = useState<string>("all");

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
    const [tripsRes, legsRes, photosRes, peopleRes] = await Promise.all([
      client.models.homeTrip.list({ limit: 500 }),
      client.models.homeTripLeg.list({ limit: 1000 }),
      client.models.homePhoto.list({ limit: 1000 }),
      client.models.homePerson.list(),
    ]);
    setTrips(tripsRes.data ?? []);
    setLegs(legsRes.data ?? []);
    setPhotos(photosRes.data ?? []);
    setPeople((peopleRes.data ?? []).filter((p) => p.active));
    setLoading(false);
  }, []);

  const filtered = useMemo(() => {
    const today = dayjs().format("YYYY-MM-DD");
    let result = trips;

    if (filter === "upcoming") {
      // Upcoming or ongoing (endDate >= today)
      result = result.filter((t) => t.endDate >= today);
    } else if (filter === "past") {
      result = result.filter((t) => t.endDate < today);
    }

    if (typeFilter !== "all") {
      result = result.filter((t) => t.type === typeFilter);
    }

    if (personFilter !== "all") {
      result = result.filter((t) =>
        (t.participantIds ?? []).filter((id): id is string => !!id).includes(personFilter)
      );
    }

    return [...result].sort((a, b) => {
      // Upcoming/all: ascending start date. Past: descending.
      if (filter === "past") return b.startDate.localeCompare(a.startDate);
      return a.startDate.localeCompare(b.startDate);
    });
  }, [trips, filter, typeFilter, personFilter]);

  function legCount(tripId: string): number {
    return legs.filter((l) => l.tripId === tripId).length;
  }
  function photoCount(tripId: string): number {
    return photos.filter((p) => p.tripId === tripId).length;
  }
  function personNames(ids: (string | null)[]): string {
    return ids
      .filter((id): id is string => !!id)
      .map((id) => people.find((p) => p.id === id)?.name)
      .filter(Boolean)
      .join(", ");
  }

  function newTrip() {
    router.push("/trips/new");
  }

  return (
    <DefaultLayout>
      <div className="max-w-5xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">Trips</h1>
            {loading && (
              <span className="hidden sm:inline text-xs text-default-400 animate-pulse">Loading…</span>
            )}
          </div>
          <Button size="sm" color="primary" startContent={<FaPlus size={12} />} onPress={newTrip}>
            New Trip
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-3 items-end">
          <Select
            size="sm"
            label="Show"
            selectedKeys={[filter]}
            onChange={(e) => setFilter(e.target.value as FilterMode)}
            className="max-w-[160px]"
          >
            <SelectItem key="upcoming">Upcoming &amp; ongoing</SelectItem>
            <SelectItem key="past">Past</SelectItem>
            <SelectItem key="all">All</SelectItem>
          </Select>
          <Select
            size="sm"
            label="Type"
            selectedKeys={[typeFilter]}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="max-w-[160px]"
          >
            <>
              <SelectItem key="all">All types</SelectItem>
              {(Object.entries(TRIP_TYPE_CONFIG) as [TripType, { label: string }][]).map(
                ([key, { label }]) => (
                  <SelectItem key={key}>{label}</SelectItem>
                )
              )}
            </>
          </Select>
          <Select
            size="sm"
            label="Person"
            selectedKeys={[personFilter]}
            onChange={(e) => setPersonFilter(e.target.value)}
            className="max-w-[160px]"
          >
            <>
              <SelectItem key="all">Anyone</SelectItem>
              {people.map((p) => (
                <SelectItem key={p.id}>{p.name}</SelectItem>
              )) as any}
            </>
          </Select>
        </div>
        <p className="text-xs text-default-400 mb-3">
          {filtered.length} trip{filtered.length === 1 ? "" : "s"}
        </p>

        {/* List */}
        {filtered.length === 0 && !loading && (
          <p className="text-center text-default-300 py-10 text-sm">No trips match your filters</p>
        )}
        <div className="space-y-2">
          {filtered.map((trip) => {
            const tripType = trip.type as TripType;
            const color = TRIP_TYPE_CONFIG[tripType]?.color ?? "#999";
            const dest = (trip.destination ?? {}) as any;
            const destStr = dest.city
              ? dest.country
                ? `${dest.city}, ${dest.country}`
                : dest.city
              : "";
            const nLegs = legCount(trip.id);
            const nPhotos = photoCount(trip.id);
            const participants = personNames(trip.participantIds ?? []);
            const isOngoing =
              trip.startDate <= dayjs().format("YYYY-MM-DD") &&
              trip.endDate >= dayjs().format("YYYY-MM-DD");
            return (
              <NextLink key={trip.id} href={`/trips/${trip.id}`} className="block">
                <Card isPressable className="w-full">
                  <CardBody className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div
                        className="w-1 self-stretch rounded-sm flex-shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2 flex-wrap">
                          <p className="font-medium text-sm flex items-center gap-2">
                            {trip.name}
                            {isOngoing && (
                              <span className="text-[10px] uppercase tracking-wide bg-success/20 text-success px-1.5 py-0.5 rounded">
                                Now
                              </span>
                            )}
                          </p>
                          <span className="text-xs text-default-400 flex-shrink-0">
                            {dayjs(trip.startDate).format("MMM D")} – {dayjs(trip.endDate).format("MMM D, YYYY")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-default-500 mt-1 flex-wrap">
                          <span>{TRIP_TYPE_CONFIG[tripType]?.label ?? trip.type}</span>
                          {destStr && (
                            <>
                              <span>·</span>
                              <span>{destStr}</span>
                            </>
                          )}
                          {participants && (
                            <>
                              <span>·</span>
                              <span>{participants}</span>
                            </>
                          )}
                          {nLegs > 0 && (
                            <>
                              <span>·</span>
                              <span className="flex items-center gap-1">
                                <FaPlane size={10} /> {nLegs}
                              </span>
                            </>
                          )}
                          {nPhotos > 0 && (
                            <>
                              <span>·</span>
                              <span className="flex items-center gap-1">
                                <FaImages size={10} /> {nPhotos}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardBody>
                </Card>
              </NextLink>
            );
          })}
        </div>
      </div>
    </DefaultLayout>
  );
}
