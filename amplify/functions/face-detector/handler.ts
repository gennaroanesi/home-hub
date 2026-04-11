import type { DynamoDBStreamHandler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import {
  RekognitionClient,
  IndexFacesCommand,
  SearchFacesCommand,
  type SearchFacesCommandOutput,
  DeleteFacesCommand,
} from "@aws-sdk/client-rekognition";
import { env } from "$amplify/env/face-detector";
import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const rek = new RekognitionClient({});

const COLLECTION_ID = process.env.REKOGNITION_COLLECTION_ID!;
const PHOTOS_BUCKET = process.env.PHOTOS_BUCKET!;
const SIMILARITY_THRESHOLD = 85;

/**
 * Triggered by the homePhoto DynamoDB stream on INSERT. For each new photo:
 *   1. IndexFaces on the S3 image — Rekognition detects all faces and adds
 *      them to the shared collection (giving each a fresh FaceId).
 *   2. For every detected face, SearchFaces by that FaceId. We walk the
 *      results and look for the first one that maps to a homePersonFace
 *      row — that's a hit on an *enrolled* face.
 *   3. If matched, write homePhotoFace with personId set, then delete the
 *      newly-indexed face (it's redundant — the enrolled face already
 *      represents this person). If unmatched, write homePhotoFace with
 *      personId=null and KEEP the new face in the collection so the
 *      admin /admin/faces page can later enroll it (linking it to a
 *      person creates a homePersonFace row pointing at this same id).
 *
 * Why one collection (not two): SearchFaces only searches within the
 * collection containing the source FaceId, so we have to put the candidate
 * face in the same collection as the enrolled faces. The enrolled-vs-not
 * filter happens via the homePersonFace lookup — anything not in that
 * table is treated as a candidate, never as a match.
 */
export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName !== "INSERT") continue;

    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;

    const photoId = newImage.id?.S;
    const s3key = newImage.s3key?.S;
    const contentType = newImage.contentType?.S;

    if (!photoId || !s3key) continue;

    // Rekognition only supports JPEG and PNG. Skip everything else
    // (HEIC/HEIF from iPhones, raw files from Lightroom imports of
    // non-raw originals, video, etc).
    if (contentType && !["image/jpeg", "image/jpg", "image/png"].includes(contentType)) {
      console.log(`Skipping ${photoId} — unsupported content type ${contentType}`);
      continue;
    }

    try {
      await processPhoto(photoId, s3key);
    } catch (err) {
      console.error(`Failed to process photo ${photoId} (${s3key}):`, err);
    }
  }
};

