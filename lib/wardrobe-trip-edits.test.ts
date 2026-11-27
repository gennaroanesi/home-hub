import { describe, expect, it } from "vitest";
import { removeTripPlanItem, type TripLook, type TripPlanSnapshot } from "./wardrobe-trip";
import {
  editTripPlanPatch,
  forgetFeedbackPatch,
  groupByCategory,
  latestTripPlan,
  moveTripLookPatch,
  packEditSummary,
  pinTripLookPatch,
  shownTripPlan,
  sortTripsForPlanning,
  togglePackedPatch,
  tripPlanStillGenerating,
  tripsForPerson,
  undoTripPlanPatch,
  type TripPlanRow,
} from "./wardrobe-trip-edits";

const looks: TripLook[] = [
  { date: "2026-12-01", title: "Arrival", occasion: null, itemIds: ["shirt", "chino"], why: "Easy" },
  { date: "2026-12-02", title: "Dinner", occasion: "Dinner", itemIds: ["shirt", "boots"], why: null },
];

function row(extra: Partial<TripPlanRow> = {}): TripPlanRow {
  return {
    status: "READY",
    generatedAt: "2026-11-15T10:00:00Z",
    updatedAt: "2026-11-15T10:00:00Z",
    packItemIds: ["shirt", "chino", "boots"],
    packedItemIds: ["shirt", "boots"],
    looks: JSON.stringify(looks),
    tips: "Roll, don't fold",
    feedback: ["no loafers"],
    ...extra,
  };
}

describe("trip plan patches", () => {
  it("toggles a packed tick", () => {
    expect(togglePackedPatch(row(), "shirt").packedItemIds).toEqual(["boots"]);
    expect(togglePackedPatch(row(), "chino").packedItemIds).toEqual(["shirt", "boots", "chino"]);
  });

  it("saves a direct edit with a snapshot for undo, dropping ticks of removed pieces", () => {
    const r = row();
    const { plan } = removeTripPlanItem({ packItemIds: ["shirt", "chino", "boots"], looks, tips: null }, "boots");
    const patch = editTripPlanPatch(r, plan);
    expect(patch.packItemIds).toEqual(["shirt", "chino"]);
    expect(patch.packedItemIds).toEqual(["shirt"]);
    expect(typeof patch.looks).toBe("string");
    const snap = JSON.parse(patch.previousPlan!) as TripPlanSnapshot;
    expect(snap.packItemIds).toEqual(["shirt", "chino", "boots"]);
    expect(snap.feedback).toEqual(["no loafers"]);
    expect(snap.tips).toBe("Roll, don't fold");
  });

  it("keeps a PICKED plan's picks in step with its packing list", () => {
    const r = row({ mode: "PICKED", pickedItemIds: ["shirt", "chino", "boots"], pickedCopies: JSON.stringify({ shirt: 2, boots: 1 }) });
    const { plan } = removeTripPlanItem({ packItemIds: ["shirt", "chino", "boots"], looks, tips: null }, "chino");
    const patch = editTripPlanPatch(r, plan);
    expect(patch.pickedItemIds).toEqual(["shirt", "boots"]);
    expect(JSON.parse(patch.pickedCopies!)).toEqual({ shirt: 2, boots: 1 });
    // A stylist plan has no picks to keep.
    expect(editTripPlanPatch(row(), plan).pickedItemIds).toBeUndefined();
  });

  it("undo swaps current and previous, so it can be redone", () => {
    const prev: TripPlanSnapshot = { packItemIds: ["shirt", "chino"], looks: [looks[0]], tips: null, feedback: [] };
    const r = row({ previousPlan: JSON.stringify(prev) });
    const patch = undoTripPlanPatch(r)!;
    expect(patch.packItemIds).toEqual(["shirt", "chino"]);
    expect(patch.packedItemIds).toEqual(["shirt"]);
    expect(patch.feedback).toEqual([]);
    expect(JSON.parse(patch.previousPlan!).packItemIds).toEqual(["shirt", "chino", "boots"]);
    expect(undoTripPlanPatch(row())).toBeNull();
  });

  it("moves a look and reports the swap", () => {
    const m = moveTripLookPatch(row(), 0, "2026-12-02")!;
    expect(m.moved.title).toBe("Arrival");
    expect(m.swappedWith?.title).toBe("Dinner");
    const next = JSON.parse(m.patch.looks!) as TripLook[];
    expect(next.map((l) => [l.title, l.date])).toEqual([
      ["Dinner", "2026-12-01"],
      ["Arrival", "2026-12-02"],
    ]);
    expect(moveTripLookPatch(row(), 0, "2026-12-01")).toBeNull();
  });

  it("pins a look with the saved edits and packs its pieces; unpins", () => {
    const patch = pinTripLookPatch(row(), 1, { id: "L1", title: "Steakhouse", note: null, itemIds: ["shirt", "jacket"] })!;
    const next = JSON.parse(patch.looks!) as TripLook[];
    expect(next[1]).toMatchObject({ lookId: "L1", title: "Steakhouse", itemIds: ["shirt", "jacket"], why: null });
    expect(patch.packItemIds).toEqual(["shirt", "chino", "boots", "jacket"]);
    const un = JSON.parse(pinTripLookPatch({ ...row(), looks: patch.looks }, 1, null)!.looks!) as TripLook[];
    expect(un[1].lookId).toBeNull();
    expect(pinTripLookPatch(row(), 5, null)).toBeNull();
  });

  it("forgets one remembered change", () => {
    expect(forgetFeedbackPatch(row({ feedback: ["a", "b"] }), 0).feedback).toEqual(["b"]);
  });
});

