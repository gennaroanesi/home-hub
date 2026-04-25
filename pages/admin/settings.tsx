"use client";

import React, { useState, useEffect, useCallback } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Select, SelectItem } from "@heroui/select";
import { Input } from "@heroui/input";
import { addToast } from "@heroui/react";
import { FaArrowLeft, FaSave } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Settings = Schema["homeSettings"]["type"];

// Curated list of common timezones. If a user needs something exotic they
// can type it in — the input falls back to a text field.
const COMMON_TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Honolulu",
  "America/Sao_Paulo",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Paris",
  "Europe/Rome",
  "Europe/Berlin",
  "Europe/Madrid",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Australia/Sydney",
  "UTC",
];

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [householdTimezone, setHouseholdTimezone] = useState("America/Chicago");
  const [customTz, setCustomTz] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      await getCurrentUser();
      await loadSettings();
    } catch {
      router.push("/login");
    }
  }

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.models.homeSettings.list();
      const row = data?.[0] ?? null;
      setSettings(row);
      if (row?.householdTimezone) {
        setHouseholdTimezone(row.householdTimezone);
        setCustomTz(!COMMON_TIMEZONES.includes(row.householdTimezone));
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
    setLoading(false);
  }, []);

  async function save() {
    if (!householdTimezone.trim()) {
      addToast({ title: "Timezone is required", color: "warning" });
      return;
    }
    // Validate TZ — catch typos like "America/Chigago"
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: householdTimezone.trim() });
    } catch {
      addToast({
        title: "Invalid timezone",
        description: `"${householdTimezone}" is not a recognized IANA timezone`,
        color: "danger",
      });
      return;
    }

    setSaving(true);
    try {
      if (settings) {
        const { errors } = await client.models.homeSettings.update({
          id: settings.id,
          householdTimezone: householdTimezone.trim(),
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else {
        const { errors } = await client.models.homeSettings.create({
          householdTimezone: householdTimezone.trim(),
        });
        if (errors?.length) throw new Error(errors[0].message);
      }
      addToast({ title: "Settings saved", color: "success" });
      await loadSettings();
    } catch (err: any) {
      console.error("Failed to save settings:", err);
      addToast({
        title: "Save failed",
        description: err?.message ?? String(err),
        color: "danger",
      });
    }
    setSaving(false);
  }

  // Current local time in the configured TZ — handy feedback while picking
  const currentTimeLabel = (() => {
    try {
      return new Date().toLocaleString("en-US", {
        timeZone: householdTimezone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });
    } catch {
      return "—";
    }
  })();

  return (
    <DefaultLayout>
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="flex items-center gap-3 mb-6">
          <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
            <FaArrowLeft />
          </Button>
          <h1 className="text-2xl font-bold">Settings</h1>
        </div>

        {loading && <p className="text-center text-default-400 py-6">Loading…</p>}

        {!loading && (
          <Card>
            <CardHeader className="px-4 pt-4 pb-0">
              <div>
                <h2 className="text-lg font-semibold">Household</h2>
                <p className="text-xs text-default-500">
                  Settings that apply to the whole household. Per-person overrides
                  (like timezone when travelling) live on each person&apos;s profile.
                </p>
              </div>
            </CardHeader>
            <CardBody className="px-4 py-4 space-y-3">
              <div className="space-y-2">
                <p className="text-sm font-medium">Household timezone</p>
                <p className="text-xs text-default-500">
                  Used to interpret reminder times, daily summary time, and
                  anywhere we need a household-wide &quot;local time&quot;.
                  Person-targeted reminders fall back to the person&apos;s own
                  timezone if set.
                </p>
                {!customTz ? (
                  <Select
                    size="sm"
                    selectedKeys={[householdTimezone]}
                    onChange={(e) => setHouseholdTimezone(e.target.value)}
                  >
                    <>
                      {COMMON_TIMEZONES.map((tz) => (
                        <SelectItem key={tz}>{tz}</SelectItem>
                      )) as any}
                    </>
                  </Select>
                ) : (
                  <Input
                    size="sm"
                    placeholder="IANA timezone, e.g. America/Chicago"
                    value={householdTimezone}
                    onValueChange={setHouseholdTimezone}
                  />
                )}
                <button
                  className="text-xs text-primary-500 hover:underline"
                  onClick={() => setCustomTz((v) => !v)}
                >
                  {customTz ? "Pick from common list" : "Enter a custom IANA timezone"}
                </button>
                <p className="text-xs text-default-400 pt-1">
                  Current time there: <span className="font-mono">{currentTimeLabel}</span>
                </p>
              </div>
            </CardBody>
          </Card>
        )}

        {!loading && (
          <div className="mt-4 flex justify-end">
            <Button
              color="primary"
              onPress={save}
              isDisabled={saving}
              startContent={<FaSave size={12} />}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </div>
    </DefaultLayout>
  );
}
