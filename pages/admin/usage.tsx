"use client";

// How the household uses the web and phone apps: page / screen opens logged
// by lib/usage.ts, summarized by get_usage_report.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Select, SelectItem } from "@heroui/select";
import { Tab, Tabs } from "@heroui/tabs";
import { FaArrowLeft } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { ACCOUNT_LINKS, NAV_SECTIONS } from "@/config/nav";
import { callOp } from "@/lib/ops-client";
import type { OpOutput } from "@/lib/ops/registry";

const client = generateClient({ authMode: "userPool" });

type Report = OpOutput<"get_usage_report">;
type ScreenRow = Report["screens"][number];

const PERIODS = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "Year" },
];

/** Every page in the sidebar, by route. */
const NAV_PAGES: Array<{ name: string; href: string }> = [
  { name: "Home", href: "/" },
  ...NAV_SECTIONS.flatMap((s) => s.items.map((i) => ({ name: i.name, href: i.href }))),
  ...ACCOUNT_LINKS.map((i) => ({ name: i.name, href: i.href })),
].filter((p, i, all) => all.findIndex((q) => q.href === p.href) === i);

const NAV_NAME = new Map(NAV_PAGES.map((p) => [p.href, p.name]));

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return `today ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <Card shadow="sm">
      <CardBody className="px-4 py-3">
        <p className="text-xs text-default-500">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-default-400">{hint}</p>}
      </CardBody>
    </Card>
  );
}

/** Views per day: one series, one hue, a tooltip on hover or tap. */
function DailyChart({ days, from, to }: { days: Report["days"]; from: string; to: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    const out: Report["days"] = [];
    for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      out.push(byDay.get(day) ?? { day, views: 0, visits: 0, people: 0 });
    }
    return out;
  }, [days, from, to]);
  const max = Math.max(1, ...series.map((d) => d.views));
  const shown = hover != null ? series[hover] : null;
  const label = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div>
      <div className="h-6 text-xs text-default-500">
        {shown ? (
          <span>
            <span className="font-medium text-foreground">{label(shown.day)}</span> · {shown.views} views · {shown.visits} visits · {shown.people} {shown.people === 1 ? "person" : "people"}
          </span>
        ) : (
          <span>Hover a day for its numbers</span>
        )}
      </div>
      <div className="flex items-end h-36 border-b border-default-200" style={{ gap: series.length > 120 ? 0 : 2 }} onMouseLeave={() => setHover(null)}>
        {series.map((d, i) => (
          <div key={d.day} className="flex-1 h-full flex items-end cursor-default" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
            <div
              className={`w-full rounded-t-[4px] ${hover === i ? "bg-primary-600" : "bg-primary-400"}`}
              style={{ height: d.views ? `${Math.max(2, (d.views / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-default-400 mt-1">
        <span>{label(series[0]?.day ?? from)}</span>
        <span>{label(series[series.length - 1]?.day ?? to)}</span>
      </div>
    </div>
  );
}

function ScreenTable({ rows, title, nameOf }: { rows: ScreenRow[]; title: string; nameOf?: (screen: string) => string | undefined }) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...rows.map((r) => r.views));
  const list = all ? rows : rows.slice(0, 15);
  return (
    <Card shadow="sm">
      <CardHeader className="px-4 pt-4 pb-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="ml-2 text-xs text-default-400">{rows.length}</span>
      </CardHeader>
      <CardBody className="px-4 pb-4 pt-1">
        {rows.length === 0 && <p className="text-sm text-default-400">Nothing yet.</p>}
        <div className="space-y-2">
          {list.map((r) => {
            const name = nameOf?.(r.screen);
            return (
              <div key={r.screen}>
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium truncate">{name ?? r.screen}</span>
                  {name && <span className="text-xs text-default-400 truncate">{r.screen}</span>}
                  <span className="ml-auto tabular-nums">{r.views}</span>
                </div>
                <div className="h-1.5 rounded-full bg-default-100 mt-1">
                  <div className="h-1.5 rounded-full bg-primary-400" style={{ width: `${(r.views / max) * 100}%` }} />
                </div>
                <p className="text-[11px] text-default-400 mt-0.5">
                  {r.people.map((p) => `${p.name} ${p.views}`).join(" · ")} · last {when(r.lastSeen)}
                </p>
              </div>
            );
          })}
        </div>
        {rows.length > 15 && (
          <Button size="sm" variant="light" className="mt-2 self-start" onPress={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </Button>
        )}
      </CardBody>
    </Card>
  );
}

