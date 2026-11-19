// What the phone's inventory screens need besides the items: categories
// (list_inventory_categories), shopping lists, rooms with their
// "Room › Closet" labels, and who things can belong to (the household,
// its members, active pets). Loaded once per app session and shared.

import { useEffect, useState } from "react";
import { router } from "expo-router";

import { getClient } from "../../lib/amplify";
import { callOp } from "../../lib/ops";
import { householdMembers } from "../../lib/household";
import { roomLabel } from "../../../lib/floorplan";
import { listAllPages } from "../../../lib/list-all";
import type { InventoryCategory } from "./ItemFormModal";

export interface InventoryRefs {
  categories: InventoryCategory[];
  lists: Array<{ id: string; name: string }>;
  rooms: Array<{ id: string; label: string }>;
  owners: Array<{ key: string; label: string }>;
}

const EMPTY: InventoryRefs = { categories: [], lists: [], rooms: [], owners: [{ key: "household", label: "Household" }] };
let cache: InventoryRefs | null = null;
let inflight: Promise<InventoryRefs> | null = null;

const PET_EMOJI: Record<string, string> = { DOG: "🐶", CAT: "🐱" };

async function loadRefs(): Promise<InventoryRefs> {
  const client: any = getClient(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [cats, lists, rooms, people, pets] = await Promise.all([
    callOp("list_inventory_categories", {}),
    listAllPages<any>(client.models.homeShoppingList), // eslint-disable-line @typescript-eslint/no-explicit-any
    client.models.homeRoom ? listAllPages<any>(client.models.homeRoom) : Promise.resolve([]), // eslint-disable-line @typescript-eslint/no-explicit-any
    listAllPages<any>(client.models.homePerson), // eslint-disable-line @typescript-eslint/no-explicit-any
    client.models.homePet ? listAllPages<any>(client.models.homePet) : Promise.resolve([]), // eslint-disable-line @typescript-eslint/no-explicit-any
  ]);
  const byId = new Map(rooms.map((r: any) => [r.id, r])); // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    categories: "error" in cats ? [] : cats.result.categories,
    lists: lists.filter((l: any) => !l.isArchived).map((l: any) => ({ id: l.id, name: `${l.emoji ?? ""} ${l.name}`.trim() })), // eslint-disable-line @typescript-eslint/no-explicit-any
    rooms: rooms.map((r: any) => ({ id: r.id, label: roomLabel(r, byId as any) })).sort((a: any, b: any) => a.label.localeCompare(b.label)), // eslint-disable-line @typescript-eslint/no-explicit-any
    owners: [
      { key: "household", label: "Household" },
      ...householdMembers(people).map((p: any) => ({ key: p.id, label: p.name })), // eslint-disable-line @typescript-eslint/no-explicit-any
      ...pets.filter((p: any) => p.active !== false).map((p: any) => ({ key: `pet:${p.id}`, label: `${PET_EMOJI[p.species ?? ""] ?? "🐾"} ${p.name}` })), // eslint-disable-line @typescript-eslint/no-explicit-any
    ],
  };
}

/** Refetch next time (after a category change). */
export function forgetInventoryRefs() {
  cache = null;
}

export function useInventoryRefs(): InventoryRefs {
  const [refs, setRefs] = useState<InventoryRefs>(cache ?? EMPTY);
  useEffect(() => {
    if (cache) return;
    inflight ??= loadRefs().finally(() => {
      inflight = null;
    });
    inflight.then(
      (r) => {
        cache = r;
        setRefs(r);
      },
      () => {},
    );
  }, []);
  return refs;
}

/** Push an item's page. The cast: expo-router's generated route types only learn new files on the next `expo start`. */
export function openInventoryItem(id: string) {
  router.push({ pathname: "/more/inventory/[id]", params: { id } } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
}
