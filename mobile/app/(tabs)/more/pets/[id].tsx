// Pet detail. Header card with the basics + sections for
// Medications and Vaccines that match the pattern used elsewhere
// (Tasks / Documents / Trips). "+" buttons in each section header
// open the matching form modal in create mode; tap a row to edit.

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import {
  SPECIES_EMOJI,
  SPECIES_LABEL,
  ageLabel,
  compareMedications,
  compareVaccines,
  formatDate,
  isVaccineDueSoon,
  nextDueLabel,
  type Pet,
  type PetMedication,
  type PetSpecies,
  type PetVaccine,
} from "../../../../lib/pets";
import { PetFormModal } from "../../../../components/PetFormModal";
import { PetMedicationFormModal } from "../../../../components/PetMedicationFormModal";
import { PetVaccineFormModal } from "../../../../components/PetVaccineFormModal";

interface PetData {
  pet: Pet;
  meds: PetMedication[];
  vaccines: PetVaccine[];
}

export default function PetDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<PetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [petModalOpen, setPetModalOpen] = useState(false);
  const [medModalOpen, setMedModalOpen] = useState(false);
  const [editingMed, setEditingMed] = useState<PetMedication | null>(null);
  const [vacModalOpen, setVacModalOpen] = useState(false);
  const [editingVac, setEditingVac] = useState<PetVaccine | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const client = getClient();
    const [petRes, medsRes, vacRes] = await Promise.all([
      client.models.homePet.get({ id }),
      client.models.homePetMedication.list({ filter: { petId: { eq: id } } }),
      client.models.homePetVaccine.list({ filter: { petId: { eq: id } } }),
    ]);
    if (!petRes.data) {
      setData(null);
      setLoading(false);
      return;
    }
    setData({
      pet: petRes.data,
      meds: (medsRes.data ?? []).slice().sort(compareMedications),
      vaccines: (vacRes.data ?? []).slice().sort(compareVaccines),
    });
    setLoading(false);
  }, [id]);

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

  function openMed(med: PetMedication | null) {
    setEditingMed(med);
    setMedModalOpen(true);
  }
  function openVac(vac: PetVaccine | null) {
    setEditingVac(vac);
    setVacModalOpen(true);
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={28} color="#735f55" />
        </Pressable>
        <Text style={styles.heading} numberOfLines={1}>
          {data?.pet.name ?? "Pet"}
        </Text>
        {data?.pet && (
          <Pressable
            onPress={() => setPetModalOpen(true)}
            hitSlop={12}
            style={styles.editBtn}
          >
            <Ionicons name="pencil" size={20} color="#735f55" />
          </Pressable>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : !data ? (
        <Text style={styles.empty}>Pet not found.</Text>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          <PetHeaderCard pet={data.pet} />

          <SectionHeader
            title="Medications"
            onAdd={() => openMed(null)}
          />
          {data.meds.length === 0 ? (
            <EmptyCard>No medications recorded.</EmptyCard>
          ) : (
            <View style={styles.card}>
              {data.meds.map((m, i) => (
                <MedicationRow
                  key={m.id}
                  med={m}
                  divider={i < data.meds.length - 1}
                  onPress={() => openMed(m)}
                />
              ))}
            </View>
          )}

          <SectionHeader
            title="Vaccines"
            onAdd={() => openVac(null)}
          />
          {data.vaccines.length === 0 ? (
            <EmptyCard>No vaccines recorded.</EmptyCard>
          ) : (
            <View style={styles.card}>
              {data.vaccines.map((v, i) => (
                <VaccineRow
                  key={v.id}
                  vaccine={v}
                  divider={i < data.vaccines.length - 1}
                  onPress={() => openVac(v)}
                />
              ))}
            </View>
          )}

          {(data.pet.foodBrand || data.pet.foodNotes) && (
            <>
              <SectionHeader title="Food" />
              <View style={styles.infoCard}>
                {!!data.pet.foodBrand && (
                  <Text style={styles.infoTitle}>{data.pet.foodBrand}</Text>
                )}
                {!!data.pet.foodNotes && (
                  <Text style={styles.infoBody}>{data.pet.foodNotes}</Text>
                )}
              </View>
            </>
          )}

          {(data.pet.vetName || data.pet.vetPhone) && (
            <>
              <SectionHeader title="Vet" />
              <View style={styles.infoCard}>
                {!!data.pet.vetName && (
                  <Text style={styles.infoTitle}>{data.pet.vetName}</Text>
                )}
                {!!data.pet.vetPhone && (
                  <Text style={styles.infoBody} selectable>
                    {data.pet.vetPhone}
                  </Text>
                )}
              </View>
            </>
          )}

          {!!data.pet.notes && (
            <>
              <SectionHeader title="Notes" />
              <View style={styles.infoCard}>
                <Text style={styles.infoBody}>{data.pet.notes}</Text>
              </View>
            </>
          )}
        </ScrollView>
      )}

      {data?.pet && (
        <>
          <PetFormModal
            visible={petModalOpen}
            pet={data.pet}
            onClose={() => setPetModalOpen(false)}
            onSaved={() => load()}
          />
          <PetMedicationFormModal
            visible={medModalOpen}
            petId={data.pet.id}
            medication={editingMed}
            onClose={() => setMedModalOpen(false)}
            onSaved={() => load()}
          />
          <PetVaccineFormModal
            visible={vacModalOpen}
            petId={data.pet.id}
            vaccine={editingVac}
            onClose={() => setVacModalOpen(false)}
            onSaved={() => load()}
          />
        </>
      )}
    </SafeAreaView>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function PetHeaderCard({ pet }: { pet: Pet }) {
  const species = (pet.species as PetSpecies | null) ?? "OTHER";
  const age = ageLabel(pet.dob);
  const meta = [pet.breed, SPECIES_LABEL[species], age, pet.weight]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={styles.headerCard}>
      <Text style={styles.headerEmoji}>{SPECIES_EMOJI[species]}</Text>
      <Text style={styles.headerName}>{pet.name}</Text>
      {!!meta && <Text style={styles.headerMeta}>{meta}</Text>}
      {!!pet.color && <Text style={styles.headerMetaQuiet}>{pet.color}</Text>}
    </View>
  );
}

function SectionHeader({
  title,
  onAdd,
}: {
  title: string;
  onAdd?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionLabel}>{title}</Text>
      {onAdd && (
        <Pressable onPress={onAdd} hitSlop={12}>
          <Ionicons name="add" size={20} color="#735f55" />
        </Pressable>
      )}
    </View>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.empty}>{children}</Text>
    </View>
  );
}

