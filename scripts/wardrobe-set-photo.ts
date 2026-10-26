/**
 * Puts a photo on one wardrobe item — as the main (first) photo by
 * default — uploading it to S3 under home/wardrobe/.
 *
 * Usage:
 *   HOME_HUB_BUCKET=<bucket> npx tsx scripts/wardrobe-set-photo.ts \
 *     --person "Gennaro" --item "7fam-san-miguel" --file ./jeans.png [--replace] [--last]
 *
 *   --item     The item's externalId (the closet export id), its row id,
 *              or a case-insensitive substring of its name/color.
 *   --replace  Drop the item's existing photos instead of keeping them.
 *   --last     Append instead of making it the main photo.
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

async function main() {
  const personName = arg("person");
  const itemQuery = arg("item");
  const file = arg("file");
  if (!personName || !itemQuery || !file) {
    console.error('Usage: npx tsx scripts/wardrobe-set-photo.ts --person "<name>" --item <externalId|id|name> --file <image> [--replace] [--last]');
    process.exit(1);
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) throw new Error(`Unsupported image type .${ext} (jpg, png, webp, gif)`);
  const bucket = process.env.HOME_HUB_BUCKET ?? "";
  if (!bucket) throw new Error("HOME_HUB_BUCKET must be set.");

  const outputs = JSON.parse(await readFile("./amplify_outputs.json", "utf8"));
  Amplify.configure(outputs, { ssr: false });
  const email = process.env.AMPLIFY_EMAIL ?? (await prompt("Cognito email"));
  const password = process.env.AMPLIFY_PASSWORD ?? (await prompt("Password (input visible)"));
  await signOut().catch(() => {});
  const res = await signIn({ username: email, password });
  if (!res.isSignedIn) throw new Error(`Sign-in incomplete: ${JSON.stringify(res.nextStep)}`);
  const client = generateClient<Schema>({ authMode: "userPool" });

  const { data: people } = await client.models.homePerson.list();
  const person = (people ?? []).find((p) => p.name.toLowerCase() === personName.toLowerCase());
  if (!person) throw new Error(`No homePerson named "${personName}". Known: ${(people ?? []).map((p) => p.name).join(", ")}`);

  const items = await listAllPages<Item>(client.models.homeWardrobeItem, { filter: { ownerPersonId: { eq: person.id } } });
  const q = itemQuery.toLowerCase();
  let matches = items.filter((i) => i.externalId === itemQuery || i.id === itemQuery);
  if (!matches.length) {
    matches = items.filter((i) => `${i.brand ?? ""} ${i.name} ${i.color ?? ""}`.toLowerCase().includes(q));
  }
  if (matches.length !== 1) {
    const list = matches.map((i) => `  ${i.externalId ?? i.id}: ${i.brand ?? ""} ${i.name} (${i.color ?? ""})`).join("\n");
    throw new Error(matches.length ? `"${itemQuery}" matches ${matches.length} items — be more specific:\n${list}` : `No item matches "${itemQuery}".`);
  }
  const item = matches[0];

  const key = `home/wardrobe/${randomUUID()}.${ext === "jpeg" ? "jpg" : ext}`;
  await new S3Client({ region: "us-east-1" }).send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: await readFile(file), ContentType: contentType }),
  );

  const current = flag("replace") ? [] : (item.imageKeys ?? []).filter((k): k is string => !!k);
  const imageKeys = flag("last") ? [...current, key] : [key, ...current];
  const { errors } = await client.models.homeWardrobeItem.update({ id: item.id, imageKeys });
  if (errors?.length) throw new Error(errors[0].message);

  console.log(`✓ ${item.brand ?? ""} ${item.name} (${item.color ?? ""})`);
  console.log(`  photos: ${imageKeys.length} — ${flag("last") ? "added last" : "new main photo"}${flag("replace") ? ", old photos dropped" : ""}`);
  console.log(`  ${key}`);
  await signOut().catch(() => {});
}

main().catch((err) => {
  console.error(`✗ ${err?.message ?? err}`);
  process.exit(1);
});
