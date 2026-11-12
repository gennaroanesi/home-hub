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
import { FaCheck, FaListUl, FaMagic, FaPlus, FaThumbtack, FaTimes, FaUndo } from "react-icons/fa";

import { listAllPages } from "@/lib/list-all";
import { photoUrl } from "@/lib/image-loader";
import { mainImage } from "@/lib/wardrobe";
import { formatTripRange } from "@/lib/trip";
import {
  TRIP_CAPACITIES,
  TRIP_CAPACITY_LABELS,
  packCount,
  parseJsonField,
  tripDates,
  type TripActivity,
  type TripCapacity,
  type TripDayWeather,
  type TripLook,
  type TripPlanSnapshot,
} from "@/lib/wardrobe-trip";
import type { Schema } from "@/amplify/data/resource";
import type { WardrobeItem } from "./shared";
import { LookCard } from "./look-card";
import { PackChecklistModal } from "./pack-checklist-modal";

const client = generateClient<Schema>({ authMode: "userPool" });

type Trip = Schema["homeTrip"]["type"];
type Plan = Schema["homeWardrobeTripPlan"]["type"];
type SavedLook = Pick<Schema["homeWardrobeLook"]["type"], "id" | "title" | "occasion" | "note" | "itemIds">;

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
  // Opens the save dialog; `done` gets the saved look so the plan can pin it.
  onSave: (look: TripLook, done: (saved?: SavedLook) => void) => void;
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
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [change, setChange] = useState("");
  const [tweaking, setTweaking] = useState(false); // the running job is a tweak, not a fresh plan
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
    // A tweak that didn't work leaves the old plan READY, with the error.
    else if (tweaking && p?.error) addToast({ title: "Couldn't make that change", description: p.error, color: "danger" });
    else if (tweaking) setChange("");
  }

  // A fresh plan from the form, or (with `revision`) a tweak of the saved one.
  async function generate(revision?: string) {
    if (!trip) return;
    setBusy(true);
    setTweaking(!!revision);
    try {
      const { data, errors } = await client.mutations.planTripOutfits({
        tripId: trip.id,
        personId,
        capacity,
        maxPieces: capacity === "PIECES" ? Number(maxPieces) || 12 : null,
        activities: JSON.stringify(activities.filter((a) => a.text.trim())),
        request: request.trim() || null,
        revision: revision ?? null,
      });
      if (errors?.length) throw new Error(errors[0].message);
      const p = await loadPlan();
      if (p?.status === "FAILED" || data?.error) {
        addToast({ title: revision ? "Couldn't make that change" : "No trip plan", description: data?.error ?? p?.error ?? undefined, color: "danger" });
      } else if (revision) setChange("");
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

  async function savePlan(patch: Partial<Plan>) {
    if (!plan) return;
    setPlan({ ...plan, ...patch });
    const r = await client.models.homeWardrobeTripPlan.update({ id: plan.id, ...patch });
    if (r.errors?.length) addToast({ title: "Couldn't save", description: r.errors[0].message, color: "danger" });
  }

  // Pin look `n` to a saved closet look (taking any edits made while saving), or unpin it.
  async function pinLook(n: number, saved: SavedLook | null) {
    if (!plan) return;
    const list = parseJsonField<TripLook[]>(plan.looks, []);
    const l = list[n];
    if (!l) return;
    const itemIds = saved ? (saved.itemIds ?? []).filter((x): x is string => !!x) : l.itemIds;
    list[n] = saved
      ? { ...l, lookId: saved.id, title: saved.title || l.title, occasion: saved.occasion ?? l.occasion, why: saved.note ?? l.why, itemIds: itemIds.length ? itemIds : l.itemIds }
      : { ...l, lookId: null };
    const pack = (plan.packItemIds ?? []).filter((x): x is string => !!x);
    for (const id of list[n].itemIds) if (!pack.includes(id)) pack.push(id);
    await savePlan({ looks: JSON.stringify(list) as any, packItemIds: pack }); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  // Swap the plan with the one before the last tweak or re-plan, so undo can be undone.
  async function undo() {
    const prev = parseJsonField<TripPlanSnapshot | null>(plan?.previousPlan, null);
    if (!plan || !prev) return;
    const now: TripPlanSnapshot = {
      packItemIds: (plan.packItemIds ?? []).filter((x): x is string => !!x),
      looks: parseJsonField<TripLook[]>(plan.looks, []),
      tips: plan.tips ?? null,
      feedback: (plan.feedback ?? []).filter((x): x is string => !!x),
    };
    await savePlan({
      packItemIds: prev.packItemIds,
      looks: JSON.stringify(prev.looks) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      tips: prev.tips,
      feedback: prev.feedback,
      packedItemIds: (plan.packedItemIds ?? []).filter((id): id is string => !!id && prev.packItemIds.includes(id)),
      previousPlan: JSON.stringify(now) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      error: null,
    });
  }

  const setActivity = (n: number, patch: Partial<TripActivity>) =>
    setActivities((list) => list.map((a, i) => (i === n ? { ...a, ...patch } : a)));

  const working = busy || polling;
  // While a tweak or re-plan runs, keep showing the plan it started from.
  const ready = plan?.status === "READY" || (plan?.status === "GENERATING" && plan.generatedAt) ? plan : null;
  const feedback = (plan?.feedback ?? []).filter((x): x is string => !!x);
  const canUndo = !!plan?.previousPlan && !working;
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
          <Button color="primary" startContent={!working && <FaMagic size={12} />} onPress={() => generate()} isLoading={working && !tweaking} isDisabled={!trip || working}>
            {working && !tweaking ? "Planning…" : ready ? "Plan again from scratch" : "Plan trip looks"}
          </Button>
        </div>
      </div>

      {plan?.status === "FAILED" && !working && <p role="alert" className="text-sm text-danger">{plan.error ?? "Planning failed. Try again."}</p>}

      {ready && (
        <div className={`flex flex-col gap-5 ${working ? "opacity-50 pointer-events-none" : ""}`}>
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
              <div className="flex items-center gap-2">
                <span className="text-xs text-default-500">
                  {pack.reduce((n, p) => n + packCount(p, looks), 0)} pieces ·{" "}
                  {pack.reduce((n, p) => n + (packed.has(p.id) ? packCount(p, looks) : 0), 0)} packed
                  {ready.capacity === "PIECES" && ready.maxPieces ? ` · limit ${ready.maxPieces}` : ready.capacity ? ` · ${TRIP_CAPACITY_LABELS[ready.capacity as TripCapacity]}` : ""}
                </span>
                {pack.length > 0 && (
                  <Button size="sm" variant="flat" startContent={<FaListUl size={11} />} onPress={() => setChecklistOpen(true)}>
                    Add to checklist
                  </Button>
                )}
              </div>
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
                          <span className={`line-clamp-2 ${on ? "line-through text-default-400" : ""}`}>
                            {p.name}
                            {(p.quantity ?? 1) > 1 && (
                              <span className="text-default-500"> · pack {packCount(p, looks)} of {p.quantity}</span>
                            )}
                          </span>
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

          <section className="rounded-xl border border-default-200 bg-content1 p-4 flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Tweak the plan</h2>
            <p className="text-xs text-default-500">Say what to change; everything else stays as it is. Changes are remembered, so planning again from scratch still follows them. Looks you saved stay fixed either way (Unpin to let them change).</p>
            <Textarea
              aria-label="Change to make"
              placeholder="The field jacket is too specific, pack something more low-profile…"
              value={change}
              onValueChange={setChange}
              minRows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && change.trim()) generate(change.trim());
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button color="primary" variant="flat" onPress={() => generate(change.trim())} isLoading={working && tweaking} isDisabled={!change.trim() || working}>
                {working && tweaking ? "Changing…" : "Apply change"}
              </Button>
              {canUndo && (
                <Button variant="light" startContent={<FaUndo size={11} />} onPress={undo}>
                  Undo last change
                </Button>
              )}
            </div>
            {feedback.length > 0 && (
              <div className="flex flex-col gap-1 mt-1">
                <span className="text-[11px] uppercase tracking-wider text-default-400">Changes so far</span>
                {feedback.map((f, n) => (
                  <div key={n} className="flex items-start gap-2 text-sm text-default-600">
                    <span className="flex-1">{f}</span>
                    <button
                      type="button"
                      aria-label="Forget this change"
                      title="Forget this change (the next plan won't follow it)"
                      className="text-default-400 hover:text-danger mt-0.5"
                      onClick={() => savePlan({ feedback: feedback.filter((_, i) => i !== n) })}
                    >
                      <FaTimes size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

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
                  l.lookId ? (
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-success flex items-center gap-1" title="Saved to Looks; planning again or tweaking keeps it as it is">
                        <FaThumbtack size={10} /> Saved, kept on re-plan
                      </span>
                      <Button size="sm" variant="light" onPress={() => pinLook(n, null)} isDisabled={working}>
                        Unpin
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="flat" color="primary" isDisabled={working} onPress={() => onSave(l, (saved) => saved && pinLook(n, saved))}>
                      Save as look
                    </Button>
                  )
                }
              />
            ))}
          </div>

          {trip && (
            <PackChecklistModal
              isOpen={checklistOpen}
              onClose={() => setChecklistOpen(false)}
              tripId={trip.id}
              tripName={trip.name}
              personId={personId}
              personName={personName}
              groups={packGroups}
              copies={(it) => packCount(it, looks)}
            />
          )}
        </div>
      )}
    </div>
  );
}
