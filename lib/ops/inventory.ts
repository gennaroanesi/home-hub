// Inventory categories: an editable tree. Items point at one with categoryId;
// the item tools themselves are still legacy agent tools.

import { z } from "zod/v4";
import { CATEGORY_DETAIL_TYPES, categoryAndDescendants, categoryTree, type CategoryNode } from "../inventory";
import { listAllPages } from "../list-all";
import type { OpContext } from "./context";
import { OpError, defineOp } from "./define";

const CategoryOut = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string().describe('Full path, e.g. "Clothing › Baby"'),
  parentId: z.string().nullable(),
  depth: z.number().describe("0 = top level"),
  detailType: z.enum(CATEGORY_DETAIL_TYPES).nullable().describe("Own or inherited: which extra fields its items have"),
  sortOrder: z.number(),
  itemCount: z.number().describe("Items here and in its subcategories"),
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const allCategories = (ctx: OpContext) => listAllPages<any>(ctx.client.models.homeInventoryCategory);
const allItems = (ctx: OpContext) => listAllPages<any>(ctx.client.models.homeInventoryItem);

function categoryForApi(node: CategoryNode<any>, categories: any[], items: any[]): z.infer<typeof CategoryOut> {
  const ids = categoryAndDescendants(node.category.id, categories);
  return {
    id: node.category.id,
    name: node.category.name,
    path: node.path,
    parentId: node.category.parentId ?? null,
    depth: node.depth,
    detailType: node.detailType,
    sortOrder: node.category.sortOrder ?? 0,
    itemCount: items.filter((i) => i.categoryId && ids.has(i.categoryId)).length,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function refuseSiblingDuplicate(categories: { id: string; name: string; parentId?: string | null }[], id: string | undefined, name: string, parentId: string | null) {
  const dup = categories.find((c) => c.id !== id && (c.parentId ?? null) === parentId && c.name.trim().toLowerCase() === name.toLowerCase());
  if (dup) throw new OpError(`There's already a category called "${dup.name}" there`);
}

export const listInventoryCategories = defineOp({
  name: "list_inventory_categories",
  domain: "inventory",
  access: "read",
  description:
    "List the household's inventory categories as a tree, in display order, with each one's full path and item count. Categories are editable and can be nested (e.g. Clothing › Baby). Use it to see which categories exist before filing an item or changing a category.",
  input: z.object({}),
  output: z.object({ categories: z.array(CategoryOut) }),
  async run(ctx) {
    const [categories, items] = await Promise.all([allCategories(ctx), allItems(ctx)]);
    return { categories: categoryTree(categories).map((n) => categoryForApi(n, categories, items)) };
  },
});

export const saveInventoryCategory = defineOp({
  name: "save_inventory_category",
  domain: "inventory",
  access: "write",
  description:
    "Create an inventory category or change one. Without categoryId it creates one (name required), at the top level unless parentId is given. With categoryId it updates what's given: name renames it, parentId moves it with its subcategories (null makes it top level), sortOrder sets its place among its siblings. Subcategories inherit detailType, so it's only needed on a top-level category whose items need clothing or consumable fields. Items stay in the category when it's renamed or moved. Find ids with list_inventory_categories.",
  input: z.object({
    categoryId: z.string().optional().describe("Category to update. Leave out to create."),
    name: z.string().optional(),
    parentId: z.string().nullable().optional().describe("Parent category; null = top level."),
    detailType: z.enum(CATEGORY_DETAIL_TYPES).nullable().optional().describe("Extra fields its items have; null = none of its own."),
    sortOrder: z.number().int().optional(),
  }),
  output: z.object({ action: z.enum(["created", "updated"]), category: CategoryOut }),
  async run(ctx, input) {
    const name = input.name?.trim();
    if (input.name !== undefined && !name) throw new OpError("A category needs a name");
    const categories = await allCategories(ctx);
    const existing = input.categoryId ? categories.find((c) => c.id === input.categoryId) : undefined;
    if (input.categoryId && !existing) throw new OpError(`No category ${input.categoryId}. Use list_inventory_categories to find the id.`);
    if (input.parentId && !categories.some((c) => c.id === input.parentId)) throw new OpError(`No parent category ${input.parentId}`);

    let saved;
    let action: "created" | "updated";
    if (existing) {
      if (input.parentId && categoryAndDescendants(existing.id, categories).has(input.parentId)) {
        throw new OpError("A category can't move inside itself or one of its subcategories");
      }
      const parentId = input.parentId === undefined ? (existing.parentId ?? null) : input.parentId;
      refuseSiblingDuplicate(categories, existing.id, name ?? existing.name, parentId);
      const r = await ctx.client.models.homeInventoryCategory.update({
        id: existing.id,
        ...(name ? { name } : {}),
        ...(input.parentId !== undefined ? { parentId } : {}),
        ...(input.detailType !== undefined ? { detailType: input.detailType } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      saved = r.data;
      action = "updated";
    } else {
      if (!name) throw new OpError("name is required to create a category");
      const parentId = input.parentId ?? null;
      refuseSiblingDuplicate(categories, undefined, name, parentId);
      const r = await ctx.client.models.homeInventoryCategory.create({
        name,
        parentId,
        detailType: input.detailType ?? null,
        sortOrder: input.sortOrder ?? categories.filter((c) => (c.parentId ?? null) === parentId).length,
      });
      if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "Save failed");
      saved = r.data;
      action = "created";
    }

    const after = [...categories.filter((c) => c.id !== saved.id), saved];
    const node = categoryTree(after).find((n) => n.category.id === saved.id);
    return { action, category: categoryForApi(node!, after, await allItems(ctx)) };
  },
});

export const deleteInventoryCategory = defineOp({
  name: "delete_inventory_category",
  domain: "inventory",
  access: "write",
  description:
    "Delete an inventory category without losing anything. Its items move to moveToCategoryId, or to its parent when that's left out; a top-level category that has items needs moveToCategoryId. Its subcategories move up to its parent.",
  input: z.object({
    categoryId: z.string(),
    moveToCategoryId: z.string().optional().describe("Where its items go. Default: its parent."),
  }),
  output: z.object({
    deleted: z.string(),
    itemsMoved: z.number(),
    subcategoriesMoved: z.number(),
  }),
  async run(ctx, input) {
    const [categories, items] = await Promise.all([allCategories(ctx), allItems(ctx)]);
    const category = categories.find((c) => c.id === input.categoryId);
    if (!category) throw new OpError(`No category ${input.categoryId}. Use list_inventory_categories to find the id.`);
    if (input.moveToCategoryId) {
      if (!categories.some((c) => c.id === input.moveToCategoryId)) throw new OpError(`No category ${input.moveToCategoryId}`);
      if (input.moveToCategoryId === category.id) throw new OpError("Items can't move to the category being deleted");
    }
    const target = input.moveToCategoryId ?? category.parentId ?? null;
    const own = items.filter((i) => i.categoryId === category.id);
    if (own.length && !target) {
      throw new OpError(`"${category.name}" has ${own.length} item${own.length === 1 ? "" : "s"}. Pass moveToCategoryId to say where they go.`, { itemCount: own.length });
    }
    const children = categories.filter((c) => c.parentId === category.id);
    for (let i = 0; i < own.length; i += 25) {
      await Promise.all(
        own.slice(i, i + 25).map(async (item) => {
          const r = await ctx.client.models.homeInventoryItem.update({ id: item.id, categoryId: target });
          if (r.errors?.length) throw new Error(r.errors[0].message);
        }),
      );
    }
    for (const child of children) {
      const r = await ctx.client.models.homeInventoryCategory.update({ id: child.id, parentId: category.parentId ?? null });
      if (r.errors?.length) throw new Error(r.errors[0].message);
    }
    const r = await ctx.client.models.homeInventoryCategory.delete({ id: category.id });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    return { deleted: category.name, itemsMoved: own.length, subcategoriesMoved: children.length };
  },
});

export const inventoryOps = [listInventoryCategories, saveInventoryCategory, deleteInventoryCategory];
