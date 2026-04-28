// Create / edit a homePet row.
//
// Photos are deferred to the photos phase; for now a species emoji
// is the visual identity. Same chip + text-input layout as the
// other form modals.

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { getClient } from "../lib/amplify";
import {
  SPECIES_EMOJI,
  SPECIES_LABEL,
  type Pet,
  type PetSpecies,
} from "../lib/pets";

interface Props {
  visible: boolean;
  pet: Pet | null;
  onClose: () => void;
  onSaved: (pet: Pet) => void;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SPECIES_LIST: PetSpecies[] = ["DOG", "CAT", "OTHER"];

export function PetFormModal({ visible, pet, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [species, setSpecies] = useState<PetSpecies>("DOG");
  const [breed, setBreed] = useState("");
  const [dob, setDob] = useState("");
  const [color, setColor] = useState("");
  const [weight, setWeight] = useState("");
  const [microchipId, setMicrochipId] = useState("");
  const [vetName, setVetName] = useState("");
  const [vetPhone, setVetPhone] = useState("");
  const [foodBrand, setFoodBrand] = useState("");
  const [foodNotes, setFoodNotes] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (pet) {
      setName(pet.name);
      setSpecies((pet.species as PetSpecies | null) ?? "DOG");
      setBreed(pet.breed ?? "");
      setDob(pet.dob ?? "");
      setColor(pet.color ?? "");
      setWeight(pet.weight ?? "");
      setMicrochipId(pet.microchipId ?? "");
      setVetName(pet.vetName ?? "");
      setVetPhone(pet.vetPhone ?? "");
      setFoodBrand(pet.foodBrand ?? "");
      setFoodNotes(pet.foodNotes ?? "");
      setNotes(pet.notes ?? "");
      setActive(pet.active !== false);
    } else {
      setName("");
      setSpecies("DOG");
      setBreed("");
      setDob("");
      setColor("");
      setWeight("");
      setMicrochipId("");
      setVetName("");
      setVetPhone("");
      setFoodBrand("");
      setFoodNotes("");
      setNotes("");
      setActive(true);
    }
  }, [visible, pet]);

  async function save() {
    if (!name.trim()) {
      Alert.alert("Name required");
      return;
    }
    if (dob && !ISO_DATE_RE.test(dob)) {
      Alert.alert("Birth date must be YYYY-MM-DD");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        species,
        breed: breed.trim() || null,
        dob: dob || null,
        color: color.trim() || null,
        weight: weight.trim() || null,
        microchipId: microchipId.trim() || null,
        vetName: vetName.trim() || null,
        vetPhone: vetPhone.trim() || null,
        foodBrand: foodBrand.trim() || null,
        foodNotes: foodNotes.trim() || null,
        notes: notes.trim() || null,
        active,
      };
      const client = getClient();
      if (pet) {
        const { data, errors } = await client.models.homePet.update({
          id: pet.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
        if (data) onSaved(data);
      } else {
        const { data, errors } = await client.models.homePet.create(payload);
        if (errors?.length) throw new Error(errors[0].message);
        if (data) onSaved(data);
      }
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={onClose} disabled={busy}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle}>{pet ? "Edit pet" : "New pet"}</Text>
          <Pressable onPress={save} disabled={busy}>
            {busy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.save, !name.trim() && styles.disabled]}>
                Save
              </Text>
            )}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Dolce"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!pet}
          />

          <Text style={styles.label}>Species</Text>
          <View style={styles.chipRow}>
            {SPECIES_LIST.map((s) => {
              const on = species === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => setSpecies(s)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {SPECIES_EMOJI[s]} {SPECIES_LABEL[s]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.label}>Breed</Text>
          <TextInput
            style={styles.input}
            value={breed}
            onChangeText={setBreed}
            placeholder="Maltipoo"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Birth date (YYYY-MM-DD)</Text>
          <TextInput
            style={styles.input}
            value={dob}
            onChangeText={setDob}
            placeholder="2020-04-15"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={!busy}
          />

          <Text style={styles.label}>Color</Text>
          <TextInput
            style={styles.input}
            value={color}
            onChangeText={setColor}
            placeholder="White"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Weight</Text>
          <TextInput
            style={styles.input}
            value={weight}
            onChangeText={setWeight}
            placeholder="12 lb"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Microchip ID</Text>
          <TextInput
            style={styles.input}
            value={microchipId}
            onChangeText={setMicrochipId}
            placeholder="900..."
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />

          <Text style={styles.label}>Vet name</Text>
          <TextInput
            style={styles.input}
            value={vetName}
            onChangeText={setVetName}
            placeholder="Dr. Smith / Banfield"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Vet phone</Text>
          <TextInput
            style={styles.input}
            value={vetPhone}
            onChangeText={setVetPhone}
            placeholder="+15125551234"
            placeholderTextColor="#888"
            keyboardType="phone-pad"
            editable={!busy}
          />

          <Text style={styles.label}>Food brand</Text>
          <TextInput
            style={styles.input}
            value={foodBrand}
            onChangeText={setFoodBrand}
            placeholder="Hill's Science Diet small breed"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Food notes</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={foodNotes}
            onChangeText={setFoodNotes}
            placeholder="1/4 cup twice daily, no chicken"
            placeholderTextColor="#888"
            multiline
            editable={!busy}
          />

          <Text style={styles.label}>Notes</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Allergic to chicken, scared of vacuums"
            placeholderTextColor="#888"
            multiline
            editable={!busy}
          />

          <View style={styles.activeRow}>
            <Text style={styles.label}>Active</Text>
            <Switch value={active} onValueChange={setActive} disabled={busy} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
    backgroundColor: "#fff",
  },
  headerTitle: { fontSize: 16, fontWeight: "600" },
  cancel: { color: "#888", fontSize: 15 },
  save: { color: "#735f55", fontWeight: "600", fontSize: 15 },
  disabled: { opacity: 0.4 },

  body: { padding: 20, gap: 8, paddingBottom: 40 },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
  },
  input: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  multiline: { minHeight: 60, textAlignVertical: "top" },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  chipOn: { backgroundColor: "#735f55", borderColor: "#735f55" },
  chipText: { color: "#444", fontSize: 13 },
  chipTextOn: { color: "#fff" },

  activeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
});
