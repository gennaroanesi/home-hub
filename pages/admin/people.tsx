"use client";

// Admin-facing people management.
//
// Sectioning is driven by the homePerson.groups cache (synced from
// Cognito by the setPersonGroups Lambda):
//
//   - Household: groups includes "home-users". Members of the home.
//   - Friends:   has cognitoUsername (so they can log in) but is NOT
//                in home-users. Future-proofs invited guests.
//   - Others:    no cognitoUsername — face-tag-only rows for kids /
//                extended family.
//
// Group changes are admin-only and route through the setPersonGroups
// mutation, which rewrites Cognito group membership AND mirrors the
// result onto homePerson.groups. Non-admin household members can
// still edit names, colors, timezones, and their own notification
// flags via the regular update path.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { fetchAuthSession, getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
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
import {
  FaPlus,
  FaTrash,
  FaPen,
  FaArrowLeft,
  FaCodeBranch,
} from "react-icons/fa";

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

// The set of groups admins can assign from the UI. Cognito allows
// arbitrary group names but the UI shouldn't be a free-text editor —
// limit to the ones the app actually uses, plus "friends" so we have
// somewhere to land invited guests.
const ASSIGNABLE_GROUPS = ["home-users", "admins", "friends"];

function rowGroups(p: Person): string[] {
  return (p.groups ?? []).filter((g): g is string => !!g);
}

function isHousehold(p: Person): boolean {
  return rowGroups(p).includes("home-users");
}

function isFriend(p: Person): boolean {
  return !!p.cognitoUsername && !isHousehold(p);
}

