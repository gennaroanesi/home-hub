// Create / edit a homePet row.
//
// Updates from feedback:
//   - KeyboardAvoidingView so the long form scrolls above the keyboard
//   - Native date picker for DOB (no more YYYY-MM-DD typing)
//   - Decimal-pad numeric weight with "lb" displayed as a suffix; the
//     stored value is just the number ("12.3"), the unit is part of
//     the UI not the data
//   - Photo picker (camera or library) → S3 upload via the shared
//     /api/documents/upload-url endpoint with prefix=pets
//
// Native modules used here that need a dev-client rebuild:
//   @react-native-community/datetimepicker (DOB picker)
//   expo-image-picker (already linked, no rebuild needed)

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";

import { getClient } from "../lib/amplify";
import { uploadDocumentFile } from "../lib/documents-upload";
import { originalImageUrl } from "../lib/image";
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

const SPECIES_LIST: PetSpecies[] = ["DOG", "CAT", "OTHER"];
const WEIGHT_RE = /^\d+(\.\d)?$/; // optional one decimal place

function isoDateOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDob(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function formatDobLabel(s: string): string {
  const d = parseDob(s);
  if (!d) return s;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function PetFormModal({ visible, pet, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [species, setSpecies] = useState<PetSpecies>("DOG");
  const [breed, setBreed] = useState("");
  const [dob, setDob] = useState("");
  const [showDobPicker, setShowDobPicker] = useState(false);
  const [color, setColor] = useState("");
  const [weight, setWeight] = useState("");
  const [microchipId, setMicrochipId] = useState("");
  const [vetName, setVetName] = useState("");
  const [vetPhone, setVetPhone] = useState("");
  const [foodBrand, setFoodBrand] = useState("");
  const [foodNotes, setFoodNotes] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  // Photo state. `existingS3Key` is the saved value from the row;
  // `pendingPhoto` is a freshly-picked local file we'll upload on
  // save. They never coexist — picking a new photo replaces the
  // existing key.
  const [existingS3Key, setExistingS3Key] = useState<string | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<{
    uri: string;
    contentType: string;
    filename: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
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
      setExistingS3Key(pet.photoS3Key ?? null);
      setPendingPhoto(null);
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
      setExistingS3Key(null);
      setPendingPhoto(null);
    }
    setShowDobPicker(false);
  }, [visible, pet]);

  // ── Photo pickers ────────────────────────────────────────────────────────

  async function pickFromCamera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera permission needed");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.85,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    setPendingPhoto({
      uri: a.uri,
      contentType: a.mimeType ?? "image/jpeg",
      filename: a.fileName ?? "pet.jpg",
    });
  }

  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Photo library permission needed");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.85,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    setPendingPhoto({
      uri: a.uri,
      contentType: a.mimeType ?? "image/jpeg",
      filename: a.fileName ?? "pet.jpg",
    });
  }

  function clearPhoto() {
    setExistingS3Key(null);
    setPendingPhoto(null);
  }

  // Show the freshly-picked file if any, else the saved one.
  const photoPreviewUri = pendingPhoto
    ? pendingPhoto.uri
    : existingS3Key
      ? originalImageUrl(existingS3Key)
      : null;

  // ── Save ─────────────────────────────────────────────────────────────────

  async function save() {
    if (!name.trim()) {
      Alert.alert("Name required");
      return;
    }
    if (weight && !WEIGHT_RE.test(weight)) {
      Alert.alert("Weight must be a number with up to one decimal");
      return;
    }
    setBusy(true);
    try {
      let photoS3Key: string | null = existingS3Key;
      if (pendingPhoto) {
        setUploading(true);
        try {
          const uploaded = await uploadDocumentFile({
            uri: pendingPhoto.uri,
            contentType: pendingPhoto.contentType,
            filename: pendingPhoto.filename,
            prefix: "pets",
          });
          photoS3Key = uploaded.s3Key;
        } finally {
          setUploading(false);
        }
      }

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
        photoS3Key,
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

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
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

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {/* Photo */}
          <View style={styles.photoBlock}>
            {photoPreviewUri ? (
              <Image source={{ uri: photoPreviewUri }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, styles.photoPlaceholder]}>
                <Text style={styles.photoPlaceholderEmoji}>
                  {SPECIES_EMOJI[species]}
                </Text>
              </View>
            )}
            <View style={styles.photoBtnRow}>
              <Pressable
                onPress={pickFromCamera}
                style={styles.photoBtn}
                disabled={busy}
              >
                <Ionicons name="camera-outline" size={16} color="#735f55" />
                <Text style={styles.photoBtnText}>Camera</Text>
              </Pressable>
              <Pressable
                onPress={pickFromLibrary}
                style={styles.photoBtn}
                disabled={busy}
              >
                <Ionicons name="image-outline" size={16} color="#735f55" />
                <Text style={styles.photoBtnText}>Choose</Text>
              </Pressable>
              {photoPreviewUri && (
                <Pressable
                  onPress={clearPhoto}
                  style={styles.photoBtn}
                  disabled={busy}
                >
                  <Ionicons name="trash-outline" size={16} color="#c44" />
                  <Text style={[styles.photoBtnText, { color: "#c44" }]}>
                    Remove
                  </Text>
                </Pressable>
              )}
            </View>
            {uploading && (
              <View style={styles.uploadingRow}>
                <ActivityIndicator size="small" />
                <Text style={styles.uploadingText}>Uploading photo…</Text>
              </View>
            )}
          </View>

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

          <Text style={styles.label}>Birth date</Text>
          <Pressable
            onPress={() => setShowDobPicker((v) => !v)}
            style={styles.dateBtn}
            disabled={busy}
          >
            <Text style={[styles.dateBtnText, !dob && styles.dateBtnPlaceholder]}>
              {dob ? formatDobLabel(dob) : "Pick a date"}
            </Text>
            {dob && (
              <Pressable
                onPress={() => setDob("")}
                hitSlop={8}
                disabled={busy}
              >
                <Ionicons name="close-circle" size={18} color="#bbb" />
              </Pressable>
            )}
          </Pressable>
          {showDobPicker && (
            <View style={styles.spinnerCard}>
              <DateTimePicker
                value={parseDob(dob) ?? new Date()}
                mode="date"
                display={Platform.OS === "ios" ? "spinner" : "default"}
                themeVariant="light"
                maximumDate={new Date()}
                onChange={(_, picked) => {
                  if (Platform.OS !== "ios") setShowDobPicker(false);
                  if (picked) setDob(isoDateOf(picked));
                }}
              />
            </View>
          )}

          <Text style={styles.label}>Color</Text>
          <TextInput
            style={styles.input}
            value={color}
            onChangeText={setColor}
            placeholder="White"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Weight (lb)</Text>
          <View style={styles.weightRow}>
            <TextInput
              style={[styles.input, styles.weightInput]}
              value={weight}
              onChangeText={(v) => {
                // Live-strip non-numeric / extra-decimal characters so
                // the user literally can't type something invalid.
                const cleaned = v.replace(/[^0-9.]/g, "");
                const parts = cleaned.split(".");
                const reassembled =
                  parts.length > 1
                    ? `${parts[0]}.${parts.slice(1).join("").slice(0, 1)}`
                    : cleaned;
                setWeight(reassembled);
              }}
              placeholder="12.3"
              placeholderTextColor="#888"
              keyboardType="decimal-pad"
              editable={!busy}
            />
            <Text style={styles.weightSuffix}>lb</Text>
          </View>

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
      </KeyboardAvoidingView>
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

  body: { padding: 20, gap: 8, paddingBottom: 60 },
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

  dateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  dateBtnText: { fontSize: 15, color: "#222" },
  dateBtnPlaceholder: { color: "#888" },
  spinnerCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    marginTop: 6,
    paddingVertical: 4,
  },

  weightRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  weightInput: { flex: 1 },
  weightSuffix: { color: "#666", fontSize: 14 },

  activeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },

  photoBlock: { alignItems: "center", marginTop: 4 },
  photo: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "#eee",
  },
  photoPlaceholder: { alignItems: "center", justifyContent: "center" },
  photoPlaceholderEmoji: { fontSize: 60 },
  photoBtnRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  photoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
  },
  photoBtnText: { color: "#735f55", fontWeight: "500", fontSize: 13 },
  uploadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  uploadingText: { color: "#666", fontSize: 13 },
});
