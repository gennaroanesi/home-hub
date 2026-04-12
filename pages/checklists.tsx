"use client";

import React, { useState, useEffect } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner } from "@heroui/react";
// Progress bar removed — ChecklistPanel handles its own display
import { Link } from "@heroui/link";
import NextLink from "next/link";
import { FaCheckSquare } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { ChecklistPanel } from "@/components/checklist-panel";
import { listAllPages } from "@/lib/list-all";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Checklist = Schema["homeChecklist"]["type"];
type ChecklistItem = Schema["homeChecklistItem"]["type"];
type EntityType = "TRIP" | "EVENT" | "BILL" | "DOCUMENT" | "TASK" | "TEMPLATE" | "OTHER";

// ── Entity type display config ──────────────────────────────────────────

const ENTITY_TYPE_ORDER: EntityType[] = ["TRIP", "EVENT", "TASK", "BILL", "DOCUMENT", "OTHER"];

const ENTITY_TYPE_LABELS: Record<string, string> = {
  TRIP: "Trips",
  EVENT: "Events",
  TASK: "Tasks",
  BILL: "Bills",
  DOCUMENT: "Documents",
  OTHER: "Other",
};

function entityDetailHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case "TRIP":
      return `/trips/${entityId}`;
    case "EVENT":
      return `/calendar`;
    case "TASK":
      return `/tasks`;
    case "BILL":
      return `/bills`;
    case "DOCUMENT":
      return `/documents`;
    default:
      return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function groupBySection(items: ChecklistItem[]): { section: string | null; items: ChecklistItem[] }[] {
  const map = new Map<string | null, ChecklistItem[]>();
  for (const item of items) {
    const key = (item as any).section || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  const groups: { section: string | null; items: ChecklistItem[] }[] = [];
  if (map.has(null)) groups.push({ section: null, items: map.get(null)! });
  const sorted = Array.from(map.entries())
    .filter(([k]) => k !== null)
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
  for (const [key, items] of sorted) {
    groups.push({ section: key, items });
  }
  return groups;
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function ChecklistsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  // Items are fetched by each ChecklistPanel instance — no page-level fetch needed.
  const [entityNames, setEntityNames] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
      } catch {
        router.push("/login");
        return;
      }
      await loadAll();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll() {
    try {
      // Load all non-TEMPLATE checklists
      const allChecklists = await listAllPages<Checklist>(
        client.models.homeChecklist,
      );
      const nonTemplate = allChecklists.filter((c) => (c.entityType as string) !== "TEMPLATE");
      setChecklists(nonTemplate);

      // Resolve entity names
      const names: Record<string, string> = {};
      const idsByType: Record<string, Set<string>> = {};
      for (const cl of nonTemplate) {
        const t = cl.entityType ?? "OTHER";
        if (!idsByType[t]) idsByType[t] = new Set();
        idsByType[t].add(cl.entityId);
      }

      await Promise.all([
        resolveNames(idsByType["TRIP"], "homeTrip", "name", names),
        resolveNames(idsByType["EVENT"], "homeCalendarEvent", "title", names),
        resolveNames(idsByType["TASK"], "homeTask", "title", names),
        resolveNames(idsByType["BILL"], "homeBill", "name", names),
        resolveNames(idsByType["DOCUMENT"], "homeDocument", "title", names),
      ]);
      setEntityNames(names);
    } catch (err) {
      console.error("Failed to load checklists:", err);
    } finally {
      setLoading(false);
    }
  }

  async function resolveNames(
    ids: Set<string> | undefined,
    modelName: keyof typeof client.models,
    field: string,
    out: Record<string, string>,
  ) {
    if (!ids || ids.size === 0) return;
    await Promise.all(
      Array.from(ids).map(async (id) => {
        try {
          const { data } = await (client.models[modelName] as any).get({ id });
          if (data) out[id] = (data as any)[field] ?? id;
        } catch {
          out[id] = id;
        }
      }),
    );
  }

  // Group checklists by entityType
  const grouped = ENTITY_TYPE_ORDER.map((type) => ({
    type,
    label: ENTITY_TYPE_LABELS[type],
    checklists: checklists
      .filter((c) => (c.entityType ?? "OTHER") === type)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.checklists.length > 0);

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto px-4 py-10">
        {/* ── Templates section ──────────────────────────────────────── */}
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <FaCheckSquare className="text-default-500" />
            <h1 className="text-2xl font-bold">Checklists</h1>
          </div>

          <h2 className="text-lg font-semibold mb-3">Templates</h2>
          <ChecklistPanel entityType="TEMPLATE" entityId="templates" />
        </div>

        {/* ── All checklists section ─────────────────────────────────── */}
        <div>
          <h2 className="text-lg font-semibold mb-4">All Checklists</h2>

          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner label="Loading checklists..." />
            </div>
          ) : grouped.length === 0 ? (
            <p className="text-default-400 text-sm py-4">
              No checklists yet. Create one from a trip, event, or document
              detail page.
            </p>
          ) : (
            <div className="space-y-8">
              {grouped.map((group) => {
                // Deduplicate by entityId — ChecklistPanel renders all
                // checklists for a given entity, so we only need one
                // panel per unique entityId.
                const seen = new Set<string>();
                const uniqueEntities = group.checklists.filter((cl) => {
                  if (seen.has(cl.entityId)) return false;
                  seen.add(cl.entityId);
                  return true;
                });

                return (
                  <div key={group.type}>
                    <h3 className="text-xs text-default-400 uppercase tracking-wider mb-3">
                      {group.label}
                    </h3>
                    <div className="space-y-4">
                      {uniqueEntities.map((cl) => {
                        const href = entityDetailHref(cl.entityType ?? "OTHER", cl.entityId);
                        const eName = entityNames[cl.entityId] ?? cl.entityId;

                        return (
                          <div key={cl.entityId} className="border border-default-200 rounded-md p-4 bg-default-50">
                            <div className="mb-2">
                              {href ? (
                                <Link
                                  as={NextLink}
                                  href={href}
                                  className="text-sm font-medium text-primary"
                                >
                                  {eName}
                                </Link>
                              ) : (
                                <p className="text-sm font-medium text-default-600">
                                  {eName}
                                </p>
                              )}
                            </div>
                            <ChecklistPanel
                              entityType={cl.entityType as any ?? "OTHER"}
                              entityId={cl.entityId}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </DefaultLayout>
  );
}
