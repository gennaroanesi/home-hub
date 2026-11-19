"use client";

// Inventory + wishlist (the wishlist doubles as the private baby registry).
//
// Items come from and are saved through the inventory ops (list_inventory,
// manage_inventory_item, …, lib/ops/inventory-items.ts), the same ones the
// phone and Janet use: they join each item's detail fields (clothing,
// consumable, firearm, ammo, filament, instrument, photography, electronic:
// lib/inventory-details.ts), keep firearms and ammo to their owner, and
// restock low consumables. The add / edit form's detail section is
// generated from the same spec. docs/inventory-specialized.md.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner, addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { FaBoxOpen, FaCamera, FaPlus, FaMinus, FaExternalLinkAlt, FaFolderOpen, FaLock } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { DateInput } from "@/components/date-input";
import { CategoryManager } from "@/components/inventory/category-manager";
import { DetailFields } from "@/components/inventory/detail-fields";
import { AmmoPanel } from "@/components/inventory/ammo-panel";
import { InventoryOverview, type Overview, type OverviewPick } from "@/components/inventory/overview";
import { householdMembers } from "@/lib/household";
import { babyProfileFor } from "@/lib/pregnancy";
import { listAllPages } from "@/lib/list-all";
import { callOp } from "@/lib/ops-client";
import type { OpOutput } from "@/lib/ops/registry";
import {
  ACQUIRED_VIA_LABELS,
  INVENTORY_STATUSES,
  INVENTORY_STATUS_LABELS,
  PRIORITY_LABELS,
  categoryAndDescendants,
  categoryTree,
  formatUsd,
  sizeRank,
  spentTotal,
  wishlistSummary,
  type CategoryNode,
  type InventoryStatus,
} from "@/lib/inventory";
import { DETAIL_SPECS, detailSpec, type DetailType } from "@/lib/inventory-details";
import { roomAndDescendants, roomLabel } from "@/lib/floorplan";
import { originalPhotoUrl, photoUrl } from "@/lib/image-loader";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Item = OpOutput<"list_inventory">["items"][number];
type Person = Schema["homePerson"]["type"];
type Pregnancy = Schema["homePregnancy"]["type"];
type Category = Schema["homeInventoryCategory"]["type"];
type ShoppingList = Schema["homeShoppingList"]["type"];
type Room = Schema["homeRoom"]["type"];
type Pet = Schema["homePet"]["type"];
type Floor = Schema["homeFloor"]["type"];

interface RoomOption {
  key: string;
  label: string; // "Primary bedroom › Closet"
  floor: string;
}

type Tab = "DRAFT" | "OWNED" | "WISHLIST" | "PAST";
// Drafts (from Janet's photo intake) only get a tab while there are some.
const TABS: { key: Tab; label: string }[] = [
  { key: "DRAFT", label: "Drafts" },
  { key: "OWNED", label: "Owned" },
  { key: "WISHLIST", label: "Wishlist" },
  { key: "PAST", label: "Sold / given away" },
];

// Owner filter / picker keys: "" = all (filter only), "household",
// "baby:<pregnancyId>", "pet:<petId>", or a homePerson id. The ops take
// the same keys as ownerName.
const HOUSEHOLD = "household";
const babyKey = (pregnancyId: string) => `baby:${pregnancyId}`;
const petKey = (petId: string) => `pet:${petId}`;

function ownerKeyOf(i: Item): string {
  if (i.pregnancyId) return babyKey(i.pregnancyId);
  if (i.petId) return petKey(i.petId);
  return i.ownerPersonId ?? HOUSEHOLD;
}

const PET_EMOJI: Record<string, string> = { DOG: "🐶", CAT: "🐱" };

function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const failed = (title: string, error: string) => addToast({ title, description: error, color: "danger" });

