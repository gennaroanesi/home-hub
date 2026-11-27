import { describe, expect, it } from "vitest";
import {
  MAX_TRIP_DAYS,
  buildTripPrompt,
  categoryCounts,
  categoryCountsLabel,
  mergePinned,
  pickedCopies,
  picksOf,
  capacityRule,
  fetchTripWeather,
  packCount,
  parseTripPlan,
  resolveTripLocation,
  addTripPlanItem,
  moveTripLook,
  removeTripPlanItem,
  sameDayYearsAgo,
  swapTripPlanItem,
  tripDates,
  typicalWeather,
  type TripPlanContext,
} from "./wardrobe-trip";

const items = [
  { id: "shirt", category: "Tops", name: "Oxford" },
  { id: "chino", category: "Pants", name: "Chino" },
  { id: "boots", category: "Shoes", name: "Boots" },
  { id: "jacket", category: "Outerwear", name: "Harrington" },
];

describe("trip dates", () => {
  it("lists every day inclusive and caps long trips", () => {
    expect(tripDates("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(tripDates("2026-01-01", "2026-03-01")).toHaveLength(MAX_TRIP_DAYS);
    expect(tripDates("2026-01-02", "2026-01-01")).toEqual([]);
  });

  it("shifts years back and maps Feb 29 to Feb 28", () => {
    expect(sameDayYearsAgo("2026-11-14", 2)).toBe("2024-11-14");
    expect(sameDayYearsAgo("2028-02-29", 1)).toBe("2027-02-28");
    expect(sameDayYearsAgo("2028-02-29", 4)).toBe("2024-02-29");
  });
});

describe("weather", () => {
  it("averages past years and turns wet years into a rain chance", () => {
    const w = typicalWeather(
      ["2026-11-14", "2026-11-15"],
      [
        { temperature_2m_max: [70, 60], temperature_2m_min: [50, 40], precipitation_sum: [0, 5] },
        { temperature_2m_max: [74, 62], temperature_2m_min: [52, null], precipitation_sum: [2, 0] },
      ],
    );
    expect(w[0]).toMatchObject({ date: "2026-11-14", highF: 72, lowF: 51, precipChance: 50, source: "TYPICAL", summary: "Often rainy" });
    // Second year has no low that day, so only the first year counts.
    expect(w[1]).toMatchObject({ highF: 60, lowF: 40, precipChance: 100 });
  });

  it("uses the forecast inside 16 days and history beyond it", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      if (u.hostname.startsWith("archive")) {
        return new Response(JSON.stringify({ daily: { temperature_2m_max: [80, 81], temperature_2m_min: [60, 61], precipitation_sum: [0, 0] } }));
      }
      return new Response(
        JSON.stringify({ daily: { temperature_2m_max: [70], temperature_2m_min: [55], precipitation_probability_max: [10], weather_code: [1] } }),
      );
    }) as typeof fetch;
    const loc = { latitude: 1, longitude: 2, label: "X", timezone: "Europe/Lisbon" };
    // Nov 12 is the 16th day counting Oct 28; Nov 13 falls outside.
    const w = await fetchTripWeather(["2026-11-12", "2026-11-13"], loc, "2026-10-28", fake);
    expect(w.map((d) => d.source)).toEqual(["FORECAST", "TYPICAL"]);
    expect(w[0]).toMatchObject({ highF: 70, summary: "Mostly clear" });
    expect(w[1]).toMatchObject({ highF: 81, lowF: 61 });
    expect(calls.filter((c) => c.includes("archive"))).toHaveLength(3);
  });
});

describe("trip location", () => {
  const at = (city: string) => ({ city, latitude: 1, longitude: 1 });
  it("prefers the destination, then the first hotel, then where the first leg lands", () => {
    expect(resolveTripLocation({ destination: at("Lisbon") }, [], [])?.label).toBe("Lisbon");
    expect(
      resolveTripLocation(
        { destination: { city: "No coords" } },
        [
          { type: "HOTEL", startAt: "2026-11-15T15:00:00.000Z", location: at("Porto") },
          { type: "HOTEL", startAt: "2026-11-12T15:00:00.000Z", location: at("Lisbon") },
        ],
        [],
      )?.label,
    ).toBe("Lisbon");
    expect(resolveTripLocation({}, [], [{ departAt: "2026-11-12T08:00:00.000Z", toLocation: at("Madrid") }])?.label).toBe("Madrid");
    expect(resolveTripLocation({}, [], [])).toBeNull();
  });
});

