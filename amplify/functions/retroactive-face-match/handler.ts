import type { AppSyncResolverHandler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import {
  RekognitionClient,
  SearchFacesCommand,
} from "@aws-sdk/client-rekognition";
import { env } from "$amplify/env/retroactive-face-match";
import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const rek = new RekognitionClient({});

const COLLECTION_ID = process.env.REKOGNITION_COLLECTION_ID!;

// Require at least this many enrolled homePersonFace rows for a person
// before the retroactive sweep runs. Lower counts produce low-confidence
// matches and lots of false positives — with 5+ templates Rekognition has
// enough variation to anchor the person's identity across angles/lighting.
const MIN_ENROLLMENTS = 5;

// SearchFaces similarity threshold for retroactive matching. Deliberately
// HIGHER than the per-photo face-detector threshold (85%) because false
// positives here pollute history rather than just the current upload.
const SIMILARITY_THRESHOLD = 90;

// Cap on matches per enrolled face. Rekognition allows up to 4096 but
// we'd rather do many smaller searches with dedup than one huge one.
const MAX_FACES_PER_SEARCH = 500;

// Concurrency for the final homePhotoFace update pass. Higher is faster
// but stresses AppSync — 10 is comfortable.
const UPDATE_CONCURRENCY = 10;

type RetroactiveArgs = {
  personId: string;
};

type RetroactiveResponse = {
  status: "MATCHED" | "SKIPPED";
  reason: string | null;
  enrolledCount: number;
  candidateCount: number;
  updatedCount: number;
};

export const handler: AppSyncResolverHandler<
  RetroactiveArgs,
  RetroactiveResponse
> = async (event) => {
  const { personId } = event.arguments;
  console.log(`Retroactive face match for person ${personId}`);

  // ── Step 1: gather this person's enrolled faces ─────────────────────────
  // These are the "templates" Rekognition will search with. Paginate just
  // in case the person has a lot of enrollments.
  const enrolledFaceIds: string[] = [];
  let nextToken: string | null | undefined = undefined;
  do {
    const page: any = await client.models.homePersonFace.list({
      filter: { personId: { eq: personId } },
      limit: 200,
      nextToken: nextToken ?? undefined,
    });
    for (const row of (page.data ?? []) as Array<{ rekognitionFaceId: string | null }>) {
      if (row.rekognitionFaceId) enrolledFaceIds.push(row.rekognitionFaceId);
    }
    nextToken = page.nextToken;
  } while (nextToken);

  console.log(`  Enrolled faces: ${enrolledFaceIds.length}`);

  if (enrolledFaceIds.length < MIN_ENROLLMENTS) {
    return {
      status: "SKIPPED",
      reason: `Need ${MIN_ENROLLMENTS}+ enrolled faces for this person (have ${enrolledFaceIds.length})`,
      enrolledCount: enrolledFaceIds.length,
      candidateCount: 0,
      updatedCount: 0,
    };
  }

  // ── Step 2: collect candidate FaceIds from Rekognition ──────────────────
  // For each enrolled template, SearchFaces finds similar faces in the
  // collection (includes the template itself as a 100% self-match, plus
  // every unmatched candidate face the face-detector has written).
  // Dedupe by FaceId and remember the highest similarity seen.
  const candidateSimilarity = new Map<string, number>();
  const enrolledSet = new Set(enrolledFaceIds);

  for (const enrolledId of enrolledFaceIds) {
    try {
      const res = await rek.send(
        new SearchFacesCommand({
          CollectionId: COLLECTION_ID,
          FaceId: enrolledId,
          FaceMatchThreshold: SIMILARITY_THRESHOLD,
          MaxFaces: MAX_FACES_PER_SEARCH,
        })
      );
      for (const match of res.FaceMatches ?? []) {
        const id = match.Face?.FaceId;
        const sim = match.Similarity ?? 0;
        if (!id) continue;
        // Skip the enrolled templates themselves — those already belong
        // to this person via homePersonFace, not homePhotoFace.
        if (enrolledSet.has(id)) continue;
        const prev = candidateSimilarity.get(id) ?? 0;
        if (sim > prev) candidateSimilarity.set(id, sim);
      }
    } catch (err: any) {
      console.error(
        `  SearchFaces failed for enrolled face ${enrolledId}: ${err?.message ?? err}`
      );
    }
  }

  console.log(`  Candidate FaceIds: ${candidateSimilarity.size}`);

  if (candidateSimilarity.size === 0) {
    return {
      status: "MATCHED",
      reason: null,
      enrolledCount: enrolledFaceIds.length,
      candidateCount: 0,
      updatedCount: 0,
    };
  }

  // ── Step 3: find unmatched homePhotoFace rows whose rekognitionFaceId
  // is in the candidate set. The model doesn't have a GSI on
  // rekognitionFaceId, so we list all rows with personId missing and
  // filter in-memory. For our dataset (<5k rows) this is fine and avoids
  // a schema migration.
  const unmatchedRows: Array<{ id: string; rekognitionFaceId: string }> = [];
  nextToken = undefined;
  do {
    const page: any = await client.models.homePhotoFace.list({
      filter: { personId: { attributeExists: false } },
      limit: 200,
      nextToken: nextToken ?? undefined,
    });
    for (const row of (page.data ?? []) as Array<{
      id: string;
      rekognitionFaceId: string | null;
    }>) {
      if (!row.rekognitionFaceId) continue;
      if (candidateSimilarity.has(row.rekognitionFaceId)) {
        unmatchedRows.push({
          id: row.id,
          rekognitionFaceId: row.rekognitionFaceId,
        });
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);

  console.log(`  Unmatched homePhotoFace rows to update: ${unmatchedRows.length}`);

  // ── Step 4: update each matching row, assigning personId and similarity.
  // We use a small worker pool so we don't fire 100s of mutations in a
  // single tick. Each update is idempotent — Amplify Data does a
  // conditional write under the hood so re-running is safe.
  let updatedCount = 0;
  const queue = [...unmatchedRows];

  async function worker() {
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row) break;
      try {
        const sim = candidateSimilarity.get(row.rekognitionFaceId) ?? null;
        const { errors } = await client.models.homePhotoFace.update({
          id: row.id,
          personId,
          similarity: sim,
        });
        if (errors?.length) {
          console.error(
            `  Failed to update ${row.id}: ${JSON.stringify(errors)}`
          );
        } else {
          updatedCount++;
        }
      } catch (err: any) {
        console.error(`  Update threw for ${row.id}: ${err?.message ?? err}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: UPDATE_CONCURRENCY }, () => worker())
  );

  console.log(
    `  Updated ${updatedCount}/${unmatchedRows.length} rows for person ${personId}`
  );

  return {
    status: "MATCHED",
    reason: null,
    enrolledCount: enrolledFaceIds.length,
    candidateCount: candidateSimilarity.size,
    updatedCount,
  };
};
