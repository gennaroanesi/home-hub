// Contacts → Businesses: service people and businesses (homeBusiness,
// through the list_businesses / save_business ops Janet also uses) plus
// health providers, which are edited on /health.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Card, CardBody } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Select, SelectItem } from "@heroui/select";
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
  FaPen,
  FaTrash,
  FaSearch,
  FaExternalLinkAlt,
  FaHeartbeat,
} from "react-icons/fa";

import { callOp } from "@/lib/ops-client";
import {
  BUSINESS_CATEGORIES,
  BUSINESS_CATEGORY_LABELS,
  type BusinessRow,
  businessCategoryLabel,
  businessMatches,
} from "@/lib/businesses";

const EMPTY = {
  name: "",
  category: "",
  service: "",
  contactName: "",
  phone: "",
  email: "",
  website: "",
  address: "",
  lastUsedOn: "",
  notes: "",
  active: true,
};

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function BusinessesTab({ client }: { client: any }) {
  const [rows, setRows] = useState<BusinessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<BusinessRow | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const modal = useDisclosure();

  const load = useCallback(async () => {
    const r = await callOp(client, "list_businesses", {
      includeInactive: true,
    });
    if ("error" in r)
      addToast({
        title: "Couldn't load businesses",
        description: r.error,
        color: "danger",
      });
    else setRows(r.result.businesses as BusinessRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(
    () =>
      rows.filter(
        (b) =>
          (showInactive || b.active) &&
          (category === "ALL" || b.category === category) &&
          (!query.trim() || businessMatches(b, query)),
      ),
    [rows, showInactive, category, query],
  );

  // Only categories in use, so the filter row stays short.
  const usedCategories = useMemo(() => {
    const used = new Set(rows.map((b) => b.category ?? "OTHER"));
    return [...BUSINESS_CATEGORIES, "HEALTH" as const].filter((c) =>
      used.has(c),
    );
  }, [rows]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    modal.onOpen();
  }

  function openEdit(b: BusinessRow) {
    setEditing(b);
    setForm({
      name: b.name,
      category: b.category ?? "",
      service: b.service ?? "",
      contactName: b.contactName ?? "",
      phone: b.phone ?? "",
      email: b.email ?? "",
      website: b.website ?? "",
      address: b.address ?? "",
      lastUsedOn: b.lastUsedOn ?? "",
      notes: b.notes ?? "",
      active: b.active,
    });
    modal.onOpen();
  }

  async function save(onClose: () => void) {
    if (!form.name.trim()) return;
    setSaving(true);
    const { category: cat, lastUsedOn, ...text } = form;
    const r = await callOp(client, "save_business", {
      ...(editing ? { businessId: editing.id } : {}),
      ...Object.fromEntries(
        Object.entries(text).map(([k, v]) => [
          k,
          typeof v === "string" ? v.trim() || null : v,
        ]),
      ),
      name: form.name.trim(),
      category: (cat || null) as (typeof BUSINESS_CATEGORIES)[number] | null,
      lastUsedOn: lastUsedOn || null,
    });
    setSaving(false);
    if ("error" in r) {
      addToast({
        title: "Couldn't save",
        description: r.error,
        color: "danger",
      });
      return;
    }
    onClose();
    await load();
  }

  async function remove(b: BusinessRow) {
    if (!confirm(`Delete ${b.name}?`)) return;
    const r = await client.models.homeBusiness.delete({ id: b.id });
    if (r.errors?.length)
      addToast({
        title: "Couldn't delete",
        description: r.errors[0].message,
        color: "danger",
      });
    await load();
  }

  return (
    <>
      <div className="flex flex-col gap-2 mb-4">
        <div className="flex gap-2">
          <Input
            size="sm"
            placeholder="Search name, service, phone, notes"
            startContent={<FaSearch className="text-default-400" size={12} />}
            value={query}
            onValueChange={setQuery}
            isClearable
            onClear={() => setQuery("")}
          />
          <Button
            color="primary"
            size="sm"
            className="shrink-0 h-auto"
            startContent={<FaPlus size={12} />}
            onPress={openCreate}
          >
            New business
          </Button>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {["ALL", ...usedCategories].map((c) => (
            <Chip
              key={c}
              size="sm"
              className="cursor-pointer"
              variant={category === c ? "solid" : "flat"}
              color={category === c ? "primary" : "default"}
              onClick={() => setCategory(c)}
            >
              {c === "ALL" ? "All" : businessCategoryLabel(c)}
            </Chip>
          ))}
          <span className="flex-1" />
          <Switch
            size="sm"
            isSelected={showInactive}
            onValueChange={setShowInactive}
          >
            <span className="text-xs">Show inactive</span>
          </Switch>
        </div>
      </div>

      <div className="space-y-2">
        {shown.map((b) => (
          <Card
            key={`${b.source}:${b.id}`}
            className={b.active ? "" : "opacity-60"}
          >
            <CardBody className="flex flex-row items-start gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1 flex-wrap">
                  <p className="text-sm font-medium">{b.name}</p>
                  {b.category && (
                    <Chip
                      size="sm"
                      variant="flat"
                      color={b.source === "health" ? "danger" : "default"}
                      startContent={
                        b.source === "health" ? (
                          <FaHeartbeat size={10} className="ml-1" />
                        ) : undefined
                      }
                    >
                      {businessCategoryLabel(b.category)}
                    </Chip>
                  )}
                  {!b.active && (
                    <span className="text-xs text-default-400">inactive</span>
                  )}
                </div>
                {(b.service || b.contactName) && (
                  <p className="text-xs text-default-500">
                    {[b.service, b.contactName].filter(Boolean).join(" · ")}
                  </p>
                )}
                <p className="text-xs text-default-400">
                  {[
                    b.phone,
                    b.email,
                    b.lastUsedOn
                      ? `last used ${shortDate(b.lastUsedOn)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {b.website && (
                    <>
                      {b.phone || b.email || b.lastUsedOn ? " · " : ""}
                      <a
                        href={
                          /^https?:\/\//.test(b.website)
                            ? b.website
                            : `https://${b.website}`
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        website{" "}
                        <FaExternalLinkAlt size={8} className="inline" />
                      </a>
                    </>
                  )}
                </p>
                {b.address && (
                  <p className="text-xs text-default-400 truncate">
                    {b.address}
                  </p>
                )}
                {b.notes && (
                  <p className="text-xs text-default-500 line-clamp-2">
                    {b.notes}
                  </p>
                )}
              </div>
              <div className="flex gap-1">
                {b.source === "health" ? (
                  <Button
                    as={NextLink}
                    href="/health"
                    size="sm"
                    variant="light"
                    title="Health providers are edited in Health"
                  >
                    In Health
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      title="Edit"
                      onPress={() => openEdit(b)}
                    >
                      <FaPen size={12} />
                    </Button>
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      color="danger"
                      title="Delete"
                      onPress={() => remove(b)}
                    >
                      <FaTrash size={12} />
                    </Button>
                  </>
                )}
              </div>
            </CardBody>
          </Card>
        ))}
        {!loading && shown.length === 0 && (
          <p className="text-center text-default-300 py-10">
            {rows.length ? "No businesses match." : "No businesses yet."}
          </p>
        )}
      </div>

      <Modal
        isOpen={modal.isOpen}
        onOpenChange={modal.onOpenChange}
        scrollBehavior="inside"
        size="lg"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>
                {editing ? `Edit ${editing.name}` : "New business"}
              </ModalHeader>
              <ModalBody>
                <Input
                  label="Name"
                  value={form.name}
                  onValueChange={(v) => setForm({ ...form, name: v })}
                  placeholder="Austin Appliance Repair"
                  isRequired
                />
                <Select
                  label="Category"
                  placeholder="None"
                  selectedKeys={
                    form.category ? new Set([form.category]) : new Set<string>()
                  }
                  onSelectionChange={(keys) =>
                    setForm({
                      ...form,
                      category: String(
                        Array.from(keys as Set<string>)[0] ?? "",
                      ),
                    })
                  }
                  description="Doctors and labs go in Health, where visits can point at them."
                >
                  {BUSINESS_CATEGORIES.map((c) => (
                    <SelectItem key={c}>
                      {BUSINESS_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </Select>
                <Input
                  label="What they do for us"
                  value={form.service}
                  onValueChange={(v) => setForm({ ...form, service: v })}
                  placeholder="Fixed the dishwasher pump"
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    label="Contact person"
                    value={form.contactName}
                    onValueChange={(v) => setForm({ ...form, contactName: v })}
                  />
                  <Input
                    label="Phone"
                    value={form.phone}
                    onValueChange={(v) => setForm({ ...form, phone: v })}
                  />
                  <Input
                    label="Email"
                    type="email"
                    value={form.email}
                    onValueChange={(v) => setForm({ ...form, email: v })}
                  />
                  <Input
                    label="Website"
                    value={form.website}
                    onValueChange={(v) => setForm({ ...form, website: v })}
                  />
                </div>
                <Input
                  label="Address"
                  value={form.address}
                  onValueChange={(v) => setForm({ ...form, address: v })}
                />
                <Input
                  label="Last used"
                  type="date"
                  placeholder=" "
                  value={form.lastUsedOn}
                  onValueChange={(v) => setForm({ ...form, lastUsedOn: v })}
                />
                <Textarea
                  label="Notes"
                  value={form.notes}
                  onValueChange={(v) => setForm({ ...form, notes: v })}
                  minRows={2}
                  placeholder="Price, quality, would we use them again?"
                />
                <Switch
                  size="sm"
                  isSelected={form.active}
                  onValueChange={(v) => setForm({ ...form, active: v })}
                >
                  <span className="text-sm">
                    Active (off = we don&apos;t use them anymore)
                  </span>
                </Switch>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>
                  Cancel
                </Button>
                <Button
                  color="primary"
                  isLoading={saving}
                  onPress={() => save(onClose)}
                >
                  {editing ? "Save" : "Create"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
