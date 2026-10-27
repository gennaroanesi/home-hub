import { describe, expect, it } from "vitest";
import { DEFAULT_WARDROBE_ROUTE, parseWardrobeRoute, wardrobeHref, type WardrobeRoute } from "./wardrobe-route";

const route = (r: Partial<WardrobeRoute>): WardrobeRoute => ({ ...DEFAULT_WARDROBE_ROUTE, personId: "p1", ...r });

describe("wardrobe route", () => {
  it("leaves defaults out of the URL", () => {
    expect(wardrobeHref(route({}))).toBe("/wardrobe/p1/closet");
    expect(wardrobeHref(route({ view: "SUGGEST", search: "ignored" }))).toBe("/wardrobe/p1/suggest");
    expect(wardrobeHref({ ...DEFAULT_WARDROBE_ROUTE })).toBe("/wardrobe");
  });

  it("round-trips closet filters", () => {
    const r = route({ category: "Golf", status: "", search: "navy polo", inLook: "NO" });
    const href = wardrobeHref(r);
    expect(href).toBe("/wardrobe/p1/closet?cat=Golf&status=all&q=navy+polo&inlook=no");
    const u = new URL(href, "http://x");
    expect(parseWardrobeRoute(u.pathname.split("/").slice(2), Object.fromEntries(u.searchParams))).toEqual(r);
  });

  it("round-trips looks filters and keeps closet filters out", () => {
    const r = route({ view: "LOOKS", lookSearch: "brown", lookOccasion: "golf", lookTryOn: true });
    const href = wardrobeHref({ ...r, category: "Golf" });
    expect(href).toBe("/wardrobe/p1/looks?q=brown&occasion=golf&tryon=1");
    const u = new URL(href, "http://x");
    expect(parseWardrobeRoute(u.pathname.split("/").slice(2), Object.fromEntries(u.searchParams))).toEqual(r);
  });

  it("tolerates bad input and old ?person= links", () => {
    expect(parseWardrobeRoute([], { person: "p9" })).toEqual({ ...DEFAULT_WARDROBE_ROUTE, personId: "p9" });
    const r = parseWardrobeRoute(["p1", "nope"], { status: "bogus", inlook: "maybe", tryon: "1" });
    expect(r).toEqual(route({}));
    expect(parseWardrobeRoute(["p1", "Closet"], { status: "wishlist" }).status).toBe("WISHLIST");
  });
});
