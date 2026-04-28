// Document detail. Metadata view + actions:
//   - Open document → Safari → web Duo flow → file
//   - Edit → DocumentFormModal
//   - Delete → confirm + remove S3 object + remove row
//
// `documentNumber` is intentionally not shown — the field is
// Duo-gated at the agent / web layer and we haven't ported a
// native Duo prompt to mobile yet. Users who need the number can
// still see it on the web Documents page.

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
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
  DOCUMENT_TYPE_EMOJI,
  DOCUMENT_TYPE_LABEL,
  type Document,
  type DocumentType,
  expiryLabel,
  isExpiringSoon,
  ownerLabel,
} from "../../../../lib/documents";
import { webDocumentsUrl } from "../../../../lib/documents-upload";
import { usePeople } from "../../../../lib/use-people";
import { usePerson } from "../../../../lib/use-person";
import { DocumentFormModal } from "../../../../components/DocumentFormModal";

export default function DocumentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { people } = usePeople();
  const personState = usePerson();
  const myPersonId =
    personState.status === "found" ? personState.person.id : null;

  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const client = getClient();
    const { data } = await client.models.homeDocument.get({ id });
    setDoc(data ?? null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function openOnWeb() {
    void Linking.openURL(webDocumentsUrl()).catch(() => {
      Alert.alert("Couldn't open browser");
    });
  }

  function confirmDelete() {
    if (!doc) return;
    Alert.alert(
      `Delete "${doc.title}"?`,
      "This removes the metadata row. The S3 file is left in place — clean it up from the web if needed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const client = getClient();
              const { errors } = await client.models.homeDocument.delete({
                id: doc.id,
              });
              if (errors?.length) throw new Error(errors[0].message);
              router.back();
            } catch (err: any) {
              Alert.alert("Delete failed", err?.message ?? String(err));
            }
          },
        },
      ]
    );
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
          {doc?.title ?? "Document"}
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : !doc ? (
        <Text style={styles.empty}>Document not found.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <DocumentSummary doc={doc} ownerName={ownerLabel(doc, people)} />

          <View style={styles.actions}>
            <Pressable onPress={openOnWeb} style={styles.primaryBtn}>
              <Ionicons name="open-outline" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Open on web</Text>
            </Pressable>
            <Pressable onPress={() => setEditOpen(true)} style={styles.secondaryBtn}>
              <Ionicons name="pencil" size={14} color="#735f55" />
              <Text style={styles.secondaryBtnText}>Edit</Text>
            </Pressable>
          </View>
          <Text style={styles.openHint}>
            "Open on web" launches Safari and routes through the web Duo flow
            for the actual file. Native Duo on mobile is a follow-up.
          </Text>

          <View style={styles.metaCard}>
            <MetaRow label="Type" value={DOCUMENT_TYPE_LABEL[(doc.type as DocumentType) ?? "OTHER"]} />
            <MetaRow label="Owner" value={ownerLabel(doc, people)} divider />
            {!!doc.issuer && <MetaRow label="Issuer" value={doc.issuer} divider />}
            {!!doc.issuedDate && (
              <MetaRow label="Issued" value={formatDate(doc.issuedDate)} divider />
            )}
            {!!doc.expiresDate && (
              <MetaRow
                label="Expires"
                value={formatDate(doc.expiresDate)}
                accent={isExpiringSoon(doc) ? "#a44" : undefined}
                divider
              />
            )}
            {!!doc.s3Key && (
              <MetaRow
                label="File"
                value={doc.originalFilename ?? "(uploaded)"}
                divider
              />
            )}
            {!!doc.uploadedBy && (
              <MetaRow label="Uploaded by" value={doc.uploadedBy} divider />
            )}
          </View>

          {!!doc.notes && (
            <>
              <Text style={styles.sectionLabel}>Notes</Text>
              <View style={styles.notesCard}>
                <Text style={styles.notes}>{doc.notes}</Text>
              </View>
            </>
          )}

          <Pressable onPress={confirmDelete} style={styles.deleteBtn}>
            <Text style={styles.deleteText}>Delete document</Text>
          </Pressable>
        </ScrollView>
      )}

      <DocumentFormModal
        visible={editOpen}
        doc={doc}
        people={people}
        myPersonId={myPersonId}
        onClose={() => setEditOpen(false)}
        onSaved={load}
      />
    </SafeAreaView>
  );
}

function DocumentSummary({
  doc,
  ownerName,
}: {
  doc: Document;
  ownerName: string;
}) {
  const type = (doc.type as DocumentType | null) ?? "OTHER";
  const exp = expiryLabel(doc);
  const warn = isExpiringSoon(doc);
  return (
    <View style={styles.summaryCard}>
      <Text style={styles.summaryEmoji}>{DOCUMENT_TYPE_EMOJI[type]}</Text>
      <Text style={styles.summaryTitle}>{doc.title}</Text>
      <Text style={styles.summarySub}>
        {DOCUMENT_TYPE_LABEL[type]} · {ownerName}
      </Text>
      {exp && (
        <Text style={[styles.summaryExpiry, warn && styles.summaryExpiryWarn]}>
          {exp}
        </Text>
      )}
    </View>
  );
}

function MetaRow({
  label,
  value,
  accent,
  divider,
}: {
  label: string;
  value: string;
  accent?: string;
  divider?: boolean;
}) {
  return (
    <View style={[styles.metaRow, divider && styles.metaRowDivider]}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text
        style={[styles.metaValue, accent ? { color: accent, fontWeight: "500" } : null]}
      >
        {value}
      </Text>
    </View>
  );
}

function formatDate(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
  heading: { fontSize: 22, fontWeight: "600", flex: 1 },

  body: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  summaryCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 18,
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
    marginBottom: 16,
    gap: 4,
  },
  summaryEmoji: { fontSize: 44, marginBottom: 4 },
  summaryTitle: { fontSize: 18, fontWeight: "600", color: "#222" },
  summarySub: { fontSize: 13, color: "#666" },
  summaryExpiry: { fontSize: 13, color: "#888", marginTop: 4 },
  summaryExpiryWarn: { color: "#a44", fontWeight: "500" },

  actions: { flexDirection: "row", gap: 8 },
  primaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#735f55",
    borderRadius: 10,
    paddingVertical: 12,
  },
  primaryBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
  },
  secondaryBtnText: { color: "#735f55", fontWeight: "500", fontSize: 15 },
  openHint: {
    color: "#888",
    fontSize: 12,
    marginTop: 8,
    marginBottom: 16,
    fontStyle: "italic",
    lineHeight: 17,
  },

  metaCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  metaRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#eee",
  },
  metaLabel: { color: "#888", fontSize: 13 },
  metaValue: { color: "#222", fontSize: 14, flexShrink: 1, textAlign: "right" },

  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 6,
  },
  notesCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  notes: { color: "#333", fontSize: 14, lineHeight: 20 },

  deleteBtn: { marginTop: 32, paddingVertical: 14, alignItems: "center" },
  deleteText: { color: "#c44", fontSize: 15, fontWeight: "500" },
});