describe("trip plan status", () => {
  it("shows a ready plan, or the one a running tweak started from", () => {
    expect(shownTripPlan(row())).not.toBeNull();
    expect(shownTripPlan(row({ status: "GENERATING" }))).not.toBeNull();
    expect(shownTripPlan(row({ status: "GENERATING", generatedAt: null }))).toBeNull();
    expect(shownTripPlan(row({ status: "FAILED" }))).toBeNull();
  });

  it("polls only a recent GENERATING plan", () => {
    const now = Date.parse("2026-11-15T10:01:00Z");
    expect(tripPlanStillGenerating(row({ status: "GENERATING" }), now)).toBe(true);
    expect(tripPlanStillGenerating(row({ status: "GENERATING" }), now + 3_600_000)).toBe(false);
    expect(tripPlanStillGenerating(row(), now)).toBe(false);
  });

  it("picks the newest row", () => {
    expect(latestTripPlan([{ id: "a", updatedAt: "2026-01-01" }, { id: "b", updatedAt: "2026-02-01" }])?.id).toBe("b");
    expect(latestTripPlan([])).toBeNull();
  });
});

describe("trip lists and labels", () => {
  it("keeps the person's trips (or everyone's) with live ones first", () => {
    const trips = [
      { id: "past", startDate: "2026-01-01", endDate: "2026-01-05", participantIds: [] },
      { id: "later", startDate: "2027-03-01", endDate: "2027-03-05", participantIds: ["p1"] },
      { id: "soon", startDate: "2026-12-01", endDate: "2026-12-05", participantIds: null },
      { id: "theirs", startDate: "2026-12-01", endDate: "2026-12-05", participantIds: ["p2"] },
    ];
    expect(sortTripsForPlanning(tripsForPerson(trips, "p1"), "2026-11-15").map((t) => t.id)).toEqual(["soon", "later", "past"]);
  });

  it("groups pieces by category in list order and summarises edits", () => {
    const g = groupByCategory([
      { id: "a", category: "Tops" },
      { id: "b", category: "Shoes" },
      { id: "c", category: "Tops" },
    ]);
    expect(g.map(([c, l]) => [c, l.map((x) => x.id)])).toEqual([
      ["Tops", ["a", "c"]],
      ["Shoes", ["b"]],
    ]);
    expect(packEditSummary(1, 0)).toBe("1 look changed");
    expect(packEditSummary(2, 1, "Oxford")).toBe("2 looks changed; 1 saved look keeps the Oxford");
  });
});
