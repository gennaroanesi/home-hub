/**
 * Imports a closet export (the "Export for Home Hub" zip from the old
 * closet artifact) into one person's wardrobe.
 *
 * Usage:
 *   unzip wardrobe-export.zip -d wardrobe-export
 *   HOME_HUB_BUCKET=<bucket> npx tsx scripts/wardrobe-import.ts --dir wardrobe-export --person "Gennaro" [--dry-run]
 *
 * The export folder holds items.json, looks.json and images/<assetId>.<ext>.
 * Re-running is safe: rows are matched on externalId (the artifact's item
 * / look id) and updated in place; photos already uploaded for an item are
 * kept unless --reupload is passed.
 *
 * Auth: signs in to Cognito like scripts/amplify-repl.ts (AMPLIFY_EMAIL /
 * AMPLIFY_PASSWORD, else prompted) and writes through the data client.
 * Photos go straight to S3 under home/wardrobe/ with the standard AWS
 * credential chain (AWS_PROFILE=… if needed). Uses amplify_outputs.json
 * from the repo root, so point it at the sandbox or prod as usual.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Schema } from "../amplify/data/resource";
import { DEFAULT_CATEGORIES } from "../lib/wardrobe";
import { listAllPages } from "../lib/list-all";

type Item = Schema["homeWardrobeItem"]["type"];
type Look = Schema["homeWardrobeLook"]["type"];

interface ExportItem {
  id: string;
  cat?: string;
  brand?: string;
  name?: string;
  color?: string;
  hex?: string;
  size?: string;
  fabric?: string;
  fit?: string;
  code?: string;
  status?: string;
  notes?: string;
  photo?: string;
  photos?: string[];
  tagPhoto?: string;
}

interface ExportLook {
  id: string;
  title: string;
  palette?: string;
  occasion?: string;
  note?: string;
  pieces?: string[];
  order?: number;
}

const STATUS: Record<string, Item["status"]> = {
  keep: "KEEP",
  new: "NEW",
  tailor: "TAILOR",
  retire: "RETIRE",
  wish: "WISHLIST",
};

const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function prompt(label: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${label}: `)).trim();
  rl.close();
  return a;
}

function galleryOf(i: ExportItem): string[] {
  const g = i.photos?.length ? [...i.photos] : i.photo ? [i.photo] : [];
  if (i.tagPhoto && !g.includes(i.tagPhoto)) g.push(i.tagPhoto);
  return g.filter(Boolean);
}

async function main() {
  const dir = arg("dir");
  const personName = arg("person");
  const dryRun = flag("dry-run");
  const reupload = flag("reupload");
  if (!dir || !personName) {
    console.error('Usage: npx tsx scripts/wardrobe-import.ts --dir <export folder> --person "<name>" [--dry-run] [--reupload]');
    process.exit(1);
  }
  const bucket = process.env.HOME_HUB_BUCKET ?? "";
  if (!bucket && !dryRun) {
    console.error("HOME_HUB_BUCKET must be set (the bucket behind the CloudFront photo URLs).");
    process.exit(1);
  }

  const items: ExportItem[] = JSON.parse(await readFile(path.join(dir, "items.json"), "utf8"));
  const looks: ExportLook[] = JSON.parse(await readFile(path.join(dir, "looks.json"), "utf8").catch(() => "[]"));
  const imageFiles = new Map<string, string>();
  for (const f of await readdir(path.join(dir, "images")).catch(() => [] as string[])) {
    imageFiles.set(f.replace(/\.[^.]+$/, ""), path.join(dir, "images", f));
  }
  console.log(`Export: ${items.length} items, ${looks.length} looks, ${imageFiles.size} photos`);

  const outputs = JSON.parse(await readFile("./amplify_outputs.json", "utf8"));
  Amplify.configure(outputs, { ssr: false });
  const email = process.env.AMPLIFY_EMAIL ?? (await prompt("Cognito email"));
  const password = process.env.AMPLIFY_PASSWORD ?? (await prompt("Password (input visible)"));
  await signOut().catch(() => {});
  const res = await signIn({ username: email, password });
  if (!res.isSignedIn) throw new Error(`Sign-in incomplete: ${JSON.stringify(res.nextStep)}`);
  const client = generateClient<Schema>({ authMode: "userPool" });
  const s3 = new S3Client({ region: "us-east-1" });

  const { data: people } = await client.models.homePerson.list();
  const person = (people ?? []).find((p) => p.name.toLowerCase() === personName.toLowerCase());
  if (!person) throw new Error(`No homePerson named "${personName}". Known: ${(people ?? []).map((p) => p.name).join(", ")}`);
  console.log(`Importing into ${person.name}'s wardrobe (${person.id})${dryRun ? " — DRY RUN" : ""}`);

  // Profile: create with the export's categories if there isn't one yet.
  const profiles = await listAllPages<Schema["homeWardrobeProfile"]["type"]>(client.models.homeWardrobeProfile, {
    filter: { personId: { eq: person.id } },
  });
  if (!profiles.length) {
    const used = Array.from(new Set(items.map((i) => i.cat).filter((c): c is string => !!c)));
    const categories = [...DEFAULT_CATEGORIES.filter((c) => used.includes(c)), ...used.filter((c) => !DEFAULT_CATEGORIES.includes(c))];
    console.log(`+ profile with categories: ${categories.join(", ")}`);
    if (!dryRun) await client.models.homeWardrobeProfile.create({ personId: person.id, categories });
  }

  const existing = await listAllPages<Item>(client.models.homeWardrobeItem, { filter: { ownerPersonId: { eq: person.id } } });
  const byExternal = new Map(existing.filter((i) => i.externalId).map((i) => [i.externalId!, i]));
  const idMap = new Map<string, string>(); // artifact item id → homeWardrobeItem.id
  const uploaded = new Map<string, string>(); // asset id → s3 key (dedupe within this run)

  async function upload(assetId: string): Promise<string | null> {
    if (uploaded.has(assetId)) return uploaded.get(assetId)!;
    const file = imageFiles.get(assetId);
    if (!file) {
      console.warn(`  ! photo ${assetId} missing from the export`);
      return null;
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    const key = `home/wardrobe/${randomUUID()}.${ext === "jpeg" ? "jpg" : ext}`;
    if (!dryRun) {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: await readFile(file), ContentType: CONTENT_TYPES[ext] ?? "image/jpeg" }),
      );
    }
    uploaded.set(assetId, key);
    return key;
  }

  let created = 0,
    updated = 0;
  for (const it of items) {
    const prior = byExternal.get(it.id);
    let imageKeys = prior?.imageKeys?.filter((k): k is string => !!k) ?? [];
    if (!imageKeys.length || reupload) {
      imageKeys = [];
      for (const a of galleryOf(it)) {
        const k = await upload(a);
        if (k) imageKeys.push(k);
      }
    }
    const body = {
      ownerPersonId: person.id,
      category: it.cat || "Tops",
      name: it.name || it.id,
      brand: it.brand || null,
      color: it.color || null,
      colorHex: it.hex || null,
      size: it.size || null,
      fabric: it.fabric || null,
      fit: it.fit || null,
      styleCode: it.code || null,
      status: STATUS[(it.status ?? "keep").toLowerCase()] ?? "KEEP",
      notes: it.notes || null,
      imageKeys,
      externalId: it.id,
    };
    if (dryRun) {
      console.log(`${prior ? "~" : "+"} ${body.category}: ${body.brand ?? ""} ${body.name} (${imageKeys.length} photos)`);
      idMap.set(it.id, prior?.id ?? `dry-${it.id}`);
      continue;
    }
    const r = prior
      ? await client.models.homeWardrobeItem.update({ id: prior.id, ...body })
      : await client.models.homeWardrobeItem.create(body);
    if (r.errors?.length || !r.data) throw new Error(`${it.id}: ${r.errors?.[0]?.message ?? "no data"}`);
    idMap.set(it.id, r.data.id);
    if (prior) updated++;
    else created++;
    process.stdout.write(prior ? "~" : "+");
  }
  console.log(`\nItems: ${created} created, ${updated} updated, ${uploaded.size} photos uploaded`);

  const existingLooks = await listAllPages<Look>(client.models.homeWardrobeLook, { filter: { ownerPersonId: { eq: person.id } } });
  const looksByExternal = new Map(existingLooks.filter((l) => l.externalId).map((l) => [l.externalId!, l]));
  let lc = 0;
  for (const l of looks) {
    const itemIds = (l.pieces ?? []).map((p) => idMap.get(p)).filter((x): x is string => !!x);
    if (itemIds.length < 2) {
      console.warn(`  ! look "${l.title}" skipped: fewer than two pieces resolved`);
      continue;
    }
    const body = {
      ownerPersonId: person.id,
      title: l.title,
      palette: l.palette || null,
      occasion: l.occasion || null,
      note: l.note || null,
      itemIds,
      source: "IMPORTED" as const,
      sortOrder: l.order ?? null,
      externalId: l.id,
    };
    if (dryRun) {
      console.log(`look: ${l.title} (${itemIds.length} pieces)`);
      continue;
    }
    const prior = looksByExternal.get(l.id);
    const r = prior ? await client.models.homeWardrobeLook.update({ id: prior.id, ...body }) : await client.models.homeWardrobeLook.create(body);
    if (r.errors?.length) throw new Error(`look ${l.id}: ${r.errors[0].message}`);
    lc++;
  }
  console.log(`Looks: ${lc} written`);
  await signOut().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
