"use client";

import React, { useState, useEffect, useRef, useCallback, Key } from "react";
import { getCurrentUser, fetchUserAttributes } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
import { Spinner, addToast } from "@heroui/react";
import { FaPaperPlane, FaChevronDown, FaChevronUp, FaPlus, FaEllipsisV, FaPaperclip, FaTimes } from "react-icons/fa";
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from "@heroui/react";

import DefaultLayout from "@/layouts/default";
import type { Schema } from "@/amplify/data/resource";
import { originalPhotoUrl } from "@/lib/image-loader";

const MAX_IMAGES_PER_TURN = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB — Claude's per-image limit
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const ACCEPT_ATTR = "image/jpeg,image/png,image/gif,image/webp";

const client = generateClient<Schema>({ authMode: "userPool" });

interface ActionTaken {
  tool: string;
  result: Record<string, any>;
}

interface Attachment {
  type: string;
  url?: string;
  s3Key?: string;
  caption?: string | null;
  // Local-only blob URL for optimistic render of just-uploaded user images.
  // Not persisted; lost after navigation/reload (we fall back to s3Key + CloudFront).
  blobUrl?: string;
}

interface PendingImage {
  id: string;
  file: File;
  blobUrl: string;
}

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  sender?: string;
  actionsTaken?: ActionTaken[];
  attachments?: Attachment[];
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
  send_photos: "Sent photos",
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
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Revoke any outstanding pending-image blob URLs on unmount to prevent
  // memory leaks. Sent-message blob URLs are revoked when the message is
  // dropped from local state (which currently never happens within the
  // page lifetime), so this catches any still-pending picks at teardown.
  useEffect(() => {
    return () => {
      pendingImages.forEach((p) => URL.revokeObjectURL(p.blobUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        attachments: m.attachments ? (m.attachments as Attachment[]) : undefined,
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
      attachments: msg.attachments && msg.attachments.length > 0 ? JSON.stringify(msg.attachments) : null,
    });
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = "";
    if (files.length === 0) return;

    const accepted: PendingImage[] = [];
    const remainingSlots = MAX_IMAGES_PER_TURN - pendingImages.length;
    if (remainingSlots <= 0) {
      addToast({
        title: "Too many images",
        description: `Max ${MAX_IMAGES_PER_TURN} images per message`,
      });
      return;
    }

    for (const file of files) {
      if (accepted.length >= remainingSlots) {
        addToast({
          title: "Too many images",
          description: `Max ${MAX_IMAGES_PER_TURN} images per message`,
        });
        break;
      }
      // HEIC sometimes shows up with empty type or "image/heic"; reject
      // anything not on the strict allow-list.
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        if (file.type === "image/heic" || file.type === "image/heif" || file.name.toLowerCase().endsWith(".heic")) {
          addToast({
            title: "HEIC not supported",
            description: "Share a screenshot or JPG instead.",
          });
        } else {
          addToast({
            title: "Unsupported image type",
            description: `${file.name}: only JPEG, PNG, GIF, or WebP are accepted.`,
          });
        }
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        addToast({
          title: "Image too large",
          description: `${file.name} is over 5 MB. Resize and try again.`,
        });
        continue;
      }
      accepted.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        blobUrl: URL.createObjectURL(file),
      });
    }

    if (accepted.length > 0) {
      setPendingImages((prev) => [...prev, ...accepted]);
    }
  }

  function removePendingImage(id: string) {
    setPendingImages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.blobUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  async function uploadPendingImage(p: PendingImage): Promise<string> {
    const urlRes = await fetch("/api/agent/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: p.file.type }),
    });
    if (!urlRes.ok) {
      const body = await urlRes.json().catch(() => ({}));
      throw new Error(body.error ?? `Upload URL error: ${urlRes.status}`);
    }
    const { uploadUrl, s3key } = await urlRes.json();
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": p.file.type },
      body: p.file,
    });
    if (!putRes.ok) throw new Error(`S3 upload failed: ${putRes.status}`);
    return s3key as string;
  }

  async function sendMessage() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || isLoading) return;

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

    // Upload any attached images BEFORE we mutate state, so a failure
    // leaves the input + pending picks intact for the user to retry.
    setIsLoading(true);
    let uploadedKeys: string[] = [];
    const imagesForTurn = pendingImages;
    if (imagesForTurn.length > 0) {
      try {
        uploadedKeys = await Promise.all(imagesForTurn.map(uploadPendingImage));
      } catch (err: any) {
        addToast({
          title: "Image upload failed",
          description: err?.message ?? String(err),
        });
        setIsLoading(false);
        return;
      }
    }

    // Build user-turn attachments. Pair each blob URL with its s3Key so
    // the bubble renders optimistically (blobUrl) on first paint and
    // falls back to CloudFront on reload.
    const userAttachments: Attachment[] = imagesForTurn.map((p, i) => ({
      type: "image",
      s3Key: uploadedKeys[i],
      blobUrl: p.blobUrl,
    }));

    const userMessage: Message = {
      role: "user",
      content: text,
      sender,
      attachments: userAttachments.length > 0 ? userAttachments : undefined,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    // Don't revoke blob URLs here — the message bubble is still using them
    // for optimistic rendering. They live for the rest of the page session.
    setPendingImages([]);

    // Persist user message
    await persistMessage(convoId, userMessage);

    try {
      // The agent handler expects history as { role, content, attachments }.
      // Forwarding attachments activates the handler's image-rehydration
      // path so prior-turn images stay in Claude's context. Cap to the
      // last 10 messages so we don't blow the prompt as conversations grow.
      const history = messages.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
        // Strip blobUrl (local-only) — keep type/s3Key/url so the
        // handler can rehydrate user images and ignore assistant URLs.
        attachments: m.attachments?.map((a) => ({
          type: a.type,
          s3Key: a.s3Key,
          url: a.url,
          caption: a.caption,
        })),
      }));

      const { data, errors } = await client.mutations.invokeHomeAgent({
        message: text,
        history: JSON.stringify(history),
        sender,
        imageS3Keys: uploadedKeys,
      });

      if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "Agent failed");

      const assistantMessage: Message = {
        role: "assistant",
        content: data.message,
        actionsTaken: (data.actionsTaken?.filter(Boolean) ?? []) as ActionTaken[],
        attachments: (data.attachments?.filter(Boolean) ?? []) as Attachment[],
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
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        {msg.attachments.map((att, idx) => {
                          if (att.type !== "image") return null;
                          // Prefer the optimistic local blob URL (only set
                          // pre-send for user uploads), then CloudFront via
                          // s3Key (works for both reload + assistant photos
                          // when they store keys), then the absolute url
                          // (assistant send_photos result).
                          const src =
                            att.blobUrl ??
                            (att.s3Key ? originalPhotoUrl(att.s3Key) : att.url);
                          if (!src) return null;
                          return (
                            <a
                              key={idx}
                              href={src}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={src}
                                alt={att.caption ?? "photo"}
                                loading="lazy"
                                className="w-full h-auto rounded-sm"
                              />
                              {att.caption && (
                                <p className="text-xs opacity-70 mt-0.5 truncate">{att.caption}</p>
                              )}
                            </a>
                          );
                        })}
                      </div>
                    )}
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
            {pendingImages.length > 0 && (
              <div className="flex gap-2 flex-wrap pb-2">
                {pendingImages.map((p) => (
                  <div key={p.id} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.blobUrl}
                      alt={p.file.name}
                      className="w-16 h-16 object-cover rounded border border-default-200"
                    />
                    <button
                      type="button"
                      onClick={() => removePendingImage(p.id)}
                      className="absolute -top-1 -right-1 bg-default-900 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] hover:bg-danger transition-colors"
                      aria-label={`Remove ${p.file.name}`}
                    >
                      <FaTimes size={8} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              multiple
              className="hidden"
              onChange={handleFilePick}
            />
            <div className="flex gap-2">
              <Button
                isIconOnly
                variant="flat"
                onPress={() => fileInputRef.current?.click()}
                isDisabled={isLoading || pendingImages.length >= MAX_IMAGES_PER_TURN}
                aria-label="Attach images"
              >
                <FaPaperclip />
              </Button>
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
                isDisabled={(!input.trim() && pendingImages.length === 0) || isLoading}
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