describe("parseTripPlan", () => {
  const ctx = { items, dates: ["2026-11-12", "2026-11-13"] };

  it("drops unknown ids and thin looks, and packs everything the looks use", () => {
    const plan = parseTripPlan(
      {
        packItemIds: ["shirt", "ghost", "shirt"],
        looks: [
          { date: "2026-11-13", title: "Dinner", itemIds: ["shirt", "chino", "boots", "ghost"], why: "Easy." },
          { date: "2026-11-12", title: "Travel day", itemIds: ["jacket", "chino", "boots"] },
          { date: "2026-11-12", title: "Thin", itemIds: ["shirt", "ghost"] },
          { date: "2030-01-01", title: "Off-trip date", itemIds: ["shirt", "chino"] },
        ],
        tips: "  Wear the boots on the plane. ",
      },
      ctx,
    );
    expect(plan.looks.map((l) => [l.date, l.title])).toEqual([
      ["2026-11-12", "Travel day"],
      ["2026-11-13", "Dinner"],
      [null, "Off-trip date"],
    ]);
    expect(plan.looks[1].itemIds).toEqual(["shirt", "chino", "boots"]);
    expect(plan.packItemIds.sort()).toEqual(["boots", "chino", "jacket", "shirt"]);
    expect(plan.tips).toBe("Wear the boots on the plane.");
  });

  it("survives junk", () => {
    expect(parseTripPlan(null, ctx)).toEqual({ packItemIds: [], looks: [], tips: null });
  });
});

describe("packCount", () => {
  const looks = [
    { date: "2026-11-15", itemIds: ["tee", "chino"] },
    { date: "2026-11-15", itemIds: ["tee", "jacket"] }, // same day: still one tee
    { date: "2026-11-16", itemIds: ["tee"] },
    { date: null, itemIds: ["tee"] },
  ];
  it("packs one copy per day worn, capped at what's owned", () => {
    expect(packCount({ id: "tee", quantity: 4 }, looks)).toBe(3);
    expect(packCount({ id: "tee", quantity: 2 }, looks)).toBe(2);
    expect(packCount({ id: "tee" }, looks)).toBe(1);
    expect(packCount({ id: "ghost", quantity: 3 }, looks)).toBe(1);
  });
});

describe("prompt", () => {
  it("states the luggage limit, days, activities and reservations", () => {
    const ctx: TripPlanContext = {
      person: { id: "p", name: "Gennaro" },
      styleNotes: null,
      trip: { id: "t", name: "Lisbon", type: "LEISURE", startDate: "2026-11-12", endDate: "2026-11-13", notes: null },
      location: { latitude: 1, longitude: 1, label: "Lisbon, Portugal" },
      dates: ["2026-11-12", "2026-11-13"],
      weather: [{ date: "2026-11-12", source: "TYPICAL", highF: 66, lowF: 54, precipChance: 40, summary: "Some rainy days" }],
      reservations: [{ type: "RESTAURANT", name: "Belcanto", date: "2026-11-13", time: "20:00" }],
      items: [...items, { id: "tee", category: "Tops", name: "Supima tee", quantity: 4 }],
    };
    const { user } = buildTripPrompt(ctx, {
      capacity: "PIECES",
      maxPieces: 9,
      activities: [{ date: "2026-11-13", text: "Golf" }, { text: "  " }, { text: "Museum" }],
    });
    expect(user).toContain("at most 9 pieces");
    expect(user).toContain("- 2026-11-12: Some rainy days, 66°F / 54°F, 40% rain (typical for the date)");
    expect(user).toContain("- 2026-11-13: weather unknown");
    expect(user).toContain("- 2026-11-13: Golf\n- Some day: Museum");
    expect(user).toContain("- 2026-11-13 20:00: restaurant Belcanto");
    expect(user).toContain("Supima tee | owns 4 identical copies");
    expect(user).not.toContain("Chino | owns");
    expect(capacityRule("CARRY_ON")).toMatch(/Carry-on/);
  });

  it("the request is an instruction the model must follow, and pieces keep their wardrobe names", () => {
    const ctx: TripPlanContext = {
      person: { id: "p", name: "Gennaro" },
      styleNotes: null,
      trip: { id: "t", name: "Seattle", type: "WORK", startDate: "2026-11-16", endDate: "2026-11-17", notes: null },
      location: null,
      dates: ["2026-11-16", "2026-11-17"],
      weather: [],
      reservations: [],
      items,
    };
    const { system, user } = buildTripPrompt(ctx, { capacity: "CARRY_ON", activities: [], request: "  Consider the Beaufort jacket.  " });
    expect(user).toContain("Request (follow it; pieces it names go in the plan):\nConsider the Beaufort jacket.");
    expect(system).toContain("The request is an instruction, not a suggestion");
    expect(system).toContain("even as 'consider' or 'ideally'");
    expect(system).toContain("exactly as listed in the wardrobe; never rename");
    expect(buildTripPrompt(ctx, { capacity: "CARRY_ON", activities: [], request: " " }).user).not.toContain("Request (");
  });

  it("a tweak sends the current plan and the change; earlier changes always ride along", () => {
    const ctx: TripPlanContext = {
      person: { id: "p", name: "Gennaro" },
      styleNotes: null,
      trip: { id: "t", name: "Lisbon", type: null, startDate: "2026-11-12", endDate: "2026-11-12", notes: null },
      location: null,
      dates: ["2026-11-12"],
      weather: [],
      reservations: [],
      items,
    };
    const current = { packItemIds: [items[0].id, items[1].id], looks: [{ date: "2026-11-12", title: "Travel", occasion: null, itemIds: [items[0].id, items[1].id], why: null }], tips: "Wear the boots." };
    const fresh = buildTripPrompt(ctx, { capacity: "CARRY_ON", activities: [], feedback: ["No shorts", " "] }).user;
    expect(fresh).toContain("Feedback on earlier versions of this plan (still applies):\n- No shorts");
    expect(fresh).not.toContain("Current plan");
    expect(fresh).toMatch(/Plan the trip with the propose_trip_plan tool\.$/);

    const tweak = buildTripPrompt(ctx, { capacity: "CARRY_ON", activities: [], feedback: ["No shorts"], revise: { current, change: " The jacket is too specific " } }).user;
    expect(tweak).toContain(`- 2026-11-12 · Travel: [${items[0].id}]`);
    expect(tweak).toContain("Tips: Wear the boots.");
    expect(tweak).toContain("Change requested: The jacket is too specific\nRevise the current plan");
    expect(tweak).not.toContain("Plan the trip with");
  });
});

