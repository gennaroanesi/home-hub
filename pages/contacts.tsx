"use client";

// Contacts, two tabs:
//   - People: everyone the app knows who isn't in the household (friends,
//     family, people tagged in photos). Same homePerson table as the
//     household (see lib/people.ts), so inviting a contact later keeps
//     their faces, birthday and history. Members are on /admin/people.
//   - Businesses: service people and businesses (homeBusiness) plus
//     health providers; components/businesses-tab.tsx.

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { fetchAuthSession, getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Select, SelectItem } from "@heroui/select";
import { Tabs, Tab } from "@heroui/tabs";
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
  FaImages,
  FaBirthdayCake,
  FaSearch,
} from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { listAllPages } from "@/lib/list-all";
import { todayIso } from "@/lib/finance/dates";
import {
  MAX_WEB_IMAGE_BYTES,
  WEB_IMAGE_TYPES,
  uploadImages,
} from "@/lib/upload-images";
import {
  CIRCLES,
  CIRCLE_LABELS,
  birthdayLabel,
  daysToBirthday,
  inHousehold,
  circleLabel,
} from "@/lib/people";
import {
  MergeModal,
  PersonAvatar,
  RelationshipsEditor,
  relationsLine,
  type Person,
} from "@/components/people";
import type { RelationshipRow } from "@/lib/relationships";
import { BusinessesTab } from "@/components/businesses-tab";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Sort = "name" | "birthday";

const EMPTY_FORM = {
  name: "",
  circle: "",
  birthday: "",
  phoneNumber: "",
  email: "",
  notes: "",
  color: "#3a5068",
  emoji: "",
  photoKey: "",
};

