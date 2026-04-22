"use client";

import React, { useMemo, useState, useEffect } from "react";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Checkbox } from "@heroui/checkbox";
import { Button } from "@heroui/button";
import { FaPlus, FaTrash } from "react-icons/fa";

import {
  parseRRULE,
  formatScheduleLabel as sharedFormatScheduleLabel,
} from "@/lib/reminder-schedule";

// Re-export so existing import sites (pages/reminders.tsx) that grab
// formatScheduleLabel from "@/components/schedule-picker" keep working.
// This also lets future consumers pick whichever module feels more
// natural — the picker for UI, the lib for pure logic.
export const formatScheduleLabel = sharedFormatScheduleLabel;

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Schedule modes supported by the picker. These cover the common cases —
 * anything exotic falls to "custom" with a raw RRULE text box.
 */
export type ScheduleMode =
  | "once"
  | "daily"
  | "multiple" // multiple times per day (e.g. supplements 9am + 9pm)
  | "weekly"
  | "monthly"
  | "custom";

/**
 * Stored form of the schedule — exactly one of { firesAt, rrule } is set
 * on the parent reminder item.
 */
export interface ScheduleValue {
  firesAt?: string | null; // ISO datetime for one-shot
  rrule?: string | null; // RRULE string for recurring
}

interface SchedulePickerProps {
  value: ScheduleValue;
  onChange: (next: ScheduleValue) => void;
}

// ── Day-of-week constants ───────────────────────────────────────────────────

const DAYS_OF_WEEK: { key: string; label: string }[] = [
  { key: "SU", label: "Sun" },
  { key: "MO", label: "Mon" },
  { key: "TU", label: "Tue" },
  { key: "WE", label: "Wed" },
  { key: "TH", label: "Thu" },
  { key: "FR", label: "Fri" },
  { key: "SA", label: "Sat" },
];

// ── Mode detection + local time helpers ────────────────────────────────────
// parseRRULE lives in lib/reminder-schedule and handles the wire parse.
// detectMode is UI-specific (deciding which picker to show) so it stays
// here. Same for the HH:MM <-> hour/minute conversions — used only by
// the picker's time inputs.

function detectMode(value: ScheduleValue): ScheduleMode {
  if (value.firesAt) return "once";
  if (!value.rrule) return "once"; // empty state defaults to once
  const p = parseRRULE(value.rrule);
  if (p.freq === "DAILY") {
    const times = p.byhour?.length ?? 0;
    return times > 1 ? "multiple" : "daily";
  }
  if (p.freq === "WEEKLY") return "weekly";
  if (p.freq === "MONTHLY") return "monthly";
  return "custom";
}

function timeStringToHourMinute(t: string): { hour: number; minute: number } {
  const [h, m] = t.split(":").map((x) => parseInt(x, 10));
  return { hour: h || 0, minute: m || 0 };
}

function hourMinuteToTimeString(hour: number, minute: number): string {
  const h = String(hour).padStart(2, "0");
  const m = String(minute).padStart(2, "0");
  return `${h}:${m}`;
}

// ── Component ───────────────────────────────────────────────────────────────

