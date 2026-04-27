// Janet — agent chat. Single active conversation: we pick the most
// recent homeConversation on mount, or auto-create one on the first
// send. Messages are persisted to homeAgentMessage as user → assistant
// pairs, and `invokeHomeAgent` returns the assistant turn synchronously.
//
// Phase 2A scope: text only. Image attachments (Janet's "send_photos"
// flow on web) require expo-image-picker + S3 upload and would force
// a dev-client rebuild — deferred until Phase 4 when photos land.
//
// `actionsTaken` is collapsed under each assistant bubble; tap to
// expand the list of tool calls Janet ran. Useful for verifying
// "did she actually create the task?".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { getClient } from "../../lib/amplify";
import { usePerson } from "../../lib/use-person";
import { ConversationsModal } from "../../components/ConversationsModal";
import type { Schema } from "../../../amplify/data/resource";

type StoredMsg = Schema["homeAgentMessage"]["type"];

interface ActionTaken {
  tool: string;
  result?: Record<string, unknown>;
}

interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  actionsTaken?: ActionTaken[];
}

const TOOL_LABELS: Record<string, string> = {
  create_task: "Created task",
  complete_task: "Completed task",
  list_tasks: "Listed tasks",
  create_bill: "Created bill",
  mark_bill_paid: "Marked bill paid",
  list_bills: "Listed bills",
  create_event: "Created event",
  schedule_reminder: "Scheduled reminder",
  send_photos: "Sent photos",
};

export default function Agent() {
  const personState = usePerson();
  const sender =
    personState.status === "found" ? personState.person.name : "User";

  const [conversationId, setConversationId] = useState<string | null>(null);
  // Track whether the active conversation already has a title so we
  // only auto-title once (mirrors the web behavior).
  const [hasTitle, setHasTitle] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [convoModalOpen, setConvoModalOpen] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  // Pick the most recent conversation (or none if first run). Don't
  // auto-create here — only create when the user actually sends.
  const loadLatest = useCallback(async () => {
    setLoading(true);
    try {
      const client = getClient();
      const { data } = await client.models.homeConversation.list();
      const latest = (data ?? []).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
      )[0];
      if (!latest) {
        setConversationId(null);
        setHasTitle(false);
        setMessages([]);
        return;
      }
      await loadConversation(latest.id, !!latest.title);
    } finally {
      setLoading(false);
    }
  }, []);

  // Pull a specific conversation's messages into the screen.
  const loadConversation = useCallback(
    async (id: string, titled: boolean) => {
      const client = getClient();
      setConversationId(id);
      setHasTitle(titled);
      const { data: msgs } = await client.models.homeAgentMessage.list({
        filter: { conversationId: { eq: id } },
      });
      const sorted = (msgs ?? []).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      );
      setMessages(sorted.map(toChatMessage));
    },
    []
  );

  async function selectConversation(id: string) {
    setConvoModalOpen(false);
    if (id === conversationId) return;
    setLoading(true);
    try {
      const client = getClient();
      const { data } = await client.models.homeConversation.get({ id });
      await loadConversation(id, !!data?.title);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [messages.length]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");

    let convoId = conversationId;
    try {
      const client = getClient();

      // Lazy-create the conversation row on first send so empty Janet
      // sessions don't pollute the conversations table.
      if (!convoId) {
        const { data, errors } = await client.models.homeConversation.create({
          title: null,
          createdBy: sender,
        });
        if (errors?.length || !data) {
          throw new Error(errors?.[0]?.message ?? "Failed to start conversation");
        }
        convoId = data.id;
        setConversationId(convoId);
        setHasTitle(false);
      }

      // Optimistically render the user turn.
      const userMsg: ChatMessage = { role: "user", content: text };
      const turnHistory = [...messages, userMsg];
      setMessages(turnHistory);

      // Persist the user message in parallel with the agent call —
      // saves a roundtrip vs. awaiting the create first.
      void client.models.homeAgentMessage.create({
        conversationId: convoId,
        role: "user",
        content: text,
        sender,
      });

      // The agent expects history as an AWSJSON-serialized array.
      // Cap at 10 turns so we don't blow the prompt.
      const history = turnHistory.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const { data, errors } = await client.mutations.invokeHomeAgent({
        message: text,
        history: JSON.stringify(history) as unknown as object, // AWSJSON
        sender,
      });
      if (errors?.length || !data) {
        throw new Error(errors?.[0]?.message ?? "Agent failed");
      }

      const actionsTaken = parseActions(data.actionsTaken);
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: data.message,
        actionsTaken: actionsTaken.length > 0 ? actionsTaken : undefined,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Persist assistant turn (fire-and-forget; UI already updated).
      void client.models.homeAgentMessage.create({
        conversationId: convoId,
        role: "assistant",
        content: data.message,
        actionsTaken:
          actionsTaken.length > 0
            ? (JSON.stringify(actionsTaken) as unknown as object)
            : null,
      });

      // Auto-title the conversation from the first user turn so the
      // conversation switcher has something useful to show.
      if (!hasTitle) {
        const title = text.length > 50 ? text.slice(0, 47) + "..." : text;
        void client.models.homeConversation.update({ id: convoId, title });
        setHasTitle(true);
      }
    } catch (err: any) {
      Alert.alert("Send failed", err?.message ?? String(err));
      // Roll back the optimistic user turn so they can retry.
      setMessages((prev) => prev.slice(0, -1));
      setInput(text);
    } finally {
      setSending(false);
    }
  }

  async function newChat() {
    if (sending) return;
    setMessages([]);
    setConversationId(null);
    setHasTitle(false);
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.heading}>Janet</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => setConvoModalOpen(true)}
            hitSlop={12}
            style={styles.addBtn}
          >
            <Ionicons name="list-outline" size={24} color="#735f55" />
          </Pressable>
          <Pressable onPress={newChat} hitSlop={12} style={styles.addBtn}>
            <Ionicons name="create-outline" size={24} color="#735f55" />
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={120}
        >
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m, i) => m.id ?? `m-${i}`}
            contentContainerStyle={styles.listBody}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Ionicons name="chatbubbles-outline" size={36} color="#ccc" />
                <Text style={styles.empty}>
                  Ask Janet to manage tasks, bills, calendar, photos, or home
                  devices.
                </Text>
              </View>
            }
            ListFooterComponent={
              sending ? (
                <View style={styles.thinking}>
                  <ActivityIndicator />
                  <Text style={styles.thinkingText}>Janet is thinking…</Text>
                </View>
              ) : null
            }
            renderItem={({ item }) => <Bubble message={item} />}
          />

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="Message Janet"
              placeholderTextColor="#888"
              multiline
              editable={!sending}
              returnKeyType="send"
              onSubmitEditing={send}
              blurOnSubmit={false}
            />
            <Pressable
              onPress={send}
              disabled={sending || !input.trim()}
              hitSlop={6}
              style={[
                styles.sendBtn,
                (sending || !input.trim()) && styles.sendBtnDisabled,
              ]}
            >
              <Ionicons name="arrow-up" size={20} color="#fff" />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}

      <ConversationsModal
        visible={convoModalOpen}
        activeId={conversationId}
        onClose={() => setConvoModalOpen(false)}
        onSelect={selectConversation}
      />
    </SafeAreaView>
  );
}