describe("swapTripPlanItem", () => {
  const plan = {
    packItemIds: ["shirt", "chino", "boots"],
    looks: [
      { date: "2026-11-16", title: "Travel", occasion: null, itemIds: ["shirt", "chino", "boots"], why: "The Oxford with chinos and the Red Wing Boots." },
      { date: "2026-11-17", title: "Office", occasion: null, itemIds: ["shirt", "chino"], why: "Oxford and chinos." },
      { date: "2026-11-18", title: "Dinner", occasion: null, itemIds: ["chino", "boots"], why: null, lookId: "saved-1" },
    ],
    tips: "Wear the boots on the plane.",
  };
  const boots = { id: "boots", brand: "Red Wing", name: "Boots" };
  const sneakers = { id: "sneakers", brand: "Nike", name: "AF1" };

  it("replaces the piece on the packing list and in every unpinned look, renaming it in why", () => {
    const { plan: next, changedLooks, pinnedKept } = swapTripPlanItem({ ...plan, looks: plan.looks.slice(0, 2) }, boots, sneakers);
    expect(next.packItemIds).toEqual(["shirt", "chino", "sneakers"]);
    expect(next.looks[0].itemIds).toEqual(["shirt", "chino", "sneakers"]);
    expect(next.looks[0].why).toBe("The Oxford with chinos and the Nike AF1.");
    expect(next.looks[1]).toBe(plan.looks[1]);
    expect(next.tips).toBe(plan.tips);
    expect(changedLooks).toBe(1);
    expect(pinnedKept).toBe(0);
  });

  it("leaves a saved look alone and keeps the old piece packed for it", () => {
    const { plan: next, changedLooks, pinnedKept } = swapTripPlanItem(plan, boots, sneakers);
    expect(next.looks[2]).toBe(plan.looks[2]);
    expect(next.packItemIds).toEqual(["shirt", "chino", "sneakers", "boots"]);
    expect(changedLooks).toBe(1);
    expect(pinnedKept).toBe(1);
  });

  it("doesn't duplicate a piece already in the look or on the list", () => {
    const { plan: next } = swapTripPlanItem({ ...plan, looks: plan.looks.slice(0, 2) }, boots, { id: "shirt", name: "Oxford" });
    expect(next.packItemIds).toEqual(["shirt", "chino"]);
    expect(next.looks[0].itemIds).toEqual(["shirt", "chino"]);
    expect(swapTripPlanItem(plan, boots, boots).plan).toBe(plan);
  });

  it("remove drops the piece from the list and unpinned looks; a saved look keeps it packed", () => {
    const r = removeTripPlanItem({ ...plan, looks: plan.looks.slice(0, 2) }, "boots");
    expect(r.plan.packItemIds).toEqual(["shirt", "chino"]);
    expect(r.plan.looks[0].itemIds).toEqual(["shirt", "chino"]);
    expect(r.plan.looks[1]).toBe(plan.looks[1]);
    expect(r.changedLooks).toBe(1);
    expect(r.pinnedKept).toBe(0);

    const kept = removeTripPlanItem(plan, "boots");
    expect(kept.plan.packItemIds).toEqual(["shirt", "chino", "boots"]);
    expect(kept.plan.looks[2]).toBe(plan.looks[2]);
    expect(kept.pinnedKept).toBe(1);
  });

  it("add puts a piece on the list only, once", () => {
    const next = addTripPlanItem(plan, "jacket");
    expect(next.packItemIds).toEqual(["shirt", "chino", "boots", "jacket"]);
    expect(next.looks).toBe(plan.looks);
    expect(addTripPlanItem(plan, "boots")).toBe(plan);
  });

  it("move swaps days with the look already there, or just moves to a free day", () => {
    const swapped = moveTripLook(plan, 2, "2026-11-16");
    expect(swapped.swappedWith?.title).toBe("Travel");
    expect(swapped.plan.looks.map((l) => `${l.date} ${l.title}`)).toEqual(["2026-11-16 Dinner", "2026-11-17 Office", "2026-11-18 Travel"]);
    expect(swapped.plan.looks[0].lookId).toBe("saved-1");

    const moved = moveTripLook(plan, 0, "2026-11-20");
    expect(moved.swappedWith).toBeNull();
    expect(moved.plan.looks.map((l) => l.date)).toEqual(["2026-11-17", "2026-11-18", "2026-11-20"]);

    const anyDay = moveTripLook(plan, 1, null);
    expect(anyDay.plan.looks.at(-1)).toMatchObject({ title: "Office", date: null });
    expect(moveTripLook(plan, 1, "2026-11-17").plan).toBe(plan);
    expect(moveTripLook(plan, 9, "2026-11-17").plan).toBe(plan);
  });
});