function PersonCard({
  person,
  onEdit,
  onRemove,
  onMerge,
  canMerge,
}: {
  person: Person;
  onEdit: () => void;
  onRemove: () => void;
  onMerge: () => void;
  canMerge: boolean;
}) {
  const groups = rowGroups(person);
  const isLogin = !!person.cognitoUsername;
  const muted: string[] = [];
  if (isLogin && person.notifyWhatsApp === false) muted.push("WA off");
  if (isLogin && person.notifyPush === false) muted.push("Push off");
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
          <div className="flex items-center gap-1 flex-wrap mt-0.5">
            {groups.map((g) => (
              <Chip key={g} size="sm" variant="flat" color="primary">
                {g}
              </Chip>
            ))}
            <span className="text-xs text-default-400">
              {person.defaultTimezone}
              {muted.length > 0 ? ` · ${muted.join(", ")}` : ""}
            </span>
          </div>
        </div>
        <div className="flex gap-1">
          {canMerge && (
            <Button size="sm" isIconOnly variant="light" onPress={onMerge} title="Merge into…">
              <FaCodeBranch size={12} />
            </Button>
          )}
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
  const [isAdmin, setIsAdmin] = useState(false);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const mergeModal = useDisclosure();
  const [mergeSource, setMergeSource] = useState<Person | null>(null);

  const [name, setName] = useState("");
  const [color, setColor] = useState("#3a5068");
  const [emoji, setEmoji] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [cognitoUsername, setCognitoUsername] = useState("");
  const [email, setEmail] = useState("");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"
  );
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(true);
  const [notifyPush, setNotifyPush] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      await getCurrentUser();
      const session = await fetchAuthSession();
      const cognitoGroups =
        (session.tokens?.idToken?.payload?.["cognito:groups"] as string[]) ?? [];
      setIsAdmin(cognitoGroups.includes("admins"));
      await loadPeople();
    } catch {
      router.push("/login");
    }
  }

  const loadPeople = useCallback(async () => {
    const { data } = await client.models.homePerson.list();
    setPeople((data ?? []).sort((a, b) => a.name.localeCompare(b.name)));
  }, []);

  const household = useMemo(() => people.filter(isHousehold), [people]);
  const friends = useMemo(() => people.filter(isFriend), [people]);
  const others = useMemo(() => people.filter((p) => !p.cognitoUsername), [people]);

  function openCreate() {
    setEditing(null);
    setName("");
    setColor("#3a5068");
    setEmoji("");
    setPhoneNumber("");
    setCognitoUsername("");
    setEmail("");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
    setNotifyWhatsApp(true);
    setNotifyPush(true);
    setGroups([]);
    onOpen();
  }

  function openEdit(p: Person) {
    setEditing(p);
    setName(p.name);
    setColor(p.color ?? "#3a5068");
    setEmoji(p.emoji ?? "");
    setPhoneNumber(p.phoneNumber ?? "");
    setCognitoUsername(p.cognitoUsername ?? "");
    setEmail(p.email ?? "");
    setTimezone(p.defaultTimezone ?? "America/New_York");
    setNotifyWhatsApp(p.notifyWhatsApp !== false);
    setNotifyPush(p.notifyPush !== false);
    setGroups(rowGroups(p));
    onOpen();
  }

  async function save(onClose: () => void) {
    if (!name.trim()) return;
    const basePayload = {
      name,
      color,
      emoji: emoji || null,
      phoneNumber: phoneNumber.trim() || null,
      cognitoUsername: cognitoUsername.trim() || null,
      email: email.trim() || null,
      defaultTimezone: timezone,
      notifyWhatsApp,
      notifyPush,
    };
    let savedPerson: Person | null = null;
    if (editing) {
      const { data } = await client.models.homePerson.update({
        id: editing.id,
        ...basePayload,
      });
      savedPerson = data ?? null;
    } else {
      const { data } = await client.models.homePerson.create({
        ...basePayload,
        active: true,
        groups: [],
      });
      savedPerson = data ?? null;
    }

    // Group changes route through the admin mutation so Cognito
    // stays in sync. Skip if the row has no Cognito link (no user
    // to assign groups to) or if nothing changed.
    if (
      isAdmin &&
      savedPerson &&
      savedPerson.cognitoUsername &&
      !arraysEqual(rowGroups(savedPerson), groups)
    ) {
      try {
        const res = await client.mutations.setPersonGroups({
          personId: savedPerson.id,
          groups,
        });
        if (res.errors?.length) {
          throw new Error(res.errors[0].message);
        }
        addToast({
          title: "Groups updated",
          description:
            "Cognito changes take effect on the user's next sign-in.",
        });
      } catch (err: any) {
        addToast({
          title: "Failed to update groups",
          description: err?.message ?? String(err),
          color: "danger",
        });
      }
    }

    onClose();
    await loadPeople();
  }

  async function remove(id: string) {
    if (!confirm("Delete this person? Tasks/events assigned to them will become unassigned.")) return;
    await client.models.homePerson.delete({ id });
    await loadPeople();
  }

  function openMerge(p: Person) {
    setMergeSource(p);
    mergeModal.onOpen();
  }

  async function performMerge(target: Person) {
    if (!mergeSource) return;
    if (!confirm(
      `Merge ${mergeSource.name} into ${target.name}? Every reference to ${mergeSource.name} will be rewritten and the row deleted.`
    )) return;
    try {
      const res = await client.mutations.mergePeople({
        sourceId: mergeSource.id,
        targetId: target.id,
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      addToast({ title: "Merged", description: JSON.stringify(res.data?.rewrites ?? {}) });
      mergeModal.onClose();
      setMergeSource(null);
      await loadPeople();
    } catch (err: any) {
      addToast({
        title: "Merge failed",
        description: err?.message ?? String(err),
        color: "danger",
      });
    }
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

        {!isAdmin && (
          <p className="text-xs text-default-400 mb-4">
            Group membership is admin-only. You can edit names / timezones /
            notification toggles, but the &quot;Groups&quot; section is read-only for you.
          </p>
        )}

        {people.length === 0 && (
          <p className="text-center text-default-300 py-10">
            No people yet. Add household members to get started.
          </p>
        )}

        <Section
          title="Household"
          rows={household}
          isAdmin={isAdmin}
          onEdit={openEdit}
          onRemove={remove}
          onMerge={openMerge}
        />
        <Section
          title="Friends (logged-in, not in household)"
          rows={friends}
          isAdmin={isAdmin}
          onEdit={openEdit}
          onRemove={remove}
          onMerge={openMerge}
        />
        <Section
          title="Others (face tagging)"
          rows={others}
          isAdmin={isAdmin}
          onEdit={openEdit}
          onRemove={remove}
          onMerge={openMerge}
        />

        {/* Edit / create modal */}
        <Modal isOpen={isOpen} onOpenChange={onOpenChange} scrollBehavior="inside">
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>{editing ? "Edit Person" : "New Person"}</ModalHeader>
                <ModalBody>
                  <Input label="Name" value={name} onValueChange={setName} isRequired />
                  <Input label="Color" type="color" value={color} onValueChange={setColor} />
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
                    label="Cognito username (sub)"
                    value={cognitoUsername}
                    onValueChange={setCognitoUsername}
                    placeholder="auto-populated on sign-up"
                    description="Set automatically by the post-confirmation Lambda. Only edit when manually linking a face row to a fresh sign-up."
                  />
                  <Input
                    label="Email"
                    value={email}
                    onValueChange={setEmail}
                    placeholder="user@example.com"
                    description="Used by the post-confirmation Lambda to match a sign-up to this row."
                  />
                  <Input
                    label="Default timezone"
                    value={timezone}
                    onValueChange={setTimezone}
                    description={`Common: ${COMMON_TIMEZONES.join(", ")}`}
                  />

                  {cognitoUsername.trim() && (
                    <div className="flex flex-col gap-2 pt-2 border-t border-default-100">
                      <p className="text-xs font-medium text-default-500 uppercase tracking-wide">
                        Notifications
                      </p>
                      <Switch size="sm" isSelected={notifyWhatsApp} onValueChange={setNotifyWhatsApp}>
                        <span className="text-sm">WhatsApp messages</span>
                      </Switch>
                      <Switch size="sm" isSelected={notifyPush} onValueChange={setNotifyPush}>
                        <span className="text-sm">App push notifications</span>
                      </Switch>
                    </div>
                  )}

                  {cognitoUsername.trim() && (
                    <div className="flex flex-col gap-2 pt-2 border-t border-default-100">
                      <p className="text-xs font-medium text-default-500 uppercase tracking-wide">
                        Groups {isAdmin ? "" : "(read-only)"}
                      </p>
                      <div className="flex gap-2 flex-wrap">
                        {ASSIGNABLE_GROUPS.map((g) => {
                          const on = groups.includes(g);
                          return (
                            <Chip
                              key={g}
                              size="sm"
                              variant={on ? "solid" : "flat"}
                              color={on ? "primary" : "default"}
                              className={isAdmin ? "cursor-pointer" : ""}
                              onClick={() => {
                                if (!isAdmin) return;
                                setGroups((prev) =>
                                  prev.includes(g)
                                    ? prev.filter((x) => x !== g)
                                    : [...prev, g]
                                );
                              }}
                            >
                              {g}
                            </Chip>
                          );
                        })}
                      </div>
                      <p className="text-xs text-default-400">
                        Cognito changes only take effect on the user&apos;s next
                        token refresh (sign out + back in).
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

        {/* Merge target picker */}
        <Modal
          isOpen={mergeModal.isOpen}
          onOpenChange={mergeModal.onOpenChange}
          scrollBehavior="inside"
        >
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>
                  Merge {mergeSource?.name} into…
                </ModalHeader>
                <ModalBody>
                  <p className="text-xs text-default-500 mb-2">
                    Every reference to {mergeSource?.name} (tasks, events, faces,
                    documents, reminders, etc.) will be rewritten to point at the
                    target row, then this row will be deleted.
                  </p>
                  <div className="space-y-2">
                    {people
                      .filter((p) => p.id !== mergeSource?.id)
                      .map((p) => (
                        <Card
                          key={p.id}
                          isPressable
                          onPress={() => performMerge(p)}
                        >
                          <CardBody className="flex flex-row items-center gap-3 px-4 py-3">
                            <div
                              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium"
                              style={{ backgroundColor: p.color ?? "#3a5068" }}
                            >
                              {p.emoji || p.name[0]}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium">{p.name}</p>
                              <div className="flex gap-1 flex-wrap">
                                {rowGroups(p).map((g) => (
                                  <Chip key={g} size="sm" variant="flat">
                                    {g}
                                  </Chip>
                                ))}
                              </div>
                            </div>
                          </CardBody>
                        </Card>
                      ))}
                  </div>
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>Cancel</Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>
      </div>
    </DefaultLayout>
  );
}

// ── Section ────────────────────────────────────────────────────────────────

function Section({
  title,
  rows,
  isAdmin,
  onEdit,
  onRemove,
  onMerge,
}: {
  title: string;
  rows: Person[];
  isAdmin: boolean;
  onEdit: (p: Person) => void;
  onRemove: (id: string) => void;
  onMerge: (p: Person) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-default-500 mt-2 mb-2">
        {title}
      </h2>
      <div className="space-y-2 mb-6">
        {rows.map((p) => (
          <PersonCard
            key={p.id}
            person={p}
            onEdit={() => onEdit(p)}
            onRemove={() => onRemove(p.id)}
            onMerge={() => onMerge(p)}
            canMerge={isAdmin}
          />
        ))}
      </div>
    </>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
