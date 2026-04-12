"use client";

import React, { useState, useEffect } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner } from "@heroui/react";
// Progress bar removed — ChecklistPanel handles its own display
import { Link } from "@heroui/link";
import NextLink from "next/link";
import { FaCheckSquare, FaPlus } from "react-icons/fa";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";

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

type EntityOption = { id: string; label: string; type: string };

export default function ChecklistsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [entityNames, setEntityNames] = useState<Record<string, string>>({});

  // Create checklist flow
  const [showCreate, setShowCreate] = useState(false);
  const [createEntityType, setCreateEntityType] = useState<string>("TRIP");
  const [createEntityId, setCreateEntityId] = useState<string>("");
  const [createName, setCreateName] = useState("");
  const [entityOptions, setEntityOptions] = useState<EntityOption[]>([]);
  const [loadingEntities, setLoadingEntities] = useState(false);

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

  // Load entities for the picker dropdown when entity type changes
  async function loadEntitiesForType(type: string) {
    setLoadingEntities(true);
    setEntityOptions([]);
    setCreateEntityId("");
    try {
      const modelMap: Record<string, { model: string; field: string }> = {
        TRIP: { model: "homeTrip", field: "name" },
        EVENT: { model: "homeCalendarEvent", field: "title" },
        TASK: { model: "homeTask", field: "title" },
        BILL: { model: "homeBill", field: "name" },
        DOCUMENT: { model: "homeDocument", field: "title" },
      };
      const cfg = modelMap[type];
      if (!cfg) { setLoadingEntities(false); return; }
      const { data } = await (client.models as any)[cfg.model].list({ limit: 500 });
      const opts: EntityOption[] = ((data ?? []) as any[])
        .map((d: any) => ({ id: d.id, label: d[cfg.field] ?? d.id, type }))
        .sort((a: EntityOption, b: EntityOption) => a.label.localeCompare(b.label));
      setEntityOptions(opts);
    } catch (err) {
      console.error("Failed to load entities:", err);
    } finally {
      setLoadingEntities(false);
    }
  }

  async function createChecklistOnEntity() {
    const name = createName.trim();
    if (!name || !createEntityId || !createEntityType) return;
    try {
      await client.models.homeChecklist.create({
        entityType: createEntityType as any,
        entityId: createEntityId,
        name,
        sortOrder: 0,
      });
      setShowCreate(false);
      setCreateName("");
      setCreateEntityId("");
      await loadAll();
    } catch (err) {
      console.error("Failed to create checklist:", err);
    }
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

        {/* ── Create checklist on entity ──────────────────────────────── */}
        <div className="mb-10">
          {!showCreate ? (
            <Button
              variant="flat"
              startContent={<FaPlus size={12} />}
              onPress={() => { setShowCreate(true); loadEntitiesForType(createEntityType); }}
            >
              Create checklist on entity
            </Button>
          ) : (
            <div className="border border-default-200 rounded-md p-4 bg-default-50 space-y-3">
              <p className="text-sm font-medium">Create checklist</p>
              <div className="flex gap-2">
                <Select
                  size="sm"
                  label="Entity type"
                  selectedKeys={[createEntityType]}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) { setCreateEntityType(v); loadEntitiesForType(v); }
                  }}
                  className="max-w-[150px]"
                >
                  {ENTITY_TYPE_ORDER.map((t) => (
                    <SelectItem key={t} textValue={ENTITY_TYPE_LABELS[t]}>
                      {ENTITY_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </Select>
                <Select
                  size="sm"
                  label={loadingEntities ? "Loading..." : "Entity"}
                  selectedKeys={createEntityId ? [createEntityId] : []}
                  onChange={(e) => setCreateEntityId(e.target.value)}
                  isDisabled={loadingEntities || entityOptions.length === 0}
                  className="flex-1"
                >
                  {entityOptions.map((o) => (
                    <SelectItem key={o.id} textValue={o.label}>
                      {o.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div className="flex gap-2">
                <Input
                  size="sm"
                  label="Checklist name"
                  value={createName}
                  onValueChange={setCreateName}
                  className="flex-1"
                />
                <Button
                  size="sm"
                  color="primary"
                  variant="flat"
                  isDisabled={!createName.trim() || !createEntityId}
                  onPress={createChecklistOnEntity}
                >
                  Create
                </Button>
                <Button
                  size="sm"
                  variant="light"
                  onPress={() => setShowCreate(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
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
