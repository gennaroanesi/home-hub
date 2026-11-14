// Server side of the document vault's two-step access (used by
// pages/api/documents/[id]/*): load the document as the caller, find
// their Duo account, and sign a short-lived link to the file.

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { appsyncAsUser } from "@/lib/appsync-as-user";

const BUCKET = process.env.HOME_HUB_BUCKET ?? "";
const s3 = new S3Client({ region: "us-east-1" });

export interface VaultDocument {
  id: string;
  title: string;
  s3Key: string | null;
  documentNumber: string | null;
  originalFilename: string | null;
  isSensitive: boolean | null;
}

export async function loadDocumentAs(accessToken: string, id: string): Promise<VaultDocument | null> {
  const data = await appsyncAsUser<{ getHomeDocument: VaultDocument | null }>(
    accessToken,
    `query G($id: ID!) { getHomeDocument(id: $id) { id title s3Key documentNumber originalFilename isSensitive } }`,
    { id },
  );
  return data.getHomeDocument;
}

/** The caller's Duo username: homePerson.cognitoUsername → homePersonAuth. Never someone else's. */
export async function duoUsernameFor(accessToken: string, cognitoUsername: string): Promise<string | null> {
  const data = await appsyncAsUser<{
    listHomePeople: { items: Array<{ id: string; cognitoUsername: string | null }> };
    listHomePersonAuths: { items: Array<{ personId: string; duoUsername: string }> };
  }>(
    accessToken,
    `query { listHomePeople(limit: 1000) { items { id cognitoUsername } } listHomePersonAuths(limit: 1000) { items { personId duoUsername } } }`,
    {},
  );
  const me = data.listHomePeople.items.find((p) => p.cognitoUsername === cognitoUsername);
  if (!me) return null;
  return data.listHomePersonAuths.items.find((a) => a.personId === me.id)?.duoUsername ?? null;
}

/** 5-minute signed GET for a vault file. */
export async function signedDocumentUrl(doc: VaultDocument, download: boolean): Promise<string | null> {
  if (!doc.s3Key || !doc.s3Key.startsWith("home/documents/")) return null;
  const name = (doc.originalFilename || doc.s3Key.split("/").pop() || "document").replace(/["\\\r\n]/g, "");
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: doc.s3Key,
      ResponseContentDisposition: `${download ? "attachment" : "inline"}; filename="${name}"`,
    }),
    { expiresIn: 300 },
  );
}
