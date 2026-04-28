// Pets list. One row per active homePet (inactive rows hidden by
// default). Tap to drill into the detail screen with medications +
// vaccines. The "+" header opens PetFormModal in create mode.
//
// Today the household has one pet (Dolce); the list still works
// for a multi-pet future and gives us a sane "no pets yet"
// empty state.

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import {
  SPECIES_EMOJI,
  ageLabel,
  type Pet,
  type PetSpecies,
} from "../../../../lib/pets";
import { PetFormModal } from "../../../../components/PetFormModal";

export default function PetsList() {
  const [pets, setPets] = useState<Pet[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homePet.list();
    const sorted = (data ?? [])
      .filter((p) => p.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name));
    setPets(sorted);
    setLoading(false);
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
        <Text style={styles.heading}>Pets</Text>
        <Pressable
          onPress={() => setModalOpen(true)}
          hitSlop={12}
          style={styles.addBtn}
        >
          <Ionicons name="add" size={28} color="#735f55" />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={pets}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.listBody}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              No pets yet. Tap + to add Dolce.
            </Text>
          }
          renderItem={({ item }) => (
            <PetRow
              pet={item}
              onPress={() => router.push(`/more/pets/${item.id}`)}
            />
          )}
        />
      )}

      <PetFormModal
        visible={modalOpen}
        pet={null}
        onClose={() => setModalOpen(false)}
        onSaved={() => load()}
      />
    </SafeAreaView>
  );
}

function PetRow({ pet, onPress }: { pet: Pet; onPress: () => void }) {
  const species = (pet.species as PetSpecies | null) ?? "OTHER";
  const age = ageLabel(pet.dob);
  const meta = [pet.breed, age, pet.weight].filter(Boolean).join(" · ");
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Text style={styles.rowEmoji}>{SPECIES_EMOJI[species]}</Text>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{pet.name}</Text>
        {!!meta && <Text style={styles.rowMeta}>{meta}</Text>}
      </View>
      <Ionicons name="chevron-forward" size={18} color="#bbb" />
    </Pressable>
  );
}

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
  heading: { fontSize: 28, fontWeight: "600", flex: 1 },
  addBtn: { padding: 4, paddingRight: 8 },

  listBody: { paddingHorizontal: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: "#fff",
    borderRadius: 10,
    marginVertical: 3,
    gap: 12,
  },
  rowEmoji: { fontSize: 28 },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 16, color: "#222", fontWeight: "500" },
  rowMeta: { fontSize: 13, color: "#666", marginTop: 2 },
});
