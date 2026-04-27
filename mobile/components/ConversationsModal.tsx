// Conversation switcher for the Janet tab. Lists past homeConversation
// rows newest-first, with row-level delete (cascades through the
// conversation's homeAgentMessage rows since the schema doesn't auto-
// cascade). Selecting a conversation hands its id back to the parent;
// the parent closes the modal and loads its messages.

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { getClient } from "../lib/amplify";
import type { Schema } from "../../amplify/data/resource";

type Conversation = Schema["homeConversation"]["type"];

interface Props {
  visible: boolean;
  activeId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
}

export function ConversationsModal({ visible, activeId, onClose, onSelect }: Props) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const client = getClient();
    const { data } = await client.models.homeConversation.list();
    const sorted = [...(data ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    setItems(sorted);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    void load();
  }, [visible, load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDelete(c: Conversation) {
    Alert.alert(
      "Delete conversation?",
      c.title ?? "This chat with Janet will be removed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const client = getClient();
              // Cascade through messages — schema has no cascade.
              const { data: msgs } = await client.models.homeAgentMessage.list({
                filter: { conversationId: { eq: c.id } },
              });
              await Promise.all(
                (msgs ?? []).map((m) =>
                  client.models.homeAgentMessage.delete({ id: m.id })
                )
              );
              const { errors } = await client.models.homeConversation.delete({
                id: c.id,
              });
              if (errors?.length) throw new Error(errors[0].message);
              setItems((prev) => prev.filter((x) => x.id !== c.id));
            } catch (err: any) {
              Alert.alert("Delete failed", err?.message ?? String(err));
            }
          },
        },
      ]
    );
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Conversations</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(c) => c.id}
            contentContainerStyle={styles.listBody}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListEmptyComponent={
              <Text style={styles.empty}>No previous conversations.</Text>
            }
            renderItem={({ item }) => (
              <ConvoRow
                convo={item}
                active={item.id === activeId}
                onSelect={() => onSelect(item.id)}
                onDelete={() => handleDelete(item)}
              />
            )}
          />
        )}
      </View>
    </Modal>
  );
}

function ConvoRow({
  convo,
  active,
  onSelect,
  onDelete,
}: {
  convo: Conversation;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const title = convo.title ?? "Untitled";
  const date = new Date(convo.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <View style={[styles.row, active && styles.rowActive]}>
      <Pressable onPress={onSelect} style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.rowMeta}>{date}</Text>
      </Pressable>
      <Pressable onPress={onDelete} hitSlop={8} style={styles.deleteBtn}>
        <Ionicons name="trash-outline" size={18} color="#c44" />
      </Pressable>
    </View>
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
  done: { color: "#735f55", fontWeight: "600", fontSize: 15 },

  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  listBody: { padding: 16 },
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
  rowActive: {
    borderWidth: 1,
    borderColor: "#735f55",
  },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 15, color: "#222" },
  rowMeta: { fontSize: 12, color: "#888", marginTop: 2 },
  deleteBtn: { padding: 4 },
});
