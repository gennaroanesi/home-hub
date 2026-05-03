// Global share-intent handler.
//
// Wired into the root layout so it's mounted everywhere. When iOS hands
// the app a shared file (image or PDF) via the Share Extension, the
// expo-share-intent hook fires and this component shows a modal:
//
//   1. Action picker — Document / Attachment / Photo
//   2. Per-action form (title, type, parent entity, etc.)
//   3. Upload + create the corresponding row, then dismiss.
//
// The actual upload reuses the same web presign endpoints as in-app
// uploads (lib/{documents,photos,attachments}-upload.ts), all of which
// run through authedFetch so the access token rides along as a Bearer
// header.

import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useShareIntent } from "expo-share-intent";
import { router, usePathname } from "expo-router";

import { getClient } from "../lib/amplify";
import { uploadDocumentFile } from "../lib/documents-upload";
import { uploadPhotoFile } from "../lib/photos-upload";
import {
  uploadAttachmentFile,
  type AttachmentParentType,
} from "../lib/attachments-upload";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABEL,
  type DocumentType,
} from "../lib/documents";
import { resolveCurrentPerson } from "../lib/current-person";

type Action = "document" | "attachment" | "photo";

interface SharedFile {
  uri: string;
  mimeType: string;
  fileName: string;
}

const PARENT_TYPES: { value: AttachmentParentType; label: string; modelKey: string }[] = [
  { value: "TASK", label: "Task", modelKey: "homeTask" },
  { value: "EVENT", label: "Event", modelKey: "homeCalendarEvent" },
  { value: "BILL", label: "Bill", modelKey: "homeBill" },
  { value: "TRIP", label: "Trip", modelKey: "homeTrip" },
  { value: "TRIP_LEG", label: "Trip leg", modelKey: "homeTripLeg" },
  { value: "RESERVATION", label: "Reservation", modelKey: "homeTripReservation" },
];

