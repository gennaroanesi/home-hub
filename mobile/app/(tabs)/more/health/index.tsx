// Health — the phone version of the web /health page. Pick a household
// member (including a kid without a login); for them: the active
// pregnancy and its care timeline, upcoming and past visits, lab results;
// plus the household's providers. Every write goes through the same
// lib/health.ts / lib/pregnancy.ts helpers the web page and Janet use, so
// visits keep their calendar event and timeline item in step.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import { householdMembers } from "../../../../lib/household";
import { listAllPages } from "../../../../../lib/list-all";
import {
  HEALTH_TZ,
  PHONE_KIND_LABELS,
  defaultHealthPersonId,
  formatVisitDateTime,
  formatYmdShort,
  groupLabResults,
  labFlagTone,
  labValueLabel,
  providerPhones,
  setCareItemStatus,
  splitVisits,
  visitDisplayTitle,
  visitVitalsSummary,
} from "../../../../../lib/health";
import {
  CARE_CATEGORY_LABELS,
  CARE_STATUSES,
  CARE_STATUS_LABELS,
  CARE_URGENCY_LABELS,
  DUE_DATE_SOURCE_LABELS,
  careUrgency,
  gestationalAge,
  isOpenCareStatus,
  sortCareItems,
  ymdInTimezone,
  type CareCategory,
  type CareStatus,
  type CareUrgency,
} from "../../../../../lib/pregnancy";
import { AttachmentSection } from "../../../../components/AttachmentSection";
import { VisitFormModal } from "../../../../components/health/VisitFormModal";
import { CareItemFormModal } from "../../../../components/health/CareItemFormModal";
import { ProviderFormModal } from "../../../../components/health/ProviderFormModal";
import { PregnancyFormModal } from "../../../../components/health/PregnancyFormModal";
import { LabResultFormModal } from "../../../../components/health/LabResultFormModal";
import type { Schema } from "../../../../../amplify/data/resource";

type Person = Schema["homePerson"]["type"];
type Pregnancy = Schema["homePregnancy"]["type"];
type CareItem = Schema["homeCareItem"]["type"];
type Visit = Schema["homeMedicalVisit"]["type"];
type LabResult = Schema["homeLabResult"]["type"];
type Provider = Schema["homeHealthProvider"]["type"];

const ACCENT = "#735f55";

const URGENCY_COLORS: Record<CareUrgency, { bg: string; fg: string }> = {
  OVERDUE: { bg: "#fde2e2", fg: "#a12b2b" },
  DUE_NOW: { bg: "#fdf0d5", fg: "#8a5a00" },
  SOON: { bg: "#e3ecfb", fg: "#2c4f8a" },
  LATER: { bg: "#efefef", fg: "#777" },
  BOOKED: { bg: "#dff3e4", fg: "#23703a" },
  CONFIRM: { bg: "#fdf0d5", fg: "#8a5a00" },
  CLOSED: { bg: "#efefef", fg: "#999" },
};

interface HealthData {
  people: Person[];
  pregnancies: Pregnancy[];
  careItems: CareItem[];
  visits: Visit[];
  labs: LabResult[];
  providers: Provider[];
}

