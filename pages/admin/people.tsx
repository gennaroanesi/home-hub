"use client";

// Household: the app's users (homePerson rows in the `home-users`
// Cognito group). Everyone else (friends, family, people tagged in
// photos) is on /contacts; see lib/people.ts.
//
// Admins invite members here (invitePerson creates the login and emails
// a temporary password; self sign-up is off) and change their groups
// (setPersonGroups, which rewrites Cognito membership and mirrors it onto
// homePerson.groups). Taking someone out of home-users moves them to
// Contacts. Non-admin members can still edit names, colors, timezones
// and notification flags via the regular update path.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { fetchAuthSession, getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Switch } from "@heroui/switch";
import { Select, SelectItem } from "@heroui/select";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { addToast } from "@heroui/react";
import { FaPen, FaArrowLeft, FaCodeBranch, FaEnvelope } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { HOUSEHOLD_GROUP } from "@/lib/household";
import { listAllPages } from "@/lib/list-all";
import { ASSIGNABLE_GROUPS, inHousehold } from "@/lib/people";
import {
  MergeModal,
  PersonAvatar,
  RelationshipsEditor,
  relationsLine,
  type Person,
} from "@/components/people";
import type { RelationshipRow } from "@/lib/relationships";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

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

const NEW_PERSON = "__new";

function rowGroups(p: Person): string[] {
  return (p.groups ?? []).filter((g): g is string => !!g);
}

