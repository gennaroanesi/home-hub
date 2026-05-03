// Documents list. Search by title + scope filter (Mine /
// Household / All) + type filter (passport, license, …). Tap a row
// to EXPAND it inline — the card opens to show full metadata
// (number behind a Face ID Reveal gate), notes, and Edit/Delete
// actions. View / Share / Download icons live in the row header
// and are always reachable. The "+" header opens the form
// modal in create mode.
//
// The /more/documents/[id] route still exists as a fallback for
// deep links from outside the app (agent DMs, push notifications);
// nothing in this list pushes to it anymore.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../../../lib/amplify";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_EMOJI,
  DOCUMENT_TYPE_LABEL,
  type Document,
  type DocumentType,
  compareDocs,
  expiryLabel,
  isExpiringSoon,
  ownerLabel,
} from "../../../../lib/documents";
import {
  downloadDocument,
  shareDocument,
  viewDocument,
} from "../../../../lib/document-download";
import { revealDocumentNumber } from "../../../../lib/document-download";
import { requireLocalAuth } from "../../../../lib/local-auth";
import { usePeople } from "../../../../lib/use-people";
import { usePerson } from "../../../../lib/use-person";
import { DocumentFormModal } from "../../../../components/DocumentFormModal";

type ScopeFilter = "all" | "mine" | "household";

