"use client";

import React, { useState, useEffect, useCallback } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Switch } from "@heroui/switch";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { addToast } from "@heroui/react";
import { FaArrowLeft, FaPlus, FaTrash, FaPen, FaSyncAlt, FaCalendarAlt } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Feed = Schema["homeCalendarFeed"]["type"];

const DEFAULT_COLOR = "#8B5CF6";

export default function CalendarFeedsPage() {
  const router = useRouter();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState(true);
  const modal = useDisclosure();
  const [editing, setEditing] = useState<Feed | null>(null);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
        await loadFeeds();
      } catch {
        router.push("/login");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadFeeds = useCallback(async () => {
    setLoading(true);
    const { data } = await client.models.homeCalendarFeed.list({ limit: 50 });
    setFeeds((data ?? []).sort((a, b) => a.name.localeCompare(b.name)));
    setLoading(false);
  }, []);

  function openCreate() {
    setEditing(null);
    setName("");
    setUrl("");
    setColor(DEFAULT_COLOR);
    modal.onOpen();
  }

  function openEdit(feed: Feed) {
    setEditing(feed);
    setName(feed.name);
    setUrl(feed.url);
    setColor(feed.color ?? DEFAULT_COLOR);
    modal.onOpen();
  }

  async function save(onClose: () => void) {
    if (!name.trim() || !url.trim()) {
      addToast({ title: "Name and URL are required", color: "warning" });
      return;
    }
    try {
      if (editing) {
        const { errors } = await client.models.homeCalendarFeed.update({
          id: editing.id,
          name: name.trim(),
          url: url.trim(),
          color,
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else {
        const { errors } = await client.models.homeCalendarFeed.create({
          name: name.trim(),
          url: url.trim(),
          color,
          active: true,
        });
        if (errors?.length) throw new Error(errors[0].message);
      }
      addToast({
        title: editing ? "Feed updated" : "Feed added",
        description: editing
          ? "Changes will take effect on the next sync"
          : "First sync runs within 15 minutes",
        color: "success",
      });
      onClose();
      await loadFeeds();
    } catch (err: any) {
      addToast({
        title: "Save failed",
        description: err?.message ?? String(err),
        color: "danger",
      });
    }
  }

  async function toggleActive(feed: Feed) {
    const next = feed.active === false;
    await client.models.homeCalendarFeed.update({ id: feed.id, active: next });
    await loadFeeds();
  }

  async function handleDelete(feed: Feed) {
    // Deleting a feed orphans its imported events — we leave them in place
    // to avoid surprising the user. If they want events gone too, they can
    // clear them from the calendar directly.
    if (
      !confirm(
        `Delete feed "${feed.name}"? Imported events will stay on the calendar but will stop syncing.`
      )
    ) {
      return;
    }
    await client.models.homeCalendarFeed.delete({ id: feed.id });
    setFeeds((prev) => prev.filter((f) => f.id !== feed.id));
  }

  function formatLastSync(iso: string | null | undefined): string {
    if (!iso) return "never";
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <FaCalendarAlt className="text-default-500" />
                Calendar feeds
              </h1>
              <p className="text-xs text-default-500">
                External ICS / webcal subscriptions. Synced every 15 minutes, one-way.
              </p>
            </div>
          </div>
          <Button
            color="primary"
            size="sm"
            startContent={<FaPlus size={12} />}
            onPress={openCreate}
          >
            Add feed
          </Button>
        </div>

        {loading && <p className="text-center text-default-400 py-6">Loading…</p>}

        {!loading && feeds.length === 0 && (
          <Card>
            <CardBody className="text-center py-10 text-default-500">
              <p className="text-sm">No feeds yet.</p>
              <p className="text-xs text-default-400 mt-1">
                Add an iCloud shared calendar, Google Calendar ICS export, or any
                public webcal subscription URL to pull its events into Home Hub.
              </p>
            </CardBody>
          </Card>
        )}

        <div className="space-y-2">
          {feeds.map((feed) => {
            const hasError = !!feed.lastSyncError;
            return (
              <Card key={feed.id} className={feed.active === false ? "opacity-60" : ""}>
                <CardHeader className="flex items-start justify-between px-4 pt-3 pb-1 gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="inline-block w-3 h-3 rounded-sm"
                        style={{ backgroundColor: feed.color ?? DEFAULT_COLOR }}
                        title="Feed colour"
                      />
                      <p className="text-sm font-semibold truncate">{feed.name}</p>
                      {feed.active === false && (
                        <Chip size="sm" variant="flat" color="default">
                          Paused
                        </Chip>
                      )}
                      {hasError && (
                        <Chip size="sm" variant="flat" color="danger">
                          Error
                        </Chip>
                      )}
                      {typeof feed.eventCount === "number" && !hasError && (
                        <Chip size="sm" variant="flat">
                          {feed.eventCount} event{feed.eventCount === 1 ? "" : "s"}
                        </Chip>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-default-400 flex-wrap">
                      <span className="flex items-center gap-1">
                        <FaSyncAlt size={9} />
                        Last sync: {formatLastSync(feed.lastSyncedAt)}
                      </span>
                    </div>
                    <p className="text-xs text-default-400 mt-0.5 truncate font-mono">
                      {feed.url}
                    </p>
                    {hasError && (
                      <p className="text-xs text-danger-500 mt-1">{feed.lastSyncError}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0 items-center">
                    <Switch
                      size="sm"
                      isSelected={feed.active !== false}
                      onValueChange={() => toggleActive(feed)}
                    />
                    <Button size="sm" isIconOnly variant="light" onPress={() => openEdit(feed)}>
                      <FaPen size={10} />
                    </Button>
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      color="danger"
                      onPress={() => handleDelete(feed)}
                    >
                      <FaTrash size={10} />
                    </Button>
                  </div>
                </CardHeader>
                <CardBody className="px-4 pt-0 pb-3" />
              </Card>
            );
          })}
        </div>

        <Modal isOpen={modal.isOpen} onOpenChange={modal.onOpenChange}>
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>{editing ? "Edit feed" : "New feed"}</ModalHeader>
                <ModalBody>
                  <Input
                    label="Name"
                    placeholder="e.g. Cris shared calendar"
                    value={name}
                    onValueChange={setName}
                    isRequired
                  />
                  <Input
                    label="URL"
                    placeholder="webcal://p68-caldav.icloud.com/published/…"
                    value={url}
                    onValueChange={setUrl}
                    description="ICS / webcal / https URL that returns an .ics file."
                    isRequired
                  />
                  <Input
                    label="Color"
                    type="color"
                    value={color}
                    onValueChange={setColor}
                    description="Used to tint imported events on the calendar."
                  />
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>
                    Cancel
                  </Button>
                  <Button color="primary" onPress={() => save(onClose)}>
                    {editing ? "Save" : "Add"}
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>
      </div>
    </DefaultLayout>
  );
}
