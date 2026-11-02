/**
 * Creates the top-level inventory categories for the old fixed list and
 * points every item without a categoryId at the one for its old category.
 * Safe to run again. Prints the plan and stops unless --yes.
 *
 * Usage:
 *   npx tsx scripts/inventory-categories-backfill.ts <amplify_outputs.json> [--yes]
 *
 * Signs in with PRD_USER / PRD_PASS from the environment.
 */

import { readFile } from "node:fs/promises";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";
import { planCategoryBackfill } from "../lib/inventory";
import { listAllPages } from "../lib/list-all";

type Category = Schema["homeInventoryCategory"]["type"];
type Item = Schema["homeInventoryItem"]["type"];

async function main() {
  const outputsPath = process.argv[2];
  if (!outputsPath || outputsPath.startsWith("--")) throw new Error("Usage: inventory-categories-backfill.ts <amplify_outputs.json> [--yes]");
  const apply = process.argv.includes("--yes");
  const { PRD_USER, PRD_PASS } = process.env;
  if (!PRD_USER || !PRD_PASS) throw new Error("PRD_USER and PRD_PASS must be set");

  Amplify.configure(JSON.parse(await readFile(outputsPath, "utf8")));
  await signOut().catch(() => {});
  await signIn({ username: PRD_USER, password: PRD_PASS });
  const client = generateClient<Schema>({ authMode: "userPool" });

  const categories = await listAllPages<Category>(client.models.homeInventoryCategory);
  const items = await listAllPages<Item>(client.models.homeInventoryItem);
  const plan = planCategoryBackfill(categories, items);

  console.log(`${categories.length} categories, ${items.length} items`);
  console.log(`To create: ${plan.createCategories.map((c) => c.name).join(", ") || "none"}`);
  const counts = new Map<string, number>();
  for (const m of plan.moves) counts.set(m.categoryName, (counts.get(m.categoryName) ?? 0) + 1);
  console.log(`Items to link: ${plan.moves.length}`);
  counts.forEach((n, name) => console.log(`  ${name}: ${n}`));
  if (!apply) {
    console.log("Dry run. Re-run with --yes to write.");
    return;
  }

  const idByName = new Map(categories.filter((c) => !c.parentId).map((c) => [c.name.toLowerCase(), c.id]));
  for (const c of plan.createCategories) {
    const r = await client.models.homeInventoryCategory.create({ ...c, parentId: null });
    if (r.errors?.length || !r.data) throw new Error(`Creating ${c.name}: ${r.errors?.[0]?.message}`);
    idByName.set(c.name.toLowerCase(), r.data.id);
  }
  let failed = 0;
  for (const m of plan.moves) {
    const r = await client.models.homeInventoryItem.update({ id: m.itemId, categoryId: idByName.get(m.categoryName.toLowerCase())! });
    if (r.errors?.length) {
      failed++;
      console.error(`${m.itemId}: ${r.errors[0].message}`);
    }
  }
  console.log(`Done: ${plan.createCategories.length} categories created, ${plan.moves.length - failed} items linked, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