export default function DocumentsList() {
  const { people } = usePeople();
  const personState = usePerson();
  const myPersonId =
    personState.status === "found" ? personState.person.id : null;

  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [typeFilter, setTypeFilter] = useState<DocumentType | "ALL">("ALL");
  const [editing, setEditing] = useState<Document | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Last-revealed document number, for the currently-expanded card.
  // Cleared when the card collapses or another row is expanded.
  const [revealedNumber, setRevealedNumber] = useState<{
    docId: string;
    value: string;
  } | null>(null);
  const [revealing, setRevealing] = useState(false);

  const load = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homeDocument.list();
    setDocs((data ?? []).slice().sort(compareDocs));
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

  const filtered = useMemo(() => {
    let result = docs;
    if (scope === "mine") {
      result = result.filter(
        (d) => d.scope === "PERSONAL" && d.ownerPersonId === myPersonId
      );
    } else if (scope === "household") {
      result = result.filter((d) => d.scope === "HOUSEHOLD");
    }
    if (typeFilter !== "ALL") {
      result = result.filter((d) => d.type === typeFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter((d) => {
        const haystack = [d.title, d.issuer, d.notes]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    return result;
  }, [docs, scope, typeFilter, search, myPersonId]);

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function toggleExpanded(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
    // Drop any revealed number when changing rows or collapsing.
    setRevealedNumber(null);
  }

  async function onEdit(d: Document) {
    // The edit form exposes documentNumber and an inline file preview,
    // both sensitive. Gate behind Face ID. If the device has no Face ID,
    // fall through and open the form — there's no second-factor fallback
    // here today.
    const auth = await requireLocalAuth({
      promptMessage: "Edit document",
    });
    if (!auth.ok && auth.reason === "cancelled") return;
    setEditing(d);
    setModalOpen(true);
  }

  function onDelete(d: Document) {
    Alert.alert(
      `Delete "${d.title}"?`,
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
                id: d.id,
              });
              if (errors?.length) throw new Error(errors[0].message);
              setExpandedId((prev) => (prev === d.id ? null : prev));
              await load();
            } catch (err: any) {
              Alert.alert("Delete failed", err?.message ?? String(err));
            }
          },
        },
      ]
    );
  }

  async function onReveal(d: Document) {
    if (!d.documentNumber) {
      Alert.alert("No number", "This document has no number to reveal.");
      return;
    }
    setRevealing(true);
    try {
      const result = await revealDocumentNumber({
        documentId: d.id,
        s3Key: d.s3Key,
        documentNumber: d.documentNumber,
      });
      if (!result.ok) {
        if (result.error !== "Cancelled")
          Alert.alert("Couldn't reveal", result.error);
        return;
      }
      if (result.documentNumber) {
        setRevealedNumber({ docId: d.id, value: result.documentNumber });
      }
    } finally {
      setRevealing(false);
    }
  }

  async function onView(d: Document) {
    if (!d.s3Key) {
      Alert.alert("Nothing to view", "This document has no file attached.");
      return;
    }
    const result = await viewDocument({
      documentId: d.id,
      s3Key: d.s3Key,
      documentNumber: d.documentNumber,
    });
    if (!result.ok && result.error && result.error !== "Cancelled") {
      Alert.alert("View failed", result.error);
    }
  }

  async function onDownload(d: Document) {
    const result = await downloadDocument({
      documentId: d.id,
      s3Key: d.s3Key,
      documentNumber: d.documentNumber,
    });
    if (!result.ok) {
      if (result.error !== "Cancelled")
        Alert.alert("Download failed", result.error);
      return;
    }
    if (result.url) {
      await Linking.openURL(result.url);
    } else if (result.documentNumber) {
      Alert.alert("Document number", result.documentNumber);
    }
  }

  async function onShare(d: Document) {
    if (!d.s3Key) {
      Alert.alert("Nothing to share", "This document has no file attached.");
      return;
    }
    const result = await shareDocument({
      documentId: d.id,
      s3Key: d.s3Key,
      documentNumber: d.documentNumber,
      filename: d.originalFilename,
    });
    if (!result.ok && result.error && result.error !== "Cancelled") {
      Alert.alert("Share failed", result.error);
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
        <Text style={styles.heading}>Documents</Text>
        <Pressable onPress={openCreate} hitSlop={12} style={styles.addBtn}>
          <Ionicons name="add" size={28} color="#735f55" />
        </Pressable>
      </View>

      <View style={styles.controls}>
        <View style={styles.searchRow}>
          <Ionicons name="search" size={14} color="#888" />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search title, issuer, notes"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>

        <View style={styles.scopeRow}>
          {(
            [
              { id: "all", label: "All" },
              { id: "mine", label: "Mine" },
              { id: "household", label: "Household" },
            ] as { id: ScopeFilter; label: string }[]
          ).map((opt) => {
            const on = scope === opt.id;
            return (
              <Pressable
                key={opt.id}
                onPress={() => setScope(opt.id)}
                style={[styles.pill, on && styles.pillOn]}
              >
                <Text style={[styles.pillText, on && styles.pillTextOn]}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.typeScroll}
          contentContainerStyle={styles.typeRow}
        >
          {[
            { id: "ALL" as const, label: "All types" },
            ...DOCUMENT_TYPES.map((t) => ({
              id: t,
              label: DOCUMENT_TYPE_LABEL[t],
            })),
          ].map((opt) => {
            const on = typeFilter === opt.id;
            return (
              <Pressable
                key={opt.id}
                onPress={() => setTypeFilter(opt.id as DocumentType | "ALL")}
                style={[styles.pill, on && styles.pillOn]}
              >
                <Text style={[styles.pillText, on && styles.pillTextOn]}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(d) => d.id}
          contentContainerStyle={styles.listBody}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {search.trim() ? "No documents match." : "No documents yet."}
            </Text>
          }
          renderItem={({ item }) => (
            <DocumentCard
              doc={item}
              ownerName={ownerLabel(item, people)}
              expanded={expandedId === item.id}
              revealedNumber={
                revealedNumber?.docId === item.id ? revealedNumber.value : null
              }
              revealing={revealing && expandedId === item.id}
              onToggle={() => toggleExpanded(item.id)}
              onView={() => onView(item)}
              onDownload={() => onDownload(item)}
              onShare={() => onShare(item)}
              onEdit={() => onEdit(item)}
              onDelete={() => onDelete(item)}
              onReveal={() => onReveal(item)}
            />
          )}
        />
      )}

      <DocumentFormModal
        visible={modalOpen}
        doc={editing}
        people={people}
        myPersonId={myPersonId}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />
    </SafeAreaView>
  );
}

interface DocumentCardProps {
  doc: Document;
  ownerName: string;
  expanded: boolean;
  revealedNumber: string | null;
  revealing: boolean;
  onToggle: () => void;
  onView: () => void;
  onDownload: () => void;
  onShare: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReveal: () => void;
}

function DocumentCard({
  doc,
  ownerName,
  expanded,
  revealedNumber,
  revealing,
  onToggle,
  onView,
  onDownload,
  onShare,
  onEdit,
  onDelete,
  onReveal,
}: DocumentCardProps) {
  const type = (doc.type as DocumentType | null) ?? "OTHER";
  const expiring = isExpiringSoon(doc);
  const expiry = expiryLabel(doc);
  const hasFile = !!doc.s3Key;

  return (
    <View style={[styles.card, expanded && styles.cardExpanded]}>
      <Pressable onPress={onToggle} style={styles.cardHeader}>
        <Text style={styles.rowEmoji}>{DOCUMENT_TYPE_EMOJI[type]}</Text>
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {doc.title}
          </Text>
          <Text style={styles.rowMeta}>
            {DOCUMENT_TYPE_LABEL[type]} · {ownerName}
          </Text>
          {expiry && (
            <Text style={[styles.rowExpiry, expiring && styles.rowExpiryWarn]}>
              {expiry}
            </Text>
          )}
        </View>
        <View style={styles.rowActions}>
          {hasFile && (
            <>
              <RowAction icon="eye-outline" label="View" onPress={onView} />
              <RowAction icon="share-outline" label="Share" onPress={onShare} />
            </>
          )}
          {(hasFile || doc.documentNumber) && (
            <RowAction
              icon="download-outline"
              label="Download"
              onPress={onDownload}
            />
          )}
          <Ionicons
            name={expanded ? "chevron-up" : "chevron-down"}
            size={16}
            color="#bbb"
            style={{ marginLeft: 4 }}
          />
        </View>
      </Pressable>

      {expanded && (
        <View style={styles.cardBody}>
          {!!doc.documentNumber && (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Number</Text>
              {revealedNumber ? (
                <Text style={styles.metaValue} selectable>
                  {revealedNumber}
                </Text>
              ) : (
                <Pressable
                  onPress={onReveal}
                  disabled={revealing}
                  style={({ pressed }) => [
                    styles.revealBtn,
                    (pressed || revealing) && styles.revealBtnPressed,
                  ]}
                >
                  {revealing ? (
                    <ActivityIndicator size="small" color="#735f55" />
                  ) : (
                    <>
                      <Ionicons
                        name="eye-outline"
                        size={14}
                        color="#735f55"
                      />
                      <Text style={styles.revealText}>Reveal</Text>
                    </>
                  )}
                </Pressable>
              )}
            </View>
          )}
          {!!doc.scope && (
            <MetaRow
              label="Scope"
              value={doc.scope === "HOUSEHOLD" ? "Household" : "Personal"}
            />
          )}
          {!!doc.issuer && <MetaRow label="Issuer" value={doc.issuer} />}
          {!!doc.issuedDate && (
            <MetaRow label="Issued" value={formatDate(doc.issuedDate)} />
          )}
          {!!doc.expiresDate && (
            <MetaRow
              label="Expires"
              value={formatDate(doc.expiresDate)}
              accent={expiring ? "#a44" : undefined}
            />
          )}
          {!!doc.s3Key && (
            <MetaRow
              label="File"
              value={
                doc.originalFilename ??
                doc.s3Key.split("/").pop() ??
                "(uploaded)"
              }
            />
          )}
          {!!doc.uploadedBy && (
            <MetaRow label="Uploaded by" value={doc.uploadedBy} />
          )}

          {!!doc.notes && (
            <>
              <Text style={styles.sectionLabel}>Notes</Text>
              <Text style={styles.notes}>{doc.notes}</Text>
            </>
          )}

          <View style={styles.bodyActions}>
            <Pressable onPress={onEdit} style={styles.bodyBtn}>
              <Ionicons name="pencil" size={14} color="#735f55" />
              <Text style={styles.bodyBtnText}>Edit</Text>
            </Pressable>
            <Pressable onPress={onDelete} style={[styles.bodyBtn, styles.deleteBtn]}>
              <Ionicons name="trash-outline" size={14} color="#a44" />
              <Text style={[styles.bodyBtnText, styles.deleteBtnText]}>Delete</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function RowAction({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={(e) => {
        e.stopPropagation();
        onPress();
      }}
      hitSlop={6}
      style={styles.rowActionBtn}
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={18} color="#735f55" />
    </Pressable>
  );
}

function MetaRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text
        style={[styles.metaValue, accent ? { color: accent } : null]}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

function formatDate(iso: string): string {
  // ISO date might be `YYYY-MM-DD` (whole day) or full ISO. We render
  // local-formatted but only date part — these are calendar-day fields.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
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
  heading: { fontSize: 28, fontWeight: "600", flex: 1 },
  addBtn: { padding: 4, paddingRight: 8 },

  controls: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    gap: 8,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 4 },

  scopeRow: { flexDirection: "row", gap: 6 },
  typeScroll: { flexGrow: 0 },
  typeRow: { flexDirection: "row", gap: 6, alignItems: "center" },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  pillOn: { backgroundColor: "#735f55", borderColor: "#735f55" },
  pillText: { color: "#444", fontSize: 13 },
  pillTextOn: { color: "#fff" },

  listBody: { paddingHorizontal: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: "#888", padding: 24, textAlign: "center" },

  card: {
    backgroundColor: "#fff",
    borderRadius: 10,
    marginVertical: 3,
    overflow: "hidden",
  },
  cardExpanded: {
    borderWidth: 1,
    borderColor: "#e0d8d2",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  cardBody: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#eee",
    paddingTop: 12,
  },

  rowEmoji: { fontSize: 22 },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 15, color: "#222", fontWeight: "500" },
  rowMeta: { fontSize: 13, color: "#666", marginTop: 2 },
  rowExpiry: { fontSize: 12, color: "#888", marginTop: 1 },
  rowExpiryWarn: { color: "#a44", fontWeight: "500" },

  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginLeft: 8,
  },
  rowActionBtn: {
    padding: 6,
    borderRadius: 6,
  },

  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
    gap: 12,
  },
  metaLabel: { fontSize: 13, color: "#888" },
  metaValue: { fontSize: 14, color: "#222", flexShrink: 1, textAlign: "right" },

  revealBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#faf6f3",
  },
  revealBtnPressed: { opacity: 0.6 },
  revealText: { fontSize: 12, color: "#735f55", fontWeight: "500" },

  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
  },
  notes: { fontSize: 13, color: "#444", lineHeight: 18 },

  bodyActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  bodyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d8c9bf",
    backgroundColor: "#faf6f3",
  },
  bodyBtnText: { fontSize: 13, color: "#735f55", fontWeight: "500" },
  deleteBtn: {
    borderColor: "#e8c2c2",
    backgroundColor: "#fdf3f3",
  },
  deleteBtnText: { color: "#a44" },
});
