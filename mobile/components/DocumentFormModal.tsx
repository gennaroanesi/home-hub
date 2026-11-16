// Create / edit a homeDocument row from mobile.
//
// File picker offers three sources:
//   - Camera (expo-image-picker, captures a photo)
//   - Photo library (expo-image-picker)
//   - File browser (expo-document-picker, mostly used for PDFs)
//
// All three converge on a uniform { uri, contentType, filename, size }
// shape that uploadDocumentFile() pushes through the web's two-step
// presign + S3 PUT flow. Keeping a single upload path means the
// homeDocument row creation downstream is identical regardless of
// where the file came from.

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as WebBrowser from "expo-web-browser";

import { getClient } from "../lib/amplify";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABEL,
  type Document,
  type DocumentType,
  documentIsSensitive,
} from "../lib/documents";
import {
  approveMarkNotSensitive,
  documentViewUrl,
} from "../lib/document-download";
import { uploadDocumentFile, type UploadedDocFile } from "../lib/documents-upload";
import { useAllPeople, type Person } from "../lib/use-people";
import { PeoplePicker } from "./PeoplePicker";

interface Props {
  visible: boolean;
  doc: Document | null;
  people: Person[];
  myPersonId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function DocumentFormModal({
  visible,
  doc,
  people,
  myPersonId,
  onClose,
  onSaved,
}: Props) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<DocumentType>("OTHER");
  const [scope, setScope] = useState<"PERSONAL" | "HOUSEHOLD">("PERSONAL");
  const [ownerPersonId, setOwnerPersonId] = useState<string | null>(null);
  const { people: allPeople } = useAllPeople();
  const [documentNumber, setDocumentNumber] = useState("");
  const [issuer, setIssuer] = useState("");
  const [issuedDate, setIssuedDate] = useState("");
  const [expiresDate, setExpiresDate] = useState("");
  const [showIssuedPicker, setShowIssuedPicker] = useState(false);
  const [showExpiresPicker, setShowExpiresPicker] = useState(false);
  const [notes, setNotes] = useState("");
  // Opening the file / number needs Face ID + Duo unless this is off.
  const [isSensitive, setIsSensitive] = useState(true);
  // Duo wait text while saving a loosening change.
  const [duoStatus, setDuoStatus] = useState<string | null>(null);
  // Pending file replacement: null = keep existing s3Key, set =
  // upload this on save.
  const [pendingFile, setPendingFile] = useState<{
    uri: string;
    contentType: string;
    filename: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (doc) {
      setTitle(doc.title);
      setType((doc.type as DocumentType | null) ?? "OTHER");
      setScope((doc.scope as "PERSONAL" | "HOUSEHOLD" | null) ?? "PERSONAL");
      setOwnerPersonId(doc.ownerPersonId ?? null);
      setDocumentNumber(doc.documentNumber ?? "");
      setIssuer(doc.issuer ?? "");
      setIssuedDate(doc.issuedDate ?? "");
      setExpiresDate(doc.expiresDate ?? "");
      setNotes(doc.notes ?? "");
      setIsSensitive(documentIsSensitive(doc));
      setPendingFile(null);
    } else {
      setTitle("");
      setType("OTHER");
      setScope("PERSONAL");
      setOwnerPersonId(myPersonId);
      setDocumentNumber("");
      setIssuer("");
      setIssuedDate("");
      setExpiresDate("");
      setNotes("");
      setIsSensitive(true);
      setPendingFile(null);
    }
    setDuoStatus(null);
  }, [visible, doc, myPersonId]);

  // ── File pickers ─────────────────────────────────────────────────────────

  async function pickFromCamera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera permission needed");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.9,
    });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    setPendingFile({
      uri: a.uri,
      contentType: a.mimeType ?? "image/jpeg",
      filename: a.fileName ?? "photo.jpg",
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
      quality: 0.9,
    });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    setPendingFile({
      uri: a.uri,
      contentType: a.mimeType ?? "image/jpeg",
      filename: a.fileName ?? "photo.jpg",
    });
  }

  async function pickPdf() {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf"],
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    setPendingFile({
      uri: a.uri,
      contentType: a.mimeType ?? "application/pdf",
      filename: a.name,
    });
  }

  // ── Save / delete ────────────────────────────────────────────────────────

  async function save() {
    if (!title.trim()) {
      Alert.alert("Title required");
      return;
    }
    if (scope === "PERSONAL" && !ownerPersonId) {
      Alert.alert("Owner required for personal documents");
      return;
    }
    for (const [label, val] of [
      ["Issued", issuedDate],
      ["Expires", expiresDate],
    ] as const) {
      if (val && !ISO_DATE_RE.test(val)) {
        Alert.alert(`${label} date must be YYYY-MM-DD`);
        return;
      }
    }

    // Loosening protection (now opens without Duo) needs a Duo push
    // first, like the web. A new doc saved not sensitive counts too;
    // turning it back on needs nothing.
    const loosening = !isSensitive && (!doc || documentIsSensitive(doc));

    setBusy(true);
    try {
      if (loosening) {
        const approved = await approveMarkNotSensitive(title.trim(), {
          onStatus: setDuoStatus,
        });
        if (!approved.ok) {
          Alert.alert("Not saved", approved.error);
          return;
        }
      }

      let uploaded: UploadedDocFile | null = null;
      if (pendingFile) {
        setUploading(true);
        try {
          uploaded = await uploadDocumentFile(pendingFile);
        } finally {
          setUploading(false);
        }
      }

      const payload = {
        title: title.trim(),
        type,
        scope,
        ownerPersonId: scope === "PERSONAL" ? ownerPersonId : null,
        documentNumber: documentNumber.trim() || null,
        issuer: issuer.trim() || null,
        issuedDate: issuedDate || null,
        expiresDate: expiresDate || null,
        notes: notes.trim() || null,
        isSensitive,
        ...(uploaded
          ? {
              s3Key: uploaded.s3Key,
              contentType: uploaded.contentType,
              sizeBytes: uploaded.sizeBytes,
              originalFilename: uploaded.originalFilename,
            }
          : {}),
      };

      const client = getClient();
      if (doc) {
        const { errors } = await client.models.homeDocument.update({
          id: doc.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else {
        const { errors } = await client.models.homeDocument.create({
          ...payload,
          uploadedBy: "mobile",
        });
        if (errors?.length) throw new Error(errors[0].message);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  // Anyone can own a document (web offers every active person), not just
  // the household; the passed household list covers the first load.
  const ownerChoices = allPeople.length ? allPeople : people;

  const fileLabel = pendingFile
    ? `New: ${pendingFile.filename}`
    : doc?.s3Key
      ? `Existing: ${doc.originalFilename ?? "(uploaded)"}`
      : "No file attached";

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
          <Text style={styles.headerTitle}>
            {doc ? "Edit document" : "New document"}
          </Text>
          <Pressable onPress={save} disabled={busy}>
            {busy ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.save, !title.trim() && styles.disabled]}>
                Save
              </Text>
            )}
          </Pressable>
        </View>
        {duoStatus && (
          <View style={styles.duoBanner}>
            <ActivityIndicator size="small" />
            <Text style={styles.duoBannerText}>{duoStatus}</Text>
          </View>
        )}

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Passport"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!doc}
          />

          <Text style={styles.label}>Type</Text>
          <View style={styles.chipRow}>
            {DOCUMENT_TYPES.map((t) => {
              const on = type === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => setType(t)}
                  style={[styles.chip, on && styles.chipOn]}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {DOCUMENT_TYPE_LABEL[t]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.scopeSwitchRow}>
            <Text style={styles.label}>Household-wide</Text>
            <Switch
              value={scope === "HOUSEHOLD"}
              onValueChange={(v) => setScope(v ? "HOUSEHOLD" : "PERSONAL")}
              disabled={busy}
            />
          </View>

          {scope === "PERSONAL" && (
            <>
              <Text style={styles.label}>Owner</Text>
              <PeoplePicker
                single
                required
                title="Owner"
                people={ownerChoices}
                selectedIds={ownerPersonId ? [ownerPersonId] : []}
                onChange={(ids) => setOwnerPersonId(ids[0] ?? null)}
                disabled={busy}
              />
            </>
          )}

          {doc?.s3Key && <FilePreview doc={doc} />}

          <Text style={styles.label}>Number (optional)</Text>
          <TextInput
            style={styles.input}
            value={documentNumber}
            onChangeText={setDocumentNumber}
            placeholder="e.g. passport / license number"
            placeholderTextColor="#888"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
          />

          <Text style={styles.label}>Issuer (optional)</Text>
          <TextInput
            style={styles.input}
            value={issuer}
            onChangeText={setIssuer}
            placeholder="State of Texas"
            placeholderTextColor="#888"
            editable={!busy}
          />

          <Text style={styles.label}>Issued</Text>
          <DateField
            value={issuedDate}
            onChange={setIssuedDate}
            show={showIssuedPicker}
            setShow={setShowIssuedPicker}
            placeholder="Pick the issue date"
            disabled={busy}
          />

          <Text style={styles.label}>Expires</Text>
          <DateField
            value={expiresDate}
            onChange={setExpiresDate}
            show={showExpiresPicker}
            setShow={setShowExpiresPicker}
            placeholder="Pick the expiration date"
            disabled={busy}
          />

          <Text style={styles.label}>File</Text>
          <Text style={styles.fileLabel}>{fileLabel}</Text>
          <View style={styles.fileBtnRow}>
            <Pressable
              onPress={pickFromCamera}
              style={styles.fileBtn}
              disabled={busy}
            >
              <Ionicons name="camera-outline" size={16} color="#735f55" />
              <Text style={styles.fileBtnText}>Camera</Text>
            </Pressable>
            <Pressable
              onPress={pickFromLibrary}
              style={styles.fileBtn}
              disabled={busy}
            >
              <Ionicons name="image-outline" size={16} color="#735f55" />
              <Text style={styles.fileBtnText}>Photo</Text>
            </Pressable>
            <Pressable onPress={pickPdf} style={styles.fileBtn} disabled={busy}>
              <Ionicons name="document-outline" size={16} color="#735f55" />
              <Text style={styles.fileBtnText}>PDF</Text>
            </Pressable>
          </View>
          <View style={styles.scopeSwitchRow}>
            <Text style={styles.label}>Sensitive</Text>
            <Switch
              value={isSensitive}
              onValueChange={setIsSensitive}
              disabled={busy}
            />
          </View>
          <Text style={styles.hint}>
            {isSensitive
              ? "Opening the file or number needs Face ID and a Duo push."
              : doc && !documentIsSensitive(doc)
                ? "Opens without Face ID or Duo, here, on the web and from Janet."
                : "Opens without Face ID or Duo, here, on the web and from Janet. Saving asks for a Duo push."}
          </Text>

          {uploading && (
            <View style={styles.uploadingRow}>
              <ActivityIndicator size="small" />
              <Text style={styles.uploadingText}>Uploading file…</Text>
            </View>
          )}

          <Text style={styles.label}>Notes</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional"
            placeholderTextColor="#888"
            multiline
            editable={!busy}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Calendar-date field. Stored as wall-clock "YYYY-MM-DD" (the
// homeDocument schema uses a.date()). The native picker hands back a
// Date instance whose y/m/d we read in local time so we don't drift
// across timezones.
function DateField({
  value,
  onChange,
  show,
  setShow,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  setShow: (b: boolean) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const parsed = parseIsoDate(value);
  return (
    <>
      <Pressable
        onPress={() => setShow(!show)}
        style={dateStyles.btn}
        disabled={disabled}
      >
        <Text style={[dateStyles.btnText, !parsed && dateStyles.placeholder]}>
          {parsed ? formatDateLabel(parsed) : placeholder}
        </Text>
        {parsed && (
          <Pressable
            onPress={() => {
              onChange("");
              setShow(false);
            }}
            hitSlop={8}
            disabled={disabled}
          >
            <Ionicons name="close-circle" size={20} color="#bbb" />
          </Pressable>
        )}
      </Pressable>
      {show && (
        <View style={dateStyles.spinner}>
          <DateTimePicker
            value={parsed ?? new Date()}
            mode="date"
            display="spinner"
            themeVariant="light"
            onChange={(_, picked) => {
              if (picked) onChange(toIsoDate(picked));
            }}
          />
        </View>
      )}
    </>
  );
}

function parseIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateLabel(d: Date): string {
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const dateStyles = StyleSheet.create({
  btn: {
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
  btnText: { fontSize: 15, color: "#222" },
  placeholder: { color: "#888" },
  spinner: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    marginTop: 6,
    paddingVertical: 4,
  },
});

// Inline preview for an existing document. The file comes as a
// short-lived signed link from the web's content API (same gate as
// View: nothing for a not-sensitive doc, Face ID + Duo otherwise), so
// it loads on its own only when that costs nothing; a sensitive doc
// waits for a tap rather than firing a Duo push just for opening Edit.
// Image renders via expo-image; PDF opens in the in-app Safari sheet.
function FilePreview({ doc }: { doc: Document }) {
  const s3Key = doc.s3Key ?? "";
  const ext = (s3Key.split(".").pop() ?? "").toLowerCase();
  const isImage = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext);
  const isPdf = ext === "pdf";
  const sensitive = documentIsSensitive(doc);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function load(): Promise<string | null> {
    if (url) return url;
    setLoading(true);
    try {
      const result = await documentViewUrl(
        { documentId: doc.id, s3Key: doc.s3Key, isSensitive: doc.isSensitive },
        { onStatus: setStatus }
      );
      if (!result.ok) {
        if (result.error !== "Cancelled") Alert.alert("Preview failed", result.error);
        return null;
      }
      setUrl(result.url ?? null);
      return result.url ?? null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setUrl(null);
    if (isImage && !sensitive) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, s3Key]);

  async function openPdf() {
    const u = await load();
    if (u) await WebBrowser.openBrowserAsync(u);
  }

  return (
    <>
      <Text style={styles.label}>Preview</Text>
      {isImage && url ? (
        <Image
          source={{ uri: url }}
          style={previewStyles.image}
          contentFit="contain"
          accessibilityLabel={doc.title}
        />
      ) : isImage || isPdf ? (
        <Pressable
          onPress={isPdf ? openPdf : () => void load()}
          style={previewStyles.pdfTile}
          disabled={loading}
        >
          <Ionicons
            name={isPdf ? "document-text-outline" : "image-outline"}
            size={28}
            color="#735f55"
          />
          <View style={{ flex: 1 }}>
            <Text style={previewStyles.pdfTitle} numberOfLines={1}>
              {doc.title}
            </Text>
            <Text style={previewStyles.pdfHint}>
              {status ??
                (loading
                  ? "Loading…"
                  : isPdf
                    ? "Tap to open PDF"
                    : "Tap to show the image")}
            </Text>
          </View>
          {loading ? (
            <ActivityIndicator size="small" />
          ) : (
            <Ionicons name="open-outline" size={18} color="#888" />
          )}
        </Pressable>
      ) : (
        <Text style={previewStyles.unsupported}>
          No inline preview for .{ext} — use the actions on the list to download.
        </Text>
      )}
    </>
  );
}

const previewStyles = StyleSheet.create({
  image: {
    width: "100%",
    height: 220,
    borderRadius: 8,
    backgroundColor: "#f0f0f0",
    marginTop: 4,
  },
  pdfTile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    marginTop: 4,
  },
  pdfTitle: { fontSize: 14, color: "#222", fontWeight: "500" },
  pdfHint: { fontSize: 12, color: "#888", marginTop: 2 },
  unsupported: { fontSize: 13, color: "#888", padding: 8 },
});

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

  body: { padding: 20, gap: 8, paddingBottom: 120 },
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
  multiline: { minHeight: 80, textAlignVertical: "top" },

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

  scopeSwitchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },

  fileLabel: { color: "#666", fontSize: 13, marginTop: 4 },
  fileBtnRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  fileBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 10,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
  },
  fileBtnText: { color: "#735f55", fontWeight: "500", fontSize: 14 },
  uploadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  uploadingText: { color: "#666", fontSize: 13 },
  hint: { color: "#888", fontSize: 12, lineHeight: 17 },
  duoBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#faf6f3",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0d8d2",
  },
  duoBannerText: { color: "#735f55", fontSize: 13, flex: 1 },
});