// ── Page ─────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [pregnancies, setPregnancies] = useState<Pregnancy[]>([]);
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [pets, setPets] = useState<Pet[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [roomFilter, setRoomFilter] = useState("");
  const [defaultRoom, setDefaultRoom] = useState("");
  const [version, setVersion] = useState(0);

  const [tab, setTab] = useState<Tab>("OWNED");
  const [category, setCategory] = useState("");
  const [owner, setOwner] = useState("");
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);

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

  // Deep links from the map: ?roomId=… filters to that room (and its
  // closets); &new=1 opens "Add item" with the room preselected.
  useEffect(() => {
    if (!router.isReady) return;
    const roomId = typeof router.query.roomId === "string" ? router.query.roomId : "";
    if (!roomId) return;
    setRoomFilter(roomId);
    if (router.query.new === "1") {
      setEditing(null);
      setDefaultRoom(roomId);
      setModalOpen(true);
    }
  }, [router.isReady, router.query.roomId, router.query.new]);

  async function loadItems() {
    const [r, ov] = await Promise.all([callOp(client, "list_inventory", { status: "ALL", limit: 1000 }), callOp(client, "get_inventory_overview", {})]);
    if ("error" in r) throw new Error(r.error);
    if (!("error" in ov)) setOverview(ov.result);
    setItems(r.result.items);
    setVersion((v) => v + 1);
    return r.result.items;
  }

  async function loadAll() {
    try {
      // Rooms/floors are optional: an older amplify_outputs.json (before
      // the house map was deployed) simply doesn't have those models.
      const models = client.models as Partial<typeof client.models>;
      const [it, ppl, preg, sl, rm, fl, cat] = await Promise.all([
        loadItems(),
        listAllPages<Person>(client.models.homePerson),
        listAllPages<Pregnancy>(client.models.homePregnancy),
        listAllPages<ShoppingList>(client.models.homeShoppingList),
        models.homeRoom ? listAllPages<Room>(models.homeRoom) : Promise.resolve([] as Room[]),
        models.homeFloor ? listAllPages<Floor>(models.homeFloor) : Promise.resolve([] as Floor[]),
        models.homeInventoryCategory ? listAllPages<Category>(models.homeInventoryCategory) : Promise.resolve([] as Category[]),
      ]);
      listAllPages<Pet>(client.models.homePet).then(setPets, () => setPets([]));
      setCategories(cat);
      setRooms(rm);
      setFloors(fl);
      if (it.some((i) => i.status === "DRAFT")) setTab((cur) => (cur === "OWNED" ? "DRAFT" : cur));
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

  // Owner options: household, the baby on the way, household members,
  // then anyone else who already owns something (e.g. a kid).
  const ownerOptions = useMemo(() => {
    const opts: { key: string; label: string }[] = [{ key: HOUSEHOLD, label: "Household (shared)" }];
    // The baby on the way, until the baby has its own profile (then the
    // baby is a household member below, lib/pregnancy.ts babyProfileFor);
    // still listed while items sit on the pregnancy.
    for (const p of pregnancies.filter((p) => p.status === "ACTIVE")) {
      if (!babyProfileFor(p, people) || items.some((i) => i.pregnancyId === p.id)) opts.push({ key: babyKey(p.id), label: "👶 Baby on the way" });
    }
    const members = householdMembers(people);
    const ownerIds = new Set(items.map((i) => i.ownerPersonId).filter(Boolean));
    const others = people.filter((p) => ownerIds.has(p.id) && !members.includes(p));
    for (const p of [...members, ...others]) {
      opts.push({ key: p.id, label: `${p.emoji ? `${p.emoji} ` : ""}${p.name}` });
    }
    // Pets: active ones, plus any retired pet that still owns something.
    const petOwnerIds = new Set(items.map((i) => i.petId).filter(Boolean));
    for (const p of pets.filter((p) => p.active !== false || petOwnerIds.has(p.id))) {
      opts.push({ key: petKey(p.id), label: `${PET_EMOJI[p.species ?? ""] ?? "🐾"} ${p.name}` });
    }
    // Items linked to a pregnancy that's no longer active still need a label.
    for (const p of pregnancies.filter((p) => p.status !== "ACTIVE")) {
      if (items.some((i) => i.pregnancyId === p.id)) opts.push({ key: babyKey(p.id), label: "👶 Baby (past pregnancy)" });
    }
    return opts;
  }, [people, pregnancies, pets, items]);

  const ownerLabel = (i: Item) => ownerOptions.find((o) => o.key === ownerKeyOf(i))?.label ?? i.owner;

  // Rooms by floor, then name, labelled "Room › Closet".
  const roomOptions = useMemo<RoomOption[]>(() => {
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const floorOf = new Map(floors.map((f) => [f.id, f]));
    return rooms
      .map((r) => ({ key: r.id, label: roomLabel(r, byId), floor: floorOf.get(r.floorId)?.name ?? "", level: floorOf.get(r.floorId)?.level ?? 0 }))
      .sort((a, b) => a.level - b.level || a.label.localeCompare(b.label))
      .map(({ key, label, floor }) => ({ key, label, floor }));
  }, [rooms, floors]);
  const roomFilterIds = useMemo(() => (roomFilter && roomFilter !== "none" ? roomAndDescendants(roomFilter, rooms) : null), [roomFilter, rooms]);

  const categoryNodes = useMemo(() => categoryTree(categories), [categories]);
  const categoryFilterIds = useMemo(() => (category && category !== "none" ? categoryAndDescendants(category, categories) : null), [category, categories]);

  const tabItems = useMemo(
    () => items.filter((i) => (tab === "PAST" ? i.status === "SOLD" || i.status === "GIVEN_AWAY" : i.status === tab)),
    [items, tab],
  );

  const visible = useMemo(() => {
    const q = search.toLowerCase().trim();
    return tabItems
      .filter((i) => (category === "none" ? !i.categoryId || !categoryNodes.some((n) => n.category.id === i.categoryId) : !categoryFilterIds || (!!i.categoryId && categoryFilterIds.has(i.categoryId))))
      .filter((i) => !owner || ownerKeyOf(i) === owner)
      .filter((i) => (roomFilter === "none" ? !i.roomId : !roomFilterIds || (!!i.roomId && roomFilterIds.has(i.roomId))))
      .filter((i) => !lowOnly || !!i.lowStock)
      .filter((i) => {
        if (!q) return true;
        return [i.name, i.brand, i.notes, i.room, i.location, ...i.tags, i.summary, i.parentName, ...Object.values(i.details ?? {}).filter((v) => typeof v === "string")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
  }, [tabItems, category, categoryNodes, categoryFilterIds, owner, roomFilter, roomFilterIds, lowOnly, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Item[]>();
    for (const i of visible) {
      const k = i.categoryId && categoryNodes.some((n) => n.category.id === i.categoryId) ? i.categoryId : "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(i);
    }
    // Tree order; items without a category go last.
    const order = (id: string) => (id ? categoryNodes.findIndex((n) => n.category.id === id) : categoryNodes.length);
    return Array.from(groups.entries())
      .sort(([a], [b]) => order(a) - order(b))
      .map(([id, rows]) => ({
        id,
        label: categoryNodes.find((n) => n.category.id === id)?.path ?? "Uncategorized",
        rows: rows.sort(
          (a, b) =>
            (tab === "WISHLIST" ? Number(a.priority !== "MUST_HAVE") - Number(b.priority !== "MUST_HAVE") : 0) ||
            sizeRank(a.details?.size as string | undefined) - sizeRank(b.details?.size as string | undefined) ||
            a.name.localeCompare(b.name),
        ),
      }));
  }, [visible, tab, categoryNodes]);

  const wish = useMemo(() => wishlistSummary(visible), [visible]);
  const spent = useMemo(() => spentTotal(visible), [visible]);
  const lowCount = useMemo(() => items.filter((i) => i.lowStock).length, [items]);
  const hasAmmo = useMemo(() => visible.some((i) => i.detailType === "AMMO"), [visible]);
  // Nothing picked yet: the overview instead of every item.
  const browsing = tab === "OWNED" && !category && !owner && !roomFilter && !lowOnly && !search.trim() && !!overview;
  const filtered = tab === "OWNED" && !browsing;
  const subcategories = useMemo(() => {
    if (!category || category === "none") return [];
    return categoryNodes
      .filter((n) => n.category.parentId === category)
      .map((n) => {
        const ids = categoryAndDescendants(n.category.id, categories);
        return { id: n.category.id, name: n.category.name, n: tabItems.filter((i) => !!i.categoryId && ids.has(i.categoryId)).length };
      })
      .filter((c) => c.n > 0);
  }, [category, categoryNodes, categories, tabItems]);
  const parentCategory = category && category !== "none" ? categoryNodes.find((n) => n.category.id === category)?.category.parentId : null;

  function clearFilters() {
    setCategory("");
    setOwner("");
    setRoomFilter("");
    setLowOnly(false);
    setSearch("");
  }

  function pick(p: OverviewPick) {
    clearFilters();
    if (p.kind === "category") setCategory(p.key);
    else if (p.kind === "room") setRoomFilter(p.key);
    else if (p.kind === "owner") setOwner(p.key);
    else if (p.key === "LOW") {
      setTab("OWNED");
      setLowOnly(true);
    } else setTab(p.key as Tab);
  }

  function upsertLocal(item: Item) {
    setItems((prev) => (prev.some((i) => i.id === item.id) ? prev.map((i) => (i.id === item.id ? item : i)) : [...prev, item]));
  }

  async function adjustQuantity(item: Item, delta: number) {
    const r = await callOp(client, "adjust_inventory_quantity", { itemId: item.id, delta });
    if ("error" in r) return failed("Update failed", r.error);
    upsertLocal({ ...item, quantity: r.result.after, lowStock: r.result.restock?.lowStock ?? item.lowStock });
    if (r.result.restock?.addedToList) addToast({ title: `Running low: added to ${r.result.restock.addedToList}`, color: "warning" });
  }

  async function review(action: "approve" | "discard", list: Item[]) {
    if (action === "discard" && list.length > 1 && !confirm(`Discard ${list.length} drafts?`)) return;
    const r = await callOp(client, "review_inventory_drafts", { action, itemIds: list.map((i) => i.id) });
    if ("error" in r) return failed("Couldn't update drafts", r.error);
    const n = action === "approve" ? r.result.approved : r.result.discarded;
    addToast({ title: `${action === "approve" ? "Approved" : "Discarded"} ${n} item${n === 1 ? "" : "s"}`, color: action === "approve" ? "success" : "default" });
    await loadItems();
  }

  async function markOwned(item: Item) {
    const r = await callOp(client, "manage_inventory_item", { action: "mark_owned", itemId: item.id });
    if ("error" in r) return failed("Update failed", r.error);
    if (r.result.item) upsertLocal(r.result.item);
    addToast({ title: `${item.name} moved to Owned`, description: "Edit it to record a gift or the actual price.", color: "success" });
  }

  async function addToShoppingList(item: Item) {
    const listId = item.details?.shoppingListId as string | undefined;
    const list = lists.find((l) => l.id === listId) ?? lists.find((l) => /supermarket|grocer/i.test(l.name)) ?? lists[0];
    if (!list) {
      addToast({ title: "No shopping list to add to", color: "warning" });
      return;
    }
    const unit = item.details?.unit as string | undefined;
    const { errors } = await client.models.homeShoppingItem.create({
      listId: list.id,
      name: item.name,
      notes: `Low stock (${item.quantity ?? 0}${unit ? ` ${unit}` : ""} left)`,
      isChecked: false,
      addedBy: "inventory",
      sortOrder: 0,
    });
    if (errors?.length) return failed("Couldn't add to list", errors[0].message);
    addToast({ title: `Added to ${list.name}`, color: "success" });
  }

  function openNew() {
    setEditing(null);
    setDefaultRoom(roomFilter);
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
          <div className="flex gap-2">
            <Button size="sm" variant="flat" startContent={<FaFolderOpen />} onPress={() => setManagerOpen(true)}>
              Categories
            </Button>
            <Button size="sm" color="primary" startContent={<FaPlus />} onPress={openNew}>
              Add item
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-4">
          {TABS.map((t) => {
            const count = items.filter((i) => (t.key === "PAST" ? i.status === "SOLD" || i.status === "GIVEN_AWAY" : i.status === t.key)).length;
            if (t.key === "DRAFT" && count === 0 && tab !== "DRAFT") return null;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`px-3 py-1 rounded-full text-sm ${
                  tab === t.key ? "bg-primary text-primary-foreground" : t.key === "DRAFT" ? "bg-warning-100 text-warning-700" : "bg-default-100 text-default-600"
                }`}
              >
                {t.label} <span className="opacity-70">{count}</span>
              </button>
            );
          })}
          {lowCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setTab("OWNED");
                setLowOnly(!lowOnly);
              }}
              className={`px-3 py-1 rounded-full text-sm ${lowOnly ? "bg-warning text-warning-foreground" : "bg-warning-100 text-warning-700"}`}
            >
              {lowCount} running low
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2 mb-6">
          <Input
            size="sm"
            aria-label="Search"
            placeholder="Search name, brand, size, color, caliber, part number…"
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
            onChange={(e) => setCategory(e.target.value)}
            className="sm:max-w-[180px]"
          >
            {[
              ...categoryNodes.map((n) => <SelectItem key={n.category.id}>{n.path}</SelectItem>),
              <SelectItem key="none">Uncategorized</SelectItem>,
            ]}
          </Select>
          <Select size="sm" aria-label="Owner" placeholder="Everyone" selectedKeys={owner ? [owner] : []} onChange={(e) => setOwner(e.target.value)} className="sm:max-w-[200px]">
            {ownerOptions.map((o) => (
              <SelectItem key={o.key}>{o.label}</SelectItem>
            ))}
          </Select>
          {roomOptions.length > 0 && (
            <Select size="sm" aria-label="Room" placeholder="Any room" selectedKeys={roomFilter ? [roomFilter] : []} onChange={(e) => setRoomFilter(e.target.value)} className="sm:max-w-[220px]">
              {[
                ...roomOptions.map((o) => (
                  <SelectItem key={o.key} textValue={o.label}>
                    {o.label}
                    <span className="text-default-400 text-xs"> · {o.floor}</span>
                  </SelectItem>
                )),
                <SelectItem key="none">No room</SelectItem>,
              ]}
            </Select>
          )}
        </div>

        {filtered && (
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <button type="button" onClick={clearFilters} className="text-sm text-primary hover:underline">
              ← Overview
            </button>
            {parentCategory && (
              <button type="button" onClick={() => setCategory(parentCategory)} className="text-sm text-primary hover:underline">
                ← {categoryNodes.find((n) => n.category.id === parentCategory)?.category.name}
              </button>
            )}
            {subcategories.map((c) => (
              <button key={c.id} type="button" onClick={() => setCategory(c.id)} className="px-3 py-1 rounded-full text-sm bg-default-100 text-default-600 hover:bg-default-200">
                {c.name} <span className="opacity-70">{c.n}</span>
              </button>
            ))}
          </div>
        )}

        {/* Totals */}
        {!loading && tab === "DRAFT" && visible.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-2 rounded-md border border-warning-200 bg-warning-50 px-3 py-2">
            <p className="text-sm text-warning-800 flex-1 min-w-[200px]">
              {visible.length} item{visible.length === 1 ? "" : "s"} identified by Janet — check them, then approve. Drafts don&apos;t count in totals, the map or low-stock refills.
            </p>
            <Button size="sm" color="success" variant="flat" onPress={() => review("approve", visible)}>
              Approve all
            </Button>
            <Button size="sm" color="danger" variant="light" onPress={() => review("discard", visible)}>
              Discard all
            </Button>
          </div>
        )}
        {!loading && tab === "WISHLIST" && wish.count > 0 && (
          <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Items" value={String(wish.count)} />
            <Stat label="Estimated" value={formatUsd(wish.estimatedTotal)} />
            <Stat label="Must-haves" value={formatUsd(wish.mustHaveTotal)} />
            <Stat label="No price yet" value={String(wish.unpriced)} muted={wish.unpriced === 0} />
          </div>
        )}
        {!loading && filtered && hasAmmo && <AmmoPanel client={client} version={version} onChanged={() => void loadItems()} />}
        {!loading && filtered && spent > 0 && (
          <p className="mb-6 text-sm text-default-500">
            Spent on what&apos;s shown: <span className="font-semibold text-foreground">{formatUsd(spent)}</span>{" "}
            <span className="text-default-400">(gifts and hand-me-downs excluded)</span>
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner label="Loading inventory..." />
          </div>
        ) : browsing ? (
          <InventoryOverview
            overview={overview!}
            onPick={pick}
            onOpenItem={(id) => {
              const it = items.find((i) => i.id === id);
              if (!it) return;
              setEditing(it);
              setModalOpen(true);
            }}
          />
        ) : grouped.length === 0 ? (
          <div className="text-center py-12 text-default-400">
            <p>{tabItems.length === 0 ? `Nothing here yet.` : "No items match these filters."}</p>
            {tabItems.length === 0 && <p className="text-sm mt-1">Add items here, or tell Janet — “add a stroller to the baby wishlist, about $400”.</p>}
          </div>
        ) : (
          <div className="space-y-8">
            {grouped.map(({ id, label, rows }) => (
              <section key={id}>
                <h2 className="text-xs font-medium uppercase tracking-wider text-default-400 mb-2">
                  {label} · {rows.length}
                </h2>
                <div className="divide-y divide-default-100 border border-default-200 rounded-md bg-default-50">
                  {rows.map((i) => (
                    <ItemRow
                      key={i.id}
                      item={i}
                      ownerLabel={ownerLabel(i)}
                      onEdit={() => {
                        setEditing(i);
                        setModalOpen(true);
                      }}
                      onAdjust={(d) => adjustQuantity(i, d)}
                      onMarkOwned={() => markOwned(i)}
                      onApprove={() => review("approve", [i])}
                      onDiscard={() => review("discard", [i])}
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
        items={items}
        defaultStatus={tab === "WISHLIST" ? "WISHLIST" : "OWNED"}
        defaultCategory={category}
        categoryNodes={categoryNodes}
        defaultOwner={owner || HOUSEHOLD}
        ownerOptions={ownerOptions}
        roomOptions={roomOptions}
        defaultRoom={defaultRoom}
        lists={lists}
        onSaved={() => void loadItems()}
      />
      <CategoryManager isOpen={managerOpen} onClose={() => setManagerOpen(false)} client={client} categories={categories} items={items} onChanged={loadAll} />
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
  ownerLabel,
  onEdit,
  onAdjust,
  onMarkOwned,
  onAddToList,
  onApprove,
  onDiscard,
}: {
  item: Item;
  ownerLabel: string;
  onEdit: () => void;
  onAdjust: (delta: number) => void;
  onMarkOwned: () => void;
  onApprove: () => void;
  onDiscard: () => void;
  onAddToList: () => void;
}) {
  const consumable = item.detailType === "CONSUMABLE";
  const qty = item.quantity ?? 1;
  const price = item.status === "WISHLIST" ? item.estimatedPrice : item.pricePaid;

  const chips: string[] = [];
  if (item.summary && !consumable) chips.push(item.summary);
  if (item.brand) chips.push(item.brand);
  if (item.parentName) chips.push(`on ${item.parentName}`);
  if (item.partCount) chips.push(`${item.partCount} part${item.partCount === 1 ? "" : "s"}`);
  if (item.acquiredVia && item.acquiredVia !== "PURCHASED") {
    const via = ACQUIRED_VIA_LABELS[item.acquiredVia as keyof typeof ACQUIRED_VIA_LABELS] ?? item.acquiredVia;
    chips.push(item.giftFrom ? `${via} from ${item.giftFrom}` : via);
  }
  for (const t of item.tags) chips.push(`#${t}`);

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      {item.imageKeys[0] ? (
        <button type="button" onClick={onEdit} className="shrink-0" aria-label="Open photo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl(item.imageKeys[0], 96)} alt="" loading="lazy" className="w-10 h-10 rounded object-cover bg-default-100" />
        </button>
      ) : null}
      <button type="button" onClick={onEdit} className="flex-1 min-w-0 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{item.name}</span>
          {item.private && <FaLock size={10} className="text-default-400" title="Only you can see this" />}
          {item.status === "WISHLIST" && item.priority === "MUST_HAVE" && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-100 text-primary-700">Must have</span>}
          {item.lowStock && <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-100 text-warning-700">Low</span>}
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-default-400 hover:text-primary" aria-label="Open link">
              <FaExternalLinkAlt size={10} />
            </a>
          )}
        </div>
        <p className="text-xs text-default-500 truncate">
          {[ownerLabel, ...chips, [item.room, item.location].filter(Boolean).join(": ")].filter(Boolean).join(" · ")}
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
            {item.details?.unit ? <span className="text-[10px] text-default-400 block leading-none">{String(item.details.unit)}</span> : null}
          </span>
          <Button isIconOnly size="sm" variant="light" aria-label="One more" onPress={() => onAdjust(1)}>
            <FaPlus size={10} />
          </Button>
          {item.lowStock && (
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
      {item.status === "DRAFT" && (
        <div className="flex gap-1 shrink-0">
          <Button size="sm" variant="flat" color="success" onPress={onApprove}>
            Approve
          </Button>
          <Button size="sm" variant="light" color="danger" onPress={onDiscard}>
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Add / edit modal ─────────────────────────────────────────────────────

function ItemModal({
  isOpen,
  onClose,
  editing,
  items,
  defaultStatus,
  defaultCategory,
  categoryNodes,
  defaultOwner,
  ownerOptions,
  roomOptions,
  defaultRoom,
  lists,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  editing: Item | null;
  items: Item[];
  defaultStatus: InventoryStatus;
  defaultCategory: string;
  categoryNodes: CategoryNode<Category>[];
  defaultOwner: string;
  ownerOptions: { key: string; label: string }[];
  roomOptions: RoomOption[];
  defaultRoom: string;
  lists: ShoppingList[];
  onSaved: () => void;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Presign → PUT straight to S3 (home/inventory/) → keep the key. The
  // item gets the keys on Save, so this works for new items too.
  async function uploadPhotos(files: FileList) {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const contentType = file.type || "image/jpeg";
        const urlRes = await fetch("/api/documents/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType, prefix: "inventory" }),
        });
        if (!urlRes.ok) {
          const err = await urlRes.json().catch(() => ({}));
          throw new Error(err.error ?? `Upload URL failed: ${urlRes.status}`);
        }
        const { uploadUrl, s3key } = await urlRes.json();
        const putRes = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
        if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
        setPhotos((prev) => [...prev, s3key]);
      }
    } catch (err: any) {
      addToast({ title: "Photo upload failed", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setUploading(false);
    }
  }
  const set = (k: string) => (v: string) => setF((prev) => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (!isOpen) return;
    const e = editing;
    const s = (v: unknown) => (v == null ? "" : String(v));
    setPhotos(e?.imageKeys ?? []);
    setDetails(Object.fromEntries(Object.entries(e?.details ?? {}).map(([k, v]) => [k, s(v)])));
    setF({
      name: s(e?.name),
      categoryId: e ? s(e.categoryId) : defaultCategory,
      status: s(e?.status ?? defaultStatus),
      owner: e ? ownerKeyOf(e) : defaultOwner,
      roomId: e ? s(e.roomId) : defaultRoom,
      parentItemId: s(e?.parentItemId),
      brand: s(e?.brand),
      quantity: s(e?.quantity ?? 1),
      location: s(e?.location),
      tags: (e?.tags ?? []).join(", "),
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
    });
  }, [isOpen, editing, defaultStatus, defaultCategory, defaultOwner, defaultRoom]);

  const detailType = (categoryNodes.find((n) => n.category.id === f.categoryId)?.detailType ?? null) as DetailType | null;
  const isPrivate = !!detailSpec(detailType)?.private;
  const num = (k: string) => (f[k]?.trim() && !Number.isNaN(Number(f[k])) ? Number(f[k]) : null);
  // A part can go on anything else that's still around (not itself or its own parts).
  const parentOptions = useMemo(
    () => items.filter((i) => i.id !== editing?.id && i.parentItemId !== editing?.id && i.status !== "SOLD" && i.status !== "GIVEN_AWAY").sort((a, b) => a.name.localeCompare(b.name)),
    [items, editing],
  );

  async function save() {
    if (!f.name?.trim()) {
      addToast({ title: "Name is required", color: "warning" });
      return;
    }
    if (!f.categoryId && !editing) {
      addToast({ title: "Pick a category", color: "warning" });
      return;
    }
    setSaving(true);
    try {
      const status = f.status as Exclude<InventoryStatus, "DRAFT">;
      const r = await callOp(client, "manage_inventory_item", {
        action: editing ? "update" : "create",
        ...(editing ? { itemId: editing.id } : {}),
        name: f.name.trim(),
        categoryId: f.categoryId || null,
        ...(editing?.status === "DRAFT" && status === ("DRAFT" as string) ? {} : { status }),
        // Owner-only types always belong to whoever saves them.
        ...(isPrivate ? {} : { ownerName: f.owner || HOUSEHOLD }),
        roomId: f.roomId || null,
        partOf: f.parentItemId || "",
        imageKeys: photos,
        brand: f.brand,
        quantity: Math.max(0, Math.round(num("quantity") ?? 1)),
        location: f.location,
        tags: f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        notes: f.notes,
        url: f.url,
        priority: (f.priority || null) as "MUST_HAVE" | "NICE_TO_HAVE" | null,
        neededBy: f.neededBy,
        estimatedPrice: num("estimatedPrice"),
        acquiredVia: (f.acquiredVia || null) as "PURCHASED" | "GIFT" | "HAND_ME_DOWN" | null,
        giftFrom: f.giftFrom,
        vendor: f.vendor,
        acquiredAt: f.acquiredAt || (status === "OWNED" && editing?.status !== "OWNED" ? todayYmd() : ""),
        pricePaid: num("pricePaid"),
        priceSold: num("priceSold"),
        ...(detailType ? { details: Object.fromEntries(DETAIL_SPECS[detailType].fields.map((fl) => [fl.key, details[fl.key] ?? ""])) } : {}),
      });
      if ("error" in r) throw new Error(r.error);
      if (r.result.restock?.addedToList) addToast({ title: `Running low: added to ${r.result.restock.addedToList}`, color: "warning" });
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
      const r = await callOp(client, "manage_inventory_item", { action: "delete", itemId: editing.id });
      if ("error" in r) throw new Error(r.error);
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
  const quantityLabel = detailType === "AMMO" ? `Quantity (${(DETAIL_SPECS.AMMO.fields[1].optionLabels?.[details.unit ?? ""] ?? "units").toLowerCase()})` : detailType === "FILAMENT" ? "Spools" : "Quantity";

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{editing ? "Edit item" : "Add item"}</ModalHeader>
        <ModalBody className="gap-3">
          <Input label="Name" value={f.name ?? ""} onValueChange={set("name")} isRequired autoFocus={!editing} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Select label="Category" placeholder="Pick one" selectedKeys={f.categoryId ? [f.categoryId] : []} onChange={(e) => set("categoryId")(e.target.value)} isRequired={!editing}>
              {categoryNodes.map((n) => (
                <SelectItem key={n.category.id}>{n.path}</SelectItem>
              ))}
            </Select>
            <Select label="Status" selectedKeys={f.status ? [f.status] : []} onChange={(e) => e.target.value && set("status")(e.target.value)}>
              {INVENTORY_STATUSES.filter((s) => s !== "DRAFT" || editing?.status === "DRAFT").map((s) => (
                <SelectItem key={s}>{INVENTORY_STATUS_LABELS[s]}</SelectItem>
              ))}
            </Select>
            {isPrivate ? (
              <Input label="Belongs to" value="You" isReadOnly startContent={<FaLock size={11} className="text-default-400" />} description="Only you can see it" />
            ) : (
              <Select label="Belongs to" selectedKeys={f.owner ? [f.owner] : []} onChange={(e) => e.target.value && set("owner")(e.target.value)}>
                {ownerOptions.map((o) => (
                  <SelectItem key={o.key}>{o.label}</SelectItem>
                ))}
              </Select>
            )}
          </div>

          {detailType && (
            <div>
              <p className="text-xs text-default-500 mb-1">{DETAIL_SPECS[detailType].label} details</p>
              <DetailFields type={detailType} values={details} onChange={(k, v) => setDetails((prev) => ({ ...prev, [k]: v }))} lists={lists} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Input label="Brand" value={f.brand ?? ""} onValueChange={set("brand")} />
            <Input label={quantityLabel} type="number" min={0} value={f.quantity ?? ""} onValueChange={set("quantity")} />
          </div>
          {parentOptions.length > 0 && (
            <Select
              label="Part of / installed on"
              placeholder="Nothing (a standalone item)"
              selectedKeys={f.parentItemId ? [f.parentItemId] : []}
              onChange={(e) => set("parentItemId")(e.target.value)}
              description="An optic on a rifle, pickups in a guitar: it shows on that item and adds to its value"
            >
              {parentOptions.map((i) => (
                <SelectItem key={i.id} textValue={i.name}>
                  {i.name}
                  {i.category && <span className="text-default-400 text-xs"> · {i.category}</span>}
                </SelectItem>
              ))}
            </Select>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {roomOptions.length > 0 ? (
              <Select label="Room" placeholder="Not set" selectedKeys={f.roomId ? [f.roomId] : []} onChange={(e) => set("roomId")(e.target.value)}>
                {roomOptions.map((o) => (
                  <SelectItem key={o.key} textValue={o.label}>
                    {o.label}
                    <span className="text-default-400 text-xs"> · {o.floor}</span>
                  </SelectItem>
                ))}
              </Select>
            ) : null}
            <Input
              label={roomOptions.length > 0 ? "Where in the room" : "Location"}
              placeholder={roomOptions.length > 0 ? "Over the closet, gray box" : "Nursery closet"}
              value={f.location ?? ""}
              onValueChange={set("location")}
            />
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
              <Select label="Priority" selectedKeys={f.priority ? [f.priority] : []} onChange={(e) => set("priority")(e.target.value)}>
                {(Object.keys(PRIORITY_LABELS) as (keyof typeof PRIORITY_LABELS)[]).map((p) => (
                  <SelectItem key={p}>{PRIORITY_LABELS[p]}</SelectItem>
                ))}
              </Select>
              <DateInput label="Needed by" value={f.neededBy ?? ""} onChange={set("neededBy")} />
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Select label="Got it as" selectedKeys={f.acquiredVia ? [f.acquiredVia] : []} onChange={(e) => set("acquiredVia")(e.target.value)}>
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

          {editing && editing.partCount > 0 && (
            <div className="text-xs text-default-500">
              <p className="mb-1">Parts installed on it</p>
              <ul className="space-y-0.5">
                {items
                  .filter((i) => i.parentItemId === editing.id)
                  .map((p) => (
                    <li key={p.id}>
                      {p.name}
                      {p.pricePaid != null && <span className="text-default-400"> · {formatUsd(p.pricePaid)}</span>}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-default-500">Photos</p>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void uploadPhotos(e.target.files);
                  e.target.value = ""; // picking the same file again still fires
                }}
              />
              <Button size="sm" variant="flat" startContent={<FaCamera size={11} />} isLoading={uploading} onPress={() => photoInputRef.current?.click()}>
                Add photo
              </Button>
            </div>
            {photos.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {photos.map((k) => (
                  <div key={k} className="relative">
                    <a href={originalPhotoUrl(k)} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photoUrl(k, 320)} alt="" className="h-28 rounded object-cover bg-default-100" />
                    </a>
                    <button
                      type="button"
                      onClick={() => setPhotos((prev) => prev.filter((x) => x !== k))}
                      className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-white"
                      aria-label="Remove photo from this item"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
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
