#!/usr/bin/env node
/**
 * Lightroom album importer.
 *
 * Usage:
 *   node scripts/lightroom-import.mjs --list-albums
 *   node scripts/lightroom-import.mjs --list-home-albums
 *   node scripts/lightroom-import.mjs --lr-album "Italy 2026"
 *   node scripts/lightroom-import.mjs --lr-album "Italy 2026" --home-album "Italy"
 *   node scripts/lightroom-import.mjs --lr-album "Italy 2026" --home-album-id <uuid>
 *
 * Flags:
 *   --list-albums           Print all Lightroom albums and exit
 *   --list-home-albums      Print all home-hub albums and exit (with IDs)
 *   --lr-album <name>       Lightroom album name (fuzzy match)
 *   --lr-album-id <uuid>    Exact Lightroom album ID
 *   --home-album <name>     home-hub album name (find by name, create if missing)
 *   --home-album-id <uuid>  Existing home-hub album ID — must already exist.
 *                           Useful when name matching is ambiguous or you
 *                           want to add to an album with a different name
 *                           than the Lightroom one.
 *   --limit <n>             Cap the number of photos to import (for testing)
 *   --dry-run               Don't actually upload — just print what would be imported
 *   --prod                  Target the production AppSync endpoint instead
 *                           of the sandbox URL from amplify_outputs.json
 *   --appsync-url <url>     Explicit AppSync endpoint override (advanced)
 *
 * Reads from .env.local:
 *   ADOBE_CLIENT_ID, ADOBE_CLIENT_SECRET   (from Adobe Developer Console)
 *   LIGHTROOM_REFRESH_TOKEN                (from `node scripts/lightroom-auth.mjs`)
 *
 * AWS credentials: standard chain (env vars, ~/.aws/credentials, etc).
 * Run with `AWS_PROFILE=admin node scripts/lightroom-import.mjs ...` if needed.
 */

import fs from "fs";
import path from "path";
import { v7 as uuid } from "uuid";
import { SignatureV4 } from "@smithy/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// ── Config ──────────────────────────────────────────────────────────────────

const TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";
const LR_BASE = "https://lr.adobe.io/v2";
const BUCKET = "cristinegennaro.com";
const REGION = "us-east-1";

const ENV_FILE = path.resolve(process.cwd(), ".env.local");
const OUTPUTS_FILE = path.resolve(process.cwd(), "amplify_outputs.json");

// ── Env loading ─────────────────────────────────────────────────────────────

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`Error: ${ENV_FILE} not found`);
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const CLIENT_ID = env.ADOBE_CLIENT_ID;
const CLIENT_SECRET = env.ADOBE_CLIENT_SECRET;
const REFRESH_TOKEN = env.LIGHTROOM_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("Error: ADOBE_CLIENT_ID, ADOBE_CLIENT_SECRET, and LIGHTROOM_REFRESH_TOKEN must be set in .env.local");
  console.error("Run `node scripts/lightroom-auth.mjs` first to get the refresh token.");
  process.exit(1);
}

// Hard-coded prod AppSync URL — used when --prod is passed.
// Sandbox URL comes from amplify_outputs.json by default.
const PROD_APPSYNC_URL =
  "https://pzn6gqjwxndatgpb6ujcey47fe.appsync-api.us-east-1.amazonaws.com/graphql";

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--list-albums") opts.listAlbums = true;
    else if (a === "--list-home-albums") opts.listHomeAlbums = true;
    else if (a === "--lr-album") opts.lrAlbumName = args[++i];
    else if (a === "--lr-album-id") opts.lrAlbumId = args[++i];
    else if (a === "--home-album") opts.homeAlbumName = args[++i];
    else if (a === "--home-album-id") opts.homeAlbumId = args[++i];
    else if (a === "--limit") opts.limit = parseInt(args[++i], 10);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--prod") opts.prod = true;
    else if (a === "--appsync-url") opts.appsyncUrl = args[++i];
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(import.meta.url.replace("file://", ""), "utf-8")
        .split("\n").filter(l => l.startsWith(" *")).join("\n").replace(/^ \*\/?/gm, ""));
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs();

