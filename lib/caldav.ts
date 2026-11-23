// Minimal CalDAV client for two-way calendar feeds (iCloud): discover the
// account's calendars, read every event in one, and write or delete one.
// Server-side only (Basic auth with an app-specific password from Secrets
// Manager, `CALDAV_SECRET_NAME`). No XML library: multistatus responses are
// read with a namespace-agnostic scan, which is all these few calls need.

export const CALDAV_SECRET_NAME = "home-hub/icloud-caldav";
export const ICLOUD_CALDAV_ROOT = "https://caldav.icloud.com/";

export interface CaldavCreds {
  username: string;
  password: string;
}

export interface CaldavCalendar {
  url: string;
  name: string;
  /** False when the account can only read it (a calendar shared read-only). */
  writable: boolean;
}

export interface CaldavObject {
  url: string;
  etag: string | null;
  ics: string;
}

export class CaldavError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function authHeader(c: CaldavCreds): string {
  return "Basic " + Buffer.from(`${c.username}:${c.password}`).toString("base64");
}

async function dav(c: CaldavCreds, method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(c),
      ...(body ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
      ...headers,
    },
    body,
    redirect: "follow",
  });
  return res;
}

function decodeXml(s: string): string {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  if (cdata) return cdata[1];
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Inner text of every <tag> (any namespace prefix) in `xml`. */
function tags(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`, "gi");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

const first = (xml: string, tag: string) => tags(xml, tag)[0];

/** One entry per <response>: its href and, from the 200 propstat only, the props' raw XML. */
export function parseMultistatus(xml: string): Array<{ href: string; props: string }> {
  return tags(xml, "response").map((r) => {
    const ok = tags(r, "propstat").filter((p) => /\b200\b/.test(first(p, "status") ?? ""));
    return { href: decodeXml((first(r, "href") ?? "").trim()), props: ok.map((p) => first(p, "prop") ?? "").join("") };
  });
}

async function propfind(c: CaldavCreds, url: string, depth: "0" | "1", props: string): Promise<{ base: string; entries: Array<{ href: string; props: string }> }> {
  const res = await dav(c, "PROPFIND", url, `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${props}</d:prop></d:propfind>`, { Depth: depth });
  if (res.status === 401) throw new CaldavError("CalDAV sign-in refused (check the Apple ID and app-specific password)", 401);
  if (res.status !== 207) throw new CaldavError(`PROPFIND ${url}: ${res.status}`, res.status);
  return { base: res.url || url, entries: parseMultistatus(await res.text()) };
}

/** Every calendar collection (VEVENT-capable) on the account. */
export async function listCalendars(c: CaldavCreds, root = ICLOUD_CALDAV_ROOT): Promise<CaldavCalendar[]> {
  const p = await propfind(c, root, "0", "<d:current-user-principal/>");
  const principalHref = first(p.entries[0]?.props ?? "", "href");
  if (!principalHref) throw new CaldavError("CalDAV: no current-user-principal", 0);
  const principal = new URL(decodeXml(principalHref.trim()), p.base).toString();
  const h = await propfind(c, principal, "0", "<c:calendar-home-set/>");
  const homeHref = first(first(h.entries[0]?.props ?? "", "calendar-home-set") ?? "", "href");
  if (!homeHref) throw new CaldavError("CalDAV: no calendar-home-set", 0);
  const home = new URL(decodeXml(homeHref.trim()), h.base).toString();
  const list = await propfind(c, home, "1", "<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:current-user-privilege-set/>");
  const out: CaldavCalendar[] = [];
  for (const e of list.entries) {
    const rt = first(e.props, "resourcetype") ?? "";
    if (!/calendar\b/i.test(rt.replace(/calendar-home/gi, ""))) continue;
    const comps = first(e.props, "supported-calendar-component-set");
    if (comps && !/VEVENT/i.test(comps)) continue;
    const privs = first(e.props, "current-user-privilege-set");
    out.push({
      url: new URL(e.href, list.base).toString(),
      name: decodeXml((first(e.props, "displayname") ?? "").trim()) || e.href,
      writable: !privs || /<(?:[\w-]+:)?(write|write-content|all)\b/i.test(privs),
    });
  }
  return out;
}

/** Every event object in a calendar, with its etag. */
export async function fetchCalendarObjects(c: CaldavCreds, calendarUrl: string): Promise<CaldavObject[]> {
  const body =
    '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    "<d:prop><d:getetag/><c:calendar-data/></d:prop>" +
    '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>';
  const res = await dav(c, "REPORT", calendarUrl, body, { Depth: "1" });
  if (res.status === 401) throw new CaldavError("CalDAV sign-in refused (check the Apple ID and app-specific password)", 401);
  if (res.status === 404) throw new CaldavError(`Calendar not found at ${calendarUrl} (deleted or unshared?)`, 404);
  if (res.status !== 207) throw new CaldavError(`REPORT ${calendarUrl}: ${res.status}`, res.status);
  const base = res.url || calendarUrl;
  const out: CaldavObject[] = [];
  for (const e of parseMultistatus(await res.text())) {
    const data = first(e.props, "calendar-data");
    if (!data) continue;
    out.push({ url: new URL(e.href, base).toString(), etag: normEtag(first(e.props, "getetag")), ics: decodeXml(data) });
  }
  return out;
}

function normEtag(v: string | null | undefined): string | null {
  const s = v ? decodeXml(v.trim()) : "";
  return s || null;
}

/** One object, or null when it's gone. */
export async function getObject(c: CaldavCreds, url: string): Promise<CaldavObject | null> {
  const res = await dav(c, "GET", url);
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new CaldavError(`GET ${url}: ${res.status}`, res.status);
  return { url, etag: normEtag(res.headers.get("etag")), ics: await res.text() };
}

/**
 * Create (`ifMatch` null: fails with 412 if it exists) or replace (fails
 * with 412 if someone changed it since `ifMatch`). Returns the new etag
 * when the server sends one.
 */
export async function putObject(c: CaldavCreds, url: string, ics: string, ifMatch: string | null): Promise<string | null> {
  const res = await dav(c, "PUT", url, ics, {
    "Content-Type": "text/calendar; charset=utf-8",
    ...(ifMatch ? { "If-Match": ifMatch } : { "If-None-Match": "*" }),
  });
  if (!res.ok) throw new CaldavError(`PUT ${url}: ${res.status}`, res.status);
  return normEtag(res.headers.get("etag"));
}

/** Delete; an object that's already gone is fine. */
export async function deleteObject(c: CaldavCreds, url: string): Promise<void> {
  const res = await dav(c, "DELETE", url);
  if (res.ok || res.status === 404 || res.status === 410) return;
  throw new CaldavError(`DELETE ${url}: ${res.status}`, res.status);
}

/** Where a new event goes: `<calendar>/<uid>.ics`. */
export function objectUrl(calendarUrl: string, uid: string): string {
  return calendarUrl.replace(/\/?$/, "/") + encodeURIComponent(uid) + ".ics";
}
