"use client";

// Household inventory + wishlist (the wishlist doubles as the private
// baby registry).
//
// Data model is modular: homeInventoryItem is the base row; CLOTHING and
// CONSUMABLE items also have a detail row (homeInventoryClothing /
// homeInventoryConsumable) keyed by itemId. This page loads all three and
// joins them in memory. Janet writes the same tables (list_inventory,
// manage_inventory_item, adjust_inventory_quantity) and also restocks
// low consumables onto the shopping list automatically; here that's a
// manual "Add to list" button.

import React, { useEffect, useMemo, useState } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner, addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/modal";
import { FaBoxOpen, FaPlus, FaMinus, FaExternalLinkAlt } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { DateInput } from "@/components/date-input";
import { householdMembers } from "@/lib/household";
import { listAllPages } from "@/lib/list-all";
import {
  ACQUIRED_VIA_LABELS,
  CLOTHING_SIZE_PRESETS,
  INVENTORY_CATEGORIES,
  INVENTORY_CATEGORY_LABELS,
  INVENTORY_STATUSES,
  INVENTORY_STATUS_LABELS,
  PRIORITY_LABELS,
  formatUsd,
  isLowStock,
  sizeRank,
  spentTotal,
  wishlistSummary,
  type InventoryCategory,
  type InventoryStatus,
} from "@/lib/inventory";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Person = Schema["homePerson"]["type"];
type Pregnancy = Schema["homePregnancy"]["type"];
type Item = Schema["homeInventoryItem"]["type"];
type Clothing = Schema["homeInventoryClothing"]["type"];
type Consumable = Schema["homeInventoryConsumable"]["type"];
type ShoppingList = Schema["homeShoppingList"]["type"];

type Tab = "OWNED" | "WISHLIST" | "PAST";
const TABS: { key: Tab; label: string }[] = [
  { key: "OWNED", label: "Owned" },
  { key: "WISHLIST", label: "Wishlist" },
  { key: "PAST", label: "Sold / given away" },
];

// Owner filter / picker keys: "" = all (filter only), "household",
// "baby:<pregnancyId>", or a homePerson id.
const HOUSEHOLD = "household";
const babyKey = (pregnancyId: string) => `baby:${pregnancyId}`;

function ownerKeyOf(i: Item): string {
  if (i.pregnancyId) return babyKey(i.pregnancyId);
  return i.ownerPersonId ?? HOUSEHOLD;
}

function ownerFieldsFromKey(key: string): { ownerPersonId: string | null; pregnancyId: string | null } {
  if (key.startsWith("baby:")) return { ownerPersonId: null, pregnancyId: key.slice(5) };
  if (!key || key === HOUSEHOLD) return { ownerPersonId: null, pregnancyId: null };
  return { ownerPersonId: key, pregnancyId: null };
}