export default function HealthScreen() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [personId, setPersonId] = useState("");
  const [showClosedCare, setShowClosedCare] = useState(false);
  const [openLabFiles, setOpenLabFiles] = useState<string | null>(null);
  const [showPastAll, setShowPastAll] = useState(false);

  const [visitModal, setVisitModal] = useState<{ visit: Visit | null } | null>(null);
  const [careModal, setCareModal] = useState<{ item: CareItem | null; preset: CareStatus | null } | null>(null);
  const [providerModal, setProviderModal] = useState<{ provider: Provider | null } | null>(null);
  const [pregnancyModalOpen, setPregnancyModalOpen] = useState(false);
  const [labModalOpen, setLabModalOpen] = useState(false);

  const today = ymdInTimezone(HEALTH_TZ);

  const load = useCallback(async () => {
    try {
      const client = getClient();
      const [ppl, preg, care, vis, lab, prov] = await Promise.all([
        listAllPages<Person>(client.models.homePerson),
        listAllPages<Pregnancy>(client.models.homePregnancy),
        listAllPages<CareItem>(client.models.homeCareItem),
        listAllPages<Visit>(client.models.homeMedicalVisit),
        listAllPages<LabResult>(client.models.homeLabResult),
        listAllPages<Provider>(client.models.homeHealthProvider),
      ]);
      const household = householdMembers(ppl);
      setData({
        people: household.length > 0 ? household : ppl.filter((p) => p.active !== false),
        pregnancies: preg,
        careItems: care,
        visits: vis,
        labs: lab,
        providers: prov.filter((p) => p.active !== false),
      });
      setPersonId((cur) => cur || defaultHealthPersonId(preg, household, ppl));
    } catch (err: any) {
      Alert.alert("Couldn't load health records", err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const pregnancy = useMemo(
    () => data?.pregnancies.find((p) => p.personId === personId && p.status === "ACTIVE") ?? null,
    [data, personId],
  );
  const pregnancyCare = useMemo(
    () => (pregnancy && data ? sortCareItems(data.careItems.filter((c) => c.pregnancyId === pregnancy.id)) : []),
    [data, pregnancy],
  );
  const { upcoming, past } = useMemo(
    () => splitVisits((data?.visits ?? []).filter((v) => v.personId === personId)),
    [data, personId],
  );
  const labGroups = useMemo(
    () => groupLabResults((data?.labs ?? []).filter((l) => l.personId === personId)),
    [data, personId],
  );

  const providerName = (id: string | null | undefined) => data?.providers.find((p) => p.id === id)?.name ?? null;
  const pregnancyById = (id: string | null | undefined) => data?.pregnancies.find((p) => p.id === id) ?? null;

  function pickCareStatus(item: CareItem) {
    Alert.alert(item.title, "Set status", [
      ...CARE_STATUSES.map((s) => ({
        text: CARE_STATUS_LABELS[s] + (s === item.status ? " ✓" : ""),
        onPress: () => void changeCareStatus(item, s),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  async function changeCareStatus(item: CareItem, status: CareStatus) {
    // Scheduling or completing needs a real date — ask for it.
    if (status === "SCHEDULED" || status === "DONE") {
      setCareModal({ item, preset: status });
      return;
    }
    try {
      const updated = (await setCareItemStatus(getClient(), item.id, status)) as unknown as CareItem;
      setData((d) => (d ? { ...d, careItems: d.careItems.map((c) => (c.id === updated.id ? updated : c)) } : d));
    } catch (err: any) {
      Alert.alert("Update failed", err?.message ?? String(err));
    }
  }

  const visiblePast = showPastAll ? past : past.slice(0, 10);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color={ACCENT} />
        </Pressable>
        <Text style={styles.heading}>Health</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : !data ? (
        <Text style={styles.empty}>Couldn't load health records.</Text>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {data.people.length > 1 && (
            <ScrollView horizontal style={{ flexGrow: 0, flexShrink: 0 }} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.personRow}>
              {data.people.map((p) => {
                const on = p.id === personId;
                return (
                  <Pressable key={p.id} onPress={() => setPersonId(p.id)} style={[styles.personChip, on && styles.personChipOn]}>
                    <Text style={[styles.personChipText, on && styles.personChipTextOn]}>
                      {p.emoji ? `${p.emoji} ` : ""}
                      {p.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          {/* ── Pregnancy ─────────────────────────────────────────── */}
          {pregnancy ? (
            <PregnancyCard pregnancy={pregnancy} today={today} onEdit={() => setPregnancyModalOpen(true)} />
          ) : (
            !!personId && (
              <Pressable onPress={() => setPregnancyModalOpen(true)} style={styles.trackBtn}>
                <Text style={styles.trackBtnText}>Track a pregnancy</Text>
              </Pressable>
            )
          )}

          {pregnancy && (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionLabel}>Care timeline</Text>
                <View style={styles.sectionActions}>
                  <Pressable onPress={() => setShowClosedCare((v) => !v)} hitSlop={8}>
                    <Text style={styles.sectionLink}>{showClosedCare ? "Hide done" : "Show all"}</Text>
                  </Pressable>
                  <Pressable onPress={() => setCareModal({ item: null, preset: null })} hitSlop={12}>
                    <Ionicons name="add" size={20} color={ACCENT} />
                  </Pressable>
                </View>
              </View>
              <CareList
                items={pregnancyCare.filter((c) => showClosedCare || isOpenCareStatus(c.status))}
                today={today}
                onOpen={(c) => setCareModal({ item: c, preset: null })}
                onStatus={pickCareStatus}
              />

              <View style={styles.sectionHeader}>
                <Text style={styles.sectionLabel}>Scans & media</Text>
              </View>
              <View style={styles.infoCard}>
                <AttachmentSection parentType="PREGNANCY" parentId={pregnancy.id} />
                <Text style={styles.rowMetaQuiet}>
                  Files on visits and timeline items are inside each one.
                </Text>
              </View>
            </>
          )}

          {/* ── Visits ────────────────────────────────────────────── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>Upcoming visits</Text>
            <Pressable onPress={() => setVisitModal({ visit: null })} hitSlop={12}>
              <Ionicons name="add" size={20} color={ACCENT} />
            </Pressable>
          </View>
          {upcoming.length === 0 ? (
            <EmptyCard>Nothing booked. Add a visit, or tell Janet about an appointment.</EmptyCard>
          ) : (
            <View style={styles.card}>
              {upcoming.map((v, i) => (
                <VisitRow
                  key={v.id}
                  visit={v}
                  divider={i < upcoming.length - 1}
                  providerName={providerName(v.providerId)}
                  pregnancy={pregnancyById(v.pregnancyId)}
                  onPress={() => setVisitModal({ visit: v })}
                />
              ))}
            </View>
          )}

          {past.length > 0 && (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionLabel}>Past visits</Text>
              </View>
              <View style={styles.card}>
                {visiblePast.map((v, i) => (
                  <VisitRow
                    key={v.id}
                    visit={v}
                    divider={i < visiblePast.length - 1}
                    providerName={providerName(v.providerId)}
                    pregnancy={pregnancyById(v.pregnancyId)}
                    onPress={() => setVisitModal({ visit: v })}
                  />
                ))}
              </View>
              {past.length > visiblePast.length && (
                <Pressable onPress={() => setShowPastAll(true)} style={styles.moreBtn}>
                  <Text style={styles.sectionLink}>Show all {past.length}</Text>
                </Pressable>
              )}
            </>
          )}

          {/* ── Lab results ──────────────────────────────────────── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>Lab results</Text>
            <Pressable onPress={() => setLabModalOpen(true)} hitSlop={12}>
              <Ionicons name="add" size={20} color={ACCENT} />
            </Pressable>
          </View>
          {labGroups.length === 0 ? (
            <EmptyCard>No results yet. Send Janet a photo or PDF of the lab report and she'll log each value.</EmptyCard>
          ) : (
            labGroups.map((g) => {
              const filesOpen = openLabFiles === g.key;
              return (
                <View key={g.key} style={styles.card}>
                  <View style={[styles.labHeader, styles.rowDivider]}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {g.label}
                    </Text>
                    <View style={styles.sectionActions}>
                      <Pressable onPress={() => setOpenLabFiles(filesOpen ? null : g.key)} hitSlop={8}>
                        <Text style={styles.sectionLink}>{filesOpen ? "Hide files" : "Files"}</Text>
                      </Pressable>
                      <Text style={styles.rowMetaQuiet}>{formatYmdShort(g.date)}</Text>
                    </View>
                  </View>
                  {filesOpen && (
                    <View style={[styles.labFiles, styles.rowDivider]}>
                      {/* Report files hang off the panel's first row. */}
                      <AttachmentSection parentType="LAB_RESULT" parentId={g.rows[0].id} />
                    </View>
                  )}
                  {g.rows.map((r, i) => {
                    const tone = labFlagTone(r.flag);
                    return (
                      <View key={r.id} style={[styles.labRow, i < g.rows.length - 1 && styles.rowDivider]}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.labTest}>{r.testName}</Text>
                          {!!r.referenceRange && <Text style={styles.rowMetaQuiet}>{r.referenceRange}</Text>}
                        </View>
                        <Text
                          style={[
                            styles.labValue,
                            tone === "danger" && { color: "#b42318" },
                            tone === "warning" && { color: "#a66a00" },
                            tone === "pending" && { color: "#999", fontStyle: "italic" },
                          ]}
                        >
                          {labValueLabel(r)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              );
            })
          )}

          {/* ── Providers ────────────────────────────────────────── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>Providers</Text>
            <Pressable onPress={() => setProviderModal({ provider: null })} hitSlop={12}>
              <Ionicons name="add" size={20} color={ACCENT} />
            </Pressable>
          </View>
          {data.providers.length === 0 ? (
            <EmptyCard>No providers yet.</EmptyCard>
          ) : (
            <View style={styles.card}>
              {data.providers.map((p, i) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  divider={i < data.providers.length - 1}
                  onPress={() => setProviderModal({ provider: p })}
                />
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {data && (
        <>
          <VisitFormModal
            visible={!!visitModal}
            visit={visitModal?.visit ?? null}
            personId={personId}
            pregnancyId={pregnancy?.id ?? null}
            providers={data.providers}
            careItems={pregnancyCare}
            onClose={() => setVisitModal(null)}
            onSaved={() => load()}
          />
          <ProviderFormModal
            visible={!!providerModal}
            provider={providerModal?.provider ?? null}
            personId={personId}
            onClose={() => setProviderModal(null)}
            onSaved={() => load()}
          />
          <LabResultFormModal
            visible={labModalOpen}
            personId={personId}
            today={today}
            onClose={() => setLabModalOpen(false)}
            onSaved={() => load()}
          />
          <PregnancyFormModal
            visible={pregnancyModalOpen}
            pregnancy={pregnancy}
            personId={personId}
            providers={data.providers}
            today={today}
            onClose={() => setPregnancyModalOpen(false)}
            onSaved={() => load()}
          />
          {pregnancy && (
            <CareItemFormModal
              visible={!!careModal}
              item={careModal?.item ?? null}
              presetStatus={careModal?.preset ?? null}
              pregnancyId={pregnancy.id}
              personId={pregnancy.personId}
              today={today}
              onClose={() => setCareModal(null)}
              onSaved={() => load()}
            />
          )}
        </>
      )}
    </SafeAreaView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function PregnancyCard({ pregnancy, today, onEdit }: { pregnancy: Pregnancy; today: string; onEdit: () => void }) {
  const ga = gestationalAge(pregnancy.dueDate, today);
  const pct = Math.min(100, Math.max(0, (ga.days / 280) * 100));
  const due = new Date(`${pregnancy.dueDate}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return (
    <View style={styles.pregCard}>
      <View style={styles.pregTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.pregGa}>{ga.label}</Text>
          <Text style={styles.rowMeta}>
            Trimester {ga.trimester} · {ga.daysToGo >= 0 ? `${ga.daysToGo} days to go` : `${-ga.daysToGo} days past due`}
          </Text>
        </View>
        <Pressable onPress={onEdit} hitSlop={10} style={{ alignItems: "flex-end" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={styles.rowMetaQuiet}>Due</Text>
            <Ionicons name="pencil" size={12} color={ACCENT} />
          </View>
          <Text style={styles.rowTitle}>{due}</Text>
          {!!pregnancy.dueDateSource && (
            <Text style={styles.rowMetaQuiet}>
              {DUE_DATE_SOURCE_LABELS[pregnancy.dueDateSource] ?? pregnancy.dueDateSource.toLowerCase()}
            </Text>
          )}
        </Pressable>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%` }]} />
      </View>
      <View style={styles.progressScale}>
        {["0", "14w", "28w", "40w"].map((l) => (
          <Text key={l} style={styles.progressLabel}>
            {l}
          </Text>
        ))}
      </View>
    </View>
  );
}

function CareList({
  items,
  today,
  onOpen,
  onStatus,
}: {
  items: CareItem[];
  today: string;
  onOpen: (c: CareItem) => void;
  onStatus: (c: CareItem) => void;
}) {
  if (items.length === 0) return <EmptyCard>Nothing open on the timeline.</EmptyCard>;
  return (
    <View style={styles.card}>
      {items.map((c, i) => {
        const urgency = careUrgency(
          { status: c.status, windowStart: c.windowStart, windowEnd: c.windowEnd, scheduledAt: c.scheduledAt },
          today,
        );
        const closed = urgency === "CLOSED";
        const booked = c.status === "SCHEDULED" && c.scheduledAt;
        const done = c.status === "DONE" && c.completedAt;
        const window = `${formatYmdShort(c.windowStart)} – ${formatYmdShort(c.windowEnd)}`;
        const when = booked
          ? formatVisitDateTime(c.scheduledAt!)
          : done
            ? `Done ${formatYmdShort(c.completedAt)}`
            : window;
        const colors = URGENCY_COLORS[urgency];
        return (
          <View key={c.id} style={[styles.row, i < items.length - 1 && styles.rowDivider, closed && { opacity: 0.6 }]}>
            <Pressable style={styles.rowMain} onPress={() => onOpen(c)}>
              <View style={styles.titleLine}>
                <Text style={[styles.rowTitle, closed && styles.strike]}>{c.title}</Text>
                {!!c.optional && <Text style={styles.optional}>OPTIONAL</Text>}
                {!closed && (
                  <View style={[styles.badge, { backgroundColor: colors.bg }]}>
                    <Text style={[styles.badgeText, { color: colors.fg }]}>{CARE_URGENCY_LABELS[urgency]}</Text>
                  </View>
                )}
              </View>
              <Text style={styles.rowMeta}>
                {c.category ? `${CARE_CATEGORY_LABELS[c.category as CareCategory]} · ` : ""}
                <Text style={(booked || done) && styles.rowMetaStrong}>{when}</Text>
                {c.visitId ? "  📅" : ""}
              </Text>
              {(booked || done) && <Text style={styles.rowMetaQuiet}>window {window}</Text>}
              {!!c.notes && (
                <Text style={styles.rowMetaQuiet} numberOfLines={3}>
                  {c.notes}
                </Text>
              )}
            </Pressable>
            <Pressable onPress={() => onStatus(c)} style={styles.statusPill} hitSlop={6}>
              <Text style={styles.statusPillText}>{CARE_STATUS_LABELS[(c.status ?? "UPCOMING") as CareStatus]}</Text>
              <Ionicons name="chevron-down" size={12} color={ACCENT} />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function VisitRow({
  visit: v,
  divider,
  providerName,
  pregnancy,
  onPress,
}: {
  visit: Visit;
  divider: boolean;
  providerName: string | null;
  pregnancy: Pregnancy | null;
  onPress: () => void;
}) {
  const ga = pregnancy ? gestationalAge(pregnancy.dueDate, ymdInTimezone(HEALTH_TZ, new Date(v.visitAt))).label : null;
  const vitals = visitVitalsSummary(v);
  const cancelled = v.status === "CANCELLED";
  return (
    <Pressable onPress={onPress} style={[styles.row, divider && styles.rowDivider]}>
      <View style={styles.rowMain}>
        <View style={styles.titleLine}>
          <Text style={[styles.rowTitle, cancelled && styles.strike]}>{visitDisplayTitle(v)}</Text>
          {v.status === "PLANNED" && (
            <View style={[styles.badge, { backgroundColor: "#e3ecfb" }]}>
              <Text style={[styles.badgeText, { color: "#2c4f8a" }]}>Planned</Text>
            </View>
          )}
          {cancelled && (
            <View style={[styles.badge, { backgroundColor: "#efefef" }]}>
              <Text style={[styles.badgeText, { color: "#777" }]}>Cancelled</Text>
            </View>
          )}
          {!!v.eventId && <Ionicons name="calendar-outline" size={13} color="#999" />}
        </View>
        <Text style={styles.rowMeta}>
          {formatVisitDateTime(v.visitAt)}
          {ga ? ` · ${ga}` : ""}
          {providerName ? ` · ${providerName}` : ""}
        </Text>
        {!!vitals && <Text style={styles.rowMetaStrong}>{vitals}</Text>}
        {v.status === "PLANNED" && !!v.questions && <Text style={styles.rowMetaQuiet}>{v.questions}</Text>}
        {v.status !== "PLANNED" && !!v.notes && (
          <Text style={styles.rowMetaQuiet} numberOfLines={2}>
            {v.notes}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={16} color="#bbb" />
    </Pressable>
  );
}

function ProviderRow({ provider: p, divider, onPress }: { provider: Provider; divider: boolean; onPress: () => void }) {
  const phones = providerPhones(p as Parameters<typeof providerPhones>[0]);
  return (
    <Pressable onPress={onPress} style={[styles.row, divider && styles.rowDivider]}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>
          {p.name}
          {!!p.specialty && <Text style={styles.rowMeta}> · {p.specialty}</Text>}
        </Text>
        {!!p.practice && <Text style={styles.rowMeta}>{p.practice}</Text>}
        {phones.map((ph, i) => (
          <Pressable key={i} onPress={() => Linking.openURL(`tel:${ph.number.replace(/[^\d+]/g, "")}`)} hitSlop={4}>
            <Text style={styles.link}>
              <Text style={styles.rowMetaQuiet}>{ph.label || (ph.kind ? PHONE_KIND_LABELS[ph.kind] : "Phone")}: </Text>
              {ph.number}
            </Text>
          </Pressable>
        ))}
        {!!p.portalUrl && (
          <Pressable onPress={() => Linking.openURL(p.portalUrl!)} hitSlop={4}>
            <Text style={styles.link}>Patient portal</Text>
          </Pressable>
        )}
        {!!p.address && <Text style={styles.rowMetaQuiet}>{p.address}</Text>}
      </View>
      <Ionicons name="chevron-forward" size={16} color="#bbb" />
    </Pressable>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.empty}>{children}</Text>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 4,
  },
  backBtn: { padding: 4 },
  heading: { fontSize: 22, fontWeight: "600", flex: 1 },

  body: { padding: 20, paddingTop: 4, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 16, textAlign: "center" },

  personRow: { gap: 8, paddingBottom: 12 },
  personChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  personChipOn: { backgroundColor: ACCENT, borderColor: ACCENT },
  personChipText: { color: "#444", fontSize: 14 },
  personChipTextOn: { color: "#fff", fontWeight: "500" },

  trackBtn: { alignSelf: "flex-start", paddingVertical: 6, marginBottom: 4 },
  trackBtnText: { color: ACCENT, fontWeight: "500", fontSize: 14 },

  pregCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    marginBottom: 8,
  },
  pregTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  pregGa: { fontSize: 30, fontWeight: "700", color: "#222" },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: "#eee", overflow: "hidden", marginTop: 14 },
  progressFill: { height: "100%", backgroundColor: ACCENT },
  progressScale: { flexDirection: "row", justifyContent: "space-between", marginTop: 3 },
  progressLabel: { fontSize: 10, color: "#999" },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 14,
    marginBottom: 6,
  },
  sectionActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionLink: { color: ACCENT, fontSize: 13, fontWeight: "500" },
  moreBtn: { alignItems: "center", paddingVertical: 6 },

  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    marginBottom: 8,
  },
  infoCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    marginBottom: 8,
    gap: 6,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 10,
  },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#eee" },
  rowMain: { flex: 1 },
  titleLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  rowTitle: { fontSize: 15, color: "#222", fontWeight: "500" },
  strike: { textDecorationLine: "line-through" },
  rowMeta: { fontSize: 13, color: "#666", marginTop: 2 },
  rowMetaStrong: { fontSize: 13, color: "#333", fontWeight: "500", marginTop: 2 },
  rowMetaQuiet: { fontSize: 12, color: "#888", marginTop: 2 },
  link: { fontSize: 13, color: ACCENT, marginTop: 3 },
  optional: { fontSize: 10, color: "#999", letterSpacing: 0.5 },

  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  badgeText: { fontSize: 11, fontWeight: "500" },

  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fafafa",
  },
  statusPillText: { fontSize: 12, color: "#444" },

  labHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  labFiles: { paddingHorizontal: 14, paddingVertical: 10 },
  labRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 8, gap: 10 },
  labTest: { fontSize: 14, color: "#222" },
  labValue: { fontSize: 14, color: "#222", fontWeight: "500", textAlign: "right" },
});
