"use client";

// /checklists — every checklist by what it's attached to, in tabs:
// Active, Archived (past trips' lists archive themselves, lib/trip-prep.ts)
// and Templates, where templates are edited (?tab=templates&open=<id>
// opens one; "Edit its template" on a list made from one links here).

import React, { useState, useEffect } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner } from "@heroui/react";
import { Link } from "@heroui/link";
import NextLink from "next/link";
import { FaArchive, FaBoxOpen, FaCheckSquare, FaPlus } from "react-icons/fa";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";

import DefaultLayout from "@/layouts/default";
import { ChecklistPanel } from "@/components/checklist-panel";
import { listAllPages } from "@/lib/list-all";
import {
  AUTO_ATTACH_HINT,
  AUTO_ATTACH_LABEL,
  ENTITY_TYPE_LABELS,
  ENTITY_TYPE_ORDER,
  TEMPLATE_ENTITY_ID,
  archivePatch,
  isArchived,
  matchesArchiveFilter,
  type Checklist,
  type EntityType,
} from "@/lib/checklist";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

function entityDetailHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case "TRIP":
      return `/trips/${entityId}`;
    case "EVENT":
      return `/calendar`;
    case "TASK":
      return `/tasks`;
    case "DOCUMENT":
      return `/documents`;
    case "PREGNANCY":
      return `/health`;
    default:
      return null;
  }
}

// ── Page ─────────────────────────────────────────────────────────────────

type EntityOption = { id: string; label: string; type: string };
type Tab = "ACTIVE" | "ARCHIVED" | "TEMPLATES";
const TABS: { id: Tab; label: string }[] = [
  { id: "ACTIVE", label: "Active" },
  { id: "ARCHIVED", label: "Archived" },
  { id: "TEMPLATES", label: "Templates" },
];

