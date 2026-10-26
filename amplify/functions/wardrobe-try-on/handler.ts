import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/wardrobe-try-on";
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../lib/list-all";
import { isWearable, mainImage } from "../../../lib/wardrobe";
import {
  DEFAULT_TRY_ON_MODEL, MAX_REFERENCE_PHOTOS, MAX_TRY_ON_ITEMS,
  isWardrobeImageKey, normalizeRenderInputs, renderCacheId, type RenderInputs,
} from "../../../lib/wardrobe-try-on";
import { renderWardrobeImage } from "../../../lib/wardrobe-image-renderer";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();
const db = new DynamoDBClient({});
const lambda = new LambdaClient({});
const s3 = new S3Client({});
const table = process.env.TRY_ON_TABLE!;
const bucket = process.env.HOME_HUB_BUCKET!;
type Row = Record<string, AttributeValue>;
interface Args { personId: string; itemIds: (string | null)[]; stylingInstructions?: string | null; regenerate?: boolean | null }
interface Work { jobId: string; attempt: string }
const str = (value: string): AttributeValue => ({ S: value });
const list = (values: string[]): AttributeValue => ({ L: values.map(str) });
const conditional = (err: unknown) => (err as { name?: string })?.name === "ConditionalCheckFailedException";
async function read(id: string): Promise<Row | undefined> {
  return (await db.send(new GetItemCommand({ TableName: table, Key: { id: str(id) }, ConsistentRead: true }))).Item;
}
async function finish(work: Work, status: "READY" | "FAILED", field: "previewImageKey" | "error", value: string) {
  await db.send(new UpdateItemCommand({
    TableName: table, Key: { id: str(work.jobId) },
    UpdateExpression: "SET #status = :status, #field = :value, updatedAt = :now",
    ConditionExpression: "attempt = :attempt AND #status = :processing",
    ExpressionAttributeNames: { "#status": "status", "#field": field },
    ExpressionAttributeValues: {
      ":status": str(status), ":value": str(value), ":now": str(new Date().toISOString()),
      ":attempt": str(work.attempt), ":processing": str("PROCESSING"),
    },
  }));
}
async function processJob(work: Work) {
  try {
    await db.send(new UpdateItemCommand({
      TableName: table, Key: { id: str(work.jobId) },
      UpdateExpression: "SET #status = :processing, updatedAt = :now",
      ConditionExpression: "attempt = :attempt AND #status = :queued",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":attempt": str(work.attempt), ":queued": str("QUEUED"),
        ":processing": str("PROCESSING"), ":now": str(new Date().toISOString()),
      },
    }));
  } catch (err) { if (conditional(err)) return; throw err; }
  try {
    const row = await read(work.jobId);
    const input = JSON.parse(row!.renderInputs.S!) as RenderInputs;
    // Sequential reads keep memory bounded; never fetch caller-supplied URLs.
    const images = [];
    let totalBytes = 0;
    for (const key of [...input.referenceImageKeys, ...input.garments.map(g => g.imageKey)]) {
      if (!isWardrobeImageKey(key)) throw new Error("Unsupported wardrobe photo. Use JPEG, PNG or WebP.");
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!object.ContentLength || object.ContentLength > 10 * 1024 * 1024) throw new Error("Reference and garment photos must be under 10 MB each.");
      const bytes = await object.Body!.transformToByteArray();
      totalBytes += bytes.byteLength;
      if (totalBytes > 40 * 1024 * 1024) throw new Error("Too many large photos. Upload smaller reference or garment images.");
      const contentType = object.ContentType === "image/jpg" ? "image/jpeg" : object.ContentType;
      if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) throw new Error("Use JPEG, PNG or WebP photos for try-on.");
      images.push({ bytes, contentType });
    }
    const bytes = await renderWardrobeImage(input, images, process.env.OPENAI_API_KEY!);
    const key = `home/wardrobe/try-on/${work.jobId}/${work.attempt}.png`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: "image/png", CacheControl: "max-age=31536000, immutable" }));
    await finish(work, "READY", "previewImageKey", key);
  } catch (err) {
    await finish(work, "FAILED", "error", err instanceof Error ? err.message : "Try-on failed. Please retry.");
  }
}
async function request(args: Args): Promise<{ jobId: string | null; error: string | null }> {
  const ids = [...new Set(args.itemIds.filter((id): id is string => !!id))];
  if (ids.length < 2 || ids.length > MAX_TRY_ON_ITEMS) throw new Error(`Choose 2–${MAX_TRY_ON_ITEMS} wardrobe pieces.`);
  if ((args.stylingInstructions?.length ?? 0) > 2000) throw new Error("Keep wearing instructions under 2,000 characters.");
  const profiles = await listAllPages<Schema["homeWardrobeProfile"]["type"]>(client.models.homeWardrobeProfile, { filter: { personId: { eq: args.personId } } });
  const profile = profiles[0];
  const refs = (profile?.referenceImageKeys ?? []).filter((key): key is string => !!key);
  if (!refs.length) throw new Error("Add a full-body reference photo in Closet settings first.");
  if (refs.length > MAX_REFERENCE_PHOTOS || refs.some(key => !isWardrobeImageKey(key))) throw new Error("Use up to three JPEG, PNG or WebP reference photos.");
  const garments = await Promise.all(ids.map(async id => {
    const { data: item, errors } = await client.models.homeWardrobeItem.get({ id });
    if (errors?.length || !item || item.ownerPersonId !== args.personId || !isWearable(item)) throw new Error("Every piece must belong to this person's wearable wardrobe.");
    const imageKey = mainImage(item);
    if (!imageKey || !isWardrobeImageKey(imageKey)) throw new Error(`Add a JPEG, PNG or WebP photo for ${item.name} before previewing.`);
    return { id, imageKey, description: [item.category, item.brand, item.name, item.color, item.fabric, item.fit].filter(Boolean).join(" | ") };
  }));
  const input = normalizeRenderInputs({
    personId: args.personId, referenceImageKeys: refs, garments,
    fitNotes: profile?.fitNotes ?? "", stylingInstructions: args.stylingInstructions ?? "",
    model: process.env.WARDROBE_TRY_ON_MODEL || DEFAULT_TRY_ON_MODEL,
  });
  const id = renderCacheId(input);
  const existing = await read(id);
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const inFlight = !!existing && existing.status.S !== "READY" && existing.status.S !== "FAILED" && existing.updatedAt.S! > staleBefore;
  // A fresh in-flight render is always joined, never doubled. A finished one
  // is reused unless the caller asked to regenerate; the new attempt writes a
  // new S3 key, so looks still pointing at the old image keep it.
  if (inFlight || (existing?.status.S === "READY" && !args.regenerate)) return { jobId: id, error: null };
  if (!process.env.OPENAI_API_KEY) throw new Error("Try-on rendering needs OPENAI_API_KEY configured on the server.");
  const attempt = randomUUID();
  const now = new Date().toISOString();
  const row: Row = {
    id: str(id), __typename: str("homeWardrobeTryOn"), ownerPersonId: str(args.personId),
    itemIds: list(input.garments.map(g => g.id)), referenceImageKeys: list(refs),
    stylingInstructions: str(input.stylingInstructions), renderInputs: str(JSON.stringify(input)),
    model: str(input.model), status: str("QUEUED"), attempt: str(attempt),
    createdAt: existing?.createdAt ?? str(now), updatedAt: str(now),
  };
  try {
    await db.send(new PutItemCommand({
      TableName: table, Item: row,
      ConditionExpression: args.regenerate
        ? "attribute_not_exists(id) OR #status = :failed OR #status = :ready OR updatedAt < :stale"
        : "attribute_not_exists(id) OR #status = :failed OR (#status <> :ready AND updatedAt < :stale)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":failed": str("FAILED"), ":ready": str("READY"), ":stale": str(staleBefore) },
    }));
  } catch (err) { if (conditional(err)) return { jobId: id, error: null }; throw err; }
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME!, InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ jobId: id, attempt })),
    }));
  } catch {
    // Dispatch failed before a worker could claim the queued row.
    await db.send(new UpdateItemCommand({
      TableName: table, Key: { id: str(id) },
      UpdateExpression: "SET #status = :failed, #error = :error, updatedAt = :now",
      ConditionExpression: "attempt = :attempt AND #status = :queued",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: { ":attempt": str(attempt), ":queued": str("QUEUED"), ":failed": str("FAILED"), ":error": str("Couldn't start the renderer. Please retry."), ":now": str(new Date().toISOString()) },
    }));
  }
  return { jobId: id, error: null };
}
export async function handler(event: { arguments: Args } | Work) {
  if ("arguments" in event) {
    try { return await request(event.arguments); }
    catch (err) { return { jobId: null, error: err instanceof Error ? err.message : "Couldn't start try-on." }; }
  }
  await processJob(event);
}
