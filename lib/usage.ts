// Page / screen usage, web and phone. The apps log one homeUsageEvent per
// page or screen opened (createUsageLogger: queued, sent in the background,
// never on the navigation path); get_usage_report (lib/ops/usage.ts) reads
// them back and summarizeUsage turns them into the /admin/usage numbers.
// Shared by the web app, the mobile app and the ops Lambda.

export type UsagePlatform = "WEB" | "IOS" | "ANDROID";

export type UsageRow = {
  username: string;
  platform: UsagePlatform;
  screen: string;
  at: string; // ISO
  month: string; // "2026-11", UTC
  expiresAt: number; // epoch seconds (DynamoDB TTL)
};

export const USAGE_RETENTION_DAYS = 365;
/** Opens of the same screen closer than this are one (a re-render, a double tap). */
const REPEAT_MS = 3000;
/** Quiet time before a visit ends: the next event starts a new one. */
export const VISIT_GAP_MIN = 30;

export function usageRow(username: string, platform: UsagePlatform, screen: string, at: Date): UsageRow {
  const iso = at.toISOString();
  return { username, platform, screen, at: iso, month: iso.slice(0, 7), expiresAt: Math.floor(at.getTime() / 1000) + USAGE_RETENTION_DAYS * 86400 };
}

/** "/(tabs)/more/inventory/[id]" segments → "/more/inventory/[id]": expo-router groups dropped. */
export function screenFromSegments(segments: readonly string[]): string {
  const parts = segments.filter((s) => s && !(s.startsWith("(") && s.endsWith(")")) && s !== "index");
  return "/" + parts.join("/");
}

export const CREATE_USAGE_EVENT = /* GraphQL */ `
  mutation CreateHomeUsageEvent($input: CreateHomeUsageEventInput!) {
    createHomeUsageEvent(input: $input) { id }
  }
`;

export type UsageLogger = { track(screen: string): void; flush(): Promise<void> };

/**
 * Queues screen opens and sends them in batches: after `flushMs` of the
 * first queued one, at 20 queued, or when the caller flushes (the page is
 * hidden, the app goes to the background). Failures are dropped: usage is
 * best effort and must never surface to the person using the app.
 */
export function createUsageLogger(opts: {
  platform: UsagePlatform;
  /** The signed-in Cognito username, or null (signed out: nothing is logged). */
  getUsername: () => Promise<string | null>;
  send: (rows: UsageRow[]) => Promise<void>;
  flushMs?: number;
  now?: () => Date;
}): UsageLogger {
  const now = opts.now ?? (() => new Date());
  let queue: Array<{ screen: string; at: Date }> = [];
  let last: { screen: string; ms: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    try {
      const username = await opts.getUsername();
      if (!username) return;
      await opts.send(batch.map((e) => usageRow(username, opts.platform, e.screen, e.at)));
    } catch {
      // best effort
    }
  }

  return {
    track(screen: string) {
      const at = now();
      if (last && last.screen === screen && at.getTime() - last.ms < REPEAT_MS) return;
      last = { screen, ms: at.getTime() };
      queue.push({ screen, at });
      if (queue.length >= 20) void flush();
      else if (!timer) timer = setTimeout(() => void flush(), opts.flushMs ?? 15000);
    },
    flush,
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

export type UsageEventLike = { username: string; platform?: string | null; screen: string; at: string };

export type UsageReport = {
  views: number;
  visits: number;
  activeDays: number;
  people: Array<{ username: string; name: string; views: number; visits: number; web: number; ios: number; android: number; lastSeen: string }>;
  screens: Array<{ screen: string; kind: "web" | "phone"; views: number; people: Array<{ name: string; views: number }>; lastSeen: string }>;
  days: Array<{ day: string; views: number; visits: number; people: number }>;
};

const kindOf = (platform?: string | null): "web" | "phone" => (platform === "IOS" || platform === "ANDROID" ? "phone" : "web");

function dayIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/**
 * Events → totals, per person, per screen and per day. A visit is a run of
 * one person's events on one platform with no gap over VISIT_GAP_MIN; it
 * counts on the day it starts. `names`: Cognito username → person name.
 */
export function summarizeUsage(events: UsageEventLike[], opts: { timeZone: string; names: Map<string, string>; from?: string; to?: string }): UsageReport {
  const nameOf = (u: string) => opts.names.get(u) ?? opts.names.get(u.toLowerCase()) ?? u;
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const people = new Map<string, UsageReport["people"][number]>();
  const screens = new Map<string, { screen: string; kind: "web" | "phone"; views: number; by: Map<string, number>; lastSeen: string }>();
  const days = new Map<string, { views: number; visits: number; people: Set<string> }>();
  const lastAt = new Map<string, number>(); // username|kind → ms
  let visits = 0;

  for (const e of sorted) {
    const name = nameOf(e.username);
    const kind = kindOf(e.platform);
    const day = dayIn(e.at, opts.timeZone);
    const ms = Date.parse(e.at);
    const p = people.get(e.username) ?? { username: e.username, name, views: 0, visits: 0, web: 0, ios: 0, android: 0, lastSeen: e.at };
    p.views++;
    if (e.platform === "IOS") p.ios++;
    else if (e.platform === "ANDROID") p.android++;
    else p.web++;
    p.lastSeen = e.at;
    const d = days.get(day) ?? { views: 0, visits: 0, people: new Set<string>() };
    d.views++;
    d.people.add(e.username);
    const key = `${e.username}|${kind}`;
    const prev = lastAt.get(key);
    if (prev == null || ms - prev > VISIT_GAP_MIN * 60000) {
      visits++;
      p.visits++;
      d.visits++;
    }
    lastAt.set(key, ms);
    people.set(e.username, p);
    days.set(day, d);
    const sk = `${kind}|${e.screen}`;
    const s = screens.get(sk) ?? { screen: e.screen, kind, views: 0, by: new Map<string, number>(), lastSeen: e.at };
    s.views++;
    s.by.set(name, (s.by.get(name) ?? 0) + 1);
    s.lastSeen = e.at;
    screens.set(sk, s);
  }

  return {
    views: sorted.length,
    visits,
    activeDays: days.size,
    people: [...people.values()].sort((a, b) => b.views - a.views),
    screens: [...screens.values()]
      .map((s) => ({ screen: s.screen, kind: s.kind, views: s.views, lastSeen: s.lastSeen, people: [...s.by].map(([n, v]) => ({ name: n, views: v })).sort((a, b) => b.views - a.views) }))
      .sort((a, b) => b.views - a.views || a.screen.localeCompare(b.screen)),
    days: [...days].map(([day, d]) => ({ day, views: d.views, visits: d.visits, people: d.people.size })).sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** The months ("2026-11", UTC) an [fromIso, toIso] range touches: one index query each. */
export function monthsBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  let y = Number(fromIso.slice(0, 4));
  let m = Number(fromIso.slice(5, 7));
  const end = toIso.slice(0, 7);
  for (let guard = 0; guard < 400; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= end) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
