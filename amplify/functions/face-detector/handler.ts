import type { DynamoDBStreamHandler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import {
  RekognitionClient,
  IndexFacesCommand,
  SearchFacesCommand,
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

    try {
      const searchResult = await rek.send(
        new SearchFacesCommand({
          CollectionId: COLLECTION_ID,
          FaceId: candidateFaceId,
          FaceMatchThreshold: SIMILARITY_THRESHOLD,
          MaxFaces: 5,
        })
      );

      // Walk matches in descending similarity order (Rekognition returns
      // them sorted) and stop at the first one that maps to an enrolled
      // person. Self-matches and matches to other unmatched candidates
      // are filtered out implicitly via the homePersonFace lookup.
      for (const match of searchResult.FaceMatches ?? []) {
        const matchFaceId = match.Face?.FaceId;
        if (!matchFaceId || matchFaceId === candidateFaceId) continue;

        const enrolled = await client.models.homePersonFace.listhomePersonFaceByRekognitionFaceId({
          rekognitionFaceId: matchFaceId,
        });

        if (enrolled.data && enrolled.data.length > 0) {
          matchedPersonId = enrolled.data[0].personId;
          storedFaceId = matchFaceId; // store the canonical enrolled id
          similarity = match.Similarity ?? null;
          break;
        }
      }
    } catch (err: any) {
      console.error(`  SearchFaces failed for ${candidateFaceId}: ${err.message ?? err}`);
    }

    await client.models.homePhotoFace.create({
      photoId,
      personId: matchedPersonId,
      rekognitionFaceId: storedFaceId,
      similarity,
      boundingBox: boundingBox as any,
    });

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