// ── Resolve AppSync endpoint ────────────────────────────────────────────────
// Default: read amplify_outputs.json (the sandbox URL while developing locally).
// --prod          → hard-coded prod URL (safer than overwriting amplify_outputs)
// --appsync-url X → explicit override
let APPSYNC_ENDPOINT;
if (opts.appsyncUrl) {
  APPSYNC_ENDPOINT = opts.appsyncUrl;
} else if (opts.prod) {
  APPSYNC_ENDPOINT = PROD_APPSYNC_URL;
} else {
  if (!fs.existsSync(OUTPUTS_FILE)) {
    console.error(`Error: ${OUTPUTS_FILE} not found. Pass --prod or --appsync-url <url>.`);
    process.exit(1);
  }
  const outputs = JSON.parse(fs.readFileSync(OUTPUTS_FILE, "utf-8"));
  APPSYNC_ENDPOINT = outputs.data.url;
}
const envLabel = opts.appsyncUrl
  ? "custom"
  : opts.prod
  ? "PROD"
  : "sandbox (from amplify_outputs.json)";
console.log(`Target: ${envLabel} — ${APPSYNC_ENDPOINT}`);

// ── Lightroom token + API ───────────────────────────────────────────────────

let _accessToken = null;
let _accessTokenExpiresAt = 0;
let _accountId = null;
let _catalogId = null;

async function getAccessToken() {
  if (_accessToken && Date.now() < _accessTokenExpiresAt - 30_000) return _accessToken;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }
  const tokens = await res.json();
  _accessToken = tokens.access_token;
  _accessTokenExpiresAt = Date.now() + tokens.expires_in * 1000;
  return _accessToken;
}

// Lightroom API responses are wrapped in a 4-byte prefix `while (1) {}` for
// security. Strip it before parsing.
function stripJsonp(text) {
  return text.startsWith("while (1) {}\n") ? text.slice("while (1) {}\n".length) : text;
}

