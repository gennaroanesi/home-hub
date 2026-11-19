// Reading and writing inventory items across their two tables and their
// detail models (docs/inventory-specialized.md). Items of an owner-only
// detail type (firearms, ammo) live in homePrivateInventoryItem, the rest
// in homeInventoryItem; everything here takes either, so callers never
// pick a table themselves. Takes the Amplify data client as `any` so the
// browser and the Lambdas both fit.
//
// Visibility: AppSync already limits a signed-in user to their own private
// rows, but a Lambda sees every row. `viewer` is the Cognito username
// whose private rows to include (null = none); the ops pass the caller's.

import { categoryTree, type CategoryNode } from "./inventory";
import { DETAIL_SPECS, DETAIL_TYPES, detailSpec, pickDetailFields, type DetailType } from "./inventory-details";
import { listAllPages } from "./list-all";

/* eslint-disable @typescript-eslint/no-explicit-any */
type DataClient = any;

export type ItemTable = "household" | "private";
export const ITEM_MODELS: Record<ItemTable, string> = { household: "homeInventoryItem", private: "homePrivateInventoryItem" };

export type StoreItem = Record<string, any> & { id: string; name: string; table: ItemTable };
export interface StoreDetail {
  type: DetailType;
  row: Record<string, any>; // includes id, itemId
}

export interface InventoryStore {
  items: StoreItem[];
  /** itemId → its detail row (the type its category says, or whichever exists). */
  details: Map<string, StoreDetail>;
  categories: any[];
  nodes: Map<string, CategoryNode<any>>;
}

/** The detail type an item's category gives it (own or inherited), or null. */
export function detailTypeOfCategory(nodes: Map<string, CategoryNode<any>>, categoryId: string | null | undefined): DetailType | null {
  return (categoryId ? nodes.get(categoryId)?.detailType : null) ?? null;
}

/** Which table an item in this category belongs in. */
export function tableForCategory(nodes: Map<string, CategoryNode<any>>, categoryId: string | null | undefined): ItemTable {
  return detailSpec(detailTypeOfCategory(nodes, categoryId))?.private ? "private" : "household";
}

export async function loadInventoryStore(client: DataClient, opts: { viewer: string | null }): Promise<InventoryStore> {
  const mine = (row: any) => !!opts.viewer && row.ownerUsername === opts.viewer;
  const privateModels = DETAIL_TYPES.filter((t) => DETAIL_SPECS[t].private);
  const [household, priv, categories, ...detailRows] = await Promise.all([
    listAllPages<any>(client.models.homeInventoryItem),
    opts.viewer && client.models.homePrivateInventoryItem ? listAllPages<any>(client.models.homePrivateInventoryItem) : Promise.resolve([]),
    listAllPages<any>(client.models.homeInventoryCategory),
    ...DETAIL_TYPES.map((t) => {
      const model = client.models[DETAIL_SPECS[t].model];
      if (!model || (privateModels.includes(t) && !opts.viewer)) return Promise.resolve([] as any[]);
      return listAllPages<any>(model);
    }),
  ]);
  const items: StoreItem[] = [
    ...household.map((i: any) => ({ ...i, table: "household" as const })),
    ...priv.filter(mine).map((i: any) => ({ ...i, table: "private" as const })),
  ];
  const nodes = new Map(categoryTree(categories).map((n) => [n.category.id, n]));
  const ids = new Set(items.map((i) => i.id));
  const details = new Map<string, StoreDetail>();
  DETAIL_TYPES.forEach((type, k) => {
    for (const row of detailRows[k]) {
      if (!ids.has(row.itemId)) continue;
      if (DETAIL_SPECS[type].private && !mine(row)) continue;
      // Prefer the row matching the item's current category type.
      const item = items.find((i) => i.id === row.itemId)!;
      const want = detailTypeOfCategory(nodes, item.categoryId);
      const have = details.get(row.itemId);
      if (!have || (have.type !== want && type === want)) details.set(row.itemId, { type, row });
    }
  });
  return { items, details, categories, nodes };
}