export default function ContactsPage() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [faceCounts, setFaceCounts] = useState<Map<string, number>>(new Map());
  const [rels, setRels] = useState<RelationshipRow[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [query, setQuery] = useState("");
  const [relFilter, setRelFilter] = useState<string>("ALL");
  const [sort, setSort] = useState<Sort>("name");
  const [editing, setEditing] = useState<Person | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [uploading, setUploading] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const editModal = useDisclosure();
  const mergeModal = useDisclosure();
  const [mergeSource, setMergeSource] = useState<Person | null>(null);
  const today = todayIso();
  const tab = router.query.tab === "businesses" ? "businesses" : "people";

  const load = useCallback(async () => {
    const [rows, faces, relRows] = await Promise.all([
      listAllPages<Person>(client.models.homePerson),
      listAllPages<{ personId: string }>(client.models.homePersonFace).catch(
        () => [],
      ),
      listAllPages<RelationshipRow>(client.models.homePersonRelationship),
    ]);
    setPeople(rows.sort((a, b) => a.name.localeCompare(b.name)));
    setRels(relRows);
    const counts = new Map<string, number>();
    for (const f of faces)
      counts.set(f.personId, (counts.get(f.personId) ?? 0) + 1);
    setFaceCounts(counts);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
        const session = await fetchAuthSession();
        const groups =
          (session.tokens?.idToken?.payload?.["cognito:groups"] as string[]) ??
          [];
        setIsAdmin(groups.includes("admins"));
        await load();
      } catch {
        router.push("/login");
      }
    })();
  }, [load, router]);

  const contacts = useMemo(
    () => people.filter((p) => !inHousehold(p)),
    [people],
  );
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = contacts.filter((p) => {
      if (
        relFilter === "NONE"
          ? !!circleLabel(p.circle)
          : relFilter !== "ALL" && p.circle !== relFilter
      )
        return false;
      if (!q) return true;
      return [p.name, p.email, p.phoneNumber, p.notes].some((v) =>
        v?.toLowerCase().includes(q),
      );
    });
    if (sort === "birthday") {
      rows.sort(
        (a, b) =>
          (daysToBirthday(a.birthday, today) ?? 9999) -
            (daysToBirthday(b.birthday, today) ?? 9999) ||
          a.name.localeCompare(b.name),
      );
    }
    return rows;
  }, [contacts, query, relFilter, sort, today]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    editModal.onOpen();
  }

  function openEdit(p: Person) {
    setEditing(p);
    setForm({
      name: p.name,
      circle: p.circle ?? "",
      birthday: p.birthday ?? "",
      phoneNumber: p.phoneNumber ?? "",
      email: p.email ?? "",
      notes: p.notes ?? "",
      color: p.color ?? "#3a5068",
      emoji: p.emoji ?? "",
      photoKey: p.photoKey ?? "",
    });
    editModal.onOpen();
  }

  async function save(onClose: () => void) {
    if (!form.name.trim()) return;
    const payload = {
      name: form.name.trim(),
      circle: form.circle || null,
      birthday: form.birthday || null,
      phoneNumber: form.phoneNumber.trim() || null,
      email: form.email.trim() || null,
      notes: form.notes.trim() || null,
      color: form.color,
      emoji: form.emoji || null,
      photoKey: form.photoKey || null,
    };
    const res = editing
      ? await client.models.homePerson.update({ id: editing.id, ...payload })
      : await client.models.homePerson.create({
          ...payload,
          active: true,
          groups: [],
        });
    if (res.errors?.length) {
      addToast({
        title: "Couldn't save",
        description: res.errors[0].message,
        color: "danger",
      });
      return;
    }
    onClose();
    await load();
  }

  async function remove(p: Person) {
    if (
      !confirm(
        `Delete ${p.name}? Photo tags and anything assigned to them will be unlinked.`,
      )
    )
      return;
    // Their relationship rows go too, so no link points at nobody.
    await Promise.all(
      rels
        .filter((r) => r.personId === p.id || r.relatedPersonId === p.id)
        .map((r) => client.models.homePersonRelationship.delete({ id: r.id })),
    );
    await client.models.homePerson.delete({ id: p.id });
    await load();
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
            <h1 className="text-2xl font-bold text-foreground">Contacts</h1>
          </div>
          {tab === "people" && (
            <Button
              color="primary"
              size="sm"
              startContent={<FaPlus size={12} />}
              onPress={openCreate}
            >
              New contact
            </Button>
          )}
        </div>
        <p className="text-xs text-default-400 mb-4">
          People and businesses outside the household. App users are in{" "}
          <NextLink
            href="/admin/people"
            className="text-primary hover:underline"
          >
            Household
          </NextLink>
          .
        </p>

        <Tabs
          aria-label="Contacts"
          selectedKey={tab}
          onSelectionChange={(k) =>
            router.replace(
              {
                pathname: "/contacts",
                query: k === "businesses" ? { tab: "businesses" } : {},
              },
              undefined,
              { shallow: true },
            )
          }
          className="mb-4"
        >
          <Tab
            key="people"
            title={`People${contacts.length ? ` (${contacts.length})` : ""}`}
          />
          <Tab key="businesses" title="Businesses" />
        </Tabs>

        {tab === "businesses" ? (
          <BusinessesTab client={client} />
        ) : (
          <>
            <div className="flex flex-col gap-2 mb-4">
              <Input
                size="sm"
                placeholder="Search name, email, phone, notes"
                startContent={
                  <FaSearch className="text-default-400" size={12} />
                }
                value={query}
                onValueChange={setQuery}
                isClearable
                onClear={() => setQuery("")}
              />
              <div className="flex items-center gap-1 flex-wrap">
                {["ALL", ...CIRCLES, "NONE"].map((r) => (
                  <Chip
                    key={r}
                    size="sm"
                    className="cursor-pointer"
                    variant={relFilter === r ? "solid" : "flat"}
                    color={relFilter === r ? "primary" : "default"}
                    onClick={() => setRelFilter(r)}
                  >
                    {r === "ALL"
                      ? "All"
                      : r === "NONE"
                        ? "Unsorted"
                        : CIRCLE_LABELS[r as keyof typeof CIRCLE_LABELS]}
                  </Chip>
                ))}
                <span className="flex-1" />
                <Chip
                  size="sm"
                  className="cursor-pointer"
                  variant="flat"
                  startContent={
                    sort === "birthday" ? (
                      <FaBirthdayCake size={10} className="ml-1" />
                    ) : undefined
                  }
                  onClick={() => setSort(sort === "name" ? "birthday" : "name")}
                >
                  {sort === "name" ? "A–Z" : "Next birthday"}
                </Chip>
              </div>
            </div>

            <div className="space-y-2">
              {shown.map((p) => {
                const rel = circleLabel(p.circle);
                const bday = birthdayLabel(p.birthday, today);
                const faces = faceCounts.get(p.id) ?? 0;
                return (
                  <Card key={p.id}>
                    <CardBody className="flex flex-row items-center gap-3 px-4 py-3">
                      <PersonAvatar person={p} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1 flex-wrap">
                          <p className="text-sm font-medium">{p.name}</p>
                          {rel && (
                            <Chip size="sm" variant="flat">
                              {rel}
                            </Chip>
                          )}
                          {p.cognitoUsername && (
                            <Chip
                              size="sm"
                              variant="flat"
                              color="warning"
                              title="Has a login but isn't in the household"
                            >
                              login
                            </Chip>
                          )}
                        </div>
                        <p className="text-xs text-default-400 truncate">
                          {[
                            bday && `🎂 ${bday}`,
                            p.phoneNumber,
                            p.email,
                            faces
                              ? `${faces} face sample${faces === 1 ? "" : "s"}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        {relationsLine(p.id, rels, byId) && (
                          <p className="text-xs text-default-500 truncate">
                            {relationsLine(p.id, rels, byId)}
                          </p>
                        )}
                        {p.notes && (
                          <p className="text-xs text-default-500 truncate">
                            {p.notes}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          as={NextLink}
                          href={`/photos?person=${p.id}`}
                          size="sm"
                          isIconOnly
                          variant="light"
                          title="Photos"
                        >
                          <FaImages size={12} />
                        </Button>
                        {isAdmin && (
                          <Button
                            size="sm"
                            isIconOnly
                            variant="light"
                            title="Merge into…"
                            onPress={() => {
                              setMergeSource(p);
                              mergeModal.onOpen();
                            }}
                          >
                            <FaCodeBranch size={12} />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          isIconOnly
                          variant="light"
                          title="Edit"
                          onPress={() => openEdit(p)}
                        >
                          <FaPen size={12} />
                        </Button>
                        <Button
                          size="sm"
                          isIconOnly
                          variant="light"
                          color="danger"
                          title="Delete"
                          onPress={() => remove(p)}
                        >
                          <FaTrash size={12} />
                        </Button>
                      </div>
                    </CardBody>
                  </Card>
                );
              })}
              {shown.length === 0 && (
                <p className="text-center text-default-300 py-10">
                  {contacts.length ? "No contacts match." : "No contacts yet."}
                </p>
              )}
            </div>
          </>
        )}

        <Modal
          isOpen={editModal.isOpen}
          onOpenChange={editModal.onOpenChange}
          scrollBehavior="inside"
          size="lg"
        >
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader>
                  {editing ? `Edit ${editing.name}` : "New contact"}
                </ModalHeader>
                <ModalBody>
                  <div className="flex items-center gap-3">
                    <PersonAvatar
                      person={{
                        name: form.name || "?",
                        color: form.color,
                        emoji: form.emoji,
                        photoKey: form.photoKey,
                      }}
                      size={64}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="flat"
                        isLoading={uploading}
                        onPress={() => photoInput.current?.click()}
                      >
                        {form.photoKey ? "Change photo" : "Add photo"}
                      </Button>
                      <input
                        ref={photoInput}
                        type="file"
                        accept={WEB_IMAGE_TYPES.join(",")}
                        className="hidden"
                        disabled={uploading}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (!file) return;
                          if (
                            !WEB_IMAGE_TYPES.includes(file.type) ||
                            file.size > MAX_WEB_IMAGE_BYTES
                          ) {
                            addToast({
                              title:
                                "Use a JPEG, PNG or WebP photo under 10 MB",
                              color: "warning",
                            });
                            return;
                          }
                          setUploading(true);
                          try {
                            const [key] = await uploadImages([file], "people");
                            if (key) setForm((f) => ({ ...f, photoKey: key }));
                          } finally {
                            setUploading(false);
                          }
                        }}
                      />
                      {form.photoKey && (
                        <Button
                          size="sm"
                          variant="light"
                          color="danger"
                          onPress={() => setForm({ ...form, photoKey: "" })}
                        >
                          Remove photo
                        </Button>
                      )}
                    </div>
                  </div>
                  <Input
                    label="Name"
                    value={form.name}
                    onValueChange={(v) => setForm({ ...form, name: v })}
                    isRequired
                  />
                  <Select
                    label="Circle"
                    placeholder="None"
                    selectedKeys={
                      form.circle ? new Set([form.circle]) : new Set<string>()
                    }
                    onSelectionChange={(keys) =>
                      setForm({
                        ...form,
                        circle: String(
                          Array.from(keys as Set<string>)[0] ?? "",
                        ),
                      })
                    }
                  >
                    {CIRCLES.map((r) => (
                      <SelectItem key={r}>{CIRCLE_LABELS[r]}</SelectItem>
                    ))}
                  </Select>
                  <Input
                    label="Birthday (optional)"
                    type="date"
                    placeholder=" "
                    value={form.birthday}
                    onValueChange={(v) => setForm({ ...form, birthday: v })}
                    description="Shows in the week planner. Unknown year: use 1900."
                  />
                  <Input
                    label="Phone (optional)"
                    value={form.phoneNumber}
                    onValueChange={(v) => setForm({ ...form, phoneNumber: v })}
                    placeholder="+12125551234"
                  />
                  <Input
                    label="Email (optional)"
                    type="email"
                    value={form.email}
                    onValueChange={(v) => setForm({ ...form, email: v })}
                  />
                  <Textarea
                    label="Notes (optional)"
                    value={form.notes}
                    onValueChange={(v) => setForm({ ...form, notes: v })}
                    minRows={2}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      label="Color"
                      type="color"
                      value={form.color}
                      onValueChange={(v) => setForm({ ...form, color: v })}
                    />
                    <Input
                      label="Emoji (optional)"
                      value={form.emoji}
                      onValueChange={(v) => setForm({ ...form, emoji: v })}
                    />
                  </div>
                  {editing && (
                    <RelationshipsEditor
                      client={client}
                      person={editing}
                      people={people}
                      rels={rels}
                      onChanged={load}
                    />
                  )}
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>
                    Cancel
                  </Button>
                  <Button
                    color="primary"
                    onPress={() => save(onClose)}
                    isDisabled={uploading}
                  >
                    {editing ? "Save" : "Create"}
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
            load();
          }}
        />
      </div>
    </DefaultLayout>
  );
}