export default function ChecklistsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [entityNames, setEntityNames] = useState<Record<string, string>>({});
  const [tripDates, setTripDates] = useState<Record<string, string>>({});
  const [tab, setTabState] = useState<Tab>("ACTIVE");
  const openId = typeof router.query.open === "string" ? router.query.open : null;
  const archiveFilter = tab === "ARCHIVED" ? "ARCHIVED" : "ACTIVE";
  function setTab(t: Tab) {
    setTabState(t);
    void router.replace({ pathname: "/checklists", query: t === "ACTIVE" ? {} : { tab: t.toLowerCase() } }, undefined, { shallow: true });
  }
  useEffect(() => {
    if (!router.isReady) return;
    const q = String(router.query.tab ?? "").toUpperCase();
    if (q === "TEMPLATES" || q === "ARCHIVED") setTabState(q);
  }, [router.isReady, router.query.tab]);
  // Bumped per entity after a group archive so that entity's
  // ChecklistPanel remounts and re-fetches (it keeps its own state).
  const [panelVersion, setPanelVersion] = useState<Record<string, number>>({});
  const [archivingEntity, setArchivingEntity] = useState<string | null>(null);

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
        resolveNames(idsByType["DOCUMENT"], "homeDocument", "title", names),
        resolveNames(idsByType["PREGNANCY"], "homePregnancy", "dueDate", names),
      ]);
      setEntityNames(names);
      // Trip dates, to order trips (next first) and show when each is.
      const dates: Record<string, string> = {};
      await Promise.all(
        Array.from(idsByType["TRIP"] ?? []).map(async (id) => {
          const { data } = await client.models.homeTrip.get({ id });
          if (data?.startDate) dates[id] = `${data.startDate}|${data.endDate ?? data.startDate}`;
        }),
      );
      setTripDates(dates);
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
        DOCUMENT: { model: "homeDocument", field: "title" },
        PREGNANCY: { model: "homePregnancy", field: "dueDate" },
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

  // Archive (or unarchive) every checklist attached to one entity. If
  // any are still active the action archives; once all are archived it
  // flips to unarchive.
  async function toggleArchiveEntity(entityId: string) {
    const group = checklists.filter((c) => c.entityId === entityId);
    const archive = group.some((c) => !isArchived(c));
    const now = new Date().toISOString();
    setArchivingEntity(entityId);
    try {
      await Promise.all(
        group
          .filter((c) => isArchived(c) !== archive)
          .map((c) =>
            client.models.homeChecklist.update({ id: c.id, ...archivePatch(archive, new Date(now)) }),
          ),
      );
      setPanelVersion((v) => ({ ...v, [entityId]: (v[entityId] ?? 0) + 1 }));
      await loadAll();
    } catch (err) {
      console.error("Failed to archive checklists:", err);
    } finally {
      setArchivingEntity(null);
    }
  }

  const filtered = checklists.filter((c) =>
    matchesArchiveFilter(c, archiveFilter),
  );

  // Group checklists by entityType
  const grouped = ENTITY_TYPE_ORDER.map((type) => ({
    type,
    label: ENTITY_TYPE_LABELS[type],
    checklists: filtered
      .filter((c) => (c.entityType ?? "OTHER") === type)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.checklists.length > 0);

  const fmtTrip = (id: string) => {
    const d = tripDates[id];
    if (!d) return null;
    const [from, to] = d.split("|");
    const f = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return from === to ? f(from) : `${f(from)} – ${f(to)}`;
  };

  return (
    <DefaultLayout>
      <div className="max-w-5xl mx-auto px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <FaCheckSquare className="text-default-500" />
            <h1 className="text-2xl font-bold">Checklists</h1>
          </div>
          {tab !== "TEMPLATES" && !showCreate && (
            <Button
              size="sm"
              variant="flat"
              startContent={<FaPlus size={12} />}
              onPress={() => {
                setShowCreate(true);
                loadEntitiesForType(createEntityType);
              }}
            >
              New checklist
            </Button>
          )}
        </div>

        <div className="flex gap-1 mb-5 border-b border-default-200">
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-sm -mb-px border-b-2 ${on ? "border-primary text-foreground font-medium" : "border-transparent text-default-500 hover:text-default-700"}`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === "TEMPLATES" ? (
          <div>
            <p className="text-sm text-default-500 mb-3">
              Reusable lists. Add one to a trip with &ldquo;From template&rdquo;. One marked &ldquo;{AUTO_ATTACH_LABEL}&rdquo; is copied onto each new and upcoming trip by itself. Copies drop the word &ldquo;template&rdquo; from the name.
            </p>
            <ChecklistPanel entityType="TEMPLATE" entityId={TEMPLATE_ENTITY_ID} archiveFilter="ALL" openId={openId} bare />
          </div>
        ) : (
          <>
            {showCreate && (
              <div className="mb-8 border border-default-200 rounded-md p-4 bg-default-50 space-y-3">
                <p className="text-sm font-medium">New checklist</p>
                <div className="flex gap-2">
                  <Select
                    size="sm"
                    label="For a"
                    selectedKeys={[createEntityType]}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) {
                        setCreateEntityType(v);
                        loadEntitiesForType(v);
                      }
                    }}
                    className="max-w-[150px]"
                  >
                    {ENTITY_TYPE_ORDER.filter((t) => t !== "OTHER").map((t) => (
                      <SelectItem key={t} textValue={ENTITY_TYPE_LABELS[t]}>
                        {ENTITY_TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </Select>
                  <Select
                    size="sm"
                    label={loadingEntities ? "Loading..." : "Which one"}
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
                  <Input size="sm" label="Checklist name" value={createName} onValueChange={setCreateName} className="flex-1" />
                  <Button size="sm" color="primary" variant="flat" isDisabled={!createName.trim() || !createEntityId} onPress={createChecklistOnEntity}>
                    Create
                  </Button>
                  <Button size="sm" variant="light" onPress={() => setShowCreate(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="flex justify-center py-12">
                <Spinner label="Loading checklists..." />
              </div>
            ) : grouped.length === 0 ? (
              <p className="text-default-400 text-sm py-4">
                {archiveFilter === "ARCHIVED"
                  ? "No archived checklists."
                  : checklists.length > 0
                    ? "Nothing active. Past trips' checklists are under Archived."
                    : "No checklists yet. Add one from a trip, event or document, or with New checklist."}
              </p>
            ) : (
              <div className="space-y-8">
                {grouped.map((group) => {
                  // One block per entity: its panel shows all of that entity's lists.
                  const seen = new Set<string>();
                  const uniqueEntities = group.checklists.filter((cl) => {
                    if (seen.has(cl.entityId)) return false;
                    seen.add(cl.entityId);
                    return true;
                  });
                  // Trips: the next one first (archived: the latest first).
                  if (group.type === "TRIP")
                    uniqueEntities.sort((a, b) => {
                      const da = tripDates[a.entityId] ?? "9999";
                      const db = tripDates[b.entityId] ?? "9999";
                      return archiveFilter === "ARCHIVED" ? db.localeCompare(da) : da.localeCompare(db);
                    });
                  return (
                    <div key={group.type}>
                      <h3 className="text-xs text-default-400 uppercase tracking-wider mb-3">{group.label}</h3>
                      <div className="space-y-5">
                        {uniqueEntities.map((cl) => {
                          const href = entityDetailHref(cl.entityType ?? "OTHER", cl.entityId);
                          const eName = entityNames[cl.entityId] ?? cl.entityId;
                          const when = group.type === "TRIP" ? fmtTrip(cl.entityId) : null;
                          const allArchived = checklists.filter((c) => c.entityId === cl.entityId).every(isArchived);
                          return (
                            <div key={cl.entityId}>
                              <div className="mb-1.5 flex items-center justify-between gap-2">
                                <div className="flex items-baseline gap-2 min-w-0">
                                  {href ? (
                                    <Link as={NextLink} href={href} className="text-base font-semibold text-foreground hover:text-primary truncate">
                                      {eName}
                                    </Link>
                                  ) : (
                                    <p className="text-base font-semibold truncate">{eName}</p>
                                  )}
                                  {when && <span className="text-xs text-default-500 shrink-0">{when}</span>}
                                </div>
                                <Button
                                  size="sm"
                                  variant="light"
                                  isLoading={archivingEntity === cl.entityId}
                                  startContent={archivingEntity === cl.entityId ? null : allArchived ? <FaBoxOpen size={12} /> : <FaArchive size={12} />}
                                  onPress={() => toggleArchiveEntity(cl.entityId)}
                                >
                                  {allArchived ? "Unarchive all" : "Archive all"}
                                </Button>
                              </div>
                              <ChecklistPanel
                                key={panelVersion[cl.entityId] ?? 0}
                                entityType={(cl.entityType as EntityType) ?? "OTHER"}
                                entityId={cl.entityId}
                                archiveFilter={archiveFilter}
                                onArchiveChange={loadAll}
                                bare
                                actions={false}
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
          </>
        )}
      </div>
    </DefaultLayout>
  );
}
