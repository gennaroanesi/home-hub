/**
 * Adds (or updates) one wardrobe item from a JSON file, with an optional
 * photo uploaded to S3 under home/wardrobe/ as its main image.
 *
 * Usage:
 *   HOME_HUB_BUCKET=<bucket> npx tsx scripts/wardrobe-add-item.ts \
 *     --person "Gennaro" --json ./item.json [--photo ./item.png]
 *
 * item.json holds homeWardrobeItem fields, e.g.
 *   { "externalId": "massif-flight-jacket", "category": "Outerwear",
 *     "name": "Flight Suit Jacket", "brand": "Massif", "color": "Sage Green",
 *     "colorHex": "#6f7466", "status": "KEEP", "url": "https://…" }
 * `category` and `name` are required. With an `externalId`, re-running
 * updates that item instead of adding a duplicate (and keeps its photos
 * unless --photo is given, which becomes the new main photo).
 *
 * Auth and target environment work like scripts/wardrobe-import.ts:
 * AMPLIFY_EMAIL / AMPLIFY_PASSWORD (else prompted), amplify_outputs.json
 * from the current directory, AWS credential chain for S3.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Schema } from "../amplify/data/resource";
import { listAllPages } from "../lib/list-all";

type Item = Schema["homeWardrobeItem"]["type"];

const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const FIELDS = [
  "category", "name", "brand", "color", "colorHex", "size", "fabric", "fit", "styleCode",
  "status", "season", "formality", "notes", "url", "price", "externalId",
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function prompt(label: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${label}: `)).trim();
  rl.close();
  return a;
}

async function main() {
  const personName = arg("person");
  const jsonPath = arg("json");
  const photo = arg("photo");
  if (!personName || !jsonPath) {
    console.error('Usage: npx tsx scripts/wardrobe-add-item.ts --person "<name>" --json <item.json> [--photo <image>]');
    process.exit(1);
  }
  const raw = JSON.parse(await readFile(jsonPath, "utf8"));
  const fields: Record<string, unknown> = {};
  for (const k of FIELDS) if (raw[k] !== undefined && raw[k] !== "") fields[k] = raw[k];
  const unknown = Object.keys(raw).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`Unknown field(s) in ${jsonPath}: ${unknown.join(", ")}`);
  if (!fields.category || !fields.name) throw new Error("item JSON needs at least category and name.");

  let ext = "";
  if (photo) {
    ext = path.extname(photo).slice(1).toLowerCase();
    if (!CONTENT_TYPES[ext]) throw new Error(`Unsupported image type .${ext} (jpg, png, webp, gif)`);
    if (!process.env.HOME_HUB_BUCKET) throw new Error("HOME_HUB_BUCKET must be set to upload a photo.");
  }

  const outputs = JSON.parse(await readFile("./amplify_outputs.json", "utf8"));
  Amplify.configure(outputs, { ssr: false });
  const email = process.env.AMPLIFY_EMAIL ?? (await prompt("Cognito email"));
  const password = process.env.AMPLIFY_PASSWORD ?? (await prompt("Password (input visible)"));
  await signOut().catch(() => {});
  const res = await signIn({ username: email, password });
  if (!res.isSignedIn) throw new Error(`Sign-in incomplete: ${JSON.stringify(res.nextStep)}`);
  const client = generateClient<Schema>({ authMode: "userPool" });
  console.log(`Target: ${outputs.data.url}`);

  const { data: people } = await client.models.homePerson.list();
  const person = (people ?? []).find((p) => p.name.toLowerCase() === personName.toLowerCase());
  if (!person) throw new Error(`No homePerson named "${personName}". Known: ${(people ?? []).map((p) => p.name).join(", ")}`);

  const existing = fields.externalId
    ? (await listAllPages<Item>(client.models.homeWardrobeItem, { filter: { ownerPersonId: { eq: person.id } } })).find(
        (i) => i.externalId === fields.externalId,
      )
    : undefined;

  let imageKeys = (existing?.imageKeys ?? []).filter((k): k is string => !!k);
  if (photo) {
    const key = `home/wardrobe/${randomUUID()}.${ext === "jpeg" ? "jpg" : ext}`;
    await new S3Client({ region: "us-east-1" }).send(
      new PutObjectCommand({ Bucket: process.env.HOME_HUB_BUCKET, Key: key, Body: await readFile(photo), ContentType: CONTENT_TYPES[ext] }),
    );
    imageKeys = [key, ...imageKeys];
  }

  const body = { ...fields, ownerPersonId: person.id, imageKeys } as Parameters<typeof client.models.homeWardrobeItem.create>[0];
  const r = existing
    ? await client.models.homeWardrobeItem.update({ ...body, id: existing.id })
    : await client.models.homeWardrobeItem.create(body);
  if (r.errors?.length || !r.data) throw new Error(r.errors?.[0]?.message ?? "no data returned");

  console.log(`✓ ${existing ? "Updated" : "Added"} ${[r.data.brand, r.data.name].filter(Boolean).join(" ")} (${r.data.color ?? ""}) in ${person.name}'s wardrobe`);
  console.log(`  ${r.data.category} · ${r.data.status ?? "KEEP"} · ${imageKeys.length} photo(s) · id ${r.data.id}`);
  await signOut().catch(() => {});
}

main().catch((err) => {
  console.error(`✗ ${err?.message ?? err}`);
  process.exit(1);
});
