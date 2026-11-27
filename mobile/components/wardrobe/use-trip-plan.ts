// State for one trip + person's trip-looks plan on the phone, mirroring
// the web TripPanel: load the saved homeWardrobeTripPlan row and its form
// inputs, plan / tweak through the planTripOutfits mutation, and write
// direct edits (patches from lib/wardrobe-trip-edits.ts).
//
// The planner Lambda takes ~40s, past AppSync's 30s limit: it saves the
// plan itself (GENERATING → READY / FAILED) and the mutation call usually
// times out, so we poll the row, as the web does. On the phone the app may
// also go to the background mid-run (iOS suspends JS and the request can
// die): when it comes back we check the row straight away and keep polling
// while it's still generating. A run counts as finished only once the row
// changed since we started it (its updatedAt moved), so a request that
// never reached the server isn't mistaken for a finished plan.

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { getClient } from "../../lib/amplify";
import { listAllPages } from "../../../lib/list-all";
import { parseJsonField, picksOf, type TripActivity, type TripCapacity, type TripPicks, type TripPlanMode } from "../../../lib/wardrobe-trip";
import {
  TRIP_PLAN_POLL_MS,
  latestTripPlan,
  tripPlanStillGenerating,
  type TripPlanPatch,
} from "../../../lib/wardrobe-trip-edits";
import type { Schema } from "../../../amplify/data/resource";
import type { ToastMsg } from "./shared";

export type TripPlanRecord = Schema["homeWardrobeTripPlan"]["type"];

// How long a run may go without touching the row before we decide the
// request never started.
const START_GRACE_MS = 45_000;

