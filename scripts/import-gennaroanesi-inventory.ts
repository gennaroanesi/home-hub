/**
 * One-time move of gennaroanesi.com's inventory into home-hub
 * (docs/inventory-specialized.md, section 6). Reads every inventoryItem and
 * its detail row there, then creates the item here in the category for its
 * type (created if missing), owned by the person signing in here, with its
 * detail fields, its photos copied across buckets, and its embedded parts
 * as items installed on it. Firearms and ammo land in the owner-only table.
 *
 * Safe to run again: each row it creates carries importedFrom
 * ("gennaroanesi:<id>", parts "gennaroanesi:<id>:part:<n>") and is skipped
 * next time. Prints the plan and stops unless --yes.
 *
 * Usage:
 *   AWS_PROFILE=amplify-dev npx tsx scripts/import-gennaroanesi-inventory.ts \
 *     <gennaroanesi amplify_outputs.json> <home-hub amplify_outputs.json> [--yes]
 *
 * Reads GA_USER / GA_PASS (gennaroanesi.com admin) and PRD_USER / PRD_PASS
 * (the home-hub household member who owns it all) from the environment.
 * Copies photos with the AWS credentials in the environment; HOME_HUB_BUCKET
 * names the destination bucket.
 */

import { readFile } from "node:fs/promises";
import { CopyObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Amplify } from "aws-amplify";
import { getCurrentUser, signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { categoryTree } from "../lib/inventory";
import { DETAIL_SPECS, pickDetailFields, type DetailType } from "../lib/inventory-details";
import { createItem, tableForCategory, upsertDetail } from "../lib/inventory-store";
import { listAllPages } from "../lib/list-all";

/* eslint-disable @typescript-eslint/no-explicit-any */

const OLD_BUCKET = "gennaroanesi.com";

/** Old category → where it goes here: a category path (created if missing, with its detail type) and the old detail model. */
const TARGETS: Record<string, { path: Array<{ name: string; detailType: DetailType | null }>; oldModel: string | null; type: DetailType | null }> = {
  FIREARM: { path: [{ name: "Firearms", detailType: "FIREARM" }], oldModel: "inventoryFirearm", type: "FIREARM" },
  AMMO: { path: [{ name: "Ammo", detailType: "AMMO" }], oldModel: "inventoryAmmo", type: "AMMO" },
  FILAMENT: { path: [{ name: "3D printing", detailType: null }, { name: "Filament", detailType: "FILAMENT" }], oldModel: "inventoryFilament", type: "FILAMENT" },
  INSTRUMENT: { path: [{ name: "Music", detailType: "INSTRUMENT" }], oldModel: "inventoryInstrument", type: "INSTRUMENT" },
  PHOTOGRAPHY: { path: [{ name: "Photography", detailType: "PHOTOGRAPHY" }], oldModel: "inventoryPhotography", type: "PHOTOGRAPHY" },
  ELECTRONICS: { path: [{ name: "Electronics", detailType: null }, { name: "Components", detailType: "ELECTRONIC" }], oldModel: "inventoryElectronic", type: "ELECTRONIC" },
  OTHER: { path: [{ name: "Other", detailType: null }], oldModel: null, type: null },
};

/** Per-type fields that live on the base item here (count) rather than the detail row. */
const QUANTITY_FROM_DETAIL = new Set(["AMMO", "FILAMENT", "ELECTRONICS"]);

function statusOf(old: any): "OWNED" | "WISHLIST" | "SOLD" {
  if (old.status === "WISHLIST" || old.status === "SOLD" || old.status === "OWNED") return old.status;
  return old.active === false ? "SOLD" : "OWNED";
}

function detailFor(type: DetailType, row: any): Record<string, unknown> {
  const d = pickDetailFields(type, row ?? {});
  if (type === "FILAMENT" && typeof d.diameter === "string") d.diameter = d.diameter === "d285" ? "2.85" : d.diameter === "d175" ? "1.75" : d.diameter;
  // Like the old ammo page: no count on hand means all of it (units × rounds per unit).
  if (type === "AMMO" && d.roundsAvailable == null) d.roundsAvailable = (row?.quantity ?? 0) * (row?.unit === "ROUNDS" ? 1 : (row?.roundsPerUnit ?? 1));
  return d;
}

const newPhotoKey = (oldKey: string) => `home/inventory/${oldKey.split("/").pop()}`;

async function readOld(outputsPath: string) {
  Amplify.configure(JSON.parse(await readFile(outputsPath, "utf8")));
  await signIn({ username: process.env.GA_USER!, password: process.env.GA_PASS! });
  const c: any = generateClient({ authMode: "userPool" });
  const items = await listAllPages<any>(c.models.inventoryItem);
  const details = new Map<string, any>();
  for (const t of Object.values(TARGETS)) {
    if (!t.oldModel) continue;
    for (const row of await listAllPages<any>(c.models[t.oldModel])) details.set(row.itemId, row);
  }
  const thresholds = await listAllPages<any>(c.models.ammoThreshold);
  await signOut();
  return { items, details, thresholds };
}

async function main() {
  const [oldOutputs, newOutputs] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!oldOutputs || !newOutputs) throw new Error("Usage: import-gennaroanesi-inventory.ts <gennaroanesi outputs> <home-hub outputs> [--yes]");
  const apply = process.argv.includes("--yes");
  for (const k of ["GA_USER", "GA_PASS", "PRD_USER", "PRD_PASS", ...(apply ? ["HOME_HUB_BUCKET"] : [])]) if (!process.env[k]) throw new Error(`${k} must be set`);

  const old = await readOld(oldOutputs);

  Amplify.configure(JSON.parse(await readFile(newOutputs, "utf8")));
  await signIn({ username: process.env.PRD_USER!, password: process.env.PRD_PASS! });
  const { username } = await getCurrentUser();
  const client: any = generateClient({ authMode: "userPool" });
  const people = await listAllPages<any>(client.models.homePerson);
  const me = people.find((p) => p.cognitoUsername === username);
  if (!me) throw new Error(`No homePerson for the login ${username}`);

  // Already imported (re-runs skip these).
  const existing = [...(await listAllPages<any>(client.models.homeInventoryItem)), ...(await listAllPages<any>(client.models.homePrivateInventoryItem))];
  const done = new Map(existing.filter((i) => i.importedFrom).map((i) => [i.importedFrom as string, i]));

  // Categories: find each path, create what's missing (only when applying).
  let categories = await listAllPages<any>(client.models.homeInventoryCategory);
  const categoryFor = new Map<string, string | null>();
  const toCreate: string[] = [];
  for (const [key, t] of Object.entries(TARGETS)) {
    let parentId: string | null = null;
    let id: string | null = null;
    for (const step of t.path) {
      const hit = categories.find((c) => (c.parentId ?? null) === parentId && c.name.toLowerCase() === step.name.toLowerCase());
      if (hit) {
        if (step.detailType && hit.detailType !== step.detailType) {
          toCreate.push(`set ${step.name} detail type ${step.detailType} (was ${hit.detailType ?? "none"})`);
          if (apply) await client.models.homeInventoryCategory.update({ id: hit.id, detailType: step.detailType });
          hit.detailType = step.detailType;
        }
        id = hit.id;
      } else {
        toCreate.push(`create category ${t.path.slice(0, t.path.indexOf(step) + 1).map((s) => s.name).join(" › ")}${step.detailType ? ` (${step.detailType})` : ""}`);
        if (apply) {
          const r: any = await client.models.homeInventoryCategory.create({ name: step.name, parentId, detailType: step.detailType, sortOrder: categories.filter((c) => (c.parentId ?? null) === parentId).length });
          if (r.errors?.length) throw new Error(r.errors[0].message);
          categories = [...categories, r.data];
          id = r.data.id;
        } else id = `(new ${step.name})`;
      }
      parentId = id;
    }
    categoryFor.set(key, id);
  }
  const nodes = new Map(categoryTree(categories).map((n) => [n.category.id, n]));

  // The plan.
  const plan = old.items.map((o) => {
    const key = TARGETS[o.category] ? o.category : "OTHER";
    const t = TARGETS[key];
    const detail = old.details.get(o.id);
    const parts: any[] = detail?.parts ?? [];
    return { o, key, t, detail, parts, skip: done.has(`gennaroanesi:${o.id}`) };
  });
  const byKey = new Map<string, { items: number; skip: number; parts: number; photos: number; missingDetail: number }>();
  for (const p of plan) {
    const s = byKey.get(p.key) ?? { items: 0, skip: 0, parts: 0, photos: 0, missingDetail: 0 };
    s.items += 1;
    if (p.skip) s.skip += 1;
    s.parts += p.parts.length;
    s.photos += (p.o.imageKeys ?? []).filter(Boolean).length;
    if (p.t.oldModel && !p.detail) s.missingDetail += 1;
    byKey.set(p.key, s);
  }
  console.log(`Owner here: ${me.name} (${username})`);
  for (const line of toCreate) console.log(`  ${line}`);
  for (const [k, s] of byKey) {
    console.log(`${k.padEnd(12)} → ${TARGETS[k].path.map((x) => x.name).join(" › ").padEnd(26)} ${s.items} items (${s.skip} already here), ${s.parts} parts, ${s.photos} photos${s.missingDetail ? `, ${s.missingDetail} without a detail row` : ""}`);
  }
  const statuses = plan.reduce<Record<string, number>>((m, p) => ({ ...m, [statusOf(p.o)]: (m[statusOf(p.o)] ?? 0) + 1 }), {});
  console.log("statuses:", JSON.stringify(statuses), "· ammo minimums:", old.thresholds.length);
  for (const p of plan.filter((x) => x.key === "OTHER")) console.log(`  OTHER: ${p.o.name}`);
  for (const p of plan.filter((x) => x.parts.length)) console.log(`  parts of ${p.o.name}: ${p.parts.map((x: any) => x.name).join(", ")}`);
  const ammo = plan.filter((p) => p.key === "AMMO");
  const rounds = new Map<string, number>();
  for (const p of ammo) {
    const d = detailFor("AMMO", p.detail);
    rounds.set(String(d.caliber), (rounds.get(String(d.caliber)) ?? 0) + Number(d.roundsAvailable ?? 0));
  }
  console.log("  ammo on hand by caliber:", JSON.stringify(Object.fromEntries(rounds)));

  if (!apply) {
    console.log("\nDry run. Re-run with --yes to import.");
    await signOut();
    return;
  }

  const s3 = new S3Client({});
  let created = 0;
  let photos = 0;
  for (const p of plan) {
    if (p.skip) continue;
    const categoryId = categoryFor.get(p.key)!;
    const table = tableForCategory(nodes, categoryId);
    const imageKeys: string[] = [];
    for (const k of (p.o.imageKeys ?? []).filter(Boolean)) {
      const to = newPhotoKey(k);
      await s3.send(new CopyObjectCommand({ Bucket: process.env.HOME_HUB_BUCKET, Key: to, CopySource: `${OLD_BUCKET}/${encodeURI(k)}` }));
      imageKeys.push(to);
      photos += 1;
    }
    const notes = [p.o.description, p.o.notes].filter((x) => x && String(x).trim()).join("\n\n") || null;
    const base = {
      name: p.o.name,
      categoryId,
      status: statusOf(p.o),
      ownerPersonId: me.id,
      brand: p.o.brand ?? null,
      quantity: QUANTITY_FROM_DETAIL.has(p.key) ? Math.max(1, p.detail?.quantity ?? 1) : 1,
      notes,
      url: p.o.url ?? null,
      vendor: p.o.vendor ?? null,
      acquiredAt: p.o.datePurchased ?? null,
      acquiredVia: "PURCHASED",
      pricePaid: p.o.pricePaid ?? null,
      priceSold: p.o.priceSold ?? null,
      imageKeys,
      createdBy: "import",
      importedFrom: `gennaroanesi:${p.o.id}`,
    };
    const item = await createItem(client, table, base, table === "private" ? username : null);
    if (p.t.type) await upsertDetail(client, item.id, p.t.type, undefined, detailFor(p.t.type, p.detail), DETAIL_SPECS[p.t.type].private ? username : null);
    created += 1;
    for (const [n, part] of p.parts.entries()) {
      await createItem(
        client,
        table,
        {
          name: part.name,
          categoryId,
          status: base.status,
          ownerPersonId: me.id,
          brand: part.brand ?? null,
          quantity: 1,
          acquiredAt: part.installedDate ?? null,
          notes: [part.type ? `${String(part.type).charAt(0)}${String(part.type).slice(1).toLowerCase()}` : null, part.notes].filter(Boolean).join(": ") || null,
          parentItemId: item.id,
          createdBy: "import",
          importedFrom: `gennaroanesi:${p.o.id}:part:${n}`,
        },
        table === "private" ? username : null,
      );
      created += 1;
    }
    process.stdout.write(".");
  }
  for (const t of old.thresholds) {
    await client.models.homeAmmoThreshold.create({ caliber: t.caliber, minRounds: t.minRounds, enabled: t.enabled ?? true, ownerUsername: username });
  }
  console.log(`\nCreated ${created} items (parts included), copied ${photos} photos, ${old.thresholds.length} ammo minimums.`);
  await signOut();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