describe("pinned (saved) looks", () => {
  const saved = { date: "2026-11-12", title: "Dinner", occasion: "Dinner", itemIds: ["a", "b"], why: "Saved.", lookId: "L1" };
  it("puts saved looks back, drops model duplicates, and packs their pieces", () => {
    const plan = {
      packItemIds: ["c", "d"],
      looks: [
        { date: "2026-11-12", title: "dinner", occasion: null, itemIds: ["c", "d"], why: null }, // same day + title
        { date: "2026-11-12", title: "Night out", occasion: null, itemIds: ["b", "a"], why: null }, // same day + pieces
        { date: "2026-11-11", title: "Travel", occasion: null, itemIds: ["c", "d"], why: null },
      ],
      tips: null,
    };
    const out = mergePinned(plan, [saved]);
    expect(out.looks.map((l) => l.title)).toEqual(["Travel", "Dinner"]);
    expect(out.looks[1].lookId).toBe("L1");
    expect(out.packItemIds).toEqual(["c", "d", "a", "b"]);
    expect(mergePinned(plan, [])).toBe(plan);
  });

  it("tells the model the saved looks are decided", () => {
    const ctx: TripPlanContext = {
      person: { id: "p", name: "Gennaro" },
      styleNotes: null,
      trip: { id: "t", name: "Lisbon", type: null, startDate: "2026-11-12", endDate: "2026-11-12", notes: null },
      location: null,
      dates: ["2026-11-12"],
      weather: [],
      reservations: [],
      items,
    };
    const { user } = buildTripPrompt(ctx, { capacity: "CARRY_ON", activities: [], pinned: [{ ...saved, itemIds: [items[0].id, items[1].id] }] });
    expect(user).toContain(`Already decided (saved looks; keep them exactly as they are):\n- 2026-11-12 · Dinner (Dinner): [${items[0].id}]`);
    expect(user).toContain("Don't return these looks");
  });
});

// ── Picked pieces, review and mix-and-match ────────────────────────────────

