"use client";

// Health records + pregnancy tracker.
//
// Top: the active pregnancy (gestational age, due date) and its care
// timeline, seeded from lib/pregnancy.ts. Below: visits, lab results and
// providers for whichever household member is selected. Janet writes to
// the same tables (log_medical_visit, record_lab_results, …), so most
// data entry is expected to happen over WhatsApp — this page is for
// reviewing and correcting.

import React, { useEffect, useMemo, useState } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner, addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/modal";
import { FaHeartbeat, FaPlus } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { DateInput } from "@/components/date-input";
import { listAllPages } from "@/lib/list-all";
import {
  CARE_CATEGORY_LABELS,
  CARE_STATUSES,
  CARE_STATUS_LABELS,
  buildCareTimeline,
  careUrgency,
  dueDateFromLmp,
  gestationalAge,
  lmpFromDueDate,
  ymdInTimezone,
  type CareCategory,
  type CareStatus,
  type CareUrgency,
} from "@/lib/pregnancy";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });
const TZ = "America/Chicago";

type Person = Schema["homePerson"]["type"];
type Pregnancy = Schema["homePregnancy"]["type"];
type CareItem = Schema["homeCareItem"]["type"];
type Visit = Schema["homeMedicalVisit"]["type"];
type LabResult = Schema["homeLabResult"]["type"];
type Provider = Schema["homeHealthProvider"]["type"];

const VISIT_KINDS = [
  "PRENATAL",
  "ULTRASOUND",
  "LAB_DRAW",
  "CHECKUP",
  "SPECIALIST",
  "VACCINE",
  "URGENT",
  "OTHER",
] as const;
const VISIT_KIND_LABELS: Record<(typeof VISIT_KINDS)[number], string> = {
  PRENATAL: "Prenatal",
  ULTRASOUND: "Ultrasound",
  LAB_DRAW: "Lab draw",
  CHECKUP: "Checkup",
  SPECIALIST: "Specialist",
  VACCINE: "Vaccine",
  URGENT: "Urgent",
  OTHER: "Other",
};

const URGENCY_STYLES: Record<CareUrgency, string> = {
  OVERDUE: "bg-danger-100 text-danger-700",
  DUE_NOW: "bg-warning-100 text-warning-700",
  SOON: "bg-primary-100 text-primary-700",
  LATER: "bg-default-100 text-default-500",
  CLOSED: "bg-default-100 text-default-400",
};
const URGENCY_LABELS: Record<CareUrgency, string> = {
  OVERDUE: "Overdue",
  DUE_NOW: "Due now",
  SOON: "Soon",
  LATER: "Later",
  CLOSED: "",
};

const LAB_FLAG_STYLES: Record<string, string> = {
  HIGH: "text-danger-600",
  LOW: "text-danger-600",
  ABNORMAL: "text-danger-600",
  POSITIVE: "text-warning-600",
  PENDING: "text-default-400 italic",
};

