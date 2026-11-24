// One-time: fill the finance category tree (homeFinanceCategory) from the
// categories already in use: the vocabulary (rules, budget lines, the legacy
// `categories` setting) plus every category on transactions (and their
// itemized lines), scheduled transactions and invoices. "Parent: Child"
// paths become nested rows. Safe to re-run: only missing paths are added.
//
//   npx tsx scripts/finance-categories-backfill.ts --outputs <prod amplify_outputs.json> [--yes]
//
// Signs in with PRD_USER / PRD_PASS from .env.local. Without --yes it only
// prints what it would create.

import { readFileSync } from "node:fs";
import { Amplify } from "aws-amplify";
import { signIn } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";

import { listAllPages } from "../lib/list-all";
import { UNCATEGORIZED } from "../lib/finance/categories";
import { loadCategoryVocabulary } from "../lib/finance/category-list";
import { ensureTreePaths, financeCategoryTree, missingTreePaths, type FinanceCategoryRow } from "../lib/finance/category-tree";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
};

async function main() {
  const outputs = flag("outputs");
  if (!outputs) throw new Error("--outputs <amplify_outputs.json> is required");
  const env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
  Amplify.configure(JSON.parse(readFileSync(outputs, "utf8")));
  await signIn({ username: env.PRD_USER, password: env.PRD_PASS });
  const client = generateClient({ authMode: "userPool" }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!client.models.homeFinanceCategory) throw new Error("These outputs have no homeFinanceCategory model yet (deploy first)");

  const used = new Map<string, number>();
  const add = (c: unknown) => {
    if (typeof c !== "string" || !c.trim() || c === UNCATEGORIZED) return;
    used.set(c, (used.get(c) ?? 0) + 1);
  };
  const txs = await listAllPages<any>(client.models.homeFinanceTransaction, { limit: 1000 }); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const t of txs) {
    add(t.category);
    if (t.lineItems) {
      try {
        const items = typeof t.lineItems === "string" ? JSON.parse(t.lineItems) : t.lineItems;
        if (Array.isArray(items)) for (const i of items) add(i?.category);
      } catch {
        /* skip */
      }
    }
  }
  for (const m of ["homeFinanceRecurring", "homeInvoice"]) {
    if (!client.models[m]) continue;
    for (const r of await listAllPages<any>(client.models[m], { limit: 1000 })) add(r.category); // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const { categories } = await loadCategoryVocabulary(client);
  const all = [...new Set([...categories, ...used.keys()])].sort((a, b) => a.localeCompare(b));
  const tree = financeCategoryTree(await listAllPages<FinanceCategoryRow>(client.models.homeFinanceCategory));
  const plan = missingTreePaths(
    tree.map((n) => n.path),
    all,
  );
  console.log(`${txs.length} transactions; ${all.length} category names in use; ${tree.length} already in the tree.`);
  for (const p of plan) console.log(`  + ${p.path}${used.get(p.path) ? `  (${used.get(p.path)} rows)` : ""}`);
  if (!plan.length) return console.log("Nothing to add.");
  if (flag("yes") !== "true") return console.log(`\n${plan.length} to add. Re-run with --yes to create them.`);
  const created = await ensureTreePaths(client, all);
  console.log(`Created ${created.length}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