const strip = (row: Record<string, any>) => {
  const { id: _id, table: _t, createdAt: _c, updatedAt: _u, __typename: _n, owner: _o, ...rest } = row;
  return rest;
};

/** Create an item in the table its category calls for. */
export async function createItem(client: DataClient, table: ItemTable, fields: Record<string, any>, ownerUsername: string | null): Promise<StoreItem> {
  if (table === "private" && !ownerUsername) throw new Error("A private item needs its owner's login");
  const r = await client.models[ITEM_MODELS[table]].create({ ...fields, ...(table === "private" ? { ownerUsername } : {}) });
  if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Create failed");
  return { ...r.data, table };
}

export async function updateItem(client: DataClient, item: StoreItem, fields: Record<string, any>): Promise<StoreItem> {
  const r = await client.models[ITEM_MODELS[item.table]].update({ id: item.id, ...fields });
  if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Update failed");
  return { ...r.data, table: item.table };
}

/**
 * Write an item's detail fields for `type`: updates its row, or creates
 * one. `fields` holds only what changes (spec keys). Private types stamp
 * the owner's username so the owner rule lets them see it.
 */
export async function upsertDetail(
  client: DataClient,
  itemId: string,
  type: DetailType,
  existing: StoreDetail | undefined,
  fields: Record<string, unknown>,
  ownerUsername: string | null,
): Promise<StoreDetail> {
  const spec = DETAIL_SPECS[type];
  const model = client.models[spec.model];
  const stamp = spec.private ? { ownerUsername } : {};
  if (existing && existing.type === type) {
    if (Object.keys(fields).length === 0) return existing;
    const r = await model.update({ id: existing.row.id, ...fields, ...stamp });
    if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Detail update failed");
    return { type, row: r.data };
  }
  const r = await model.create({ itemId, ...fields, ...stamp });
  if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Detail create failed");
  return { type, row: r.data };
}

/** Delete every detail row an item has, in any detail model. */
export async function deleteDetails(client: DataClient, itemId: string): Promise<void> {
  for (const t of DETAIL_TYPES) {
    const model = client.models[DETAIL_SPECS[t].model];
    if (!model) continue;
    const rows = await listAllPages<any>(model, { filter: { itemId: { eq: itemId } } });
    for (const row of rows) await model.delete({ id: row.id });
  }
}

export async function deleteItem(client: DataClient, item: Pick<StoreItem, "id" | "table">): Promise<void> {
  await deleteDetails(client, item.id);
  const r = await client.models[ITEM_MODELS[item.table]].delete({ id: item.id });
  if (r.errors?.length) throw new Error(r.errors[0].message);
}

/**
 * Move an item to the other table (its category changed between a private
 * and a household type). It gets a new id; parts pointing at it follow, and
 * its detail row is rewritten for the new type by the caller.
 */
export async function moveItemTable(client: DataClient, item: StoreItem, to: ItemTable, ownerUsername: string | null, parts: StoreItem[]): Promise<StoreItem> {
  const fields = strip(item);
  delete fields.ownerUsername;
  if (to === "household") delete (fields as any).ownerUsername;
  const moved = await createItem(client, to, fields, ownerUsername);
  const old = await loadDetailsFor(client, item.id);
  for (const d of old) {
    const spec = DETAIL_SPECS[d.type];
    // Only carry a detail row across when its model is allowed in the new table.
    if (spec.private === (to === "private")) await client.models[spec.model].create({ ...pickDetailFields(d.type, d.row), itemId: moved.id, ...(spec.private ? { ownerUsername } : {}) });
  }
  for (const p of parts) await updateItem(client, p, { parentItemId: moved.id });
  await deleteItem(client, item);
  return moved;
}

async function loadDetailsFor(client: DataClient, itemId: string): Promise<StoreDetail[]> {
  const out: StoreDetail[] = [];
  for (const t of DETAIL_TYPES) {
    const model = client.models[DETAIL_SPECS[t].model];
    if (!model) continue;
    const rows = await listAllPages<any>(model, { filter: { itemId: { eq: itemId } } });
    for (const row of rows) out.push({ type: t, row });
  }
  return out;
}