async function lrFetch(url, init = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "X-API-Key": CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lightroom API ${res.status}: ${text}`);
  }
  return res;
}

async function lrJson(url) {
  const res = await lrFetch(url);
  return JSON.parse(stripJsonp(await res.text()));
}

async function getAccountAndCatalog() {
  if (_accountId && _catalogId) return { accountId: _accountId, catalogId: _catalogId };
  const account = await lrJson(`${LR_BASE}/account`);
  _accountId = account.id;
  const catalog = await lrJson(`${LR_BASE}/catalog`);
  _catalogId = catalog.id;
  return { accountId: _accountId, catalogId: _catalogId };
}

// Lightroom pagination links are relative to the response's `base` field
// (typically https://lr.adobe.io/v2/catalogs/{catalogId}/), not to the
// API root. Combine them carefully — using the URL constructor handles
// trailing/leading slashes correctly.
function resolveNextUrl(data) {
  const href = data?.links?.next?.href;
  if (!href) return null;
  const base = data.base ?? `${LR_BASE}/`;
  return new URL(href, base).toString();
}

async function listLightroomAlbums() {
  const { catalogId } = await getAccountAndCatalog();
  const albums = [];
  let next = `${LR_BASE}/catalogs/${catalogId}/albums`;
  while (next) {
    const data = await lrJson(next);
    for (const a of data.resources ?? []) {
      // Only include "collection" type, skip "collection_set" containers
      if (a.subtype === "collection") {
        albums.push({ id: a.id, name: a.payload?.name ?? "(unnamed)" });
      }
    }
    next = resolveNextUrl(data);
  }
  return albums;
}

async function listAlbumAssets(albumId) {
  const { catalogId } = await getAccountAndCatalog();
  const assets = [];
  // ?embed=asset is required so each row in the response includes the
  // actual asset object — without it we only get album_asset rows whose
  // id is the join row id, not the underlying asset id.
  let next = `${LR_BASE}/catalogs/${catalogId}/albums/${albumId}/assets?embed=asset`;
  while (next) {
    const data = await lrJson(next);
    for (const r of data.resources ?? []) {
      const asset = r.asset;
      if (!asset?.id) continue;
      assets.push({
        id: asset.id,
        subtype: asset.subtype,
        // Available rendition sizes are exposed via the asset's links:
        // /rels/rendition_type/{size}. Capture them so the importer
        // can pick the largest one rather than blindly trying fullsize
        // (which doesn't exist for cloud-synced raws).
        renditions: Object.keys(asset.links ?? {})
          .filter((k) => k.startsWith("/rels/rendition_type/"))
          .map((k) => k.replace("/rels/rendition_type/", "")),
      });
    }
    next = resolveNextUrl(data);
  }
  return assets;
}

async function getAssetMetadata(assetId) {
  const { catalogId } = await getAccountAndCatalog();
  const data = await lrJson(`${LR_BASE}/catalogs/${catalogId}/assets/${assetId}`);
  return data;
}

// Picks the largest rendition the asset actually has. Lightroom's API
// only exposes fullsize for non-raw originals; raw files (CR3, NEF, etc.)
// max out at 2048. The /master endpoint returns the original raw bytes
// but requires scopes that aren't part of lr_partner_apis (403).
const RENDITION_PREFERENCE = ["fullsize", "2560", "2048", "1280", "640", "thumbnail2x"];

function pickBestRendition(available) {
  for (const size of RENDITION_PREFERENCE) {
    if (available.includes(size)) return size;
  }
  // Fall back to whatever's there, or fullsize as a last guess
  return available[0] ?? "fullsize";
}

async function downloadAssetRendition(assetId, size) {
  const { catalogId } = await getAccountAndCatalog();
  const url = `${LR_BASE}/catalogs/${catalogId}/assets/${assetId}/renditions/${size}`;
  const res = await lrFetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// ── AppSync (signed GraphQL) ────────────────────────────────────────────────

const signer = new SignatureV4({
  credentials: defaultProvider(),
  region: REGION,
  service: "appsync",
  sha256: Sha256,
});

async function gql(query, variables) {
  const url = new URL(APPSYNC_ENDPOINT);
  const body = JSON.stringify({ query, variables });
  const request = new HttpRequest({
    method: "POST",
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      "Content-Type": "application/json",
      host: url.hostname,
    },
    body,
  });
  const signed = await signer.sign(request);
  const res = await fetch(APPSYNC_ENDPOINT, {
    method: "POST",
    headers: signed.headers,
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`AppSync non-JSON response (${res.status}): ${text.slice(0, 500)}`);
  }
  if (json.errors?.length) {
    throw new Error(`AppSync errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// ── Home-hub queries/mutations ──────────────────────────────────────────────

async function listAllHomeAlbums() {
  const list = await gql(
    `query ListAlbums { listHomeAlbums(limit: 500) { items { id name } } }`,
    {}
  );
  return list.listHomeAlbums?.items ?? [];
}

async function getHomeAlbumById(id) {
  const data = await gql(
    `query GetAlbum($id: ID!) { getHomeAlbum(id: $id) { id name } }`,
    { id }
  );
  return data.getHomeAlbum;
}

async function findOrCreateHomeAlbum(name) {
  const all = await listAllHomeAlbums();
  const existing = all.find((a) => a.name === name);
  if (existing) return existing;

  const created = await gql(
    `mutation CreateAlbum($input: CreateHomeAlbumInput!) {
       createHomeAlbum(input: $input) { id name }
     }`,
    { input: { name } }
  );
  return created.createHomeAlbum;
}

async function findExistingPhotoByAssetId(assetId) {
  const list = await gql(
    `query FindBySourceAsset($filter: ModelHomePhotoFilterInput) {
       listHomePhotos(filter: $filter, limit: 1) {
         items { id s3key }
       }
     }`,
    {
      filter: {
        sourceProvider: { eq: "lightroom" },
        sourceAssetId: { eq: assetId },
      },
    }
  );
  return list.listHomePhotos?.items?.[0] ?? null;
}

async function createHomePhoto(input) {
  const created = await gql(
    `mutation CreatePhoto($input: CreateHomePhotoInput!) {
       createHomePhoto(input: $input) { id }
     }`,
    { input }
  );
  return created.createHomePhoto;
}

async function createAlbumPhoto(albumId, photoId) {
  const created = await gql(
    `mutation CreateAlbumPhoto($input: CreateHomeAlbumPhotoInput!) {
       createHomeAlbumPhoto(input: $input) { id }
     }`,
    { input: { albumId, photoId, sortOrder: 0 } }
  );
  return created.createHomeAlbumPhoto;
}

// ── S3 upload ───────────────────────────────────────────────────────────────

const s3 = new S3Client({ region: REGION });

function extensionForContentType(contentType) {
  switch (contentType) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
    case "image/heif":
      return "heic";
    default:
      return "bin";
  }
}

