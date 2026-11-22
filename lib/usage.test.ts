import { describe, expect, it, vi } from "vitest";
import { createUsageLogger, monthsBetween, screenFromSegments, summarizeUsage, usageRow } from "./usage";

describe("usage", () => {
  it("names screens by route pattern, without expo-router groups", () => {
    expect(screenFromSegments(["(tabs)", "more", "inventory", "[id]"])).toBe("/more/inventory/[id]");
    expect(screenFromSegments(["(tabs)", "index"])).toBe("/");
  });

  it("builds a row with its month partition and a year of retention", () => {
    const r = usageRow("u1", "WEB", "/finance", new Date("2026-11-30T23:30:00Z"));
    expect(r.month).toBe("2026-11");
    expect(r.expiresAt - Math.floor(Date.parse(r.at) / 1000)).toBe(365 * 86400);
  });

  it("lists the months a range touches", () => {
    expect(monthsBetween("2026-11-20T00:00:00Z", "2027-01-02T00:00:00Z")).toEqual(["2026-11", "2026-12", "2027-01"]);
  });

  it("batches opens, drops quick repeats and sends nothing when signed out", async () => {
    vi.useFakeTimers();
    let t = Date.parse("2026-11-21T10:00:00Z");
    const sent: string[][] = [];
    const log = createUsageLogger({ platform: "IOS", getUsername: async () => "u1", send: async (rows) => void sent.push(rows.map((r) => r.screen)), now: () => new Date(t), flushMs: 1000 });
    log.track("/");
    t += 500;
    log.track("/"); // re-render
    t += 5000;
    log.track("/more/finance");
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([["/", "/more/finance"]]);
    const out = createUsageLogger({ platform: "WEB", getUsername: async () => null, send: async () => void sent.push(["nope"]) });
    out.track("/x");
    await out.flush();
    expect(sent).toHaveLength(1);
    vi.useRealTimers();
  });

  it("counts visits by a 30-minute gap per person and platform, and days in the household timezone", () => {
    const ev = (username: string, platform: string, screen: string, at: string) => ({ username, platform, screen, at });
    const r = summarizeUsage(
      [
        ev("g", "WEB", "/finance", "2026-11-21T02:00:00Z"), // 20th in Chicago
        ev("g", "WEB", "/finance/transactions", "2026-11-21T02:10:00Z"),
        ev("g", "IOS", "/more/week", "2026-11-21T02:12:00Z"), // phone: its own visit
        ev("g", "WEB", "/finance", "2026-11-21T15:00:00Z"), // later: new visit
        ev("c", "IOS", "/more/week", "2026-11-21T15:05:00Z"),
      ],
      { timeZone: "America/Chicago", names: new Map([["g", "Gennaro"], ["c", "Cris"]]) },
    );
    expect([r.views, r.visits, r.activeDays]).toEqual([5, 4, 2]);
    expect(r.people.map((p) => [p.name, p.views, p.visits, p.web, p.ios])).toEqual([["Gennaro", 4, 3, 3, 1], ["Cris", 1, 1, 0, 1]]);
    expect(r.screens[0]).toMatchObject({ screen: "/finance", kind: "web", views: 2 });
    expect(r.screens.find((s) => s.screen === "/more/week")?.people).toEqual([{ name: "Gennaro", views: 1 }, { name: "Cris", views: 1 }]);
    expect(r.days.map((d) => [d.day, d.views, d.visits, d.people])).toEqual([["2026-11-20", 3, 2, 1], ["2026-11-21", 2, 2, 2]]);
  });
});
