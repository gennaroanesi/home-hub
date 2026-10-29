// Trip looks tab on /wardrobe: pick a trip, say how much luggage and what
// you'll be doing, and get a packing list plus a look for each day and
// activity, built from the destination's weather (forecast or past years'
// averages). One saved plan per (trip, person) in homeWardrobeTripPlan; see
// lib/wardrobe-trip.ts for the planner itself.

import React, { useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { generateClient } from "aws-amplify/data";
import { addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { FaCheck, FaMagic, FaPlus, FaTimes } from "react-icons/fa";

import { listAllPages } from "@/lib/list-all";
import { photoUrl } from "@/lib/image-loader";
import { mainImage } from "@/lib/wardrobe";
import { formatTripRange } from "@/lib/trip";
import {
  TRIP_CAPACITIES,
  TRIP_CAPACITY_LABELS,
  parseJsonField,
  tripDates,
  type TripActivity,
  type TripCapacity,
  type TripDayWeather,
  type TripLook,
} from "@/lib/wardrobe-trip";
import type { Schema } from "@/amplify/data/resource";
import type { WardrobeItem } from "./shared";
import { LookCard } from "./look-card";

const client = generateClient<Schema>({ authMode: "userPool" });

type Trip = Schema["homeTrip"]["type"];
type Plan = Schema["homeWardrobeTripPlan"]["type"];

const POLL_MS = 4000;
const POLL_LIMIT_MS = 150_000;

function dayLabel(ymd: string): string {
  return new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Upcoming and ongoing trips first (soonest first), then past ones (latest first).
function sortTrips(trips: Trip[], today: string): Trip[] {
  const live = trips.filter((t) => t.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = trips.filter((t) => t.endDate < today).sort((a, b) => b.startDate.localeCompare(a.startDate));
  return [...live, ...past];
}

function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function TripPanel({
  personId,
  personName,
  tripId,
  onTripChange,
  byId,
  onOpenItem,
  onSave,
}: {
  personId: string;
  personName: string;
  tripId: string;
  onTripChange: (id: string) => void;
  byId: Map<string, WardrobeItem>;
  onOpenItem: (it: WardrobeItem) => void;
  onSave: (look: TripLook) => void;
}) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [capacity, setCapacity] = useState<TripCapacity>("CARRY_ON");
  const [maxPieces, setMaxPieces] = useState("12");
  const [activities, setActivities] = useState<TripActivity[]>([]);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false); // the mutation call is in flight
  const [polling, setPolling] = useState(false); // waiting on a saved GENERATING plan
  const pollUntil = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const all = await listAllPages<Trip>(client.models.homeTrip);
        // Trips this person is on; trips with no participants count for everyone.
        const mine = all.filter((t) => {
          const ids = (t.participantIds ?? []).filter(Boolean);
          return !ids.length || ids.includes(personId);
        });
        setTrips(sortTrips(mine, todayYmd()));
      } catch (err) {
        console.error("Failed to load trips:", err);
        addToast({ title: "Couldn't load trips", color: "danger" });
      } finally {
        setTripsLoaded(true);
      }
    })();
  }, [personId]);

  // Default to the next trip when the URL doesn't name one.
  useEffect(() => {
    if (tripsLoaded && !tripId && trips[0]) onTripChange(trips[0].id);
  }, [tripsLoaded, tripId, trips]); // eslint-disable-line react-hooks/exhaustive-deps

  const trip = trips.find((t) => t.id === tripId) ?? null;
  const dates = useMemo(() => (trip ? tripDates(trip.startDate, trip.endDate) : []), [trip]);

  async function loadPlan(): Promise<Plan | null> {
    if (!tripId) return null;
    const rows = await listAllPages<Plan>(client.models.homeWardrobeTripPlan, {
      filter: { tripId: { eq: tripId }, personId: { eq: personId } },
    });
    const p = rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
    setPlan(p);
    return p;
  }

  // Load the saved plan and its inputs when the trip changes.
  useEffect(() => {
    setPlan(null);
    if (!tripId) return;
    let cancelled = false;
    (async () => {
      const p = await loadPlan().catch(() => null);
      if (cancelled) return;
      setCapacity((p?.capacity as TripCapacity | null) ?? "CARRY_ON");
      setMaxPieces(String(p?.maxPieces ?? 12));
      setActivities(parseJsonField<TripActivity[]>(p?.activities, []));
      setRequest(p?.request ?? "");
      // A plan still generating (e.g. started before a reload) gets polled.
      if (p?.status === "GENERATING" && Date.now() - new Date(p.updatedAt).getTime() < POLL_LIMIT_MS) {
        pollUntil.current = Date.now() + POLL_LIMIT_MS;
        setPolling(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tripId, personId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the plan until the Lambda marks it READY or FAILED.
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(async () => {
      const p = await loadPlan().catch(() => null);
      if (p && p.status !== "GENERATING") {
        finish(p);
      } else if (Date.now() > pollUntil.current) {
        pollUntil.current = 0;
        setPolling(false);
        addToast({ title: "Still working on it", description: "Check back in a minute.", color: "warning" });
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [polling]); // eslint-disable-line react-hooks/exhaustive-deps

  function finish(p: Plan | null) {
    pollUntil.current = 0;
    setPolling(false);
    if (p?.status === "FAILED") addToast({ title: "No trip plan", description: p.error ?? undefined, color: "danger" });
  }

  async function generate() {
    if (!trip) return;
    setBusy(true);
    try {
      const { data, errors } = await client.mutations.planTripOutfits({
        tripId: trip.id,
        personId,
        capacity,
        maxPieces: capacity === "PIECES" ? Number(maxPieces) || 12 : null,
        activities: JSON.stringify(activities.filter((a) => a.text.trim())),
        request: request.trim() || null,
      });
      if (errors?.length) throw new Error(errors[0].message);
      const p = await loadPlan();
      if (p?.status === "FAILED" || (data?.error && p?.status !== "READY")) {
        addToast({ title: "No trip plan", description: data?.error ?? p?.error ?? undefined, color: "danger" });
      }
    } catch (err) {
      // Usually AppSync's 30s timeout: the Lambda is still running and will
      // save the plan, so poll for it.
      console.warn("planTripOutfits returned early:", err);
      pollUntil.current = Date.now() + POLL_LIMIT_MS;
      setPolling(true);
    } finally {
      setBusy(false);
    }
  }

  async function togglePacked(id: string) {
    if (!plan) return;
    const cur = (plan.packedItemIds ?? []).filter((x): x is string => !!x);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setPlan({ ...plan, packedItemIds: next });
    const r = await client.models.homeWardrobeTripPlan.update({ id: plan.id, packedItemIds: next });
    if (r.errors?.length) addToast({ title: "Couldn't save", description: r.errors[0].message, color: "danger" });
  }

  const setActivity = (n: number, patch: Partial<TripActivity>) =>
    setActivities((list) => list.map((a, i) => (i === n ? { ...a, ...patch } : a)));

  const working = busy || polling;
  const ready = plan?.status === "READY" ? plan : null;
  const weather = parseJsonField<TripDayWeather[]>(ready?.weather, []);
  const looks = parseJsonField<TripLook[]>(ready?.looks, []);
  const pack = (ready?.packItemIds ?? []).map((id) => (id ? byId.get(id) : undefined)).filter((x): x is WardrobeItem => !!x);
  const packed = new Set((ready?.packedItemIds ?? []).filter(Boolean) as string[]);
  const packGroups = useMemo(() => {
    const m = new Map<string, WardrobeItem[]>();
    for (const it of pack) m.set(it.category, [...(m.get(it.category) ?? []), it]);
    return Array.from(m.entries());
  }, [pack]);

  if (tripsLoaded && !trips.length) {
    return (
      <div className="border border-dashed border-default-300 rounded-lg p-10 text-center text-default-500">
        No trips for {personName} yet. <NextLink href="/trips/new" className="text-primary">Add a trip</NextLink> first, with its dates and destination.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-default-200 bg-content1 p-4 flex flex-col gap-3">
        <p className="text-sm text-default-600">
          Plans what {personName} should pack and wear each day, from the destination&apos;s weather (the forecast when the trip is within 16 days,
          otherwise the last few years for those dates), the trip&apos;s reservations and the activities below.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
          <Select
            label="Trip"
            selectedKeys={tripId ? [tripId] : []}
            onChange={(e) => e.target.value && onTripChange(e.target.value)}
            isLoading={!tripsLoaded}
          >
            {trips.map((t) => (
              <SelectItem key={t.id} textValue={t.name}>
                {t.name} <span className="text-default-400 text-xs">· {formatTripRange(t.startDate, t.endDate)}</span>
              </SelectItem>
            ))}
          </Select>
          {trip && (
            <p className="text-xs text-default-500 pb-2">
              {trip.destination?.city ?? "No destination set"} · {dates.length} day{dates.length === 1 ? "" : "s"} ·{" "}
              <NextLink href={`/trips/${trip.id}`} className="text-primary">
                Open trip
              </NextLink>
              {trip.destination?.latitude == null && " · add a destination to the trip for weather"}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-default-600">Luggage</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {TRIP_CAPACITIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCapacity(c)}
                className={`px-3 py-1 rounded-full text-sm ${capacity === c ? "bg-primary text-primary-foreground" : "bg-default-100 text-default-600"}`}
              >
                {TRIP_CAPACITY_LABELS[c]}
              </button>
            ))}
            {capacity === "PIECES" && (
              <Input
                size="sm"
                type="number"
                aria-label="Number of pieces"
                className="w-28"
                min={1}
                max={60}
                value={maxPieces}
                onValueChange={setMaxPieces}
                endContent={<span className="text-xs text-default-400">pieces</span>}
              />
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm text-default-600">Activities</span>
          {activities.map((a, n) => (
            <div key={n} className="flex gap-2 items-center">
              <Select
                size="sm"
                aria-label="Day"
                className="w-40 shrink-0"
                selectedKeys={[a.date || "any"]}
                onChange={(e) => setActivity(n, { date: e.target.value && e.target.value !== "any" ? e.target.value : null })}
              >
                {[
                  <SelectItem key="any">Any day</SelectItem>,
                  ...dates.map((d) => <SelectItem key={d}>{dayLabel(d)}</SelectItem>),
                ]}
              </Select>
              <Input
                size="sm"
                aria-label="Activity"
                placeholder="Golf, wedding (cocktail attire), hike, client dinner…"
                value={a.text}
                onValueChange={(v) => setActivity(n, { text: v })}
              />
              <Button size="sm" isIconOnly variant="light" aria-label="Remove activity" onPress={() => setActivities((l) => l.filter((_, i) => i !== n))}>
                <FaTimes size={11} />
              </Button>
            </div>
          ))}
          <div>
            <Button size="sm" variant="flat" startContent={<FaPlus size={10} />} onPress={() => setActivities((l) => [...l, { date: null, text: "" }])}>
              Add activity
            </Button>
          </div>
          <p className="text-xs text-default-400">Dinners, tours and tickets already on the trip are included automatically.</p>
        </div>

        <Textarea
          label="Anything else"
          placeholder="Want to wear the new boots; one smart dinner; hotel has laundry…"
          value={request}
          onValueChange={setRequest}
          minRows={2}
        />
        <div>
          <Button color="primary" startContent={!working && <FaMagic size={12} />} onPress={generate} isLoading={working} isDisabled={!trip}>
            {working ? "Planning…" : ready ? "Plan again" : "Plan trip looks"}
          </Button>
        </div>
      </div>

      {plan?.status === "FAILED" && !working && <p role="alert" className="text-sm text-danger">{plan.error ?? "Planning failed. Try again."}</p>}

      {ready && (
        <>
          {ready.context && <p className="text-xs text-default-500">Based on: {ready.context}</p>}

          {weather.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {weather.map((w) => (
                <div key={w.date} className="shrink-0 rounded-lg border border-default-200 bg-content1 px-3 py-2 text-xs min-w-[7.5rem]">
                  <p className="font-medium">{dayLabel(w.date)}</p>
                  <p className="text-default-600">
                    {w.highF}° / {w.lowF}°
                  </p>
                  <p className="text-default-500">
                    {w.summary}
                    {w.precipChance != null && w.precipChance >= 25 ? ` · ${w.precipChance}%` : ""}
                  </p>
                  {w.source === "TYPICAL" && <p className="text-[10px] uppercase tracking-wider text-default-400">Typical</p>}
                </div>
              ))}
            </div>
          )}

          <section className="rounded-xl border border-default-200 bg-content1 p-4 flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h2 className="text-lg font-semibold">Packing list</h2>
              <span className="text-xs text-default-500">
                {pack.length} pieces · {packed.size} packed
                {ready.capacity === "PIECES" && ready.maxPieces ? ` · limit ${ready.maxPieces}` : ready.capacity ? ` · ${TRIP_CAPACITY_LABELS[ready.capacity as TripCapacity]}` : ""}
              </span>
            </div>
            {packGroups.map(([cat, list]) => (
              <div key={cat}>
                <p className="text-[11px] uppercase tracking-wider text-default-400 mb-1.5">{cat}</p>
                <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 gap-2">
                  {list.map((p) => {
                    const k = mainImage(p);
                    const on = packed.has(p.id);
                    return (
                      <div key={p.id} className="min-w-0">
                        <button
                          type="button"
                          onClick={() => onOpenItem(p)}
                          className={`relative block w-full aspect-[3/4] rounded-md overflow-hidden bg-white border ${on ? "border-success opacity-60" : "border-default-200"}`}
                        >
                          {k ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={photoUrl(k, 240)} alt={p.name} loading="lazy" className="w-full h-full object-contain" />
                          ) : (
                            <div className="w-full h-full" style={{ background: p.colorHex ?? undefined }} />
                          )}
                        </button>
                        <label className="flex items-start gap-1.5 mt-1 text-xs leading-tight cursor-pointer">
                          <input type="checkbox" checked={on} onChange={() => togglePacked(p.id)} className="mt-0.5" />
                          <span className={`line-clamp-2 ${on ? "line-through text-default-400" : ""}`}>{p.name}</span>
                        </label>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {pack.length > 0 && packed.size === pack.length && (
              <p className="text-sm text-success flex items-center gap-1.5">
                <FaCheck size={11} /> All packed
              </p>
            )}
          </section>

          {ready.tips && <p className="text-sm text-default-600 rounded-lg bg-default-100 px-3 py-2">{ready.tips}</p>}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {looks.map((l, n) => (
              <LookCard
                key={`${ready.generatedAt}-${n}`}
                title={l.date ? `${dayLabel(l.date)} · ${l.title}` : l.title}
                occasion={l.occasion}
                note={l.why}
                itemIds={l.itemIds}
                byId={byId}
                onOpenItem={onOpenItem}
                actions={
                  <Button size="sm" variant="flat" color="primary" onPress={() => onSave(l)}>
                    Save as look
                  </Button>
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
