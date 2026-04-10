"use client";

import React, { useState, useEffect, useRef, useCallback, Key } from "react";
import { getCurrentUser, fetchUserAttributes } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
import { Spinner } from "@heroui/react";
import { FaPaperPlane, FaChevronDown, FaChevronUp, FaPlus, FaEllipsisV } from "react-icons/fa";
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from "@heroui/react";

import DefaultLayout from "@/layouts/default";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

interface ActionTaken {
  tool: string;
  result: Record<string, any>;
}

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  sender?: string;
  actionsTaken?: ActionTaken[];
}

interface Conversation {
  id: string;
  title: string | null;
  createdBy: string | null;
  createdAt: string;
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
};

function ActionLog({ actions }: { actions: ActionTaken[] }) {
  const [expanded, setExpanded] = useState(false);

  if (actions.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        className="flex items-center gap-1 text-xs text-default-400 hover:text-default-600 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <FaChevronUp size={10} /> : <FaChevronDown size={10} />}
        {actions.length} action{actions.length > 1 ? "s" : ""} taken
      </button>
      {expanded && (
        <div className="mt-1 space-y-1">
          {actions.map((action, i) => (
            <div
              key={i}
              className="text-xs text-default-500 bg-default-100 rounded px-2 py-1"
            >
              <span className="text-success mr-1">&#10003;</span>
              {TOOL_LABELS[action.tool] ?? action.tool}
              {action.result.title && (
                <span className="text-default-400">
                  {" "}&mdash; {action.result.title}
                </span>
              )}
              {action.result.name && (
                <span className="text-default-400">
                  {" "}&mdash; {action.result.name}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HomeAgent() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [sender, setSender] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Helper: is the viewport currently mobile-sized?
  const isMobile = useCallback(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
    []
  );

  useEffect(() => {
    checkAuth();
    // Default sidebar closed on mobile, open on desktop
    if (isMobile()) setSidebarOpen(false);
  }, [isMobile]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function checkAuth() {
    try {
      const { username } = await getCurrentUser();
      const attrs = await fetchUserAttributes();
      const name = attrs["custom:full_name"] ?? username;

      setFullName(name);
      setSender(name.toLowerCase().includes("cristine") ? "cristine" : "gennaro");
      await loadConversations();
    } catch {
      router.push("/login");
    }
  }

  async function loadConversations() {
    const { data } = await client.models.homeConversation.list({
      limit: 50,
    });
    const sorted = [...(data ?? [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    setConversations(sorted as Conversation[]);
  }

  async function loadMessages(conversationId: string) {
    const { data } = await client.models.homeAgentMessage.list({
      filter: { conversationId: { eq: conversationId } },
      limit: 200,
    });
    const sorted = [...(data ?? [])].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    setMessages(
      sorted.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        sender: m.sender ?? undefined,
        actionsTaken: m.actionsTaken ? (m.actionsTaken as ActionTaken[]) : undefined,
      }))
    );
  }

  const selectConversation = useCallback(
    async (id: string) => {
      setActiveConvoId(id);
      await loadMessages(id);
      if (isMobile()) setSidebarOpen(false);
    },
    [isMobile]
  );

  async function renameConversation(id: string) {
    const convo = conversations.find((c) => c.id === id);
    const newTitle = prompt("Rename conversation:", convo?.title ?? "");
    if (newTitle === null) return;
    await client.models.homeConversation.update({ id, title: newTitle || null });
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: newTitle || null } : c))
    );
  }

  async function deleteConversation(id: string) {
    if (!confirm("Delete this conversation?")) return;
    // Delete messages first
    const { data: msgs } = await client.models.homeAgentMessage.list({
      filter: { conversationId: { eq: id } },
      limit: 200,
    });
    await Promise.all((msgs ?? []).map((m) => client.models.homeAgentMessage.delete({ id: m.id })));
    await client.models.homeConversation.delete({ id });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConvoId === id) {
      setActiveConvoId(null);
      setMessages([]);
    }
  }

  async function createNewConversation() {
    const { data } = await client.models.homeConversation.create({
      title: null,
      createdBy: sender,
    });
    if (data) {
      const convo = data as unknown as Conversation;
      setConversations((prev) => [convo, ...prev]);
      setActiveConvoId(convo.id);
      setMessages([]);
      if (isMobile()) setSidebarOpen(false);
    }
  }

  async function persistMessage(
    conversationId: string,
    msg: Message
  ) {
    await client.models.homeAgentMessage.create({
      conversationId,
      role: msg.role,
      content: msg.content,
      sender: msg.sender ?? null,
      actionsTaken: msg.actionsTaken ? JSON.stringify(msg.actionsTaken) : null,
    });
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || isLoading) return;

    // Auto-create conversation if none selected
    let convoId = activeConvoId;
    if (!convoId) {
      const { data } = await client.models.homeConversation.create({
        title: null,
        createdBy: sender,
      });
      if (!data) return;
      const convo = data as unknown as Conversation;
      convoId = convo.id;
      setConversations((prev) => [convo, ...prev]);
      setActiveConvoId(convoId);
    }

    const userMessage: Message = { role: "user", content: text, sender };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    // Persist user message
    await persistMessage(convoId, userMessage);

    try {
      const history = messages.map((m) => ({
        role: m.role,
        content: [{ text: m.content }],
      }));

      const { data, errors } = await client.mutations.invokeHomeAgent({
        message: text,
        history: JSON.stringify(history),
        sender,
      });

      if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "Agent failed");

      const assistantMessage: Message = {
        role: "assistant",
        content: data.message,
        actionsTaken: (data.actionsTaken?.filter(Boolean) ?? []) as ActionTaken[],
      };

      setMessages((prev) => [...prev, assistantMessage]);
      await persistMessage(convoId, assistantMessage);

      // Auto-title: use first user message as conversation title
      const convo = conversations.find((c) => c.id === convoId);
      if (convo && !convo.title) {
        const title = text.length > 50 ? text.slice(0, 47) + "..." : text;
        await client.models.homeConversation.update({ id: convoId, title });
        setConversations((prev) =>
          prev.map((c) => (c.id === convoId ? { ...c, title } : c))
        );
      }
    } catch (err: any) {
      const errMsg: Message = {
        role: "assistant",
        content: `Sorry, something went wrong: ${err.message}`,
      };
      setMessages((prev) => [...prev, errMsg]);
      await persistMessage(convoId, errMsg);
    } finally {
      setIsLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <DefaultLayout>
      <div className="flex h-[calc(100dvh-4rem)] relative">
        {/* Mobile backdrop */}
        {sidebarOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/40 z-30"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Sidebar — conversation list (drawer on mobile, inline on desktop) */}
        <div
          className={`${
            sidebarOpen ? "w-64" : "w-0"
          } absolute md:relative inset-y-0 left-0 z-40 md:z-auto h-full transition-all duration-200 overflow-hidden border-r border-default-200 flex flex-col bg-default-50`}
        >
          <div className="p-3 border-b border-default-200 flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Chats</span>
            <Button size="sm" isIconOnly variant="light" onPress={createNewConversation}>
              <FaPlus size={12} />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.map((convo) => (
              <div
                key={convo.id}
                className={`group flex items-center justify-between px-3 py-2 hover:bg-default-100 transition-colors cursor-pointer ${
                  convo.id === activeConvoId
                    ? "bg-default-200 font-medium"
                    : "text-default-600"
                }`}
                onClick={() => selectConversation(convo.id)}
              >
                <span className="text-sm truncate flex-1">
                  {convo.title ?? "New conversation"}
                </span>
                <Dropdown>
                  <DropdownTrigger>
                    <button
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-default-200"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <FaEllipsisV size={10} />
                    </button>
                  </DropdownTrigger>
                  <DropdownMenu
                    onAction={(key: Key) => {
                      if (key === "rename") renameConversation(convo.id);
                      if (key === "delete") deleteConversation(convo.id);
                    }}
                  >
                    <DropdownItem key="rename">Rename</DropdownItem>
                    <DropdownItem key="delete" className="text-danger" color="danger">Delete</DropdownItem>
                  </DropdownMenu>
                </Dropdown>
              </div>
            ))}
            {conversations.length === 0 && (
              <p className="text-xs text-default-300 p-3">No conversations yet</p>
            )}
          </div>
        </div>

        {/* Main chat area */}
        <div className="flex-1 min-w-0 w-full flex flex-col max-w-2xl mx-auto px-4 py-6">
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-default-200">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                isIconOnly
                variant="light"
                onPress={() => setSidebarOpen(!sidebarOpen)}
              >
                {sidebarOpen ? "\u2190" : "\u2192"}
              </Button>
              <div>
                <h1 className="text-xl font-bold text-foreground">Home Assistant</h1>
                <p className="text-sm text-default-400">
                  {fullName ? `Hi ${fullName}` : "Loading..."}
                </p>
              </div>
            </div>
            <Button size="sm" variant="light" onPress={() => router.push("/")}>
              Dashboard
            </Button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto py-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-center text-default-300 mt-20">
                <p className="text-lg">Ask me anything about your household</p>
                <p className="text-sm mt-2">
                  I can manage tasks, bills, calendar events, and reminders.
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <Card
                  className={`max-w-[80%] ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-default-100"
                  }`}
                >
                  <CardBody className="px-4 py-3">
                    {msg.role === "user" && msg.sender && (
                      <p className="text-xs opacity-70 mb-1 capitalize">
                        {msg.sender}
                      </p>
                    )}
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                    {msg.actionsTaken && msg.actionsTaken.length > 0 && (
                      <ActionLog actions={msg.actionsTaken} />
                    )}
                  </CardBody>
                </Card>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <Card className="bg-default-100">
                  <CardBody className="px-4 py-3">
                    <Spinner size="sm" />
                  </CardBody>
                </Card>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-default-200 pt-4 pb-2">
            <div className="flex gap-2">
              <Input
                placeholder="Ask me to create a task, add a bill, schedule a reminder..."
                value={input}
                onValueChange={setInput}
                onKeyDown={handleKeyDown}
                isDisabled={isLoading}
                classNames={{
                  inputWrapper: "bg-default-100",
                }}
              />
              <Button
                isIconOnly
                color="primary"
                onPress={sendMessage}
                isDisabled={!input.trim() || isLoading}
              >
                <FaPaperPlane />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
}

