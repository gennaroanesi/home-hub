import { describe, expect, it } from "vitest";
import {
  addDaysYmd,
  categoriesFor,
  dayBoundsUtc,
  isDarkHex,
  isWearable,
  makeMain,
  recentlyWorn,
  slugify,
  DEFAULT_CATEGORIES,
} from "./wardrobe";
import {
  buildSuggestPrompt,
  describeWeather,
  fetchDayWeather,
  parseSuggestions,
  type SuggestContext,
} from "./wardrobe-suggest";

describe("categoriesFor", () => {
  it("falls back to the defaults without a profile", () => {
    expect(categoriesFor(null, [])).toEqual(DEFAULT_CATEGORIES);
  });
  it("keeps profile order and appends categories only items use", () => {
    expect(categoriesFor(["Golf", "Tops"], [{ category: "tops" }, { category: "Hats" }])).toEqual(["Golf", "Tops", "Hats"]);
  });
});

describe("photos", () => {
  it("makeMain moves the chosen photo to the front", () => {
    expect(makeMain(["a", "b", "c"], 2)).toEqual(["c", "a", "b"]);
    expect(makeMain(["a", "b"], 0)).toEqual(["a", "b"]);
  });
});

describe("status + wear history", () => {
  it("only owned, non-retired items are wearable", () => {
    expect(isWearable({ status: "KEEP" })).toBe(true);
    expect(isWearable({ status: null })).toBe(true);
    expect(isWearable({ status: "TAILOR" })).toBe(true);
    expect(isWearable({ status: "RETIRE" })).toBe(false);
    expect(isWearable({ status: "WISHLIST" })).toBe(false);
  });
  it("recentlyWorn returns ids since a date, newest first, deduped", () => {
    const wears = [
      { date: "2026-10-20", itemIds: ["old"] },
      { date: "2026-10-25", itemIds: ["a", "b"] },
      { date: "2026-10-26", itemIds: ["b", "c"] },
    ];
    expect(recentlyWorn(wears, "2026-10-24")).toEqual(["b", "c", "a"]);
  });
});

describe("dates", () => {
  it("addDaysYmd crosses month ends", () => {
    expect(addDaysYmd("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysYmd("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("dayBoundsUtc uses the local day in the timezone (CDT and CST)", () => {
    expect(dayBoundsUtc("2026-10-26", "America/Chicago").start.toISOString()).toBe("2026-10-26T05:00:00.000Z");
    expect(dayBoundsUtc("2026-12-01", "America/Chicago").start.toISOString()).toBe("2026-12-01T06:00:00.000Z");
  });
});

describe("misc", () => {
  it("slugify", () => expect(slugify("Air Force 1 '07 LV8")).toBe("air-force-1-07-lv8"));
  it("isDarkHex", () => {
    expect(isDarkHex("#1f2a44")).toBe(true);
    expect(isDarkHex("#efe6d8")).toBe(false);
  });
});

const ctx: SuggestContext = {
  person: { id: "p1", name: "Gennaro" },
  styleNotes: "No black on top.",
  date: "2026-10-26",
  timezone: "America/Chicago",
  items: [
    { id: "top", category: "Knitwear", name: "Cashmere crew", color: "Navy", colorHex: "#1f2a44" },
    { id: "pant", category: "Pants", name: "Flannel", color: "Grey" },
    { id: "shoe", category: "Shoes", name: "Lodge boot", color: "Chestnut" },
  ],
  wishlist: [{ id: "wish", category: "Outerwear", name: "Barbour Ashby", status: "WISHLIST" }],
  recentlyWornIds: ["pant"],
  events: [{ title: "Board review", startAt: "2026-10-26T15:00:00Z" }],
  weather: { highF: 68, lowF: 51, precipChance: 40, summary: "Showers" },
};

describe("suggester prompt + parsing", () => {
  it("prompt carries the brief, weather, calendar, recent wears and ids", () => {
    const { system, user } = buildSuggestPrompt(ctx, { occasion: "office", request: null, count: 2 });
    expect(system).toContain("No black on top.");
    expect(user).toContain("high 68°F");
    expect(user).toContain("40% chance of rain");
    expect(user).toContain("Board review");
    expect(user).toContain("Recently worn (avoid): pant");
    expect(user).toContain("[top]");
    expect(user).toContain("Wishlist (not owned yet)");
    expect(user).toContain("Propose 2 outfits");
  });

  it("drops invented ids, duplicates and outfits that end up too small", () => {
    const raw = {
      outfits: [
        { title: "Navy over grey", itemIds: ["top", "pant", "wish", "shoe", "top", "ghost"], why: "x" },
        { title: "Too small", itemIds: ["top", "ghost"], why: "y" },
        { title: "Nothing owned", itemIds: ["wish", "ghost", "wish"], why: "z" },
        { title: "", itemIds: ["pant", "shoe"] },
      ],
    };
    const out = parseSuggestions(raw, ctx, 5);
    expect(out).toHaveLength(2);
    expect(out[0].itemIds).toEqual(["top", "pant", "wish", "shoe"]);
    expect(out[0].wishlistItemIds).toEqual(["wish"]);
    expect(out[1].title).toBe("Outfit");
    expect(out[1].wishlistItemIds).toEqual([]);
  });

  it("caps at the requested count and tolerates garbage", () => {
    expect(parseSuggestions(null, ctx, 3)).toEqual([]);
    const many = { outfits: Array.from({ length: 5 }, () => ({ title: "t", itemIds: ["top", "pant"] })) };
    expect(parseSuggestions(many, ctx, 2)).toHaveLength(2);
  });
});

describe("weather", () => {
  it("parses an Open-Meteo daily response", async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          daily: { temperature_2m_max: [71.6], temperature_2m_min: [52.2], precipitation_probability_max: [10], weather_code: [2] },
        }),
      )) as unknown as typeof fetch;
    const w = await fetchDayWeather("2026-10-26", "America/Chicago", undefined, fake);
    expect(w).toEqual({ highF: 72, lowF: 52, precipChance: 10, summary: "Partly cloudy" });
    expect(describeWeather(w)).toBe("Partly cloudy, high 72°F / low 52°F");
  });
  it("returns null when the API fails", async () => {
    const fail = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchDayWeather("2026-10-26", "America/Chicago", undefined, fail)).toBeNull();
  });
});
