// Create / edit a person in the contact book (homePerson outside the
// household) — the native twin of the contact dialog on /contacts.
//
// Fields go through the save_contact op (the one Janet and the API use;
// it refuses a duplicate name on create and household members on edit).
// Photo: picked with expo-image-picker, uploaded to home/people/ through
// the presigned /api/documents/upload-url (prefix "people", same as the
// web's lib/upload-images.ts), then written to homePerson.photoKey like the
// web dialog does — save_contact's s3Key only takes keys from the API's
// POST /uploads. Remove goes through save_contact's removePhoto.

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
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";

import { getClient } from "../lib/amplify";
import { callOp } from "../lib/ops";
import { uploadDocumentFile } from "../lib/documents-upload";
import { resizedImageUrl } from "../lib/image";
import { BirthdayField } from "./BirthdayField";
import { ACCENT, formStyles } from "./person-form-styles";
import { CIRCLES, CIRCLE_LABELS, type Circle } from "../../lib/people";
import type { Schema } from "../../amplify/data/resource";

type Person = Schema["homePerson"]["type"];

interface Props {
  visible: boolean;
  contact: Person | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}

interface PendingPhoto {
  uri: string;
  contentType: string;
  filename: string;
}

export function ContactFormModal({ visible, contact, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [circle, setCircle] = useState<Circle | "">("");
  const [birthday, setBirthday] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [existingKey, setExistingKey] = useState<string | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<PendingPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName(contact?.name ?? "");
    setCircle((contact?.circle as Circle | null) ?? "");
    setBirthday(contact?.birthday ?? "");
    setPhoneNumber(contact?.phoneNumber ?? "");
    setEmail(contact?.email ?? "");
    setNotes(contact?.notes ?? "");
    setExistingKey(contact?.photoKey ?? null);
    setPendingPhoto(null);
  }, [visible, contact]);

  async function pick(source: "camera" | "library") {
    const perm =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(source === "camera" ? "Camera permission needed" : "Photo library permission needed");
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      quality: 0.85,
      allowsEditing: true,
      aspect: [1, 1],
    };
    const res =
      source === "camera"
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    setPendingPhoto({
      uri: a.uri,
      contentType: a.mimeType ?? "image/jpeg",
      filename: a.fileName ?? "person.jpg",
    });
  }

  function clearPhoto() {
    setExistingKey(null);
    setPendingPhoto(null);
  }

  const previewUri = pendingPhoto
    ? pendingPhoto.uri
    : existingKey
      ? resizedImageUrl(existingKey, 360)
      : null;

  async function save() {
    if (!name.trim()) {
      Alert.alert("Name required");
      return;
    }
    setBusy(true);
    try {
      let newKey: string | null = null;
      if (pendingPhoto) {
        setUploading(true);
        try {
          const up = await uploadDocumentFile({ ...pendingPhoto, prefix: "people" });
          newKey = up.s3Key;
        } finally {
          setUploading(false);
        }
      }
      const removePhoto = !!contact?.photoKey && !existingKey && !newKey;
      const r = await callOp("save_contact", {
        ...(contact ? { contactId: contact.id } : {}),
        name: name.trim(),
        circle: circle || null,
        birthday: birthday || null,
        phoneNumber: phoneNumber.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
        ...(removePhoto ? { removePhoto: true } : {}),
      });
      if ("error" in r) throw new Error(r.error);
      const id = r.result.contact.id;
      if (newKey) {
        const { errors } = await getClient().models.homePerson.update({ id, photoKey: newKey });
        if (errors?.length) throw new Error(`Saved, but the photo didn't stick: ${errors[0].message}`);
      }
      onSaved(id);
      onClose();
    } catch (err: any) {
      Alert.alert("Couldn't save", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Pressable onPress={onClose} disabled={busy}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle}>{contact ? `Edit ${contact.name}` : "New contact"}</Text>
          <Pressable onPress={save} disabled={busy}>
            {busy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.save, !name.trim() && styles.disabled]}>{contact ? "Save" : "Create"}</Text>
            )}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.photoBlock}>
            {previewUri ? (
              <Image source={{ uri: previewUri }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, styles.photoPlaceholder, { backgroundColor: contact?.color ?? "#3a5068" }]}>
                <Text style={styles.photoInitial}>
                  {contact?.emoji || (name.trim()[0] ?? "?").toUpperCase()}
                </Text>
              </View>
            )}
            <View style={styles.photoBtnRow}>
              <Pressable onPress={() => pick("camera")} style={styles.photoBtn} disabled={busy}>
                <Ionicons name="camera-outline" size={16} color={ACCENT} />
                <Text style={styles.photoBtnText}>Camera</Text>
              </Pressable>
              <Pressable onPress={() => pick("library")} style={styles.photoBtn} disabled={busy}>
                <Ionicons name="image-outline" size={16} color={ACCENT} />
                <Text style={styles.photoBtnText}>{previewUri ? "Change" : "Choose"}</Text>
              </Pressable>
              {previewUri && (
                <Pressable onPress={clearPhoto} style={styles.photoBtn} disabled={busy}>
                  <Ionicons name="trash-outline" size={16} color="#c44" />
                  <Text style={[styles.photoBtnText, { color: "#c44" }]}>Remove</Text>
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
            placeholder="Ana Silva"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!contact}
          />

          <Text style={styles.label}>Circle</Text>
          <View style={styles.chipRow}>
            {CIRCLES.map((c) => {
              const on = circle === c;
              return (
                <Pressable
                  key={c}
                  onPress={() => setCircle(on ? "" : c)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{CIRCLE_LABELS[c]}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.label}>Birthday</Text>
          <BirthdayField value={birthday} onChange={setBirthday} disabled={busy} />

          <Text style={styles.label}>Phone</Text>
          <TextInput
            style={styles.input}
            value={phoneNumber}
            onChangeText={setPhoneNumber}
            placeholder="+12125551234"
            placeholderTextColor="#888"
            keyboardType="phone-pad"
            editable={!busy}
          />

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="ana@example.com"
            placeholderTextColor="#888"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />

          <Text style={styles.label}>Notes</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Met at the climbing gym"
            placeholderTextColor="#888"
            multiline
            editable={!busy}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = formStyles;