describe("picked pieces", () => {
  const closet = [
    { id: "tee", category: "T-Shirts", name: "Supima tee", quantity: 4 },
    { id: "tee2", category: "T-Shirts", name: "Pocket tee" },
    { id: "jeans", category: "Jeans", name: "Selvedge" },
    { id: "boots", category: "Shoes", name: "Boots" },
    { id: "rain", category: "Outerwear", name: "Rain shell" },
  ];
  const ctx: TripPlanContext = {
    person: { id: "p", name: "Gennaro" },
    styleNotes: null,
    trip: { id: "t", name: "Seattle", type: "LEISURE", startDate: "2026-12-01", endDate: "2026-12-04", notes: null },
    location: null,
    dates: ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"],
    weather: [],
    reservations: [],
    items: closet,
  };
  const picks = { itemIds: ["tee", "jeans", "boots", "tee2"], copies: { tee: 3 } };

  it("counts copies by category", () => {
    const chosen = closet.filter((i) => picks.itemIds.includes(i.id));
    const counts = categoryCounts(chosen, (i) => pickedCopies(i, picks));
    expect(counts).toEqual([["T-Shirts", 4], ["Jeans", 1], ["Shoes", 1]]);
    expect(categoryCountsLabel(counts)).toBe("4 T-Shirts · 1 Jeans · 1 Shoes");
    // Copies never go past what's owned, nor below 1.
    expect(pickedCopies({ id: "tee", quantity: 4 }, { itemIds: ["tee"], copies: { tee: 9 } })).toBe(4);
    expect(pickedCopies({ id: "tee2" }, picks)).toBe(1);
    expect(packCount({ id: "tee", quantity: 4 }, [], picks)).toBe(3);
  });

  it("tells the model the picks, with counts and copies, and asks for a review", () => {
    const { system, user } = buildTripPrompt(ctx, { capacity: "CARRY_ON", activities: [], picked: picks });
    expect(system).toMatch(/already chose what to pack/);
    expect(system).toMatch(/say so in `review`/);
    expect(user).toMatch(/Picked to pack \(6 pieces: 4 T-Shirts, 1 Jeans, 1 Shoes\)/);
    expect(user).toMatch(/\[tee\] T-Shirts \| Supima tee \| packing 3 copies/);
    expect(user).toMatch(/include `review`/);
  });

  it("asks for mix-and-match looks when not per day", () => {
    expect(buildTripPrompt(ctx, { capacity: "CARRY_ON", activities: [], perDay: false }).system).toMatch(/Don't plan day by day/);
    expect(buildTripPrompt(ctx, { capacity: "CARRY_ON", activities: [] }).system).toMatch(/Plan one look per day/);
  });

  it("keeps looks to the picks, packs exactly the picks, and cleans up the review", () => {
    const raw = {
      packItemIds: ["rain", "tee"],
      looks: [
        { date: "2026-12-01", title: "Travel", itemIds: ["tee", "jeans", "boots", "rain"] },
        { title: "Mix 1", itemIds: ["tee2", "rain"] }, // only one picked piece left: dropped
      ],
      review: {
        verdict: "GAPS",
        summary: "Good base, but Seattle is wet.",
        concerns: ["No rain layer", "  "],
        add: [{ itemId: "rain", why: "Rain most days" }, { itemId: "tee", why: "already picked" }, { itemId: "ghost" }],
        leaveHome: [{ itemId: "tee2", why: "Four tees is plenty" }, { itemId: "rain" }],
      },
    };
    const plan = parseTripPlan(raw, ctx, picks);
    expect(plan.looks).toHaveLength(1);
    expect(plan.looks[0].itemIds).toEqual(["tee", "jeans", "boots"]);
    expect(plan.packItemIds).toEqual(["tee", "jeans", "boots", "tee2"]);
    expect(plan.review).toEqual({
      verdict: "GAPS",
      summary: "Good base, but Seattle is wet.",
      concerns: ["No rain layer"],
      add: [{ itemId: "rain", why: "Rain most days" }],
      leaveHome: [{ itemId: "tee2", why: "Four tees is plenty" }],
    });
    // No review back still reads as one; a stylist plan has none.
    expect(parseTripPlan({ looks: [] }, ctx, picks).review?.summary).toMatch(/No review came back/);
    expect(parseTripPlan(raw, ctx).review).toBeUndefined();
  });

  it("reads picks off the plan row", () => {
    expect(picksOf({ pickedItemIds: ["a", null, "b"], pickedCopies: '{"a":2}' })).toEqual({ itemIds: ["a", "b"], copies: { a: 2 } });
  });
});
