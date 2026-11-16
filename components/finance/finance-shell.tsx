"use client";

// Frame for every /finance page: auth gate, title and a "Sync now"
// button (syncFinance mutation → finance-sync Lambda). Pages
// pass `onSynced` to reload after a sync. Navigation between finance
// pages is the Finance section of the sidebar (config/nav.ts).

import React, { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { getCurrentUser } from "aws-amplify/auth";
import { Button } from "@heroui/button";
import { addToast } from "@heroui/react";
import { FaSyncAlt, FaWallet } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { financeClient } from "@/components/finance/client";
import { describeSyncResult } from "@/lib/finance/sync-result";

export function FinanceShell({
  title,
  subtitle,
  actions,
  onSynced,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  onSynced?: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    getCurrentUser()
      .then(() => setReady(true))
      .catch(() => router.push("/login"));
  }, [router]);

  async function syncNow() {
    setSyncing(true);
    try {
      const r = await financeClient.mutations.syncFinance({});
      const out = describeSyncResult(r.data, r.errors?.[0]?.message);
      addToast({ title: out.title, description: out.detail, color: out.ok ? "success" : "danger" });
      if (out.ok) onSynced?.();
    } catch (e) {
      addToast({ title: "Sync failed", description: e instanceof Error ? e.message : String(e), color: "danger" });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <DefaultLayout>
      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <FaWallet className="text-default-500" />
              {title}
            </h1>
            {subtitle && <div className="text-xs text-default-500 mt-0.5">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <Button size="sm" variant="flat" startContent={<FaSyncAlt className={syncing ? "animate-spin" : ""} />} isDisabled={syncing} onPress={syncNow}>
              Sync now
            </Button>
          </div>
        </div>
        {ready ? children : null}
      </div>
    </DefaultLayout>
  );
}