function MemberCard({
  person,
  relations,
  isAdmin,
  onEdit,
  onMerge,
}: {
  person: Person;
  relations: string;
  isAdmin: boolean;
  onEdit: () => void;
  onMerge: () => void;
}) {
  const muted: string[] = [];
  if (person.notifyWhatsApp === false) muted.push("WA off");
  if (person.notifyPush === false) muted.push("Push off");
  return (
    <Card>
      <CardBody className="flex flex-row items-center gap-3 px-4 py-3">
        <PersonAvatar person={person} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {person.name}
            {person.active === false && (
              <span className="text-xs text-default-400"> · inactive</span>
            )}
          </p>
          <div className="flex items-center gap-1 flex-wrap mt-0.5">
            {rowGroups(person).map((g) => (
              <Chip key={g} size="sm" variant="flat" color="primary">
                {g}
              </Chip>
            ))}
            <span className="text-xs text-default-400">
              {[person.email, person.defaultTimezone, ...muted]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          {relations && (
            <p className="text-xs text-default-500 truncate">{relations}</p>
          )}
        </div>
        <div className="flex gap-1">
          {isAdmin && (
            <Button
              size="sm"
              isIconOnly
              variant="light"
              onPress={onMerge}
              title="Merge into…"
            >
              <FaCodeBranch size={12} />
            </Button>
          )}
          <Button
            size="sm"
            isIconOnly
            variant="light"
            onPress={onEdit}
            title="Edit"
          >
            <FaPen size={12} />
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

export default function HouseholdPage() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [rels, setRels] = useState<RelationshipRow[]>([]);
  const [editing, setEditing] = useState<Person | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const editModal = useDisclosure();
  const inviteModal = useDisclosure();
  const mergeModal = useDisclosure();
  const [mergeSource, setMergeSource] = useState<Person | null>(null);

  const [name, setName] = useState("");
  const [color, setColor] = useState("#3a5068");
  const [emoji, setEmoji] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [birthday, setBirthday] = useState("");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(true);
  const [notifyPush, setNotifyPush] = useState(true);
  const [active, setActive] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);

  const [invite, setInvite] = useState({
    personId: NEW_PERSON,
    name: "",
    email: "",
    admin: false,
  });
  const [inviting, setInviting] = useState(false);

  const loadPeople = useCallback(async () => {
    const [rows, relRows] = await Promise.all([
      listAllPages<Person>(client.models.homePerson),
      listAllPages<RelationshipRow>(client.models.homePersonRelationship),
    ]);
    setPeople(rows.sort((a, b) => a.name.localeCompare(b.name)));
    setRels(relRows);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
        const session = await fetchAuthSession();
        const cognitoGroups =
          (session.tokens?.idToken?.payload?.["cognito:groups"] as string[]) ??
          [];
        setIsAdmin(cognitoGroups.includes("admins"));
        await loadPeople();
      } catch {
        router.push("/login");
      }
    })();
  }, [loadPeople, router]);

  const members = useMemo(() => people.filter(inHousehold), [people]);
  // Contacts without a login yet: an invite can turn one into a member,
  // keeping their faces, birthday and history.
  const invitable = useMemo(
    () => people.filter((p) => !inHousehold(p) && !p.cognitoUsername),
    [people],
  );

  function openEdit(p: Person) {
    setEditing(p);
    setName(p.name);
    setColor(p.color ?? "#3a5068");
    setEmoji(p.emoji ?? "");
    setPhoneNumber(p.phoneNumber ?? "");
    setBirthday(p.birthday ?? "");
    setTimezone(p.defaultTimezone ?? "America/Chicago");
    setNotifyWhatsApp(p.notifyWhatsApp !== false);
    setNotifyPush(p.notifyPush !== false);
    setActive(p.active !== false);
    setGroups(rowGroups(p));
    editModal.onOpen();
  }

  async function save(onClose: () => void) {
    if (!editing || !name.trim()) return;
    const { data: saved, errors } = await client.models.homePerson.update({
      id: editing.id,
      name: name.trim(),
      color,
      emoji: emoji || null,
      phoneNumber: phoneNumber.trim() || null,
      birthday: birthday || null,
      defaultTimezone: timezone,
      notifyWhatsApp,
      notifyPush,
      active,
    });
    if (errors?.length || !saved) {
      addToast({
        title: "Couldn't save",
        description: errors?.[0]?.message,
        color: "danger",
      });
      return;
    }

    // Group changes route through the admin mutation so Cognito stays in sync.
    if (
      isAdmin &&
      saved.cognitoUsername &&
      !sameSet(rowGroups(saved), groups)
    ) {
      try {
        const res = await client.mutations.setPersonGroups({
          personId: saved.id,
          groups,
        });
        if (res.errors?.length) throw new Error(res.errors[0].message);
        addToast({
          title: "Groups updated",
          description: groups.includes(HOUSEHOLD_GROUP)
            ? "Takes effect on their next sign-in."
            : `${saved.name} is no longer in the household; they're under Contacts now.`,
        });
      } catch (err) {
        addToast({
          title: "Failed to update groups",
          description: err instanceof Error ? err.message : String(err),
          color: "danger",
        });
      }
    }

    onClose();
    await loadPeople();
  }

  function openInvite() {
    setInvite({ personId: NEW_PERSON, name: "", email: "", admin: false });
    inviteModal.onOpen();
  }

  async function sendInvite(onClose: () => void) {
    const existing = invite.personId !== NEW_PERSON ? invite.personId : null;
    if (!invite.email.trim() || (!existing && !invite.name.trim())) return;
    setInviting(true);
    try {
      const res = await client.mutations.invitePerson({
        personId: existing,
        name: existing ? null : invite.name.trim(),
        email: invite.email.trim(),
        groups: invite.admin ? [HOUSEHOLD_GROUP, "admins"] : [HOUSEHOLD_GROUP],
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      addToast({
        title: "Invite sent",
        description: `${invite.email.trim()} will get an email with a temporary password.`,
      });
      onClose();
      await loadPeople();
    } catch (err) {
      addToast({
        title: "Invite failed",
        description: err instanceof Error ? err.message : String(err),
        color: "danger",
      });
    } finally {
      setInviting(false);
    }
  }

  return (
    <DefaultLayout>
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              isIconOnly
              variant="light"
              onPress={() => router.push("/")}
            >
              <FaArrowLeft />
            </Button>
            <h1 className="text-2xl font-bold text-foreground">Household</h1>
          </div>
          {isAdmin && (
            <Button
              color="primary"
              size="sm"
              startContent={<FaEnvelope size={12} />}
              onPress={openInvite}
            >
              Invite
            </Button>
          )}
        </div>
        <p className="text-xs text-default-400 mb-6">
          The people who use the app. Friends, family and anyone tagged in
          photos are in{" "}
          <NextLink href="/contacts" className="text-primary hover:underline">
            Contacts
          </NextLink>
          .{!isAdmin && " Inviting and group changes are admin-only."}
        </p>

        <div className="space-y-2">
          {members.map((p) => (
            <MemberCard
              key={p.id}
              person={p}
              relations={relationsLine(
                p.id,
                rels,
                new Map(people.map((x) => [x.id, x])),
              )}
              isAdmin={isAdmin}
              onEdit={() => openEdit(p)}
              onMerge={() => {
                setMergeSource(p);
                mergeModal.onOpen();
              }}
            />
          ))}
          {members.length === 0 && (
            <p className="text-center text-default-300 py-10">
              No members yet.
            </p>
          )}
        </div>

        {/* Edit */}
        <Modal
          isOpen={editModal.isOpen}
          onOpenChange={editModal.onOpenChange}
          scrollBehavior="inside"
          size="lg"
        >
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>Edit {editing?.name}</ModalHeader>
                <ModalBody>
                  <Input
                    label="Name"
                    value={name}
                    onValueChange={setName}
                    isRequired
                  />
                  <div className="grid grid-cols-2 gap-2">
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
                  </div>
                  <Input
                    label="Phone number"
                    value={phoneNumber}
                    onValueChange={setPhoneNumber}
                    placeholder="+12125551234"
                    description="E.164. Lets them DM Janet on WhatsApp and get personal messages."
                  />
                  <Input
                    label="Birthday (optional)"
                    type="date"
                    placeholder=" "
                    value={birthday}
                    onValueChange={setBirthday}
                    description="Shows in the week planner. Unknown year: use 1900."
                  />
                  <Input
                    label="Default timezone"
                    value={timezone}
                    onValueChange={setTimezone}
                    description={`Common: ${COMMON_TIMEZONES.join(", ")}`}
                  />
                  <p className="text-xs text-default-400">
                    Login: {editing?.email ?? "no email"}
                    {editing?.cognitoUsername ? "" : " · not linked to a login"}
                  </p>

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
                    <Switch
                      size="sm"
                      isSelected={active}
                      onValueChange={setActive}
                    >
                      <span className="text-sm">Active</span>
                    </Switch>
                  </div>

                  {editing?.cognitoUsername && (
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
                                    : [...prev, g],
                                );
                              }}
                            >
                              {g}
                            </Chip>
                          );
                        })}
                      </div>
                      <p className="text-xs text-default-400">
                        Without {HOUSEHOLD_GROUP} they leave the household and
                        can&apos;t see its data. Changes apply on their next
                        sign-in.
                      </p>
                    </div>
                  )}
                  {editing && (
                    <RelationshipsEditor
                      client={client}
                      person={editing}
                      people={people}
                      rels={rels}
                      onChanged={loadPeople}
                    />
                  )}
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>
                    Cancel
                  </Button>
                  <Button color="primary" onPress={() => save(onClose)}>
                    Save
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        {/* Invite */}
        <Modal
          isOpen={inviteModal.isOpen}
          onOpenChange={inviteModal.onOpenChange}
          scrollBehavior="inside"
        >
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>Invite to the household</ModalHeader>
                <ModalBody>
                  <Select
                    label="Who"
                    selectedKeys={new Set([invite.personId])}
                    onSelectionChange={(keys) => {
                      const id = String(
                        Array.from(keys as Set<string>)[0] ?? NEW_PERSON,
                      );
                      const p = people.find((x) => x.id === id);
                      setInvite({
                        ...invite,
                        personId: id,
                        email: p?.email ?? invite.email,
                      });
                    }}
                    description="Picking an existing contact keeps their photos, birthday and history."
                  >
                    {[
                      <SelectItem key={NEW_PERSON}>Someone new</SelectItem>,
                      ...invitable.map((p) => (
                        <SelectItem key={p.id}>{p.name}</SelectItem>
                      )),
                    ]}
                  </Select>
                  {invite.personId === NEW_PERSON && (
                    <Input
                      label="Name"
                      value={invite.name}
                      onValueChange={(v) => setInvite({ ...invite, name: v })}
                      isRequired
                    />
                  )}
                  <Input
                    label="Email"
                    type="email"
                    value={invite.email}
                    onValueChange={(v) => setInvite({ ...invite, email: v })}
                    description="They sign in with this. Cognito emails them a temporary password."
                    isRequired
                  />
                  <Switch
                    size="sm"
                    isSelected={invite.admin}
                    onValueChange={(v) => setInvite({ ...invite, admin: v })}
                  >
                    <span className="text-sm">
                      Admin (can invite and change groups)
                    </span>
                  </Switch>
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>
                    Cancel
                  </Button>
                  <Button
                    color="primary"
                    isLoading={inviting}
                    onPress={() => sendInvite(onClose)}
                  >
                    Send invite
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        <MergeModal
          client={client}
          source={mergeSource}
          people={people}
          isOpen={mergeModal.isOpen}
          onOpenChange={mergeModal.onOpenChange}
          onMerged={() => {
            setMergeSource(null);
            loadPeople();
          }}
        />
      </div>
    </DefaultLayout>
  );
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}
