import { describe, expect, it } from "vitest";
import {
  MAX_TRIP_DAYS,
  buildTripPrompt,
  capacityRule,
  fetchTripWeather,
  packCount,
  parseTripPlan,
  resolveTripLocation,
  sameDayYearsAgo,
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
});