export default function UsagePage() {
  const router = useRouter();
  const [period, setPeriod] = useState("30");
  const [person, setPerson] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [names, setNames] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await callOp(client, "get_usage_report", { days: Number(period), ...(person ? { personName: person } : {}) });
    if ("error" in r) setError(r.error);
    else {
      setReport(r.result);
      if (!person) setNames(r.result.people.map((p) => p.name));
    }
    setLoading(false);
  }, [period, person]);

  useEffect(() => {
    void load();
  }, [load]);

  const web = report?.screens.filter((s) => s.kind === "web") ?? [];
  const phone = report?.screens.filter((s) => s.kind === "phone") ?? [];
  const unused = useMemo(() => {
    const seen = new Set(web.map((s) => s.screen));
    return NAV_PAGES.filter((p) => !seen.has(p.href));
  }, [web]);

  return (
    <DefaultLayout>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
            <FaArrowLeft />
          </Button>
          <h1 className="text-2xl font-bold">Usage</h1>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Tabs size="sm" selectedKey={period} onSelectionChange={(k) => setPeriod(String(k))} aria-label="Period">
              {PERIODS.map((p) => (
                <Tab key={p.key} title={p.label} />
              ))}
            </Tabs>
            <Select
              size="sm"
              aria-label="Person"
              className="w-40"
              selectedKeys={[person || "all"]}
              onSelectionChange={(keys) => {
                const k = Array.from(keys)[0] as string | undefined;
                setPerson(!k || k === "all" ? "" : k);
              }}
            >
              {[<SelectItem key="all">Everyone</SelectItem>, ...names.map((n) => <SelectItem key={n}>{n}</SelectItem>)]}
            </Select>
          </div>
        </div>
        <p className="text-xs text-default-500">
          Every page or screen opened on the web and the phone app. A visit is a run of use with no 30-minute break. Kept for a year.
        </p>

        {error && <p className="text-sm text-danger">{error}</p>}
        {loading && !report && <p className="text-center text-default-400 py-6">Loading…</p>}

        {report && (
          <div className={`space-y-4 ${loading ? "opacity-60" : ""}`}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Views" value={report.views} />
              <Stat label="Visits" value={report.visits} />
              <Stat label="Active days" value={report.activeDays} hint={`of ${PERIODS.find((p) => p.key === period)?.label.toLowerCase()}`} />
              <Stat label="Pages never opened" value={unused.length} hint={`of ${NAV_PAGES.length} in the sidebar`} />
            </div>

            <Card shadow="sm">
              <CardHeader className="px-4 pt-4 pb-1">
                <h2 className="text-base font-semibold">Views per day</h2>
              </CardHeader>
              <CardBody className="px-4 pb-4 pt-1">
                <DailyChart days={report.days} from={report.from} to={report.to} />
              </CardBody>
            </Card>

            <Card shadow="sm">
              <CardHeader className="px-4 pt-4 pb-1">
                <h2 className="text-base font-semibold">People</h2>
              </CardHeader>
              <CardBody className="px-4 pb-4 pt-1 overflow-x-auto">
                {report.people.length === 0 ? (
                  <p className="text-sm text-default-400">Nothing logged in this period yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-default-500">
                        <th className="py-1 pr-3 font-medium">Person</th>
                        <th className="py-1 pr-3 font-medium text-right">Views</th>
                        <th className="py-1 pr-3 font-medium text-right">Visits</th>
                        <th className="py-1 pr-3 font-medium text-right">Web</th>
                        <th className="py-1 pr-3 font-medium text-right">iPhone</th>
                        <th className="py-1 pr-3 font-medium text-right">Android</th>
                        <th className="py-1 font-medium">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.people.map((p) => (
                        <tr key={p.username} className="border-t border-default-100">
                          <td className="py-1.5 pr-3 font-medium">{p.name}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{p.views}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{p.visits}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{p.web}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{p.ios}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{p.android}</td>
                          <td className="py-1.5 text-default-500">{when(p.lastSeen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardBody>
            </Card>

            <div className="grid md:grid-cols-2 gap-4">
              <ScreenTable title="Web pages" rows={web} nameOf={(s) => NAV_NAME.get(s)} />
              <ScreenTable title="Phone screens" rows={phone} />
            </div>

            {unused.length > 0 && (
              <Card shadow="sm">
                <CardHeader className="px-4 pt-4 pb-1">
                  <h2 className="text-base font-semibold">Sidebar pages nobody opened</h2>
                  <span className="ml-2 text-xs text-default-400">{person ? `by ${person}, ` : ""}on the web, in this period</span>
                </CardHeader>
                <CardBody className="px-4 pb-4 pt-1">
                  <div className="flex flex-wrap gap-2">
                    {unused.map((p) => (
                      <Button key={p.href} size="sm" variant="flat" onPress={() => router.push(p.href)}>
                        {p.name}
                      </Button>
                    ))}
                  </div>
                </CardBody>
              </Card>
            )}
          </div>
        )}
      </div>
    </DefaultLayout>
  );
}
