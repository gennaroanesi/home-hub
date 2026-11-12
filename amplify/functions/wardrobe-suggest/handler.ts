// wardrobe-suggest — backs the suggestOutfit and planTripOutfits AppSync
// mutations used by the /wardrobe page. All the logic lives in
// lib/wardrobe-suggest.ts and lib/wardrobe-trip.ts so Janet's tools behave
// the same way.

import type { AppSyncResolverHandler } from "aws-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/wardrobe-suggest";
import type { Schema } from "../../data/resource";
import { loadSuggestContext, suggestOutfits, type Suggestion } from "../../../lib/wardrobe-suggest.js";
import {
  TRIP_CAPACITIES,
  loadTripPlanContext,
  parseJsonField,
  planTripOutfits,
  type TripActivity,
  type TripCapacity,
  type TripLook,
  type TripPlan,
  type TripPlanSnapshot,
} from "../../../lib/wardrobe-trip.js";
import { listAllPages } from "../../../lib/list-all.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();
const anthropic = new Anthropic();

interface SuggestArgs {
  personId: string;
  date?: string | null;
  occasion?: string | null;
  request?: string | null;
  count?: number | null;
}

interface SuggestResult {
  suggestions: Suggestion[];
  context: string | null;
  error: string | null;
}

interface TripArgs {
  tripId: string;
  personId: string;
  capacity: string;
  maxPieces?: number | null;
  activities?: unknown; // AWSJSON: string or parsed
  request?: string | null;
  revision?: string | null;
}

interface TripResult {
  planId: string | null;
  error: string | null;
}

type Args = SuggestArgs | TripArgs;
type Result = SuggestResult | TripResult;

export const handler: AppSyncResolverHandler<Args, Result> = async (event) => {
  // Amplify's function resolver puts fieldName at the top of the event;
  // plain AppSync Lambda resolvers nest it under info.
  const e = event as unknown as { fieldName?: string; info?: { fieldName?: string } };
  const field = e.fieldName ?? e.info?.fieldName;
  if (field === "planTripOutfits") return planTrip(event.arguments as TripArgs);
  return suggest(event.arguments as SuggestArgs);
};

async function suggest(args: SuggestArgs): Promise<SuggestResult> {
  try {
    const ctx = await loadSuggestContext(client, { personId: args.personId, date: args.date });
    const { suggestions, context } = await suggestOutfits(anthropic, ctx, {
      occasion: args.occasion,
      request: args.request,
      count: args.count,
    });
    return { suggestions, context, error: suggestions.length ? null : "No outfits came back. Try again or loosen the request." };
  } catch (err) {
    console.error("[wardrobe-suggest]", err);
    return { suggestions: [], context: null, error: err instanceof Error ? err.message : String(err) };
  }
}

type PlanRow = Schema["homeWardrobeTripPlan"]["type"];