function fmtDate(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function HealthPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState<Person[]>([]);
  const [pregnancies, setPregnancies] = useState<Pregnancy[]>([]);
  const [careItems, setCareItems] = useState<CareItem[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [labs, setLabs] = useState<LabResult[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [personId, setPersonId] = useState<string>("");
  const [showClosedCare, setShowClosedCare] = useState(false);

  const [visitModalOpen, setVisitModalOpen] = useState(false);
  const [editingVisit, setEditingVisit] = useState<Visit | null>(null);
  const [labModalOpen, setLabModalOpen] = useState(false);
  const [providerModalOpen, setProviderModalOpen] = useState(false);

  const today = ymdInTimezone(TZ);

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
      const [ppl, preg, care, vis, lab, prov] = await Promise.all([
        listAllPages<Person>(client.models.homePerson),
        listAllPages<Pregnancy>(client.models.homePregnancy),
        listAllPages<CareItem>(client.models.homeCareItem),
        listAllPages<Visit>(client.models.homeMedicalVisit),
        listAllPages<LabResult>(client.models.homeLabResult),
        listAllPages<Provider>(client.models.homeHealthProvider),
      ]);
      const household = ppl.filter(
        (p) => p.active !== false && (p.groups ?? []).includes("home-users"),
      );
      setPeople(household.length > 0 ? household : ppl.filter((p) => p.active !== false));
      setPregnancies(preg);
      setCareItems(care);
      setVisits(vis);
      setLabs(lab);
      setProviders(prov.filter((p) => p.active !== false));
      // Default to whoever is pregnant, else the first person.
      setPersonId((cur) => {
        if (cur) return cur;
        const active = preg.find((p) => p.status === "ACTIVE");
        return active?.personId ?? household[0]?.id ?? ppl[0]?.id ?? "";
      });
    } catch (err) {
      console.error("Failed to load health data:", err);
    } finally {
      setLoading(false);
    }
  }

  const pregnancy = useMemo(
    () => pregnancies.find((p) => p.personId === personId && p.status === "ACTIVE") ?? null,
    [pregnancies, personId],
  );

  const pregnancyCare = useMemo(() => {
    if (!pregnancy) return [];
    return careItems
      .filter((c) => c.pregnancyId === pregnancy.id)
      .sort((a, b) =>
        a.windowStart === b.windowStart
          ? (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
          : a.windowStart.localeCompare(b.windowStart),
      );
  }, [careItems, pregnancy]);

  const personVisits = useMemo(
    () =>
      visits
        .filter((v) => v.personId === personId)
        .sort((a, b) => b.visitAt.localeCompare(a.visitAt)),
    [visits, personId],
  );

  const personLabs = useMemo(
    () =>
      labs
        .filter((l) => l.personId === personId)
        .sort((a, b) =>
          (b.collectedAt ?? b.createdAt).localeCompare(a.collectedAt ?? a.createdAt),
        ),
    [labs, personId],
  );

  // Group labs by panel + collected date so a report reads as one block.
  const labGroups = useMemo(() => {
    const groups = new Map<string, { label: string; date: string | null; rows: LabResult[] }>();
    for (const l of personLabs) {
      const k = `${l.panel ?? ""}|${l.collectedAt ?? ""}`;
      if (!groups.has(k)) groups.set(k, { label: l.panel ?? "Results", date: l.collectedAt ?? null, rows: [] });
      groups.get(k)!.rows.push(l);
    }
    return Array.from(groups.values());
  }, [personLabs]);

  async function updateCareStatus(item: CareItem, status: CareStatus) {
    const { data, errors } = await client.models.homeCareItem.update({
      id: item.id,
      status,
      ...(status === "DONE" && !item.completedAt ? { completedAt: today } : {}),
    });
    if (errors?.length || !data) {
      addToast({ title: "Update failed", description: errors?.[0]?.message, color: "danger" });
      return;
    }
    setCareItems((prev) => prev.map((c) => (c.id === data.id ? data : c)));
  }

  const providerName = (id: string | null | undefined) =>
    providers.find((p) => p.id === id)?.name ?? null;

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between gap-2 mb-6">
          <div className="flex items-center gap-2">
            <FaHeartbeat className="text-default-500" />
            <h1 className="text-2xl font-bold">Health</h1>
          </div>
          {people.length > 1 && (
            <Select
              size="sm"
              aria-label="Person"
              selectedKeys={personId ? [personId] : []}
              onChange={(e) => e.target.value && setPersonId(e.target.value)}
              className="max-w-[180px]"
            >
              {people.map((p) => (
                <SelectItem key={p.id} textValue={p.name}>
                  {p.emoji ? `${p.emoji} ` : ""}
                  {p.name}
                </SelectItem>
              ))}
            </Select>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner label="Loading health records..." />
          </div>
        ) : (
          <>
            {/* ── Pregnancy ─────────────────────────────────────────── */}
            {pregnancy ? (
              <PregnancyHeader pregnancy={pregnancy} today={today} />
            ) : (
              personId && (
                <CreatePregnancy
                  personId={personId}
                  onCreated={loadAll}
                />
              )
            )}

            {pregnancy && (
              <section className="mb-10">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-semibold">Care timeline</h2>
                  <button
                    type="button"
                    onClick={() => setShowClosedCare((v) => !v)}
                    className="px-3 py-1 rounded-full text-xs bg-default-100 text-default-600"
                  >
                    {showClosedCare ? "Hide done" : "Show all"}
                  </button>
                </div>
                <div className="space-y-2">
                  {pregnancyCare
                    .filter((c) => showClosedCare || c.status === "UPCOMING" || c.status === "SCHEDULED")
                    .map((c) => {
                      const urgency = careUrgency(
                        { status: c.status, windowStart: c.windowStart, windowEnd: c.windowEnd },
                        today,
                      );
                      const closed = urgency === "CLOSED";
                      return (
                        <div
                          key={c.id}
                          className={`border border-default-200 rounded-md p-3 bg-default-50 ${closed ? "opacity-60" : ""}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`text-sm font-medium ${closed ? "line-through" : ""}`}>
                                  {c.title}
                                </span>
                                {c.optional && (
                                  <span className="text-[10px] uppercase tracking-wide text-default-400">optional</span>
                                )}
                                {!closed && (
                                  <span className={`px-2 py-0.5 rounded-full text-[11px] ${URGENCY_STYLES[urgency]}`}>
                                    {URGENCY_LABELS[urgency]}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-default-500 mt-0.5">
                                {c.category ? `${CARE_CATEGORY_LABELS[c.category as CareCategory]} · ` : ""}
                                {fmtDate(c.windowStart)} – {fmtDate(c.windowEnd)}
                                {c.completedAt ? ` · done ${fmtDate(c.completedAt)}` : ""}
                              </p>
                              {c.notes && <p className="text-xs text-default-400 mt-1">{c.notes}</p>}
                            </div>
                            <Select
                              size="sm"
                              aria-label="Status"
                              selectedKeys={c.status ? [c.status] : []}
                              onChange={(e) => e.target.value && updateCareStatus(c, e.target.value as CareStatus)}
                              className="w-[130px] shrink-0"
                            >
                              {CARE_STATUSES.map((s) => (
                                <SelectItem key={s} textValue={CARE_STATUS_LABELS[s]}>
                                  {CARE_STATUS_LABELS[s]}
                                </SelectItem>
                              ))}
                            </Select>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </section>
            )}

            {/* ── Visits ────────────────────────────────────────────── */}
            <section className="mb-10">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">Visits</h2>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<FaPlus size={11} />}
                  onPress={() => {
                    setEditingVisit(null);
                    setVisitModalOpen(true);
                  }}
                >
                  Visit
                </Button>
              </div>
              {personVisits.length === 0 ? (
                <p className="text-default-400 text-sm">
                  No visits yet. Add one here, or tell Janet about an appointment.
                </p>
              ) : (
                <div className="space-y-2">
                  {personVisits.map((v) => {
                    const preg = pregnancies.find((p) => p.id === v.pregnancyId);
                    const ga = preg
                      ? gestationalAge(preg.dueDate, ymdInTimezone(TZ, new Date(v.visitAt))).label
                      : null;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => {
                          setEditingVisit(v);
                          setVisitModalOpen(true);
                        }}
                        className="w-full text-left border border-default-200 rounded-md p-3 bg-default-50 hover:bg-default-100"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">
                            {v.title || (v.kind ? VISIT_KIND_LABELS[v.kind] : "Visit")}
                          </span>
                          {v.status === "PLANNED" && (
                            <span className="px-2 py-0.5 rounded-full text-[11px] bg-primary-100 text-primary-700">Planned</span>
                          )}
                          {v.status === "CANCELLED" && (
                            <span className="px-2 py-0.5 rounded-full text-[11px] bg-default-100 text-default-500">Cancelled</span>
                          )}
                        </div>
                        <p className="text-xs text-default-500 mt-0.5">
                          {fmtDateTime(v.visitAt)}
                          {ga ? ` · ${ga}` : ""}
                          {providerName(v.providerId) ? ` · ${providerName(v.providerId)}` : ""}
                        </p>
                        {(v.weightLb || v.bpSystolic || v.fetalHeartRate) && (
                          <p className="text-xs text-default-600 mt-1">
                            {[
                              v.weightLb ? `${v.weightLb} lb` : null,
                              v.bpSystolic && v.bpDiastolic ? `BP ${v.bpSystolic}/${v.bpDiastolic}` : null,
                              v.fetalHeartRate ? `FHR ${v.fetalHeartRate} bpm` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                        {v.status === "PLANNED" && v.questions && (
                          <p className="text-xs text-default-500 mt-1 whitespace-pre-line">
                            {v.questions}
                          </p>
                        )}
                        {v.status !== "PLANNED" && v.notes && (
                          <p className="text-xs text-default-500 mt-1 line-clamp-2">{v.notes}</p>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── Lab results ──────────────────────────────────────── */}
            <section className="mb-10">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">Lab results</h2>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<FaPlus size={11} />}
                  onPress={() => setLabModalOpen(true)}
                >
                  Result
                </Button>
              </div>
              {labGroups.length === 0 ? (
                <p className="text-default-400 text-sm">
                  No results yet. Send Janet a photo or PDF of the lab report and she'll log each value.
                </p>
              ) : (
                <div className="space-y-4">
                  {labGroups.map((g) => (
                    <div key={`${g.label}|${g.date}`} className="border border-default-200 rounded-md bg-default-50">
                      <div className="px-3 py-2 border-b border-default-200 flex justify-between text-sm">
                        <span className="font-medium">{g.label}</span>
                        <span className="text-default-500 text-xs">{fmtDate(g.date)}</span>
                      </div>
                      <table className="w-full text-sm">
                        <tbody>
                          {g.rows.map((r) => (
                            <tr key={r.id} className="border-b border-default-100 last:border-0">
                              <td className="px-3 py-1.5">{r.testName}</td>
                              <td className={`px-3 py-1.5 text-right ${LAB_FLAG_STYLES[r.flag ?? ""] ?? ""}`}>
                                {r.flag === "PENDING" ? "pending" : `${r.valueText ?? ""}${r.unit ? ` ${r.unit}` : ""}`}
                              </td>
                              <td className="px-3 py-1.5 text-right text-xs text-default-400 hidden sm:table-cell">
                                {r.referenceRange ?? ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ── Providers ────────────────────────────────────────── */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">Providers</h2>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<FaPlus size={11} />}
                  onPress={() => setProviderModalOpen(true)}
                >
                  Provider
                </Button>
              </div>
              {providers.length === 0 ? (
                <p className="text-default-400 text-sm">No providers yet.</p>
              ) : (
                <div className="space-y-2">
                  {providers.map((p) => (
                    <div key={p.id} className="border border-default-200 rounded-md p-3 bg-default-50 text-sm">
                      <div className="font-medium">
                        {p.name}
                        {p.specialty && <span className="text-default-500 font-normal"> · {p.specialty}</span>}
                      </div>
                      <div className="text-xs text-default-500 mt-0.5 flex flex-wrap gap-x-3">
                        {p.practice && <span>{p.practice}</span>}
                        {p.phone && <a href={`tel:${p.phone}`} className="text-primary">{p.phone}</a>}
                        {p.portalUrl && (
                          <a href={p.portalUrl} target="_blank" rel="noreferrer" className="text-primary">
                            Patient portal
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <VisitModal
        isOpen={visitModalOpen}
        onOpenChange={setVisitModalOpen}
        editing={editingVisit}
        personId={personId}
        pregnancyId={pregnancy?.id ?? null}
        providers={providers}
        onSaved={loadAll}
      />
      <LabModal
        isOpen={labModalOpen}
        onOpenChange={setLabModalOpen}
        personId={personId}
        onSaved={loadAll}
      />
      <ProviderModal
        isOpen={providerModalOpen}
        onOpenChange={setProviderModalOpen}
        personId={personId}
        onSaved={loadAll}
      />
    </DefaultLayout>
  );
}

// ── Pregnancy header ─────────────────────────────────────────────────────

function PregnancyHeader({ pregnancy, today }: { pregnancy: Pregnancy; today: string }) {
  const ga = gestationalAge(pregnancy.dueDate, today);
  const pct = Math.min(100, Math.max(0, (ga.days / 280) * 100));
  return (
    <section className="mb-8 border border-default-200 rounded-md p-4 bg-default-50">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <p className="text-3xl font-bold">{ga.label}</p>
          <p className="text-sm text-default-500">
            Trimester {ga.trimester} · {ga.daysToGo >= 0 ? `${ga.daysToGo} days to go` : `${-ga.daysToGo} days past due`}
          </p>
        </div>
        <div className="text-right text-sm">
          <p className="text-default-500">Due</p>
          <p className="font-medium">
            {new Date(`${pregnancy.dueDate}T12:00:00Z`).toLocaleDateString("en-US", {
              timeZone: "UTC",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
          {pregnancy.dueDateSource && (
            <p className="text-xs text-default-400">by {pregnancy.dueDateSource.toLowerCase()}</p>
          )}
        </div>
      </div>
      <div className="mt-4 h-2 rounded-full bg-default-200 overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-default-400">
        <span>0</span>
        <span>14w</span>
        <span>28w</span>
        <span>40w</span>
      </div>
    </section>
  );
}

// ── Create pregnancy ─────────────────────────────────────────────────────

function CreatePregnancy({ personId, onCreated }: { personId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [lmp, setLmp] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);

  const effectiveDue = due || (lmp ? dueDateFromLmp(lmp) : "");

  async function create() {
    if (!effectiveDue) return;
    setSaving(true);
    try {
      const { data, errors } = await client.models.homePregnancy.create({
        personId,
        lmpDate: lmp || lmpFromDueDate(effectiveDue),
        dueDate: effectiveDue,
        dueDateSource: due ? "OTHER" : "LMP",
        status: "ACTIVE",
      });
      if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "create failed");
      // Same seeding the agent's set_pregnancy does.
      for (const item of buildCareTimeline(effectiveDue)) {
        await client.models.homeCareItem.create({
          pregnancyId: data.id,
          key: item.key,
          title: item.title,
          category: item.category,
          optional: item.optional,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
          status: item.status,
          notes: item.notes,
          sortOrder: item.sortOrder,
        });
      }
      addToast({ title: "Pregnancy added", color: "success" });
      onCreated();
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="mb-8">
        <Button size="sm" variant="light" onPress={() => setOpen(true)}>
          Track a pregnancy
        </Button>
      </div>
    );
  }
  return (
    <section className="mb-8 border border-default-200 rounded-md p-4 bg-default-50 space-y-3">
      <p className="text-sm font-medium">Track a pregnancy</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <DateInput size="sm" label="First day of last period" value={lmp} onChange={setLmp} />
        <DateInput size="sm" label="…or due date" value={due} onChange={setDue} />
      </div>
      {effectiveDue && (
        <p className="text-xs text-default-500">
          Due {fmtDate(effectiveDue)} · currently {gestationalAge(effectiveDue, ymdInTimezone(TZ)).label}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" color="primary" variant="flat" isDisabled={!effectiveDue} isLoading={saving} onPress={create}>
          Create
        </Button>
        <Button size="sm" variant="light" onPress={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

// ── Visit modal ──────────────────────────────────────────────────────────

function VisitModal({
  isOpen,
  onOpenChange,
  editing,
  personId,
  pregnancyId,
  providers,
  onSaved,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Visit | null;
  personId: string;
  pregnancyId: string | null;
  providers: Provider[];
  onSaved: () => void;
}) {
  const [visitAt, setVisitAt] = useState("");
  const [kind, setKind] = useState<string>("PRENATAL");
  const [status, setStatus] = useState<string>("PLANNED");
  const [title, setTitle] = useState("");
  const [providerId, setProviderId] = useState("");
  const [questions, setQuestions] = useState("");
  const [notes, setNotes] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [weight, setWeight] = useState("");
  const [bpSys, setBpSys] = useState("");
  const [bpDia, setBpDia] = useState("");
  const [fhr, setFhr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setVisitAt(toLocalInput(editing?.visitAt));
    setKind(editing?.kind ?? "PRENATAL");
    setStatus(editing?.status ?? "PLANNED");
    setTitle(editing?.title ?? "");
    setProviderId(editing?.providerId ?? "");
    setQuestions(editing?.questions ?? "");
    setNotes(editing?.notes ?? "");
    setFollowUp(editing?.followUp ?? "");
    setWeight(editing?.weightLb != null ? String(editing.weightLb) : "");
    setBpSys(editing?.bpSystolic != null ? String(editing.bpSystolic) : "");
    setBpDia(editing?.bpDiastolic != null ? String(editing.bpDiastolic) : "");
    setFhr(editing?.fetalHeartRate != null ? String(editing.fetalHeartRate) : "");
  }, [isOpen, editing]);

  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const int = (s: string) => (s.trim() === "" ? null : Math.round(Number(s)));

  async function save(onClose: () => void) {
    if (!visitAt) {
      addToast({ title: "Pick a date and time", color: "warning" });
      return;
    }
    setSaving(true);
    try {
      const fields = {
        visitAt: new Date(visitAt).toISOString(),
        kind: kind as Visit["kind"],
        status: status as Visit["status"],
        title: title.trim() || null,
        providerId: providerId || null,
        questions: questions.trim() || null,
        notes: notes.trim() || null,
        followUp: followUp.trim() || null,
        weightLb: num(weight),
        bpSystolic: int(bpSys),
        bpDiastolic: int(bpDia),
        fetalHeartRate: int(fhr),
      };
      const { errors } = editing
        ? await client.models.homeMedicalVisit.update({ id: editing.id, ...fields })
        : await client.models.homeMedicalVisit.create({
            personId,
            pregnancyId,
            createdBy: "ui",
            ...fields,
          });
      if (errors?.length) throw new Error(errors[0].message);
      addToast({ title: editing ? "Visit updated" : "Visit added", color: "success" });
      onClose();
      onSaved();
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(onClose: () => void) {
    if (!editing || !confirm("Delete this visit?")) return;
    const { errors } = await client.models.homeMedicalVisit.delete({ id: editing.id });
    if (errors?.length) {
      addToast({ title: "Delete failed", description: errors[0].message, color: "danger" });
      return;
    }
    onClose();
    onSaved();
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl" scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{editing ? "Edit visit" : "New visit"}</ModalHeader>
            <ModalBody>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  type="datetime-local"
                  label="When"
                  placeholder=" "
                  value={visitAt}
                  onValueChange={setVisitAt}
                  isRequired
                />
                <Select
                  label="Status"
                  selectedKeys={[status]}
                  onChange={(e) => e.target.value && setStatus(e.target.value)}
                >
                  <SelectItem key="PLANNED">Planned</SelectItem>
                  <SelectItem key="COMPLETED">Completed</SelectItem>
                  <SelectItem key="CANCELLED">Cancelled</SelectItem>
                </Select>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Select
                  label="Kind"
                  selectedKeys={[kind]}
                  onChange={(e) => e.target.value && setKind(e.target.value)}
                >
                  {VISIT_KINDS.map((k) => (
                    <SelectItem key={k}>{VISIT_KIND_LABELS[k]}</SelectItem>
                  ))}
                </Select>
                <Select
                  label="Provider"
                  selectedKeys={providerId ? [providerId] : []}
                  onChange={(e) => setProviderId(e.target.value)}
                  isDisabled={providers.length === 0}
                >
                  {providers.map((p) => (
                    <SelectItem key={p.id}>{p.name}</SelectItem>
                  ))}
                </Select>
              </div>
              <Input label="Title" placeholder="Intake visit, dating ultrasound…" value={title} onValueChange={setTitle} />
              <Textarea
                label="Questions to ask"
                placeholder="- Is it OK to keep flying?"
                value={questions}
                onValueChange={setQuestions}
                minRows={2}
              />
              {status === "COMPLETED" && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Input label="Weight (lb)" inputMode="decimal" value={weight} onValueChange={setWeight} />
                    <Input label="BP systolic" inputMode="numeric" value={bpSys} onValueChange={setBpSys} />
                    <Input label="BP diastolic" inputMode="numeric" value={bpDia} onValueChange={setBpDia} />
                    <Input label="Fetal HR" inputMode="numeric" value={fhr} onValueChange={setFhr} />
                  </div>
                  <Textarea label="Notes" value={notes} onValueChange={setNotes} minRows={3} />
                  <Textarea label="Follow-up" value={followUp} onValueChange={setFollowUp} minRows={1} />
                </>
              )}
            </ModalBody>
            <ModalFooter>
              {editing && (
                <Button variant="light" color="danger" className="mr-auto" onPress={() => remove(onClose)}>
                  Delete
                </Button>
              )}
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button color="primary" isLoading={saving} onPress={() => save(onClose)}>
                Save
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

// ── Lab result modal (single row; bulk entry goes through Janet) ─────────

function LabModal({
  isOpen,
  onOpenChange,
  personId,
  onSaved,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  personId: string;
  onSaved: () => void;
}) {
  const [testName, setTestName] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [range, setRange] = useState("");
  const [flag, setFlag] = useState("");
  const [panel, setPanel] = useState("");
  const [collectedAt, setCollectedAt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setTestName("");
    setValue("");
    setUnit("");
    setRange("");
    setFlag("");
    setPanel("");
    setCollectedAt(ymdInTimezone(TZ));
  }, [isOpen]);

  async function save(onClose: () => void) {
    if (!testName.trim()) return;
    setSaving(true);
    try {
      const n = Number(value);
      const { errors } = await client.models.homeLabResult.create({
        personId,
        testName: testName.trim(),
        valueText: value.trim() || null,
        valueNum: value.trim() !== "" && Number.isFinite(n) ? n : null,
        unit: unit.trim() || null,
        referenceRange: range.trim() || null,
        flag: (flag || null) as LabResult["flag"],
        panel: panel.trim() || null,
        collectedAt: collectedAt || null,
        createdBy: "ui",
      });
      if (errors?.length) throw new Error(errors[0].message);
      onClose();
      onSaved();
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>New lab result</ModalHeader>
            <ModalBody>
              <Input label="Test" placeholder="Hemoglobin" value={testName} onValueChange={setTestName} isRequired />
              <div className="grid grid-cols-2 gap-2">
                <Input label="Value" placeholder="11.8" value={value} onValueChange={setValue} />
                <Input label="Unit" placeholder="g/dL" value={unit} onValueChange={setUnit} />
                <Input label="Reference range" placeholder="11.1–15.9" value={range} onValueChange={setRange} />
                <Select label="Flag" selectedKeys={flag ? [flag] : []} onChange={(e) => setFlag(e.target.value)}>
                  {["NORMAL", "LOW", "HIGH", "ABNORMAL", "POSITIVE", "NEGATIVE", "PENDING"].map((f) => (
                    <SelectItem key={f}>{f.charAt(0) + f.slice(1).toLowerCase()}</SelectItem>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input label="Panel" placeholder="First-trimester labs" value={panel} onValueChange={setPanel} />
                <DateInput label="Collected" value={collectedAt} onChange={setCollectedAt} />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button color="primary" isDisabled={!testName.trim()} isLoading={saving} onPress={() => save(onClose)}>
                Save
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

// ── Provider modal ───────────────────────────────────────────────────────

function ProviderModal({
  isOpen,
  onOpenChange,
  personId,
  onSaved,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  personId: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [practice, setPractice] = useState("");
  const [phone, setPhone] = useState("");
  const [portalUrl, setPortalUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setSpecialty("");
    setPractice("");
    setPhone("");
    setPortalUrl("");
  }, [isOpen]);

  async function save(onClose: () => void) {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const { errors } = await client.models.homeHealthProvider.create({
        name: name.trim(),
        specialty: specialty.trim() || null,
        practice: practice.trim() || null,
        phone: phone.trim() || null,
        portalUrl: portalUrl.trim() || null,
        personIds: personId ? [personId] : [],
        active: true,
      });
      if (errors?.length) throw new Error(errors[0].message);
      onClose();
      onSaved();
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>New provider</ModalHeader>
            <ModalBody>
              <Input label="Name" placeholder="Dr. Smith" value={name} onValueChange={setName} isRequired />
              <div className="grid grid-cols-2 gap-2">
                <Input label="Specialty" placeholder="OB/GYN" value={specialty} onValueChange={setSpecialty} />
                <Input label="Practice" value={practice} onValueChange={setPractice} />
                <Input label="Phone" type="tel" value={phone} onValueChange={setPhone} />
                <Input label="Portal URL" type="url" value={portalUrl} onValueChange={setPortalUrl} />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button color="primary" isDisabled={!name.trim()} isLoading={saving} onPress={() => save(onClose)}>
                Save
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