export function ShareHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const pathname = usePathname();
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);

  // When iOS hands the app a share intent it boots us with the URL
  // `homehub://dataUrl=homehubShareKey`. Expo Router tries to map that
  // path to a route, finds none, and renders the "unmatched route" page
  // underneath our modal. Navigate to /(tabs) as soon as the share data
  // arrives so the user sees the home tab + modal instead of the 404.
  useEffect(() => {
    if (hasShareIntent && pathname && pathname.includes("dataUrl")) {
      router.replace("/(tabs)");
    }
  }, [hasShareIntent, pathname]);

  // Document fields
  const [docTitle, setDocTitle] = useState("");
  const [docType, setDocType] = useState<DocumentType>("OTHER");

  // Attachment fields
  const [attParentType, setAttParentType] = useState<AttachmentParentType | null>(null);
  const [attParentList, setAttParentList] = useState<{ id: string; label: string }[]>([]);
  const [attParentLoading, setAttParentLoading] = useState(false);
  const [attParentId, setAttParentId] = useState<string | null>(null);

  // Photo fields
  const [photoAlbumId, setPhotoAlbumId] = useState<string | null>(null);
  const [photoAlbums, setPhotoAlbums] = useState<{ id: string; name: string }[]>([]);
  const [photoAlbumsLoading, setPhotoAlbumsLoading] = useState(false);

  const sharedFile: SharedFile | null = useMemo(() => {
    if (!hasShareIntent || !shareIntent) return null;
    // expo-share-intent reports either a `files` array or a `text` payload.
    // We only handle the file case here.
    const f = shareIntent.files?.[0];
    if (!f) return null;
    return {
      uri: f.path,
      mimeType: f.mimeType ?? guessMime(f.fileName ?? f.path),
      fileName: f.fileName ?? lastSegment(f.path),
    };
  }, [hasShareIntent, shareIntent]);

  // Default the document title to the file's base name (sans extension)
  // so the user just hits Save in the common case.
  useEffect(() => {
    if (sharedFile && !docTitle) {
      setDocTitle(stripExtension(sharedFile.fileName));
    }
  }, [sharedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  function close() {
    setAction(null);
    setBusy(false);
    setDocTitle("");
    setDocType("OTHER");
    setAttParentType(null);
    setAttParentList([]);
    setAttParentId(null);
    setPhotoAlbumId(null);
    setPhotoAlbums([]);
    resetShareIntent();
  }

  async function loadParentList(type: AttachmentParentType) {
    setAttParentType(type);
    setAttParentId(null);
    setAttParentLoading(true);
    try {
      const cfg = PARENT_TYPES.find((p) => p.value === type);
      if (!cfg) return;
      const client = getClient() as any;
      const { data } = await client.models[cfg.modelKey].list({ limit: 25 });
      const rows: { id: string; label: string }[] = (data ?? []).map((r: any) => ({
        id: r.id,
        label: parentLabel(type, r),
      }));
      setAttParentList(rows);
    } catch (err) {
      Alert.alert("Couldn't load list", err instanceof Error ? err.message : String(err));
    } finally {
      setAttParentLoading(false);
    }
  }

  async function loadAlbums() {
    setPhotoAlbumsLoading(true);
    try {
      const client = getClient();
      const { data } = await client.models.homeAlbum.list({ limit: 50 });
      const rows = (data ?? []).map((a) => ({ id: a.id, name: a.name }));
      rows.sort((a, b) => a.name.localeCompare(b.name));
      setPhotoAlbums(rows);
    } finally {
      setPhotoAlbumsLoading(false);
    }
  }

  // Lazy-load albums when the user opens the photo flow.
  useEffect(() => {
    if (action === "photo" && photoAlbums.length === 0 && !photoAlbumsLoading) {
      loadAlbums();
    }
  }, [action]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!sharedFile) return;
    setBusy(true);
    try {
      const client = getClient();
      if (action === "document") {
        if (!docTitle.trim()) {
          throw new Error("Title is required");
        }
        const { person } = await resolveCurrentPerson();
        const uploaded = await uploadDocumentFile({
          uri: sharedFile.uri,
          contentType: sharedFile.mimeType,
          filename: sharedFile.fileName,
          prefix: "documents",
        });
        const { errors } = await client.models.homeDocument.create({
          title: docTitle.trim(),
          type: docType,
          scope: "PERSONAL",
          ownerPersonId: person?.id,
          s3Key: uploaded.s3Key,
          contentType: uploaded.contentType,
          sizeBytes: uploaded.sizeBytes,
          originalFilename: uploaded.originalFilename,
          uploadedBy: person?.name ?? undefined,
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else if (action === "attachment") {
        if (!attParentType || !attParentId) {
          throw new Error("Pick a parent first");
        }
        const uploaded = await uploadAttachmentFile({
          uri: sharedFile.uri,
          contentType: sharedFile.mimeType,
          filename: sharedFile.fileName,
          parentType: attParentType,
          parentId: attParentId,
        });
        const { errors } = await client.models.homeAttachment.create({
          parentType: attParentType,
          parentId: attParentId,
          s3Key: uploaded.s3Key,
          filename: uploaded.filename,
          contentType: uploaded.contentType,
          sizeBytes: uploaded.sizeBytes,
          uploadedBy: "ui",
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else if (action === "photo") {
        const uploaded = await uploadPhotoFile({
          uri: sharedFile.uri,
          contentType: sharedFile.mimeType,
          filename: sharedFile.fileName,
        });
        const { data: photo, errors } = await client.models.homePhoto.create({
          s3key: uploaded.s3Key,
          contentType: uploaded.contentType,
          sizeBytes: uploaded.sizeBytes,
          originalFilename: uploaded.originalFilename,
        });
        if (errors?.length) throw new Error(errors[0].message);
        if (photoAlbumId && photo) {
          await client.models.homeAlbumPhoto.create({
            albumId: photoAlbumId,
            photoId: photo.id,
          });
        }
      }
      close();
    } catch (err) {
      Alert.alert("Save failed", err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!sharedFile) return null;

  const canSubmit =
    !busy &&
    ((action === "document" && docTitle.trim().length > 0) ||
      (action === "attachment" && attParentType !== null && attParentId !== null) ||
      action === "photo");

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={close} disabled={busy}>
            <Text style={[styles.headerBtn, busy && styles.disabled]}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>
            {action === null ? "Save shared file" : `New ${action}`}
          </Text>
          <Pressable onPress={submit} disabled={!canSubmit}>
            <Text style={[styles.headerBtn, !canSubmit && styles.disabled, styles.primary]}>
              Save
            </Text>
          </Pressable>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <View style={styles.fileBadge}>
            <Ionicons name="document-attach-outline" size={18} color="#444" />
            <Text style={styles.fileBadgeText} numberOfLines={1}>
              {sharedFile.fileName}
            </Text>
            <Text style={styles.fileBadgeMime}>{sharedFile.mimeType}</Text>
          </View>

          {action === null && (
            <View style={styles.actionList}>
              <ActionButton
                icon="document-text-outline"
                label="Document"
                hint="Passport, license, insurance card…"
                onPress={() => setAction("document")}
              />
              <ActionButton
                icon="attach-outline"
                label="Attachment"
                hint="Attach to a task, event, trip, or bill"
                onPress={() => setAction("attachment")}
              />
              <ActionButton
                icon="image-outline"
                label="Photo"
                hint="Add to the photo library"
                onPress={() => setAction("photo")}
              />
            </View>
          )}

          {action === "document" && (
            <View style={styles.formSection}>
              <Text style={styles.label}>Title</Text>
              <TextInput
                style={styles.input}
                value={docTitle}
                onChangeText={setDocTitle}
                placeholder="e.g. Passport"
                placeholderTextColor="#888"
                editable={!busy}
                autoFocus
              />
              <Text style={styles.label}>Type</Text>
              <View style={styles.chipRow}>
                {DOCUMENT_TYPES.map((t) => (
                  <Pressable
                    key={t}
                    style={[styles.chip, docType === t && styles.chipActive]}
                    onPress={() => setDocType(t)}
                    disabled={busy}
                  >
                    <Text style={[styles.chipText, docType === t && styles.chipTextActive]}>
                      {DOCUMENT_TYPE_LABEL[t]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {action === "attachment" && (
            <View style={styles.formSection}>
              <Text style={styles.label}>Attach to</Text>
              <View style={styles.chipRow}>
                {PARENT_TYPES.map((p) => (
                  <Pressable
                    key={p.value}
                    style={[styles.chip, attParentType === p.value && styles.chipActive]}
                    onPress={() => loadParentList(p.value)}
                    disabled={busy}
                  >
                    <Text
                      style={[styles.chipText, attParentType === p.value && styles.chipTextActive]}
                    >
                      {p.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {attParentType && (
                <>
                  <Text style={styles.label}>Pick one</Text>
                  {attParentLoading ? (
                    <ActivityIndicator />
                  ) : attParentList.length === 0 ? (
                    <Text style={styles.muted}>None found.</Text>
                  ) : (
                    <View style={styles.parentList}>
                      {attParentList.map((row) => (
                        <Pressable
                          key={row.id}
                          style={[styles.parentRow, attParentId === row.id && styles.parentRowActive]}
                          onPress={() => setAttParentId(row.id)}
                          disabled={busy}
                        >
                          <Text style={styles.parentRowText} numberOfLines={2}>
                            {row.label}
                          </Text>
                          {attParentId === row.id && (
                            <Ionicons name="checkmark" size={18} color="#0a84ff" />
                          )}
                        </Pressable>
                      ))}
                    </View>
                  )}
                </>
              )}
            </View>
          )}

          {action === "photo" && (
            <View style={styles.formSection}>
              <Text style={styles.label}>Album (optional)</Text>
              {photoAlbumsLoading ? (
                <ActivityIndicator />
              ) : (
                <View style={styles.chipRow}>
                  <Pressable
                    style={[styles.chip, photoAlbumId === null && styles.chipActive]}
                    onPress={() => setPhotoAlbumId(null)}
                    disabled={busy}
                  >
                    <Text style={[styles.chipText, photoAlbumId === null && styles.chipTextActive]}>
                      No album
                    </Text>
                  </Pressable>
                  {photoAlbums.map((a) => (
                    <Pressable
                      key={a.id}
                      style={[styles.chip, photoAlbumId === a.id && styles.chipActive]}
                      onPress={() => setPhotoAlbumId(a.id)}
                      disabled={busy}
                    >
                      <Text style={[styles.chipText, photoAlbumId === a.id && styles.chipTextActive]}>
                        {a.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {busy && (
          <View style={styles.busyOverlay}>
            <ActivityIndicator size="large" />
            <Text style={styles.busyText}>Uploading…</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

function ActionButton({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.actionBtn} onPress={onPress}>
      <Ionicons name={icon} size={28} color="#0a84ff" />
      <View style={styles.actionBtnText}>
        <Text style={styles.actionBtnLabel}>{label}</Text>
        <Text style={styles.actionBtnHint}>{hint}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color="#999" />
    </Pressable>
  );
}

function lastSegment(p: string): string {
  return p.split("/").pop() ?? p;
}

function stripExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function guessMime(nameOrPath: string): string {
  const ext = nameOrPath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
    case "heif":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}

function parentLabel(type: AttachmentParentType, row: any): string {
  switch (type) {
    case "TASK":
      return row.title ?? "(untitled task)";
    case "EVENT":
      return `${row.title ?? "(untitled event)"} ${row.startsAt ?? ""}`.trim();
    case "BILL":
      return `${row.label ?? "(unlabeled bill)"} — $${row.amountCents ? (row.amountCents / 100).toFixed(2) : "?"}`;
    case "TRIP":
      return row.name ?? "(untitled trip)";
    case "TRIP_LEG":
      return `${row.fromName ?? "?"} → ${row.toName ?? "?"}`;
    case "RESERVATION":
      return row.name ?? row.confirmationNumber ?? "(reservation)";
    default:
      return row.id;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  title: { fontSize: 16, fontWeight: "600" },
  headerBtn: { fontSize: 16, color: "#0a84ff" },
  primary: { fontWeight: "600" },
  disabled: { color: "#999" },
  body: { flex: 1 },
  bodyContent: { padding: 16, paddingBottom: 40 },
  fileBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f5f5f5",
    padding: 12,
    borderRadius: 8,
    marginBottom: 20,
  },
  fileBadgeText: { flex: 1, fontSize: 13, color: "#333" },
  fileBadgeMime: { fontSize: 11, color: "#888" },
  actionList: { gap: 8 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 12,
    backgroundColor: "#fafafa",
  },
  actionBtnText: { flex: 1 },
  actionBtnLabel: { fontSize: 16, fontWeight: "600", color: "#222" },
  actionBtnHint: { fontSize: 12, color: "#666", marginTop: 2 },
  formSection: { gap: 8 },
  label: { fontSize: 13, fontWeight: "500", color: "#444", marginTop: 12 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    backgroundColor: "#fff",
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#fff",
  },
  chipActive: { backgroundColor: "#0a84ff", borderColor: "#0a84ff" },
  chipText: { fontSize: 13, color: "#333" },
  chipTextActive: { color: "#fff" },
  parentList: { gap: 4, marginTop: 4 },
  parentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 8,
    backgroundColor: "#fff",
  },
  parentRowActive: { borderColor: "#0a84ff", backgroundColor: "#f0f7ff" },
  parentRowText: { flex: 1, fontSize: 14, color: "#222" },
  muted: { fontSize: 13, color: "#888", paddingVertical: 8 },
  busyOverlay: {
    position: "absolute",
    inset: 0,
    backgroundColor: "rgba(255,255,255,0.85)",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  busyText: { fontSize: 14, color: "#444" },
});
