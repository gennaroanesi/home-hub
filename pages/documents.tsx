"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { DateInput } from "../components/date-input";
import { Select, SelectItem } from "@heroui/select";
import { Card, CardBody } from "@heroui/card";
import { Tooltip } from "@heroui/tooltip";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/modal";
import { addToast, Spinner } from "@heroui/react";
import {
  FaArrowLeft,
  FaPlus,
  FaDownload,
  FaPen,
  FaTrash,
  FaLock,
} from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { Markdown } from "@/components/markdown";
import { listAllPages } from "@/lib/list-all";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type HomeDocument = Schema["homeDocument"]["type"];
type Person = Schema["homePerson"]["type"];
type DocType = NonNullable<HomeDocument["type"]>;
type DocScope = NonNullable<HomeDocument["scope"]>;

const ALL = "all";
const HOUSEHOLD = "household";

const DOC_TYPE_LABEL: Record<DocType, string> = {
  DRIVERS_LICENSE: "Driver's License",
  PASSPORT: "Passport",
  GREEN_CARD: "Green Card",
  TSA_PRECHECK: "TSA PreCheck",
  GLOBAL_ENTRY: "Global Entry",
  INSURANCE: "Insurance",
  OTHER: "Other",
};

const DOC_TYPE_EMOJI: Record<DocType, string> = {
  DRIVERS_LICENSE: "🪪",
  PASSPORT: "🛂",
  GREEN_CARD: "🟩",
  TSA_PRECHECK: "✈️",
  GLOBAL_ENTRY: "✈️",
  INSURANCE: "🛡️",
  OTHER: "📄",
};

const DOC_TYPES: DocType[] = [
  "DRIVERS_LICENSE",
  "PASSPORT",
  "GREEN_CARD",
  "TSA_PRECHECK",
  "GLOBAL_ENTRY",
  "INSURANCE",
  "OTHER",
];

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

interface ExpirationBadge {
  label: string;
  color: "success" | "warning" | "danger" | "default";
}