function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [clothing, setClothing] = useState<Clothing[]>([]);
  const [consumables, setConsumables] = useState<Consumable[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [pregnancies, setPregnancies] = useState<Pregnancy[]>([]);
  const [lists, setLists] = useState<ShoppingList[]>([]);

  const [tab, setTab] = useState<Tab>("OWNED");
  const [category, setCategory] = useState<InventoryCategory | "">("");
  const [owner, setOwner] = useState("");
  const [search, setSearch] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
      } catch {
        router.push("/login");
        return;
      }
      await loadAll();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll() {
    try {
      const [it, cl, co, ppl, preg, sl] = await Promise.all([
        listAllPages<Item>(client.models.homeInventoryItem),
        listAllPages<Clothing>(client.models.homeInventoryClothing),
        listAllPages<Consumable>(client.models.homeInventoryConsumable),
        listAllPages<Person>(client.models.homePerson),
        listAllPages<Pregnancy>(client.models.homePregnancy),
        listAllPages<ShoppingList>(client.models.homeShoppingList),
      ]);
      setItems(it);
      setClothing(cl);
      setConsumables(co);
      setPeople(ppl);
      setPregnancies(preg);
      setLists(sl.filter((l) => !l.isArchived).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    } catch (err) {
      console.error("Failed to load inventory:", err);
      addToast({ title: "Couldn't load inventory", color: "danger" });
    } finally {
      setLoading(false);
    }
  }

  const clothingByItem = useMemo(() => new Map(clothing.map((c) => [c.itemId, c])), [clothing]);
  const consumableByItem = useMemo(() => new Map(consumables.map((c) => [c.itemId, c])), [consumables]);

  // Owner options: household, the baby on the way, household members,
  // then anyone else who already owns something (e.g. a kid).
  const ownerOptions = useMemo(() => {
    const opts: { key: string; label: string }[] = [{ key: HOUSEHOLD, label: "Household (shared)" }];
    for (const p of pregnancies.filter((p) => p.status === "ACTIVE")) {
      opts.push({ key: babyKey(p.id), label: "👶 Baby on the way" });
    }
    const members = householdMembers(people);
    const ownerIds = new Set(items.map((i) => i.ownerPersonId).filter(Boolean));
    const others = people.filter((p) => ownerIds.has(p.id) && !members.includes(p));
    for (const p of [...members, ...others]) {
      opts.push({ key: p.id, label: `${p.emoji ? `${p.emoji} ` : ""}${p.name}` });
    }
    // Items linked to a pregnancy that's no longer active still need a label.
    for (const p of pregnancies.filter((p) => p.status !== "ACTIVE")) {
      if (items.some((i) => i.pregnancyId === p.id)) opts.push({ key: babyKey(p.id), label: "👶 Baby (past pregnancy)" });
    }
    return opts;
  }, [people, pregnancies, items]);

  const ownerLabel = (i: Item) => ownerOptions.find((o) => o.key === ownerKeyOf(i))?.label ?? "Unknown";

  const tabItems = useMemo(
    () =>
      items.filter((i) =>
        tab === "PAST" ? i.status === "SOLD" || i.status === "GIVEN_AWAY" : i.status === tab,
      ),
    [items, tab],
  );

  const visible = useMemo(() => {
    const q = search.toLowerCase().trim();
    return tabItems
      .filter((i) => !category || i.category === category)
      .filter((i) => !owner || ownerKeyOf(i) === owner)
      .filter((i) => {
        if (!q) return true;
        const c = clothingByItem.get(i.id);
        return [i.name, i.brand, i.notes, i.location, ...(i.tags ?? []), c?.type, c?.color, c?.size]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
  }, [tabItems, category, owner, search, clothingByItem]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Item[]>();
    for (const i of visible) {
      const k = i.category ?? "OTHER";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(i);
    }
    const order = (c: string) => INVENTORY_CATEGORIES.indexOf(c as InventoryCategory);
    return Array.from(groups.entries())
      .sort(([a], [b]) => order(a) - order(b))
      .map(([cat, rows]) => ({
        category: cat as InventoryCategory,
        rows: rows.sort(
          (a, b) =>
            (tab === "WISHLIST" ? Number(a.priority !== "MUST_HAVE") - Number(b.priority !== "MUST_HAVE") : 0) ||
            sizeRank(clothingByItem.get(a.id)?.size) - sizeRank(clothingByItem.get(b.id)?.size) ||
            a.name.localeCompare(b.name),
        ),
      }));
  }, [visible, tab, clothingByItem]);

  const wish = useMemo(() => wishlistSummary(visible), [visible]);
  const spent = useMemo(() => spentTotal(visible), [visible]);
  const lowCount = useMemo(
    () =>
      items.filter((i) => {
        const k = consumableByItem.get(i.id);
        return i.status === "OWNED" && !!k && isLowStock(i.quantity, k.lowStockThreshold);
      }).length,
    [items, consumableByItem],
  );

  function upsertLocal(item: Item) {
    setItems((prev) => (prev.some((i) => i.id === item.id) ? prev.map((i) => (i.id === item.id ? item : i)) : [...prev, item]));
  }

  async function adjustQuantity(item: Item, delta: number) {
    const next = Math.max(0, (item.quantity ?? 0) + delta);
    const { data, errors } = await client.models.homeInventoryItem.update({ id: item.id, quantity: next });
    if (errors?.length || !data) {
      addToast({ title: "Update failed", description: errors?.[0]?.message, color: "danger" });
      return;
    }
    upsertLocal(data);
  }

  async function markOwned(item: Item) {
    const { data, errors } = await client.models.homeInventoryItem.update({
      id: item.id,
      status: "OWNED",
      acquiredAt: todayYmd(),
      acquiredVia: item.acquiredVia ?? "PURCHASED",
      ...((item.acquiredVia ?? "PURCHASED") === "PURCHASED" && item.pricePaid == null && item.estimatedPrice != null
        ? { pricePaid: item.estimatedPrice }
        : {}),
    });
    if (errors?.length || !data) {
      addToast({ title: "Update failed", description: errors?.[0]?.message, color: "danger" });
      return;
    }
    upsertLocal(data);
    addToast({ title: `${data.name} moved to Owned`, description: "Edit it to record a gift or the actual price.", color: "success" });
  }

  async function addToShoppingList(item: Item) {
    const k = consumableByItem.get(item.id);
    const list =
      lists.find((l) => l.id === k?.shoppingListId) ??
      lists.find((l) => /supermarket|grocer/i.test(l.name)) ??
      lists[0];
    if (!list) {
      addToast({ title: "No shopping list to add to", color: "warning" });
      return;
    }
    const { errors } = await client.models.homeShoppingItem.create({
      listId: list.id,
      name: item.name,
      notes: `Low stock (${item.quantity ?? 0}${k?.unit ? ` ${k.unit}` : ""} left)`,
      isChecked: false,
      addedBy: "inventory",
      sortOrder: 0,
    });
    if (errors?.length) {
      addToast({ title: "Couldn't add to list", description: errors[0].message, color: "danger" });
      return;
    }
    addToast({ title: `Added to ${list.name}`, color: "success" });
  }

  function openNew() {
    setEditing(null);
    setModalOpen(true);
  }

  return (
    <DefaultLayout>
      <div className="max-w-4xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between gap-2 mb-6">
          <div className="flex items-center gap-2">
            <FaBoxOpen className="text-default-500" />
            <h1 className="text-2xl font-bold">Inventory</h1>
          </div>
          <Button size="sm" color="primary" startContent={<FaPlus />} onPress={openNew}>
            Add item
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-4">
          {TABS.map((t) => {
            const count = items.filter((i) =>
              t.key === "PAST" ? i.status === "SOLD" || i.status === "GIVEN_AWAY" : i.status === t.key,
            ).length;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`px-3 py-1 rounded-full text-sm ${
                  tab === t.key ? "bg-primary text-primary-foreground" : "bg-default-100 text-default-600"
                }`}
              >
                {t.label} <span className="opacity-70">{count}</span>
              </button>
            );
          })}
          {lowCount > 0 && (
            <span className="px-3 py-1 rounded-full text-sm bg-warning-100 text-warning-700">
              {lowCount} running low
            </span>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2 mb-6">
          <Input
            size="sm"
            aria-label="Search"
            placeholder="Search name, brand, size, color, tags…"
            value={search}
            onValueChange={setSearch}
            isClearable
            onClear={() => setSearch("")}
          />
          <Select
            size="sm"
            aria-label="Category"
            placeholder="All categories"
            selectedKeys={category ? [category] : []}
            onChange={(e) => setCategory((e.target.value as InventoryCategory) || "")}
            className="sm:max-w-[180px]"
          >
            {INVENTORY_CATEGORIES.map((c) => (
              <SelectItem key={c}>{INVENTORY_CATEGORY_LABELS[c]}</SelectItem>
            ))}
          </Select>
          <Select
            size="sm"
            aria-label="Owner"
            placeholder="Everyone"
            selectedKeys={owner ? [owner] : []}
            onChange={(e) => setOwner(e.target.value)}
            className="sm:max-w-[200px]"
          >
            {ownerOptions.map((o) => (
              <SelectItem key={o.key}>{o.label}</SelectItem>
            ))}
          </Select>
        </div>

        {/* Totals */}
        {!loading && tab === "WISHLIST" && wish.count > 0 && (
          <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Items" value={String(wish.count)} />
            <Stat label="Estimated" value={formatUsd(wish.estimatedTotal)} />
            <Stat label="Must-haves" value={formatUsd(wish.mustHaveTotal)} />
            <Stat label="No price yet" value={String(wish.unpriced)} muted={wish.unpriced === 0} />
          </div>
        )}
        {!loading && tab === "OWNED" && spent > 0 && (
          <p className="mb-6 text-sm text-default-500">
            Spent on what&apos;s shown: <span className="font-semibold text-foreground">{formatUsd(spent)}</span>{" "}
            <span className="text-default-400">(gifts and hand-me-downs excluded)</span>
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner label="Loading inventory..." />
          </div>
        ) : grouped.length === 0 ? (
          <div className="text-center py-12 text-default-400">
            <p>{tabItems.length === 0 ? `Nothing here yet.` : "No items match these filters."}</p>
            {tabItems.length === 0 && (
              <p className="text-sm mt-1">
                Add items here, or tell Janet — “add a stroller to the baby wishlist, about $400”.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {grouped.map(({ category: cat, rows }) => (
              <section key={cat}>
                <h2 className="text-xs font-medium uppercase tracking-wider text-default-400 mb-2">
                  {INVENTORY_CATEGORY_LABELS[cat]} · {rows.length}
                </h2>
                <div className="divide-y divide-default-100 border border-default-200 rounded-md bg-default-50">
                  {rows.map((i) => (
                    <ItemRow
                      key={i.id}
                      item={i}
                      clothing={clothingByItem.get(i.id)}
                      consumable={consumableByItem.get(i.id)}
                      ownerLabel={ownerLabel(i)}
                      onEdit={() => {
                        setEditing(i);
                        setModalOpen(true);
                      }}
                      onAdjust={(d) => adjustQuantity(i, d)}
                      onMarkOwned={() => markOwned(i)}
                      onAddToList={() => addToShoppingList(i)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <ItemModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        defaultStatus={tab === "WISHLIST" ? "WISHLIST" : "OWNED"}
        defaultCategory={category || undefined}
        defaultOwner={owner || HOUSEHOLD}
        clothing={editing ? clothingByItem.get(editing.id) : undefined}
        consumable={editing ? consumableByItem.get(editing.id) : undefined}
        ownerOptions={ownerOptions}
        lists={lists}
        onSaved={loadAll}
      />
    </DefaultLayout>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="border border-default-200 rounded-md px-3 py-2 bg-default-50">
      <p className="text-[11px] uppercase tracking-wider text-default-400">{label}</p>
      <p className={`text-lg font-semibold ${muted ? "text-default-400" : "text-foreground"}`}>{value}</p>
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────

function ItemRow({
  item,
  clothing,
  consumable,
  ownerLabel,
  onEdit,
  onAdjust,
  onMarkOwned,
  onAddToList,
}: {
  item: Item;
  clothing?: Clothing;
  consumable?: Consumable;
  ownerLabel: string;
  onEdit: () => void;
  onAdjust: (delta: number) => void;
  onMarkOwned: () => void;
  onAddToList: () => void;
}) {
  const low = item.status === "OWNED" && !!consumable && isLowStock(item.quantity, consumable.lowStockThreshold);
  const qty = item.quantity ?? 1;
  const price = item.status === "WISHLIST" ? item.estimatedPrice : item.pricePaid;

  const chips: string[] = [];
  if (clothing?.size) chips.push(clothing.size);
  if (clothing?.color) chips.push(clothing.color);
  if (clothing?.type) chips.push(clothing.type);
  if (item.brand) chips.push(item.brand);
  if (item.acquiredVia && item.acquiredVia !== "PURCHASED") {
    chips.push(item.giftFrom ? `${ACQUIRED_VIA_LABELS[item.acquiredVia]} from ${item.giftFrom}` : ACQUIRED_VIA_LABELS[item.acquiredVia]);
  }
  for (const t of item.tags ?? []) if (t) chips.push(`#${t}`);

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <button type="button" onClick={onEdit} className="flex-1 min-w-0 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{item.name}</span>
          {item.status === "WISHLIST" && item.priority === "MUST_HAVE" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-100 text-primary-700">Must have</span>
          )}
          {low && <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-100 text-warning-700">Low</span>}
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-default-400 hover:text-primary"
              aria-label="Open link"
            >
              <FaExternalLinkAlt size={10} />
            </a>
          )}
        </div>
        <p className="text-xs text-default-500 truncate">
          {[ownerLabel, ...chips, item.location].filter(Boolean).join(" · ")}
          {item.status === "WISHLIST" && item.neededBy && ` · by ${item.neededBy}`}
        </p>
      </button>

      {consumable && item.status === "OWNED" ? (
        <div className="flex items-center gap-1 shrink-0">
          <Button isIconOnly size="sm" variant="light" aria-label="One less" onPress={() => onAdjust(-1)}>
            <FaMinus size={10} />
          </Button>
          <span className="text-sm w-12 text-center tabular-nums">
            {qty}
            {consumable.unit ? <span className="text-[10px] text-default-400 block leading-none">{consumable.unit}</span> : null}
          </span>
          <Button isIconOnly size="sm" variant="light" aria-label="One more" onPress={() => onAdjust(1)}>
            <FaPlus size={10} />
          </Button>
          {low && (
            <Button size="sm" variant="flat" color="warning" onPress={onAddToList}>
              Add to list
            </Button>
          )}
        </div>
      ) : (
        qty > 1 && <span className="text-xs text-default-500 shrink-0">×{qty}</span>
      )}

      {price != null && (
        <span className="text-sm text-default-600 shrink-0 tabular-nums w-20 text-right">
          {item.status === "WISHLIST" && "~"}
          {formatUsd(price * Math.max(1, qty))}
        </span>
      )}

      {item.status === "WISHLIST" && (
        <Button size="sm" variant="flat" color="success" onPress={onMarkOwned} className="shrink-0">
          Got it
        </Button>
      )}
    </div>
  );
}

// ── Add / edit modal ─────────────────────────────────────────────────────

function ItemModal({
  isOpen,
  onClose,
  editing,
  defaultStatus,
  defaultCategory,
  defaultOwner,
  clothing,
  consumable,
  ownerOptions,
  lists,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  editing: Item | null;
  defaultStatus: InventoryStatus;
  defaultCategory?: InventoryCategory;
  defaultOwner: string;
  clothing?: Clothing;
  consumable?: Consumable;
  ownerOptions: { key: string; label: string }[];
  lists: ShoppingList[];
  onSaved: () => void;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: string) => (v: string) => setF((prev) => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (!isOpen) return;
    const e = editing;
    const s = (v: unknown) => (v == null ? "" : String(v));
    setF({
      name: s(e?.name),
      category: s(e?.category ?? defaultCategory ?? "OTHER"),
      status: s(e?.status ?? defaultStatus),
      owner: e ? ownerKeyOf(e) : defaultOwner,
      brand: s(e?.brand),
      quantity: s(e?.quantity ?? 1),
      location: s(e?.location),
      tags: (e?.tags ?? []).filter(Boolean).join(", "),
      notes: s(e?.notes),
      url: s(e?.url),
      priority: s(e?.priority),
      neededBy: s(e?.neededBy),
      estimatedPrice: s(e?.estimatedPrice),
      acquiredVia: s(e?.acquiredVia),
      giftFrom: s(e?.giftFrom),
      vendor: s(e?.vendor),
      acquiredAt: s(e?.acquiredAt),
      pricePaid: s(e?.pricePaid),
      priceSold: s(e?.priceSold),
      size: s(clothing?.size),
      color: s(clothing?.color),
      clothingType: s(clothing?.type),
      season: s(clothing?.season),
      unit: s(consumable?.unit),
      lowStockThreshold: s(consumable?.lowStockThreshold),
      shoppingListId: s(consumable?.shoppingListId),
      expiresOn: s(consumable?.expiresOn),
    });
  }, [isOpen, editing, clothing, consumable, defaultStatus, defaultCategory, defaultOwner]);

  const str = (k: string) => (f[k]?.trim() ? f[k].trim() : null);
  const num = (k: string) => (f[k]?.trim() && !Number.isNaN(Number(f[k])) ? Number(f[k]) : null);
  const int = (k: string) => (num(k) == null ? null : Math.round(num(k)!));

  async function save() {
    if (!f.name?.trim()) {
      addToast({ title: "Name is required", color: "warning" });
      return;
    }
    setSaving(true);
    try {
      const status = f.status as InventoryStatus;
      const base = {
        name: f.name.trim(),
        category: f.category as InventoryCategory,
        status,
        ...ownerFieldsFromKey(f.owner),
        brand: str("brand"),
        quantity: int("quantity") ?? 1,
        location: str("location"),
        tags: f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        notes: str("notes"),
        url: str("url"),
        priority: (str("priority") as "MUST_HAVE" | "NICE_TO_HAVE" | null) ?? null,
        neededBy: str("neededBy"),
        estimatedPrice: num("estimatedPrice"),
        acquiredVia: (str("acquiredVia") as "PURCHASED" | "GIFT" | "HAND_ME_DOWN" | null) ?? null,
        giftFrom: str("giftFrom"),
        vendor: str("vendor"),
        acquiredAt: str("acquiredAt") ?? (status === "OWNED" && editing?.status !== "OWNED" ? todayYmd() : null),
        pricePaid: num("pricePaid"),
        priceSold: num("priceSold"),
        ...((status === "SOLD" || status === "GIVEN_AWAY") && !editing?.disposedAt ? { disposedAt: todayYmd() } : {}),
      };
      const res = editing
        ? await client.models.homeInventoryItem.update({ id: editing.id, ...base })
        : await client.models.homeInventoryItem.create({ ...base, createdBy: "web" });
      if (res.errors?.length || !res.data) throw new Error(res.errors?.[0]?.message ?? "save failed");
      const itemId = res.data.id;

      // Detail row for the (possibly new) category. A detail row from a
      // previous category is left in place — harmless, and it comes back
      // if the category is switched back.
      if (base.category === "CLOTHING") {
        const detail = { size: str("size"), color: str("color"), type: str("clothingType"), season: (str("season") as "ALL" | "WARM" | "COLD" | null) ?? null };
        const r = clothing
          ? await client.models.homeInventoryClothing.update({ id: clothing.id, ...detail })
          : await client.models.homeInventoryClothing.create({ itemId, ...detail });
        if (r.errors?.length) throw new Error(r.errors[0].message);
      } else if (base.category === "CONSUMABLE") {
        const detail = {
          unit: str("unit"),
          lowStockThreshold: int("lowStockThreshold"),
          shoppingListId: str("shoppingListId"),
          expiresOn: str("expiresOn"),
        };
        const r = consumable
          ? await client.models.homeInventoryConsumable.update({ id: consumable.id, ...detail })
          : await client.models.homeInventoryConsumable.create({ itemId, ...detail });
        if (r.errors?.length) throw new Error(r.errors[0].message);
      }

      addToast({ title: editing ? "Saved" : "Item added", color: "success" });
      onSaved();
      onClose();
    } catch (err: any) {
      addToast({ title: "Save failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editing || !confirm(`Delete "${editing.name}"?`)) return;
    setSaving(true);
    try {
      if (clothing) await client.models.homeInventoryClothing.delete({ id: clothing.id });
      if (consumable) await client.models.homeInventoryConsumable.delete({ id: consumable.id });
      const { errors } = await client.models.homeInventoryItem.delete({ id: editing.id });
      if (errors?.length) throw new Error(errors[0].message);
      onSaved();
      onClose();
    } catch (err: any) {
      addToast({ title: "Delete failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setSaving(false);
    }
  }

  const status = f.status as InventoryStatus;
  const isWishlist = status === "WISHLIST";

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{editing ? "Edit item" : "Add item"}</ModalHeader>
        <ModalBody className="gap-3">
          <Input label="Name" value={f.name ?? ""} onValueChange={set("name")} isRequired autoFocus={!editing} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Select
              label="Category"
              selectedKeys={f.category ? [f.category] : []}
              onChange={(e) => e.target.value && set("category")(e.target.value)}
            >
              {INVENTORY_CATEGORIES.map((c) => (
                <SelectItem key={c}>{INVENTORY_CATEGORY_LABELS[c]}</SelectItem>
              ))}
            </Select>
            <Select
              label="Status"
              selectedKeys={f.status ? [f.status] : []}
              onChange={(e) => e.target.value && set("status")(e.target.value)}
            >
              {INVENTORY_STATUSES.map((s) => (
                <SelectItem key={s}>{INVENTORY_STATUS_LABELS[s]}</SelectItem>
              ))}
            </Select>
            <Select
              label="Belongs to"
              selectedKeys={f.owner ? [f.owner] : []}
              onChange={(e) => e.target.value && set("owner")(e.target.value)}
            >
              {ownerOptions.map((o) => (
                <SelectItem key={o.key}>{o.label}</SelectItem>
              ))}
            </Select>
          </div>

          {/* Category details */}
          {f.category === "CLOTHING" && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Input label="Size" value={f.size ?? ""} onValueChange={set("size")} list="inventory-sizes" />
              <datalist id="inventory-sizes">
                {[...CLOTHING_SIZE_PRESETS.baby, ...CLOTHING_SIZE_PRESETS.toddler, ...CLOTHING_SIZE_PRESETS.adult].map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <Input label="Color" value={f.color ?? ""} onValueChange={set("color")} />
              <Input label="Type" placeholder="Onesie, sleeper…" value={f.clothingType ?? ""} onValueChange={set("clothingType")} />
              <Select
                label="Season"
                selectedKeys={f.season ? [f.season] : []}
                onChange={(e) => set("season")(e.target.value)}
              >
                <SelectItem key="ALL">All year</SelectItem>
                <SelectItem key="WARM">Warm</SelectItem>
                <SelectItem key="COLD">Cold</SelectItem>
              </Select>
            </div>
          )}
          {f.category === "CONSUMABLE" && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Input label="Unit" placeholder="pack, box…" value={f.unit ?? ""} onValueChange={set("unit")} />
              <Input
                label="Low at"
                type="number"
                min={0}
                description="Restock at or below"
                value={f.lowStockThreshold ?? ""}
                onValueChange={set("lowStockThreshold")}
              />
              <Select
                label="Restock onto"
                placeholder="Default list"
                selectedKeys={f.shoppingListId ? [f.shoppingListId] : []}
                onChange={(e) => set("shoppingListId")(e.target.value)}
              >
                {lists.map((l) => (
                  <SelectItem key={l.id}>{`${l.emoji ?? ""} ${l.name}`.trim()}</SelectItem>
                ))}
              </Select>
              <DateInput label="Expires" value={f.expiresOn ?? ""} onChange={set("expiresOn")} />
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Input label="Brand" value={f.brand ?? ""} onValueChange={set("brand")} />
            <Input label="Quantity" type="number" min={0} value={f.quantity ?? ""} onValueChange={set("quantity")} />
            <Input label="Location" placeholder="Nursery closet" value={f.location ?? ""} onValueChange={set("location")} />
          </div>

          {isWishlist ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Input
                label="Estimated price"
                type="number"
                min={0}
                step="0.01"
                startContent={<span className="text-default-400 text-sm">$</span>}
                description="Per unit"
                value={f.estimatedPrice ?? ""}
                onValueChange={set("estimatedPrice")}
              />
              <Select
                label="Priority"
                selectedKeys={f.priority ? [f.priority] : []}
                onChange={(e) => set("priority")(e.target.value)}
              >
                {(Object.keys(PRIORITY_LABELS) as (keyof typeof PRIORITY_LABELS)[]).map((p) => (
                  <SelectItem key={p}>{PRIORITY_LABELS[p]}</SelectItem>
                ))}
              </Select>
              <DateInput label="Needed by" value={f.neededBy ?? ""} onChange={set("neededBy")} />
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Select
                label="Got it as"
                selectedKeys={f.acquiredVia ? [f.acquiredVia] : []}
                onChange={(e) => set("acquiredVia")(e.target.value)}
              >
                {(Object.keys(ACQUIRED_VIA_LABELS) as (keyof typeof ACQUIRED_VIA_LABELS)[]).map((a) => (
                  <SelectItem key={a}>{ACQUIRED_VIA_LABELS[a]}</SelectItem>
                ))}
              </Select>
              {f.acquiredVia === "GIFT" || f.acquiredVia === "HAND_ME_DOWN" ? (
                <Input label="From" value={f.giftFrom ?? ""} onValueChange={set("giftFrom")} />
              ) : (
                <Input
                  label="Price paid"
                  type="number"
                  min={0}
                  step="0.01"
                  startContent={<span className="text-default-400 text-sm">$</span>}
                  description="Per unit"
                  value={f.pricePaid ?? ""}
                  onValueChange={set("pricePaid")}
                />
              )}
              <Input label="Store" value={f.vendor ?? ""} onValueChange={set("vendor")} />
              <DateInput label="Date" value={f.acquiredAt ?? ""} onChange={set("acquiredAt")} />
            </div>
          )}
          {status === "SOLD" && (
            <Input
              label="Sold for"
              type="number"
              min={0}
              step="0.01"
              startContent={<span className="text-default-400 text-sm">$</span>}
              value={f.priceSold ?? ""}
              onValueChange={set("priceSold")}
              className="sm:max-w-[200px]"
            />
          )}

          <Input label="Link" type="url" placeholder="https://" value={f.url ?? ""} onValueChange={set("url")} />
          <Input label="Tags" placeholder="nursery, feeding" value={f.tags ?? ""} onValueChange={set("tags")} />
          <Textarea label="Notes" minRows={2} value={f.notes ?? ""} onValueChange={set("notes")} />
        </ModalBody>
        <ModalFooter className="justify-between">
          <div>
            {editing && (
              <Button color="danger" variant="light" onPress={remove} isDisabled={saving}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="light" onPress={onClose}>
              Cancel
            </Button>
            <Button color="primary" onPress={save} isLoading={saving}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
