"use client";

import React, { useState, useEffect } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner } from "@heroui/react";
import { Progress } from "@heroui/progress";
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
  const [itemsByChecklist, setItemsByChecklist] = useState<Record<string, ChecklistItem[]>>({});
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
      const nonTemplate = allChecklists.filter((c) => c.entityType !== "TEMPLATE");
      setChecklists(nonTemplate);

      // Load items for each checklist in parallel
      const grouped: Record<string, ChecklistItem[]> = {};
      await Promise.all(
        nonTemplate.map(async (cl) => {
          const { data } =
            await client.models.homeChecklistItem.listhomeChecklistItemByChecklistId({
              checklistId: cl.id,
            });
          grouped[cl.id] = (data ?? []).sort(
            (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
          );
        }),
      );
      setItemsByChecklist(grouped);

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
              {grouped.map((group) => (
                <div key={group.type}>
                  <h3 className="text-xs text-default-400 uppercase tracking-wider mb-3">
                    {group.label}
                  </h3>
                  <div className="space-y-3">
                    {group.checklists.map((cl) => {
                      const items = itemsByChecklist[cl.id] ?? [];
                      const doneCount = items.filter((i) => i.isDone).length;
                      const totalCount = items.length;
                      const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
                      const groups = groupBySection(items);
                      const href = entityDetailHref(cl.entityType ?? "OTHER", cl.entityId);
                      const eName = entityNames[cl.entityId] ?? cl.entityId;

                      // Section summary
                      const sectionCounts = groups
                        .filter((g) => g.section)
                        .map((g) => {
                          const done = g.items.filter((i) => i.isDone).length;
                          return `${g.section}: ${done}/${g.items.length}`;
                        });

                      return (
                        <div
                          key={cl.id}
                          className="border border-default-200 rounded-md p-4 bg-default-50"
                        >
                          {/* Header */}
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="min-w-0">
                              {href ? (
                                <Link
                                  as={NextLink}
                                  href={href}
                                  className="text-sm font-medium text-primary truncate block"
                                >
                                  {eName}
                                </Link>
                              ) : (
                                <p className="text-sm font-medium text-default-600 truncate">
                                  {eName}
                                </p>
                              )}
                              <p className="text-xs text-default-500">{cl.name}</p>
                            </div>
                            <div className="text-xs text-default-400 whitespace-nowrap">
                              {doneCount}/{totalCount} done
                            </div>
                          </div>

                          {/* Progress bar */}
                          {totalCount > 0 && (
                            <Progress
                              size="sm"
                              value={pct}
                              color={pct === 100 ? "success" : "primary"}
                              className="mb-2"
                              aria-label="Checklist progress"
                            />
                          )}

                          {/* Section summary */}
                          {sectionCounts.length > 0 && (
                            <p className="text-xs text-default-400 mb-2">
                              {sectionCounts.join(" · ")}
                            </p>
                          )}

                          {/* Expandable item list */}
                          {totalCount > 0 && (
                            <details className="mt-1">
                              <summary className="text-xs text-default-400 cursor-pointer select-none hover:text-default-600">
                                Show items ({totalCount})
                              </summary>
                              <div className="mt-2 space-y-2">
                                {groups.map((g) => (
                                  <div key={g.section ?? "__none__"}>
                                    {g.section && (
                                      <p className="text-xs font-semibold text-default-500 uppercase tracking-wider mb-1">
                                        {g.section}
                                      </p>
                                    )}
                                    <div className="space-y-0.5">
                                      {g.items.map((item) => (
                                        <div
                                          key={item.id}
                                          className="flex items-center gap-2 text-sm"
                                        >
                                          <span
                                            className={
                                              item.isDone
                                                ? "text-success"
                                                : "text-default-300"
                                            }
                                          >
                                            {item.isDone ? "✓" : "○"}
                                          </span>
                                          <span
                                            className={
                                              item.isDone
                                                ? "line-through text-default-400"
                                                : ""
                                            }
                                          >
                                            {item.text}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DefaultLayout>
  );
}