async function planTrip(args: TripArgs): Promise<TripResult> {
  const change = args.revision?.trim() || null;
  // One plan per (trip, person): reuse the row so the page finds it by
  // trip + person even if this call outlives AppSync's timeout.
  let planId: string | null = null;
  let before: PlanRow | undefined;
  try {
    const existing = await listAllPages<PlanRow>(client.models.homeWardrobeTripPlan, {
      filter: { tripId: { eq: args.tripId }, personId: { eq: args.personId } },
    });
    before = existing[0];
    if (change && before?.status !== "READY") throw new Error("There's no finished plan to tweak yet.");

    // A tweak keeps the saved inputs; a fresh plan takes the form's.
    const capacity: TripCapacity = change
      ? ((before!.capacity as TripCapacity | null) ?? "CARRY_ON")
      : (TRIP_CAPACITIES as readonly string[]).includes(args.capacity)
        ? (args.capacity as TripCapacity)
        : "CARRY_ON";
    const activities = parseJsonField<TripActivity[]>(change ? before!.activities : args.activities, []).filter(
      (a) => a && typeof a.text === "string" && a.text.trim(),
    );
    const maxPieces = capacity === "PIECES" ? Math.max(1, Math.min(60, (change ? before!.maxPieces : args.maxPieces) ?? 12)) : null;
    const request = (change ? before!.request : args.request)?.trim() || null;
    const feedback = (before?.feedback ?? []).filter((f): f is string => !!f);

    const inputs = {
      capacity,
      maxPieces,
      activities: JSON.stringify(activities) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      request,
      status: "GENERATING" as const,
      error: null,
    };
    const saved = before
      ? await client.models.homeWardrobeTripPlan.update({ id: before.id, ...inputs })
      : await client.models.homeWardrobeTripPlan.create({ tripId: args.tripId, personId: args.personId, ...inputs });
    if (saved.errors?.length || !saved.data) throw new Error(saved.errors?.[0]?.message ?? "Couldn't save the plan");
    planId = saved.data.id;

    const savedLooks = parseJsonField<TripLook[]>(before?.looks, []);
    const pinned = await loadPinned(savedLooks);
    const current: TripPlan | null =
      before?.status === "READY"
        ? {
            packItemIds: (before.packItemIds ?? []).filter((id): id is string => !!id),
            looks: savedLooks.filter((l) => !l.lookId),
            tips: before.tips ?? null,
          }
        : null;
    const ctx = await loadTripPlanContext(client, { tripId: args.tripId, personId: args.personId });
    const { plan, context } = await planTripOutfits(anthropic, ctx, {
      capacity,
      maxPieces,
      activities,
      request,
      feedback,
      revise: change && current ? { current, change } : null,
      pinned,
    });
    const ok = plan.looks.length > 0;
    const noLooks = context.startsWith("Add more") ? context : "No looks came back. Try again or loosen the request.";
    if (!ok && change) {
      // A failed tweak leaves the plan as it was.
      await client.models.homeWardrobeTripPlan.update({ id: planId, status: "READY", error: noLooks });
      return { planId, error: noLooks };
    }
    // Undo restores the whole plan as it was, saved looks included.
    const snapshot: TripPlanSnapshot | null = current ? { ...current, looks: savedLooks, feedback } : null;
    const r = await client.models.homeWardrobeTripPlan.update({
      id: planId,
      status: ok ? "READY" : "FAILED",
      error: ok ? null : noLooks,
      context,
      weather: JSON.stringify(ctx.weather) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      looks: JSON.stringify(plan.looks) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      packItemIds: plan.packItemIds,
      // Keep ticks for pieces still on the list.
      packedItemIds: (before?.packedItemIds ?? []).filter((id): id is string => !!id && plan.packItemIds.includes(id)),
      tips: plan.tips,
      generatedAt: new Date().toISOString(),
      feedback: change ? [...feedback, change] : feedback,
      ...(ok && snapshot ? { previousPlan: JSON.stringify(snapshot) as any } : {}), // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    return { planId, error: ok ? null : noLooks };
  } catch (err) {
    console.error("[wardrobe-suggest] planTripOutfits", err);
    const message = err instanceof Error ? err.message : String(err);
    if (planId) {
      // A tweak that blew up leaves the old plan showing, with the error.
      const status = change && before?.status === "READY" ? ("READY" as const) : ("FAILED" as const);
      await client.models.homeWardrobeTripPlan.update({ id: planId, status, error: message }).catch(() => {});
    }
    return { planId, error: message };
  }
}

// Saved trip looks, as they are now in the closet: edits made since saving
// carry over, and a look deleted from the closet is no longer pinned.
async function loadPinned(looks: TripLook[]): Promise<TripLook[]> {
  const out: TripLook[] = [];
  for (const l of looks) {
    if (!l.lookId) continue;
    const { data } = await client.models.homeWardrobeLook.get({ id: l.lookId });
    if (!data) continue;
    const itemIds = (data.itemIds ?? []).filter((x): x is string => !!x);
    out.push({ ...l, title: data.title || l.title, occasion: data.occasion ?? l.occasion, why: data.note ?? l.why, itemIds: itemIds.length ? itemIds : l.itemIds });
  }
  return out;
}