export function SchedulePicker({ value, onChange }: SchedulePickerProps) {
  // Initial mode is derived once from the incoming value. After that, the
  // user drives mode changes via the dropdown — we don't re-derive, so
  // switching back and forth doesn't clobber intermediate state.
  const initialMode = useMemo(() => detectMode(value), []);
  const [mode, setMode] = useState<ScheduleMode>(initialMode);

  // Mode-specific state. Hydrated from the incoming value on mount.
  const [onceDatetime, setOnceDatetime] = useState<string>(() =>
    value.firesAt ? value.firesAt.slice(0, 16) : ""
  );
  const [dailyTime, setDailyTime] = useState<string>(() => {
    if (value.rrule) {
      const p = parseRRULE(value.rrule);
      if (p.byhour?.length === 1) {
        return hourMinuteToTimeString(p.byhour[0], p.byminute?.[0] ?? 0);
      }
    }
    return "08:00";
  });
  const [multipleTimes, setMultipleTimes] = useState<string[]>(() => {
    if (value.rrule) {
      const p = parseRRULE(value.rrule);
      if (p.freq === "DAILY" && (p.byhour?.length ?? 0) > 1) {
        const minute = p.byminute?.[0] ?? 0;
        return (p.byhour ?? []).map((h) => hourMinuteToTimeString(h, minute));
      }
    }
    return ["09:00", "21:00"];
  });
  const [weeklyDays, setWeeklyDays] = useState<Set<string>>(() => {
    if (value.rrule) {
      const p = parseRRULE(value.rrule);
      if (p.byday) return new Set(p.byday);
    }
    return new Set(["MO"]);
  });
  const [weeklyTime, setWeeklyTime] = useState<string>(() => {
    if (value.rrule) {
      const p = parseRRULE(value.rrule);
      if (p.freq === "WEEKLY") {
        return hourMinuteToTimeString(p.byhour?.[0] ?? 8, p.byminute?.[0] ?? 0);
      }
    }
    return "08:00";
  });
  const [monthDay, setMonthDay] = useState<number>(() => {
    if (value.rrule) {
      const p = parseRRULE(value.rrule);
      if (p.bymonthday?.length) return p.bymonthday[0];
    }
    return 1;
  });
  const [monthTime, setMonthTime] = useState<string>(() => {
    if (value.rrule) {
      const p = parseRRULE(value.rrule);
      if (p.freq === "MONTHLY") {
        return hourMinuteToTimeString(p.byhour?.[0] ?? 8, p.byminute?.[0] ?? 0);
      }
    }
    return "08:00";
  });
  const [customRrule, setCustomRrule] = useState<string>(() =>
    value.rrule && detectMode(value) === "custom" ? value.rrule : ""
  );

  // ── Build the output from current state ──
  // Emits a { firesAt, rrule } pair with exactly one side set. This runs
  // on every state change and bubbles up to the parent via onChange.
  useEffect(() => {
    const next = build();
    // Only notify if the output actually changed — prevents an infinite loop
    // when the parent re-renders us with the same value.
    if (next.firesAt !== (value.firesAt ?? null) || next.rrule !== (value.rrule ?? null)) {
      onChange(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    onceDatetime,
    dailyTime,
    multipleTimes,
    weeklyDays,
    weeklyTime,
    monthDay,
    monthTime,
    customRrule,
  ]);

  function build(): ScheduleValue {
    switch (mode) {
      case "once": {
        if (!onceDatetime) return { firesAt: null, rrule: null };
        return { firesAt: new Date(onceDatetime).toISOString(), rrule: null };
      }
      case "daily": {
        const { hour, minute } = timeStringToHourMinute(dailyTime);
        return {
          firesAt: null,
          rrule: `RRULE:FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`,
        };
      }
      case "multiple": {
        const times = multipleTimes.filter((t) => t);
        if (times.length === 0) return { firesAt: null, rrule: null };
        // Group by minute so we can emit one rule when all times share the
        // same minute (the common case — 9:00am + 9:00pm). If minutes
        // differ, fall back to Daily-with-multi-BYHOUR using minute 0.
        const byhour = times.map((t) => timeStringToHourMinute(t).hour);
        const minutes = Array.from(
          new Set(times.map((t) => timeStringToHourMinute(t).minute))
        );
        const minute = minutes.length === 1 ? minutes[0] : 0;
        return {
          firesAt: null,
          rrule: `RRULE:FREQ=DAILY;BYHOUR=${byhour.join(",")};BYMINUTE=${minute}`,
        };
      }
      case "weekly": {
        const days = Array.from(weeklyDays);
        if (days.length === 0) return { firesAt: null, rrule: null };
        const { hour, minute } = timeStringToHourMinute(weeklyTime);
        return {
          firesAt: null,
          rrule: `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")};BYHOUR=${hour};BYMINUTE=${minute}`,
        };
      }
      case "monthly": {
        const { hour, minute } = timeStringToHourMinute(monthTime);
        return {
          firesAt: null,
          rrule: `RRULE:FREQ=MONTHLY;BYMONTHDAY=${monthDay};BYHOUR=${hour};BYMINUTE=${minute}`,
        };
      }
      case "custom":
        return { firesAt: null, rrule: customRrule.trim() || null };
    }
  }

  // ── Render ──

  return (
    <div className="space-y-2">
      <Select
        size="sm"
        label="Schedule"
        selectedKeys={[mode]}
        onChange={(e) => setMode(e.target.value as ScheduleMode)}
      >
        <SelectItem key="once">Once (specific date & time)</SelectItem>
        <SelectItem key="daily">Every day</SelectItem>
        <SelectItem key="multiple">Multiple times per day</SelectItem>
        <SelectItem key="weekly">Weekly (pick days)</SelectItem>
        <SelectItem key="monthly">Monthly (pick day of month)</SelectItem>
        <SelectItem key="custom">Custom RRULE</SelectItem>
      </Select>

      {mode === "once" && (
        <Input
          size="sm"
          label="Date & time"
          type="datetime-local"
          placeholder=" "
          value={onceDatetime}
          onValueChange={setOnceDatetime}
        />
      )}

      {mode === "daily" && (
        <Input
          size="sm"
          label="Time"
          type="time"
          placeholder=" "
          value={dailyTime}
          onValueChange={setDailyTime}
        />
      )}

      {mode === "multiple" && (
        <div className="space-y-2">
          <p className="text-xs text-default-500">Times of day:</p>
          <div className="space-y-1">
            {multipleTimes.map((t, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input
                  size="sm"
                  type="time"
                  placeholder=" "
                  value={t}
                  onValueChange={(v) =>
                    setMultipleTimes((prev) =>
                      prev.map((x, j) => (i === j ? v : x))
                    )
                  }
                  className="flex-1"
                />
                {multipleTimes.length > 1 && (
                  <Button
                    size="sm"
                    isIconOnly
                    variant="light"
                    color="danger"
                    onPress={() =>
                      setMultipleTimes((prev) => prev.filter((_, j) => j !== i))
                    }
                  >
                    <FaTrash size={10} />
                  </Button>
                )}
              </div>
            ))}
          </div>
          <Button
            size="sm"
            variant="flat"
            startContent={<FaPlus size={10} />}
            onPress={() => setMultipleTimes((prev) => [...prev, "12:00"])}
          >
            Add time
          </Button>
        </div>
      )}

      {mode === "weekly" && (
        <div className="space-y-2">
          <div>
            <p className="text-xs text-default-500 mb-1">Days:</p>
            <div className="flex flex-wrap gap-2">
              {DAYS_OF_WEEK.map((d) => (
                <Checkbox
                  key={d.key}
                  size="sm"
                  isSelected={weeklyDays.has(d.key)}
                  onValueChange={(checked) =>
                    setWeeklyDays((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(d.key);
                      else next.delete(d.key);
                      return next;
                    })
                  }
                >
                  {d.label}
                </Checkbox>
              ))}
            </div>
          </div>
          <Input
            size="sm"
            label="Time"
            type="time"
            placeholder=" "
            value={weeklyTime}
            onValueChange={setWeeklyTime}
          />
        </div>
      )}

      {mode === "monthly" && (
        <div className="flex gap-2">
          <Input
            size="sm"
            label="Day of month"
            type="number"
            min={1}
            max={31}
            placeholder=" "
            value={String(monthDay)}
            onValueChange={(v) => {
              const n = parseInt(v, 10);
              if (!Number.isNaN(n) && n >= 1 && n <= 31) setMonthDay(n);
            }}
            className="max-w-[130px]"
          />
          <Input
            size="sm"
            label="Time"
            type="time"
            placeholder=" "
            value={monthTime}
            onValueChange={setMonthTime}
            className="flex-1"
          />
        </div>
      )}

      {mode === "custom" && (
        <Input
          size="sm"
          label="RRULE"
          placeholder="RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0"
          value={customRrule}
          onValueChange={setCustomRrule}
          description="Advanced: hand-written RRULE string"
        />
      )}
    </div>
  );
}