function computeExpirationBadge(expiresDate: string | null | undefined): ExpirationBadge | null {
  if (!expiresDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(`${expiresDate}T00:00:00`);
  if (Number.isNaN(exp.getTime())) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.round((exp.getTime() - today.getTime()) / msPerDay);
  if (days < 0) {
    const overdueDays = Math.abs(days);
    return { label: `expired ${overdueDays}d ago`, color: "danger" };
  }
  if (days === 0) return { label: "expires today", color: "danger" };
  if (days < 30) return { label: `expires in ${days}d`, color: "danger" };
  if (days < 90) {
    const months = Math.round(days / 30);
    return { label: `expires in ${months}mo`, color: "warning" };
  }
  const months = Math.round(days / 30);
  if (months < 24) return { label: `expires in ${months}mo`, color: "success" };
  const years = Math.round(months / 12);
  return { label: `expires in ${years}y`, color: "success" };
}

interface FormState {
  title: string;
  type: DocType;
  scope: DocScope;
  ownerPersonId: string;
  issuer: string;
  documentNumber: string;
  issuedDate: string;
  expiresDate: string;
  notes: string;
}

function emptyForm(): FormState {
  return {
    title: "",
    type: "PASSPORT",
    scope: "PERSONAL",
    ownerPersonId: "",
    issuer: "",
    documentNumber: "",
    issuedDate: "",
    expiresDate: "",
    notes: "",
  };
}

function docToForm(doc: HomeDocument): FormState {
  return {
    title: doc.title ?? "",
    type: (doc.type ?? "OTHER") as DocType,
    scope: (doc.scope ?? "PERSONAL") as DocScope,
    ownerPersonId: doc.ownerPersonId ?? "",
    issuer: doc.issuer ?? "",
    documentNumber: doc.documentNumber ?? "",
    issuedDate: doc.issuedDate ?? "",
    expiresDate: doc.expiresDate ?? "",
    notes: doc.notes ?? "",
  };
}

export default function DocumentsPage() {
  const router = useRouter();
  const [documents, setDocuments] = useState<HomeDocument[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);

  const [filterOwner, setFilterOwner] = useState<string>(ALL);
  const [filterType, setFilterType] = useState<string>(ALL);

  // Upload/edit modal
  const uploadDisclosure = useDisclosure();
  const [editingDoc, setEditingDoc] = useState<HomeDocument | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadedBy, setUploadedBy] = useState<string>("");

  // Detail modal
  const detailDisclosure = useDisclosure();
  const [detailDoc, setDetailDoc] = useState<HomeDocument | null>(null);

  // Delete confirm modal
  const deleteDisclosure = useDisclosure();
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Duo auth state
  const [myDuoUsername, setMyDuoUsername] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { username, signInDetails } = await getCurrentUser();
        setUploadedBy(signInDetails?.loginId ?? username ?? "");
        await loadAll();
      } catch {
        router.push("/login");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [allDocs, allPeople, allAuths] = await Promise.all([
        listAllPages<HomeDocument>(client.models.homeDocument, { limit: 500 }),
        listAllPages<Person>(client.models.homePerson, { limit: 100 }),
        listAllPages<any>(client.models.homePersonAuth, { limit: 100 }),
      ]);
      setDocuments(allDocs);
      const activePeople = allPeople.filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name));
      setPeople(activePeople);

      // Any household member with a linked Duo account can download any
      // document — the Duo push is the real auth gate, not person matching.
      // Find the first auth row that belongs to a person whose name matches
      // the Cognito login, falling back to the first auth row if the match
      // fails (household trust boundary — both members are admins).
      const loginLower = uploadedBy?.toLowerCase() ?? "";
      const myPerson = activePeople.find(
        (p) => loginLower && (
          loginLower === p.name.toLowerCase() ||
          loginLower.includes(p.name.toLowerCase()) ||
          p.name.toLowerCase().includes(loginLower.split("@")[0])
        )
      );
      const myAuth = myPerson
        ? allAuths.find((a: any) => a.personId === myPerson.id)
        : allAuths[0]; // fallback: any enrolled person
      setMyDuoUsername(myAuth?.duoUsername ?? null);
    } catch (err) {
      console.error("loadAll failed", err);
      addToast({ title: "Could not load documents", color: "danger" });
    } finally {
      setLoading(false);
    }
  }, [uploadedBy]);

  const handleDownload = useCallback(async (doc: HomeDocument) => {
    if (!myDuoUsername) {
      addToast({ title: "Duo not linked", description: "Go to /security to link your Duo username first.", color: "warning" });
      return;
    }
    if (!doc.s3Key && !doc.documentNumber) {
      addToast({ title: "Nothing to download", description: "This document has no file or number.", color: "warning" });
      return;
    }
    setDownloading(true);
    addToast({ title: "Duo push sent", description: "Approve on your phone…", color: "primary" });
    try {
      const res = await fetch("/api/documents/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: doc.id,
          duoUsername: myDuoUsername,
          s3Key: doc.s3Key ?? undefined,
          originalFilename: doc.originalFilename ?? undefined,
          documentNumber: doc.s3Key ? undefined : (doc.documentNumber ?? undefined),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        addToast({ title: "Download denied", description: data.error ?? "Unknown error", color: "danger" });
        return;
      }
      if (data.url) {
        window.open(data.url, "_blank");
        addToast({ title: "Download started", description: `Link expires at ${new Date(data.expiresAt).toLocaleTimeString()}` });
      } else if (data.documentNumber) {
        addToast({ title: doc.title, description: `Number: ${data.documentNumber}`, color: "primary" });
      }
    } catch (err) {
      addToast({ title: "Download failed", description: err instanceof Error ? err.message : String(err), color: "danger" });
    } finally {
      setDownloading(false);
    }
  }, [myDuoUsername]);

  const personById = useMemo(() => {
    const map = new Map<string, Person>();
    for (const p of people) map.set(p.id, p);
    return map;
  }, [people]);

  const filtered = useMemo(() => {
    let list = [...documents];
    if (filterOwner !== ALL) {
      if (filterOwner === HOUSEHOLD) {
        list = list.filter((d) => d.scope === "HOUSEHOLD");
      } else {
        list = list.filter((d) => d.scope === "PERSONAL" && d.ownerPersonId === filterOwner);
      }
    }
    if (filterType !== ALL) {
      list = list.filter((d) => d.type === filterType);
    }
    return list;
  }, [documents, filterOwner, filterType]);

  // Group filtered docs by owner: each person, then household.
  const grouped = useMemo(() => {
    const groups: { key: string; label: string; emoji: string; docs: HomeDocument[] }[] = [];
    for (const person of people) {
      const personDocs = filtered
        .filter((d) => d.scope === "PERSONAL" && d.ownerPersonId === person.id)
        .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
      if (personDocs.length > 0) {
        groups.push({
          key: `person:${person.id}`,
          label: person.name,
          emoji: person.emoji ?? "👤",
          docs: personDocs,
        });
      }
    }
    const householdDocs = filtered
      .filter((d) => d.scope === "HOUSEHOLD")
      .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
    if (householdDocs.length > 0) {
      groups.push({
        key: "household",
        label: "Household",
        emoji: "🏠",
        docs: householdDocs,
      });
    }
    // Orphaned personal docs whose owner no longer exists
    const orphans = filtered.filter(
      (d) => d.scope === "PERSONAL" && (!d.ownerPersonId || !personById.has(d.ownerPersonId))
    );
    if (orphans.length > 0) {
      groups.push({
        key: "unassigned",
        label: "Unassigned",
        emoji: "❓",
        docs: orphans.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "")),
      });
    }
    return groups;
  }, [filtered, people, personById]);

  function openNewUpload() {
    setEditingDoc(null);
    setForm(emptyForm());
    setFile(null);
    uploadDisclosure.onOpen();
  }

  function openEdit(doc: HomeDocument) {
    setEditingDoc(doc);
    setForm(docToForm(doc));
    setFile(null);
    detailDisclosure.onClose();
    uploadDisclosure.onOpen();
  }

  function openDetail(doc: HomeDocument) {
    setDetailDoc(doc);
    detailDisclosure.onOpen();
  }

  async function submitForm(onClose: () => void) {
    // Validate
    if (!form.title.trim()) {
      addToast({ title: "Title is required", color: "warning" });
      return;
    }
    if (form.scope === "PERSONAL" && !form.ownerPersonId) {
      addToast({ title: "Personal documents need an owner", color: "warning" });
      return;
    }

    setSubmitting(true);
    try {
      let s3key: string | null = editingDoc?.s3Key ?? null;
      let contentType: string | null = editingDoc?.contentType ?? null;
      let sizeBytes: number | null = editingDoc?.sizeBytes ?? null;
      let originalFilename: string | null = editingDoc?.originalFilename ?? null;

      if (file) {
        if (!ALLOWED_CONTENT_TYPES.includes(file.type)) {
          addToast({
            title: "Unsupported file type",
            description: "Allowed: PDF, JPEG, PNG, WebP, HEIC",
            color: "warning",
          });
          setSubmitting(false);
          return;
        }

        // Clean up any previous file before replacing it during an edit.
        if (editingDoc?.s3Key) {
          try {
            await fetch("/api/documents/upload-url", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ s3key: editingDoc.s3Key }),
            });
          } catch (err) {
            console.warn("Failed to delete previous document file", err);
          }
        }

        const urlRes = await fetch("/api/documents/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: file.type }),
        });
        if (!urlRes.ok) {
          const err = await urlRes.json().catch(() => ({}));
          throw new Error(err.error ?? `Upload URL failed: ${urlRes.status}`);
        }
        const { uploadUrl, s3key: newKey } = await urlRes.json();
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!putRes.ok) throw new Error(`S3 upload failed: ${putRes.status}`);

        s3key = newKey;
        contentType = file.type;
        sizeBytes = file.size;
        originalFilename = file.name;
      }

      const payload = {
        title: form.title.trim(),
        type: form.type,
        scope: form.scope,
        ownerPersonId: form.scope === "PERSONAL" ? form.ownerPersonId : null,
        issuer: form.issuer.trim() || null,
        documentNumber: form.documentNumber.trim() || null,
        issuedDate: form.issuedDate || null,
        expiresDate: form.expiresDate || null,
        notes: form.notes.trim() || null,
        s3Key: s3key,
        contentType,
        sizeBytes,
        originalFilename,
      };

      if (editingDoc) {
        const { errors } = await client.models.homeDocument.update({
          id: editingDoc.id,
          ...payload,
        });
        if (errors?.length) throw new Error(errors[0].message);
        addToast({ title: "Document updated", color: "success" });
      } else {
        const { errors } = await client.models.homeDocument.create({
          ...payload,
          uploadedBy: uploadedBy || null,
        });
        if (errors?.length) throw new Error(errors[0].message);
        addToast({ title: "Document added", color: "success" });
      }

      onClose();
      setFile(null);
      setEditingDoc(null);
      await loadAll();
    } catch (err: any) {
      console.error(err);
      addToast({
        title: "Save failed",
        description: err?.message ?? "Unknown error",
        color: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function doDelete(onClose: () => void) {
    if (!detailDoc) return;
    if (deleteConfirm !== "DELETE") {
      addToast({ title: "Type DELETE to confirm", color: "warning" });
      return;
    }
    setDeleting(true);
    try {
      // Hard-delete S3 file first (if any), then the row. If the S3
      // delete fails we still try the row delete — a stranded row is
      // worse than a stranded file because the user sees it.
      if (detailDoc.s3Key) {
        try {
          await fetch("/api/documents/upload-url", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ s3key: detailDoc.s3Key }),
          });
        } catch (err) {
          console.warn("S3 delete failed", err);
        }
      }
      const { errors } = await client.models.homeDocument.delete({ id: detailDoc.id });
      if (errors?.length) throw new Error(errors[0].message);
      addToast({ title: "Document deleted", color: "success" });
      setDeleteConfirm("");
      onClose();
      detailDisclosure.onClose();
      setDetailDoc(null);
      await loadAll();
    } catch (err: any) {
      console.error(err);
      addToast({
        title: "Delete failed",
        description: err?.message ?? "Unknown error",
        color: "danger",
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <DefaultLayout>
      <div className="max-w-5xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">Documents</h1>
            {loading && (
              <span className="hidden sm:inline-flex items-center gap-2 text-xs text-default-400">
                <Spinner size="sm" />
                <span>Loading documents…</span>
              </span>
            )}
          </div>
          <Button color="primary" size="sm" startContent={<FaPlus />} onPress={openNewUpload}>
            Upload
          </Button>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-2 mb-4">
          <Select
            size="sm"
            label="Owner"
            selectedKeys={[filterOwner]}
            onSelectionChange={(keys) => {
              const key = Array.from(keys as Set<string>)[0] ?? ALL;
              setFilterOwner(key);
            }}
            className="max-w-[200px]"
          >
            <SelectItem key={ALL} textValue="Everyone">
              Everyone
            </SelectItem>
            <SelectItem key={HOUSEHOLD} textValue="Household">
              🏠 Household
            </SelectItem>
            <>
              {people.map((p) => (
                <SelectItem key={p.id} textValue={p.name}>
                  {p.emoji ?? "👤"} {p.name}
                </SelectItem>
              ))}
            </>
          </Select>
          <Select
            size="sm"
            label="Type"
            selectedKeys={[filterType]}
            onSelectionChange={(keys) => {
              const key = Array.from(keys as Set<string>)[0] ?? ALL;
              setFilterType(key);
            }}
            className="max-w-[220px]"
          >
            <SelectItem key={ALL} textValue="All types">
              All types
            </SelectItem>
            <>
              {DOC_TYPES.map((t) => (
                <SelectItem key={t} textValue={DOC_TYPE_LABEL[t]}>
                  {DOC_TYPE_EMOJI[t]} {DOC_TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </>
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner label="Loading documents…" />
          </div>
        ) : grouped.length === 0 ? (
          <Card>
            <CardBody className="text-center py-10 text-default-500">
              No documents yet. Click + Upload to add your first one.
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-6">
            {grouped.map((group) => (
              <div key={group.key}>
                <h2 className="text-sm font-semibold text-default-700 mb-2">
                  {group.emoji} {group.label}
                </h2>
                <div className="space-y-2">
                  {group.docs.map((doc) => {
                    const badge = computeExpirationBadge(doc.expiresDate);
                    const type = (doc.type ?? "OTHER") as DocType;
                    return (
                      <Card
                        key={doc.id}
                        isPressable
                        onPress={() => openDetail(doc)}
                        className="w-full"
                      >
                        <CardBody className="flex flex-row items-center gap-3 py-3">
                          <div className="text-2xl shrink-0">{DOC_TYPE_EMOJI[type]}</div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{doc.title}</div>
                            <div className="text-xs text-default-500 flex items-center gap-2 flex-wrap">
                              <span>{DOC_TYPE_LABEL[type]}</span>
                              {doc.expiresDate && (
                                <>
                                  <span>·</span>
                                  <span>exp {doc.expiresDate}</span>
                                </>
                              )}
                              {badge && (
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                    badge.color === "danger"
                                      ? "bg-danger-100 text-danger-700"
                                      : badge.color === "warning"
                                      ? "bg-warning-100 text-warning-700"
                                      : "bg-success-100 text-success-700"
                                  }`}
                                >
                                  {badge.label}
                                </span>
                              )}
                              {!doc.s3Key && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-default-100 text-default-600">
                                  metadata only
                                </span>
                              )}
                            </div>
                          </div>
                          {(doc.s3Key || doc.documentNumber) && (
                            <Tooltip content={myDuoUsername ? "Requires Duo push approval" : "Link your Duo account in /security first"}>
                              <div>
                                <Button
                                  size="sm"
                                  variant="flat"
                                  isDisabled={!myDuoUsername || downloading}
                                  isLoading={downloading}
                                  startContent={!downloading ? <FaDownload size={10} /> : undefined}
                                  onPress={() => handleDownload(doc)}
                                >
                                  Download
                                </Button>
                              </div>
                            </Tooltip>
                          )}
                        </CardBody>
                      </Card>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload / Edit modal */}
      <Modal
        isOpen={uploadDisclosure.isOpen}
        onOpenChange={uploadDisclosure.onOpenChange}
        size="2xl"
        scrollBehavior="inside"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>
                {editingDoc ? "Edit document" : "Upload document"}
              </ModalHeader>
              <ModalBody className="space-y-3">
                <Input
                  label="Title"
                  isRequired
                  value={form.title}
                  onValueChange={(v) => setForm((f) => ({ ...f, title: v }))}
                  placeholder="e.g. Gennaro's Passport"
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select
                    label="Type"
                    isRequired
                    selectedKeys={[form.type]}
                    onSelectionChange={(keys) => {
                      const k = Array.from(keys as Set<string>)[0] as DocType;
                      if (k) setForm((f) => ({ ...f, type: k }));
                    }}
                  >
                    {DOC_TYPES.map((t) => (
                      <SelectItem key={t} textValue={DOC_TYPE_LABEL[t]}>
                        {DOC_TYPE_EMOJI[t]} {DOC_TYPE_LABEL[t]}
                      </SelectItem>
                    ))}
                  </Select>
                  <Select
                    label="Scope"
                    isRequired
                    selectedKeys={[form.scope]}
                    onSelectionChange={(keys) => {
                      const k = Array.from(keys as Set<string>)[0] as DocScope;
                      if (k) setForm((f) => ({ ...f, scope: k }));
                    }}
                  >
                    <SelectItem key="PERSONAL" textValue="Personal">
                      Personal
                    </SelectItem>
                    <SelectItem key="HOUSEHOLD" textValue="Household">
                      Household
                    </SelectItem>
                  </Select>
                </div>
                {form.scope === "PERSONAL" && (
                  <Select
                    label="Owner"
                    isRequired
                    selectedKeys={form.ownerPersonId ? [form.ownerPersonId] : []}
                    onSelectionChange={(keys) => {
                      const k = Array.from(keys as Set<string>)[0] ?? "";
                      setForm((f) => ({ ...f, ownerPersonId: k }));
                    }}
                  >
                    {people.map((p) => (
                      <SelectItem key={p.id} textValue={p.name}>
                        {p.emoji ?? "👤"} {p.name}
                      </SelectItem>
                    ))}
                  </Select>
                )}
                <Input
                  label="Issuer"
                  value={form.issuer}
                  onValueChange={(v) => setForm((f) => ({ ...f, issuer: v }))}
                  placeholder="e.g. US Department of State"
                />
                <Input
                  label="Document number"
                  description="Sensitive — stored encrypted at rest"
                  value={form.documentNumber}
                  onValueChange={(v) => setForm((f) => ({ ...f, documentNumber: v }))}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <DateInput
                    label="Issued date"
                    value={form.issuedDate}
                    onChange={(v) => setForm((f) => ({ ...f, issuedDate: v }))}
                  />
                  <DateInput
                    label="Expires date"
                    value={form.expiresDate}
                    onChange={(v) => setForm((f) => ({ ...f, expiresDate: v }))}
                  />
                </div>
                <Textarea
                  label="Notes"
                  value={form.notes}
                  onValueChange={(v) => setForm((f) => ({ ...f, notes: v }))}
                />
                <div>
                  <label className="text-xs text-default-600 block mb-1">
                    File {editingDoc?.s3Key ? "(leave empty to keep existing)" : "(optional)"}
                  </label>
                  <input
                    type="file"
                    accept=".pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="text-sm"
                  />
                  <p className="text-xs text-default-400 mt-1">
                    File is optional — metadata-only entries (e.g. TSA PreCheck, Global
                    Entry numbers) don&apos;t need an uploaded file.
                  </p>
                  {file && (
                    <p className="text-xs text-default-600 mt-1">
                      Selected: {file.name} ({Math.round(file.size / 1024)} KB)
                    </p>
                  )}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose} isDisabled={submitting}>
                  Cancel
                </Button>
                <Button
                  color="primary"
                  onPress={() => submitForm(onClose)}
                  isLoading={submitting}
                >
                  {editingDoc ? "Save" : "Upload"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Detail modal */}
      <Modal
        isOpen={detailDisclosure.isOpen}
        onOpenChange={detailDisclosure.onOpenChange}
        size="xl"
      >
        <ModalContent>
          {(onClose) => {
            if (!detailDoc) return null;
            const type = (detailDoc.type ?? "OTHER") as DocType;
            const owner = detailDoc.ownerPersonId
              ? personById.get(detailDoc.ownerPersonId)
              : null;
            const badge = computeExpirationBadge(detailDoc.expiresDate);
            return (
              <>
                <ModalHeader className="flex items-center gap-2">
                  <span className="text-2xl">{DOC_TYPE_EMOJI[type]}</span>
                  <span>{detailDoc.title}</span>
                </ModalHeader>
                <ModalBody className="space-y-2 text-sm">
                  <div>
                    <span className="text-default-500">Type: </span>
                    {DOC_TYPE_LABEL[type]}
                  </div>
                  <div>
                    <span className="text-default-500">Scope: </span>
                    {detailDoc.scope === "HOUSEHOLD"
                      ? "🏠 Household"
                      : owner
                      ? `${owner.emoji ?? "👤"} ${owner.name}`
                      : "Personal (unassigned)"}
                  </div>
                  {detailDoc.issuer && (
                    <div>
                      <span className="text-default-500">Issuer: </span>
                      {detailDoc.issuer}
                    </div>
                  )}
                  {detailDoc.documentNumber && (
                    <div>
                      <span className="text-default-500">Document number: </span>
                      <span className="font-mono">{detailDoc.documentNumber}</span>
                      <div className="text-xs text-default-400 mt-0.5">
                        Visible here because you&apos;re authenticated in the web UI.
                        Retrieval via Janet (WhatsApp) will require Duo approval.
                      </div>
                    </div>
                  )}
                  {detailDoc.issuedDate && (
                    <div>
                      <span className="text-default-500">Issued: </span>
                      {detailDoc.issuedDate}
                    </div>
                  )}
                  {detailDoc.expiresDate && (
                    <div className="flex items-center gap-2">
                      <span className="text-default-500">Expires: </span>
                      <span>{detailDoc.expiresDate}</span>
                      {badge && (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            badge.color === "danger"
                              ? "bg-danger-100 text-danger-700"
                              : badge.color === "warning"
                              ? "bg-warning-100 text-warning-700"
                              : "bg-success-100 text-success-700"
                          }`}
                        >
                          {badge.label}
                        </span>
                      )}
                    </div>
                  )}
                  {detailDoc.notes && (
                    <div>
                      <span className="text-default-500">Notes: </span>
                      <Markdown content={detailDoc.notes} />
                    </div>
                  )}
                  {detailDoc.s3Key ? (
                    <div>
                      <span className="text-default-500">File: </span>
                      {detailDoc.originalFilename ?? detailDoc.s3Key}
                      {detailDoc.sizeBytes
                        ? ` (${Math.round(detailDoc.sizeBytes / 1024)} KB)`
                        : null}
                    </div>
                  ) : (
                    <div className="text-xs text-default-500 italic">
                      Metadata-only entry — no file attached.
                    </div>
                  )}
                  {detailDoc && (detailDoc.s3Key || detailDoc.documentNumber) && (
                    <div className="pt-2">
                      <Tooltip content={myDuoUsername ? "Requires Duo push approval" : "Link your Duo account in /security first"}>
                        <div className="inline-block">
                          <Button
                            size="sm"
                            variant="flat"
                            isDisabled={!myDuoUsername || downloading}
                            isLoading={downloading}
                            startContent={!downloading ? <FaLock size={10} /> : undefined}
                            onPress={() => handleDownload(detailDoc)}
                          >
                            Download
                          </Button>
                        </div>
                      </Tooltip>
                    </div>
                  )}
                </ModalBody>
                <ModalFooter className="justify-between">
                  <Button
                    color="danger"
                    variant="flat"
                    size="sm"
                    startContent={<FaTrash size={10} />}
                    onPress={() => {
                      setDeleteConfirm("");
                      deleteDisclosure.onOpen();
                    }}
                  >
                    Delete
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="light" onPress={onClose}>
                      Close
                    </Button>
                    <Button
                      color="primary"
                      size="sm"
                      startContent={<FaPen size={10} />}
                      onPress={() => openEdit(detailDoc)}
                    >
                      Edit
                    </Button>
                  </div>
                </ModalFooter>
              </>
            );
          }}
        </ModalContent>
      </Modal>

      {/* Delete confirm modal */}
      <Modal
        isOpen={deleteDisclosure.isOpen}
        onOpenChange={deleteDisclosure.onOpenChange}
        size="md"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Delete document</ModalHeader>
              <ModalBody>
                <p className="text-sm text-default-700">
                  This permanently deletes the document row and its S3 file. This cannot
                  be undone.
                </p>
                <p className="text-sm text-default-600">
                  Type <span className="font-mono font-semibold">DELETE</span> to confirm.
                </p>
                <Input
                  autoFocus
                  value={deleteConfirm}
                  onValueChange={setDeleteConfirm}
                  placeholder="DELETE"
                />
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose} isDisabled={deleting}>
                  Cancel
                </Button>
                <Button
                  color="danger"
                  onPress={() => doDelete(onClose)}
                  isDisabled={deleteConfirm !== "DELETE"}
                  isLoading={deleting}
                >
                  Delete
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </DefaultLayout>
  );
}
