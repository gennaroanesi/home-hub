"use client";

import React, { useState, useEffect, useCallback } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
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

export default function PeoplePage() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [editing, setEditing] = useState<Person | null>(null);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();

  const [name, setName] = useState("");
  const [color, setColor] = useState("#3a5068");
  const [emoji, setEmoji] = useState("");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"
  );

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
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
    onOpen();
  }

  function openEdit(p: Person) {
    setEditing(p);
    setName(p.name);
    setColor(p.color ?? "#3a5068");
    setEmoji(p.emoji ?? "");
    setTimezone(p.defaultTimezone ?? "America/New_York");
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
        defaultTimezone: timezone,
      });
    } else {
      await client.models.homePerson.create({
        name,
        color,
        emoji: emoji || null,
        defaultTimezone: timezone,
        active: true,
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

        <div className="space-y-2">
          {people.length === 0 && (
            <p className="text-center text-default-300 py-10">
              No people yet. Add Gennaro and Cristine to get started.
            </p>
          )}
          {people.map((p) => (
            <Card key={p.id}>
              <CardBody className="flex flex-row items-center gap-3 px-4 py-3">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium"
                  style={{ backgroundColor: p.color ?? "#3a5068" }}
                >
                  {p.emoji || p.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-default-400">{p.defaultTimezone}</p>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" isIconOnly variant="light" onPress={() => openEdit(p)}>
                    <FaPen size={12} />
                  </Button>
                  <Button size="sm" isIconOnly variant="light" color="danger" onPress={() => remove(p.id)}>
                    <FaTrash size={12} />
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>

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
                    label="Default timezone"
                    value={timezone}
                    onValueChange={setTimezone}
                    description={`Common: ${COMMON_TIMEZONES.join(", ")}`}
                  />
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