// ── Bubble ─────────────────────────────────────────────────────────────────

function Bubble({ message }: { message: ChatMessage }) {
  const [showActions, setShowActions] = useState(false);
  const isUser = message.role === "user";
  return (
    <View style={[styles.bubbleWrap, isUser && styles.bubbleWrapUser]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
          {message.content}
        </Text>
      </View>
      {message.actionsTaken && message.actionsTaken.length > 0 && (
        <Pressable onPress={() => setShowActions((v) => !v)} style={styles.actionsBar}>
          <Ionicons
            name={showActions ? "chevron-down" : "chevron-forward"}
            size={12}
            color="#888"
          />
          <Text style={styles.actionsHeader}>
            {message.actionsTaken.length} action
            {message.actionsTaken.length === 1 ? "" : "s"}
          </Text>
        </Pressable>
      )}
      {showActions && message.actionsTaken && (
        <View style={styles.actionsList}>
          {message.actionsTaken.map((a, i) => (
            <Text key={i} style={styles.actionLine}>
              • {TOOL_LABELS[a.tool] ?? a.tool}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function toChatMessage(m: StoredMsg): ChatMessage {
  return {
    id: m.id,
    role: (m.role as "user" | "assistant") ?? "assistant",
    content: m.content,
    actionsTaken: parseActions(m.actionsTaken),
  };
}

// AWSJSON fields can come back as a string OR a parsed object depending
// on auth path / amplify version (auto-memory: feedback_awsjson_stringify).
// Tolerate both shapes.
function parseActions(raw: unknown): ActionTaken[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as ActionTaken[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  heading: { fontSize: 28, fontWeight: "600" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  addBtn: { padding: 4 },

  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  listBody: { padding: 16, paddingBottom: 24, gap: 6 },

  emptyWrap: {
    alignItems: "center",
    paddingVertical: 80,
    paddingHorizontal: 24,
    gap: 12,
  },
  empty: { color: "#888", textAlign: "center", fontSize: 14, lineHeight: 20 },

  thinking: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingLeft: 12,
  },
  thinkingText: { color: "#888", fontSize: 13 },

  bubbleWrap: { marginVertical: 4 },
  bubbleWrapUser: { alignItems: "flex-end" },
  bubble: {
    maxWidth: "85%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleAssistant: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e5e5",
  },
  bubbleUser: {
    backgroundColor: "#735f55",
    borderTopRightRadius: 4,
  },
  bubbleText: { fontSize: 15, color: "#222", lineHeight: 21 },
  bubbleTextUser: { color: "#fff" },

  actionsBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingTop: 4,
    paddingLeft: 4,
  },
  actionsHeader: { color: "#888", fontSize: 12 },
  actionsList: { paddingLeft: 16, paddingTop: 2 },
  actionLine: { color: "#666", fontSize: 12, marginVertical: 1 },

  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#ddd",
    backgroundColor: "#fff",
  },
  input: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#f4f4f4",
    borderRadius: 18,
    maxHeight: 120,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#735f55",
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { opacity: 0.4 },
});
