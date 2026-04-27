"use client";

import React, { useState, useEffect, useCallback } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
import { Switch } from "@heroui/switch";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { FaPlus, FaTrash, FaPen, FaArrowLeft } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Person = Schema["homePerson"]["type"];

const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Rome",
  "Asia/Tokyo",
  "UTC",
];

function PersonCard({
  person,
  onEdit,
  onRemove,
}: {
  person: Person;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const isHousehold = !!person.cognitoUsername;
  const muted: string[] = [];
  if (isHousehold && person.notifyWhatsApp === false) muted.push("WA off");
  if (isHousehold && person.notifyPush === false) muted.push("Push off");
  return (
    <Card>
      <CardBody className="flex flex-row items-center gap-3 px-4 py-3">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium"
          style={{ backgroundColor: person.color ?? "#3a5068" }}
        >
          {person.emoji || person.name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{person.name}</p>
          <p className="text-xs text-default-400">
            {person.defaultTimezone}
            {muted.length > 0 ? ` · ${muted.join(", ")}` : ""}
          </p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" isIconOnly variant="light" onPress={onEdit}>
            <FaPen size={12} />
          </Button>
          <Button size="sm" isIconOnly variant="light" color="danger" onPress={onRemove}>
            <FaTrash size={12} />
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

export default function PeoplePage() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [editing, setEditing] = useState<Person | null>(null);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();

  const [name, setName] = useState("");
  const [color, setColor] = useState("#3a5068");
  const [emoji, setEmoji] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [cognitoUsername, setCognitoUsername] = useState("");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"
  );
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(true);
  const [notifyPush, setNotifyPush] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      await getCurrentUser();
      await loadPeople();
    } catch {
      router.push("/login");
    }
  }

  const loadPeople = useCallback(async () => {
    const { data } = await client.models.homePerson.list();
    setPeople((data ?? []).sort((a, b) => a.name.localeCompare(b.name)));
  }, []);

  function openCreate() {
    setEditing(null);
    setName("");
    setColor("#3a5068");
    setEmoji("");
    setPhoneNumber("");
    setCognitoUsername("");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
    setNotifyWhatsApp(true);
    setNotifyPush(true);
    onOpen();
  }

  function openEdit(p: Person) {
    setEditing(p);
    setName(p.name);
    setColor(p.color ?? "#3a5068");
    setEmoji(p.emoji ?? "");
    setPhoneNumber(p.phoneNumber ?? "");
    setCognitoUsername(p.cognitoUsername ?? "");
    setTimezone(p.defaultTimezone ?? "America/New_York");
    setNotifyWhatsApp(p.notifyWhatsApp !== false);
    setNotifyPush(p.notifyPush !== false);
    onOpen();
  }

  async function save(onClose: () => void) {
    if (!name.trim()) return;
    if (editing) {
      await client.models.homePerson.update({
        id: editing.id,
        name,
        color,
        emoji: emoji || null,
        phoneNumber: phoneNumber.trim() || null,
        cognitoUsername: cognitoUsername.trim() || null,
        defaultTimezone: timezone,
        notifyWhatsApp,
        notifyPush,
      });
    } else {
      await client.models.homePerson.create({
        name,
        color,
        emoji: emoji || null,
        phoneNumber: phoneNumber.trim() || null,
        cognitoUsername: cognitoUsername.trim() || null,
        defaultTimezone: timezone,
        active: true,
        notifyWhatsApp,
        notifyPush,
      });
    }
    onClose();
    await loadPeople();
  }

  async function remove(id: string) {
    if (!confirm("Delete this person? Tasks/events assigned to them will become unassigned.")) return;
    await client.models.homePerson.delete({ id });
    await loadPeople();
  }

  return (
    <DefaultLayout>
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-2xl font-bold text-foreground">People</h1>
          </div>
          <Button color="primary" size="sm" startContent={<FaPlus size={12} />} onPress={openCreate}>
            New Person
          </Button>
        </div>

        {people.length === 0 && (
          <p className="text-center text-default-300 py-10">
            No people yet. Add Gennaro and Cristine to get started.
          </p>
        )}

        {/* Household members — anyone with a Cognito link. They sign
            in, get reminders/notifications, appear in calendar legends. */}
        {people.some((p) => p.cognitoUsername) && (
          <>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-default-500 mt-2 mb-2">
              Household
            </h2>
            <div className="space-y-2 mb-6">
              {people
                .filter((p) => p.cognitoUsername)
                .map((p) => (
                  <PersonCard
                    key={p.id}
                    person={p}
                    onEdit={() => openEdit(p)}
                    onRemove={() => remove(p.id)}
                  />
                ))}
            </div>
          </>
        )}

        {/* Others — face-tag-only rows for extended family / friends.
            No notification flags are surfaced here since they don't
            log in. */}
        {people.some((p) => !p.cognitoUsername) && (
          <>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-default-500 mt-2 mb-2">
              Others (face tagging)
            </h2>
            <div className="space-y-2">
              {people
                .filter((p) => !p.cognitoUsername)
                .map((p) => (
                  <PersonCard
                    key={p.id}
                    person={p}
                    onEdit={() => openEdit(p)}
                    onRemove={() => remove(p.id)}
                  />
                ))}
            </div>
          </>
        )}

        <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>{editing ? "Edit Person" : "New Person"}</ModalHeader>
                <ModalBody>
                  <Input label="Name" value={name} onValueChange={setName} isRequired />
                  <Input
                    label="Color"
                    type="color"
                    value={color}
                    onValueChange={setColor}
                  />
                  <Input
                    label="Emoji (optional)"
                    value={emoji}
                    onValueChange={setEmoji}
                    placeholder="🐱"
                  />
                  <Input
                    label="Phone number (optional)"
                    value={phoneNumber}
                    onValueChange={setPhoneNumber}
                    placeholder="+12125551234"
                    description="E.164 format. Used by the WhatsApp bot to DM this person."
                  />
                  <Input
                    label="Cognito username (optional)"
                    value={cognitoUsername}
                    onValueChange={setCognitoUsername}
                    placeholder="gennaro"
                    description="Fill in for household members who log in. Drives calendar visibility and is the join key for per-user features."
                  />
                  <Input
                    label="Default timezone"
                    value={timezone}
                    onValueChange={setTimezone}
                    description={`Common: ${COMMON_TIMEZONES.join(", ")}`}
                  />

                  {/* Notification preferences only render for household
                      members — face-tag-only rows don't have anyone to
                      notify. */}
                  {cognitoUsername.trim() && (
                    <div className="flex flex-col gap-2 pt-2 border-t border-default-100">
                      <p className="text-xs font-medium text-default-500 uppercase tracking-wide">
                        Notifications
                      </p>
                      <Switch
                        size="sm"
                        isSelected={notifyWhatsApp}
                        onValueChange={setNotifyWhatsApp}
                      >
                        <span className="text-sm">WhatsApp messages</span>
                      </Switch>
                      <Switch
                        size="sm"
                        isSelected={notifyPush}
                        onValueChange={setNotifyPush}
                      >
                        <span className="text-sm">App push notifications</span>
                      </Switch>
                      <p className="text-xs text-default-400">
                        Reminders and personal messages respect these per-person
                        flags. Group/household sends still go through whichever
                        channel each member has on.
                      </p>
                    </div>
                  )}
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                  <Button color="primary" onPress={() => save(onClose)}>
                    {editing ? "Save" : "Create"}
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