async function processPhoto(photoId: string, s3key: string) {
  console.log(`Processing photo ${photoId} (${s3key})`);

  let indexResult;
  try {
    indexResult = await rek.send(
      new IndexFacesCommand({
        CollectionId: COLLECTION_ID,
        Image: { S3Object: { Bucket: PHOTOS_BUCKET, Name: s3key } },
        DetectionAttributes: [],
        MaxFaces: 20,
        QualityFilter: "AUTO",
      })
    );
  } catch (err: any) {
    // InvalidImageFormatException, InvalidS3ObjectException, etc — log and skip
    console.error(`  IndexFaces failed: ${err.name ?? "unknown"} — ${err.message ?? err}`);
    return;
  }

  const faceRecords = indexResult.FaceRecords ?? [];
  if (faceRecords.length === 0) {
    console.log(`  No faces detected`);
    return;
  }

  console.log(`  Detected ${faceRecords.length} face(s)`);

  // FaceIds we should delete after processing — populated for matched
  // faces (the enrolled face already represents the same person).
  const faceIdsToDelete: string[] = [];

  for (const fr of faceRecords) {
    const candidateFaceId = fr.Face?.FaceId;
    const boundingBox = fr.Face?.BoundingBox;
    if (!candidateFaceId) continue;

    let matchedPersonId: string | null = null;
    let storedFaceId: string = candidateFaceId;
    let similarity: number | null = null;

    // Rekognition collections have a brief eventual-consistency window after
    // IndexFaces — calling SearchFaces with the just-indexed FaceId can fail
    // with "faceId was not found in the collection" for a few hundred ms.
    // Retry up to 3 times with backoff before giving up and treating the
    // face as unmatched.
    let searchResult: SearchFacesCommandOutput | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        searchResult = await rek.send(
          new SearchFacesCommand({
            CollectionId: COLLECTION_ID,
            FaceId: candidateFaceId,
            FaceMatchThreshold: SIMILARITY_THRESHOLD,
            MaxFaces: 5,
          })
        );
        break;
      } catch (err: any) {
        const isLast = attempt === 2;
        if (isLast) {
          console.error(
            `  SearchFaces failed for ${candidateFaceId} after ${attempt + 1} attempts: ${err.message ?? err}`
          );
        } else {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
    }

    if (searchResult) {
      // Walk matches in descending similarity order (Rekognition returns
      // them sorted) and stop at the first one that maps to an enrolled
      // person. Self-matches and matches to other unmatched candidates
      // are filtered out implicitly via the homePersonFace lookup.
      for (const match of searchResult.FaceMatches ?? []) {
        const matchFaceId = match.Face?.FaceId;
        if (!matchFaceId || matchFaceId === candidateFaceId) continue;

        // Use a plain `list` with a filter rather than the generated index
        // method (`list*ByRekognitionFaceId`) — Amplify Gen 2 has a casing
        // inconsistency between the typed client and the bundled GraphQL
        // queries that breaks the index method on Lambda runtimes. The
        // filter is fine here because the rekognitionFaceId matches are
        // exact and the result set is tiny (one row per enrolled face).
        const enrolled = await client.models.homePersonFace.list({
          filter: { rekognitionFaceId: { eq: matchFaceId } },
          limit: 1,
        });

        if (enrolled.data && enrolled.data.length > 0) {
          matchedPersonId = enrolled.data[0].personId;
          storedFaceId = matchFaceId; // store the canonical enrolled id
          similarity = match.Similarity ?? null;
          break;
        }
      }
    }

    // Build the create input as a sparse object — DynamoDB GSIs reject
    // null values for indexed attributes (homePhotoFace has a GSI on
    // personId), so we have to OMIT personId entirely for unmatched faces
    // rather than passing null. The Amplify Data client drops fields that
    // aren't present in the input, which produces a sparse-index-friendly
    // PutItem. Same applies to similarity (no GSI on it but be defensive
    // and avoid sending nulls when we don't have a value).
    //
    // boundingBox is `a.json()` in the schema → AWSJSON scalar → must be
    // sent as a JSON-encoded STRING, not the raw object. Passing the raw
    // BoundingBox literal results in
    // `Variable 'boundingBox' has an invalid value.` from AppSync.
    const createInput: Parameters<typeof client.models.homePhotoFace.create>[0] = {
      photoId,
      rekognitionFaceId: storedFaceId,
      boundingBox: boundingBox ? (JSON.stringify(boundingBox) as any) : undefined,
    };
    if (matchedPersonId) createInput.personId = matchedPersonId;
    if (similarity !== null) createInput.similarity = similarity;

    const { errors: createErrors } = await client.models.homePhotoFace.create(createInput);
    if (createErrors?.length) {
      // The Amplify Data client returns errors in `errors` instead of
      // throwing — without this check the previous version was silently
      // dropping every face write and producing zero homePhotoFace rows.
      console.error(
        `  Failed to create homePhotoFace for ${storedFaceId}: ${JSON.stringify(createErrors)}`
      );
      continue;
    }

    if (matchedPersonId) {
      // Matched → the enrolled face already covers this person; the
      // newly-indexed candidate is redundant, so delete it.
      faceIdsToDelete.push(candidateFaceId);
      console.log(`  ✓ matched person ${matchedPersonId} (${similarity?.toFixed(1)}%)`);
    } else {
      // Unmatched → keep the candidate in the collection so /admin/faces
      // can later enroll it by linking this rekognitionFaceId to a person.
      console.log(`  ? unmatched face (kept in collection as ${candidateFaceId})`);
    }
  }

  if (faceIdsToDelete.length > 0) {
    try {
      await rek.send(
        new DeleteFacesCommand({
          CollectionId: COLLECTION_ID,
          FaceIds: faceIdsToDelete,
        })
      );
    } catch (err: any) {
      console.error(`  DeleteFaces cleanup failed: ${err.message ?? err}`);
    }
  }
}