async function uploadToS3(albumId, buffer, contentType) {
  // Always derive the extension from the actual content type (not the
  // source filename) — Lightroom renditions are JPEG even when the
  // original file is .CR3 / .NEF / .ARW etc.
  const ext = extensionForContentType(contentType);
  const id = uuid();
  const key = `home/photos/albums/${albumId}/${id}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return key;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (opts.listAlbums) {
    const albums = await listLightroomAlbums();
    if (albums.length === 0) {
      console.log("No Lightroom albums found.");
      return;
    }
    console.log(`\nFound ${albums.length} Lightroom album(s):\n`);
    for (const a of albums) {
      console.log(`  ${a.id}  ${a.name}`);
    }
    console.log();
    return;
  }

  if (opts.listHomeAlbums) {
    const albums = await listAllHomeAlbums();
    if (albums.length === 0) {
      console.log("No home-hub albums yet.");
      return;
    }
    const sorted = [...albums].sort((a, b) => a.name.localeCompare(b.name));
    console.log(`\nFound ${sorted.length} home-hub album(s):\n`);
    for (const a of sorted) {
      console.log(`  ${a.id}  ${a.name}`);
    }
    console.log();
    return;
  }

  // Resolve which Lightroom album to import
  let lrAlbum;
  if (opts.lrAlbumId) {
    const all = await listLightroomAlbums();
    lrAlbum = all.find((a) => a.id === opts.lrAlbumId);
    if (!lrAlbum) {
      console.error(`Lightroom album with id ${opts.lrAlbumId} not found.`);
      process.exit(1);
    }
  } else if (opts.lrAlbumName) {
    const all = await listLightroomAlbums();
    const q = opts.lrAlbumName.toLowerCase();
    lrAlbum =
      all.find((a) => a.name.toLowerCase() === q) ??
      all.find((a) => a.name.toLowerCase().includes(q));
    if (!lrAlbum) {
      console.error(`No Lightroom album matching "${opts.lrAlbumName}".`);
      console.error("Run with --list-albums to see all albums.");
      process.exit(1);
    }
  } else {
    console.error("Error: pass --lr-album <name> or --lr-album-id <uuid>, or --list-albums");
    process.exit(1);
  }

  console.log(`\nLightroom album: ${lrAlbum.name} (${lrAlbum.id})`);

  // Resolve home-hub album:
  //   --home-album-id  → look up an existing album by ID (must exist)
  //   --home-album     → find by name, create if missing
  //   (neither)        → use the Lightroom album name, create if missing
  let homeAlbum;
  if (opts.homeAlbumId) {
    if (opts.dryRun) {
      homeAlbum = { id: opts.homeAlbumId, name: "(dry-run)" };
    } else {
      const found = await getHomeAlbumById(opts.homeAlbumId);
      if (!found) {
        console.error(`Home-hub album with id ${opts.homeAlbumId} not found.`);
        console.error("Run with --list-home-albums to see all album IDs.");
        process.exit(1);
      }
      homeAlbum = found;
    }
  } else {
    const homeAlbumName = opts.homeAlbumName ?? lrAlbum.name;
    if (opts.dryRun) {
      homeAlbum = { id: "(dry-run)", name: homeAlbumName };
    } else {
      homeAlbum = await findOrCreateHomeAlbum(homeAlbumName);
    }
  }
  console.log(`Home-hub album: ${homeAlbum.name} (${homeAlbum.id})`);

  // List assets
  const assets = await listAlbumAssets(lrAlbum.id);
  const limited = opts.limit ? assets.slice(0, opts.limit) : assets;
  console.log(`\nFound ${assets.length} asset(s)${opts.limit ? `, importing first ${limited.length}` : ""}\n`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < limited.length; i++) {
    const asset = limited[i];
    const prefix = `[${i + 1}/${limited.length}]`;

    try {
      // Skip non-image assets (videos etc.)
      if (asset.subtype && asset.subtype !== "image") {
        console.log(`${prefix} skip non-image (${asset.subtype})`);
        skipped++;
        continue;
      }

      // Dedup: check if a photo with this sourceAssetId already exists
      if (!opts.dryRun) {
        const existing = await findExistingPhotoByAssetId(asset.id);
        if (existing) {
          // Already imported. If it's not in the home-hub album yet, link it.
          // (Skipped silently for now — keeping it idempotent.)
          console.log(`${prefix} skip (already imported: ${existing.id})`);
          skipped++;
          continue;
        }
      }

      // Get metadata
      const meta = await getAssetMetadata(asset.id);
      const payload = meta.payload ?? {};
      const xmp = payload.xmp ?? {};
      const filename = payload.importSource?.fileName ?? `${asset.id}.jpg`;
      const captureDate = xmp.exif?.DateTimeOriginal ?? payload.captureDate ?? null;
      const dimensions = payload.develop?.croppedDimensions ?? payload.develop?.dimensions ?? {};
      const width = dimensions.width ?? null;
      const height = dimensions.height ?? null;
      const gps = xmp.exif?.GPSLatitude !== undefined && xmp.exif?.GPSLongitude !== undefined
        ? { lat: parseFloat(xmp.exif.GPSLatitude), lon: parseFloat(xmp.exif.GPSLongitude) }
        : null;

      // Lightroom "pick" flag → home-hub favorite. Reviews are keyed by
      // user id; if any user has flagged this photo as a pick, we count
      // it as a favorite. Star ratings (payload.ratings.{user}.rating)
      // are ignored for now.
      const reviews = payload.reviews ?? {};
      const isPicked = Object.values(reviews).some(
        (r) => r && typeof r === "object" && r.flag === "pick"
      );

      console.log(
        `${prefix} ${filename}${width && height ? ` (${width}×${height})` : ""}${isPicked ? " ★" : ""}`
      );

      if (opts.dryRun) {
        imported++;
        continue;
      }

      // Pick the largest available rendition (raw originals max out at
      // 2048 since /master is forbidden under lr_partner_apis).
      const renditionSize = pickBestRendition(asset.renditions ?? []);
      const buffer = await downloadAssetRendition(asset.id, renditionSize);
      console.log(
        `        downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB (rendition: ${renditionSize})`
      );

      // Upload to S3 (renditions are always JPEG)
      const s3key = await uploadToS3(homeAlbum.id, buffer, "image/jpeg");
      console.log(`        s3://${BUCKET}/${s3key}`);

      // Create homePhoto record
      const photo = await createHomePhoto({
        s3key,
        originalFilename: filename,
        contentType: "image/jpeg",
        sizeBytes: buffer.length,
        width,
        height,
        takenAt: captureDate,
        latitude: gps?.lat ?? null,
        longitude: gps?.lon ?? null,
        isFavorite: isPicked,
        sourceProvider: "lightroom",
        sourceAssetId: asset.id,
        uploadedBy: "lightroom-import",
      });

      // Link to album
      await createAlbumPhoto(homeAlbum.id, photo.id);

      imported++;
    } catch (err) {
      console.error(`${prefix} FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n┌─ Import complete ────────────────`);
  console.log(`│  Imported: ${imported}`);
  console.log(`│  Skipped:  ${skipped}`);
  console.log(`│  Failed:   ${failed}`);
  console.log(`└──────────────────────────────────\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
