// /wardrobe URL <-> page state, so a refresh or a shared link lands on the
// same person, view and filters.
//
//   /wardrobe/<personId>/closet?cat=Golf&status=all&q=navy&inlook=yes
//   /wardrobe/<personId>/looks?occasion=golf&tryon=1&q=brown
//   /wardrobe/<personId>/suggest
//
// Defaults are left out of the query. Pure, no router access.

import { WARDROBE_STATUSES, type WardrobeStatus } from "./wardrobe";

export type WardrobeView = "CLOSET" | "LOOKS" | "SUGGEST";
export type StatusFilter = WardrobeStatus | "OWNED" | "";

export interface WardrobeRoute {
  personId: string; // "" when the URL doesn't name one
  view: WardrobeView;
  // Closet
  category: string;
  status: StatusFilter; // "OWNED" (default) = wearing; "" = everything
  search: string;
  inLook: "" | "YES" | "NO";
  // Looks
  lookSearch: string;
  lookOccasion: string; // lowercased occasion key
  lookTryOn: boolean;
}

export const DEFAULT_WARDROBE_ROUTE: WardrobeRoute = {
  personId: "",
  view: "CLOSET",
  category: "",
  status: "OWNED",
  search: "",
  inLook: "",
  lookSearch: "",
  lookOccasion: "",
  lookTryOn: false,
};

const VIEW_SLUG: Record<WardrobeView, string> = { CLOSET: "closet", LOOKS: "looks", SUGGEST: "suggest" };

type Query = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

/** `slug` is the catch-all segment list after /wardrobe. */
export function parseWardrobeRoute(slug: string[], query: Query): WardrobeRoute {
  const r: WardrobeRoute = { ...DEFAULT_WARDROBE_ROUTE };
  // Old ?person=<id> links still work.
  r.personId = slug[0] ?? one(query.person);
  const v = (slug[1] ?? "").toLowerCase();
  r.view = (Object.keys(VIEW_SLUG) as WardrobeView[]).find((k) => VIEW_SLUG[k] === v) ?? "CLOSET";

  if (r.view === "CLOSET") {
    r.category = one(query.cat);
    const s = one(query.status).toUpperCase();
    if (s === "ALL") r.status = "";
    else if ((WARDROBE_STATUSES as readonly string[]).includes(s)) r.status = s as WardrobeStatus;
    r.search = one(query.q);
    const il = one(query.inlook).toLowerCase();
    r.inLook = il === "yes" ? "YES" : il === "no" ? "NO" : "";
  } else if (r.view === "LOOKS") {
    r.lookSearch = one(query.q);
    r.lookOccasion = one(query.occasion).toLowerCase();
    r.lookTryOn = one(query.tryon) === "1";
  }
  return r;
}

export function wardrobeHref(r: WardrobeRoute): string {
  if (!r.personId) return "/wardrobe";
  const p = new URLSearchParams();
  if (r.view === "CLOSET") {
    if (r.category) p.set("cat", r.category);
    if (r.status === "") p.set("status", "all");
    else if (r.status !== "OWNED") p.set("status", r.status.toLowerCase());
    if (r.search.trim()) p.set("q", r.search.trim());
    if (r.inLook) p.set("inlook", r.inLook.toLowerCase());
  } else if (r.view === "LOOKS") {
    if (r.lookSearch.trim()) p.set("q", r.lookSearch.trim());
    if (r.lookOccasion) p.set("occasion", r.lookOccasion);
    if (r.lookTryOn) p.set("tryon", "1");
  }
  const qs = p.toString();
  return `/wardrobe/${encodeURIComponent(r.personId)}/${VIEW_SLUG[r.view]}${qs ? `?${qs}` : ""}`;
}