export function useTripPlan(tripId: string, personId: string, toast: (m: ToastMsg) => void) {
  const [plan, setPlan] = useState<TripPlanRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [capacity, setCapacity] = useState<TripCapacity>("CARRY_ON");
  const [maxPieces, setMaxPieces] = useState("12");
  const [activities, setActivities] = useState<TripActivity[]>([]);
  const [request, setRequest] = useState("");
  const [mode, setMode] = useState<TripPlanMode>("SUGGEST");
  const [picks, setPicks] = useState<TripPicks>({ itemIds: [], copies: {} });
  const [perDay, setPerDay] = useState(true);
  const [change, setChange] = useState("");
  const [busy, setBusy] = useState(false); // the mutation call is in flight
  const [polling, setPolling] = useState(false); // waiting on a saved GENERATING plan
  const [tweaking, setTweaking] = useState(false); // the running job is a tweak

  const tweakingRef = useRef(false);
  const run = useRef<{ startedAt: number; baseline: string } | null>(null);
  const planRef = useRef<TripPlanRecord | null>(null);
  planRef.current = plan;

  const loadPlan = useCallback(async (): Promise<TripPlanRecord | null> => {
    if (!tripId || !personId) return null;
    const rows = await listAllPages<TripPlanRecord>(getClient().models.homeWardrobeTripPlan, {
      filter: { tripId: { eq: tripId }, personId: { eq: personId } },
    });
    const p = latestTripPlan(rows);
    setPlan(p);
    return p;
  }, [tripId, personId]);

  function startPolling(baseline: string) {
    run.current = { startedAt: Date.now(), baseline };
    setPolling(true);
  }

  function stopPolling() {
    run.current = null;
    setPolling(false);
  }

  function finish(p: TripPlanRecord) {
    stopPolling();
    if (p.status === "FAILED") toast({ title: "No trip plan", detail: p.error ?? undefined, tone: "error" });
    // A tweak that didn't work leaves the old plan READY, with the error.
    else if (tweakingRef.current && p.error) toast({ title: "Couldn't make that change", detail: p.error, tone: "error" });
    else {
      if (tweakingRef.current) setChange("");
      toast({ title: tweakingRef.current ? "Plan changed" : "Trip looks ready" });
    }
  }

  // One poll step: finished, still going, or given up.
  const check = useCallback(async () => {
    const r = run.current;
    if (!r) return;
    const p = await loadPlan().catch(() => null);
    if (!run.current) return;
    const touched = !!p && (!r.baseline || p.updatedAt > r.baseline);
    if (p && touched && p.status !== "GENERATING") {
      finish(p);
      return;
    }
    if (p?.status === "GENERATING" && touched) {
      if (!tripPlanStillGenerating(p)) {
        stopPolling();
        toast({ title: "Still working on it", detail: "Check back in a minute.", tone: "warn" });
      }
      return;
    }
    // Not started (yet): no row, or the row is as it was.
    if (Date.now() - r.startedAt > START_GRACE_MS) {
      stopPolling();
      toast({ title: "The planner didn't start", detail: "Try again.", tone: "warn" });
    }
  }, [loadPlan]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the saved plan and its inputs when the trip or person changes.
  useEffect(() => {
    setPlan(null);
    setLoaded(false);
    stopPolling();
    if (!tripId || !personId) return;
    let cancelled = false;
    (async () => {
      const p = await loadPlan().catch(() => null);
      if (cancelled) return;
      setCapacity((p?.capacity as TripCapacity | null) ?? "CARRY_ON");
      setMaxPieces(String(p?.maxPieces ?? 12));
      setActivities(parseJsonField<TripActivity[]>(p?.activities, []));
      setRequest(p?.request ?? "");
      setMode((p?.mode as TripPlanMode | null) ?? "SUGGEST");
      setPicks(p ? picksOf(p) : { itemIds: [], copies: {} });
      setPerDay(p?.perDay !== false);
      setChange("");
      setLoaded(true);
      // A plan still generating (started on the web, or before leaving) gets polled.
      if (p && tripPlanStillGenerating(p)) {
        tweakingRef.current = !!p.generatedAt;
        setTweaking(!!p.generatedAt);
        run.current = { startedAt: Date.now(), baseline: "" };
        setPolling(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tripId, personId, loadPlan]);

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => void check(), TRIP_PLAN_POLL_MS);
    return () => clearInterval(t);
  }, [polling, check]);

  // Back from the background: look at the row now instead of waiting for
  // the next tick (timers were paused), and pick up a run started elsewhere.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (run.current) {
        void check();
        return;
      }
      void loadPlan()
        .then((p) => {
          if (p && tripPlanStillGenerating(p) && !run.current) {
            run.current = { startedAt: Date.now(), baseline: "" };
            setPolling(true);
          }
        })
        .catch(() => {});
    });
    return () => sub.remove();
  }, [check, loadPlan]);

  /** A fresh plan from the form, or (with `revision`) a tweak of the saved one. */
  async function generate(revision?: string) {
    if (!tripId || !personId) return;
    if (!revision && mode === "PICKED" && picks.itemIds.length < 2) {
      toast({ title: "Pick at least two pieces", detail: "Tap what you'd pack, then check.", tone: "warn" });
      return;
    }
    tweakingRef.current = !!revision;
    setTweaking(!!revision);
    setBusy(true);
    const baseline = planRef.current?.updatedAt ?? "";
    // Poll from the start too: if the phone sleeps, the call may never return.
    startPolling(baseline);
    try {
      const { data, errors } = await getClient().mutations.planTripOutfits({
        tripId,
        personId,
        capacity,
        maxPieces: capacity === "PIECES" ? Number(maxPieces) || 12 : null,
        activities: JSON.stringify(activities.filter((a) => a.text.trim())),
        request: request.trim() || null,
        revision: revision ?? null,
        mode,
        perDay,
        pickedItemIds: mode === "PICKED" ? picks.itemIds : null,
        pickedCopies: mode === "PICKED" ? JSON.stringify(picks.copies ?? {}) : null,
      });
      if (errors?.length) throw new Error(errors[0].message);
      if (!run.current) return; // the poll already finished it
      const p = await loadPlan();
      stopPolling();
      if (p?.status === "FAILED" || data?.error) {
        toast({ title: revision ? "Couldn't make that change" : "No trip plan", detail: data?.error ?? p?.error ?? undefined, tone: "error" });
      } else {
        if (revision) setChange("");
        toast({ title: revision ? "Plan changed" : "Trip looks ready" });
      }
    } catch (err) {
      // Usually AppSync's 30s timeout (or the phone suspending the request):
      // the Lambda is still running and will save the plan, so keep polling.
      console.warn("planTripOutfits returned early:", err);
    } finally {
      setBusy(false);
    }
  }

  /** Optimistic write of a patch from lib/wardrobe-trip-edits.ts. */
  async function savePlan(patch: TripPlanPatch): Promise<boolean> {
    const cur = planRef.current;
    if (!cur) return false;
    setPlan({ ...cur, ...(patch as Partial<TripPlanRecord>) });
    const r = await getClient().models.homeWardrobeTripPlan.update({ id: cur.id, ...(patch as any) });
    if (r.errors?.length) {
      toast({ title: "Couldn't save", detail: r.errors[0].message, tone: "error" });
      void loadPlan().catch(() => {});
      return false;
    }
    return true;
  }

  async function deletePlan(): Promise<boolean> {
    const cur = planRef.current;
    if (!cur) return false;
    const r = await getClient().models.homeWardrobeTripPlan.delete({ id: cur.id });
    if (r.errors?.length) {
      toast({ title: "Couldn't delete the plan", detail: r.errors[0].message, tone: "error" });
      return false;
    }
    setPlan(null);
    setChange("");
    return true;
  }

  return {
    plan,
    loaded,
    reload: loadPlan,
    form: { capacity, setCapacity, maxPieces, setMaxPieces, activities, setActivities, request, setRequest, mode, setMode, picks, setPicks, perDay, setPerDay },
    change,
    setChange,
    busy,
    polling,
    working: busy || polling,
    tweaking,
    generate,
    savePlan,
    deletePlan,
  };
}