function MedicationRow({
  med,
  divider,
  onPress,
}: {
  med: PetMedication;
  divider: boolean;
  onPress: () => void;
}) {
  const inactive = med.isActive === false;
  const meta = [med.dosage, med.schedule].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, divider && styles.rowDivider]}
    >
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, inactive && styles.rowTitleInactive]}>
          {med.name}
          {inactive ? " (inactive)" : ""}
        </Text>
        {!!meta && <Text style={styles.rowMeta}>{meta}</Text>}
        {!!med.refillsRemaining && med.refillsRemaining > 0 && (
          <Text style={styles.rowMetaQuiet}>
            {med.refillsRemaining} refill{med.refillsRemaining === 1 ? "" : "s"}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={16} color="#bbb" />
    </Pressable>
  );
}

function VaccineRow({
  vaccine,
  divider,
  onPress,
}: {
  vaccine: PetVaccine;
  divider: boolean;
  onPress: () => void;
}) {
  const due = nextDueLabel(vaccine.nextDueAt);
  const dueSoon = isVaccineDueSoon(vaccine);
  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, divider && styles.rowDivider]}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{vaccine.name}</Text>
        <Text style={styles.rowMeta}>
          Given {formatDate(vaccine.administeredAt)}
          {vaccine.administeredBy ? `  •  ${vaccine.administeredBy}` : ""}
        </Text>
        {due && (
          <Text style={[styles.rowMetaQuiet, dueSoon && styles.rowMetaWarn]}>
            {due}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={16} color="#bbb" />
    </Pressable>
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
  editBtn: { padding: 8 },

  body: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 16, textAlign: "center" },

  headerCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 18,
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    marginBottom: 16,
    gap: 4,
  },
  headerEmoji: { fontSize: 56, marginBottom: 4 },
  headerName: { fontSize: 22, fontWeight: "600", color: "#222" },
  headerMeta: { fontSize: 13, color: "#666" },
  headerMetaQuiet: { fontSize: 12, color: "#888" },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 6,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

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
    gap: 4,
  },
  infoTitle: { fontSize: 15, color: "#222", fontWeight: "500" },
  infoBody: { fontSize: 14, color: "#444", lineHeight: 20 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 15, color: "#222", fontWeight: "500" },
  rowTitleInactive: { color: "#888" },
  rowMeta: { fontSize: 13, color: "#666", marginTop: 2 },
  rowMetaQuiet: { fontSize: 12, color: "#888", marginTop: 1 },
  rowMetaWarn: { color: "#a44", fontWeight: "500" },
});
