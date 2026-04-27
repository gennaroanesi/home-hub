// mergePeople — admin-only mutation that rewrites every reference to
// `sourceId` in the data layer to `targetId`, then deletes the source
// homePerson row.
//
// Used when:
//   - Two homePerson rows exist for the same human (typically a
//     face-tag row pre-dating sign-up that the post-confirm Lambda
//     didn't auto-link).
//   - The "Link" admin action: pass the freshly-created sub row as
//     source and the pre-existing face row as target. The UI is
//     expected to copy cognitoUsername / email / groups onto the
//     target *before* invoking this mutation, so the source is
//     truly redundant by the time we delete it.
//
// Conservatively single-threaded — we walk one model at a time so
// errors mid-walk leave a partially-rewritten state that's still
// readable. The admin can re-run the mutation; rewrites are
// idempotent (already-rewritten rows match neither source nor
// target uniquely, but the array deduper drops the source from
// arrays even when target was already present).
//
// Models that reference homePerson by id (kept in sync with the
// schema; if a new model adds a personId field, add it here):
//
//   single-id:
//     homeCalendarDay.personId            (required)
//     homePersonFace.personId             (required)
//     homePhotoFace.personId              (optional)
//     homeDocument.ownerPersonId          (optional)
//     homePersonAuth.personId             (required)
//     homePendingAuthChallenge.personId   (required)
//     homeDocumentAccessLog.personId      (optional)
//     homeDeviceAction.personId           (optional)
//     homeOutboundMessage.personId        (optional)
//     homePushSubscription.personId       (required)
//     homeReminder.personId               (optional)
//
//   array:
//     homeTask.assignedPersonIds
//     homeBill.assignedPersonIds
//     homeCalendarEvent.assignedPersonIds

import type { AppSyncResolverHandler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/merge-people";
import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

interface Args {
  sourceId: string;
  targetId: string;
}

interface Identity {
  groups?: string[];
  username?: string;
}

interface MergeResult {
  ok: boolean;
  rewrites: Record<string, number>;
  targetId: string;
}

// Pull every page of a list+filter, since a merge needs to find ALL
// references not just the first page.
async function listAll<T>(
  fetchPage: (nextToken: string | null) => Promise<{
    data: T[] | null | undefined;
    nextToken?: string | null | undefined;
  }>
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | null = null;
  // 50 pages of default 100 = 5k rows. More than any household model
  // realistically holds; the cap stops a runaway nextToken loop.
  for (let i = 0; i < 50; i++) {
    const { data, nextToken: nt } = await fetchPage(nextToken);
    if (data) out.push(...data);
    if (!nt) return out;
    nextToken = nt;
  }
  return out;
}

export const handler: AppSyncResolverHandler<Args, MergeResult> = async (event) => {
  const identity = event.identity as Identity | undefined;
  if (!identity?.groups?.includes("admins")) {
    throw new Error("Forbidden: admins only");
  }

  const { sourceId, targetId } = event.arguments;
  if (!sourceId || !targetId) {
    throw new Error("sourceId and targetId are required");
  }
  if (sourceId === targetId) {
    throw new Error("sourceId and targetId must differ");
  }

  // Sanity: target must exist; source must exist (we'll delete it).
  const [{ data: src }, { data: tgt }] = await Promise.all([
    client.models.homePerson.get({ id: sourceId }),
    client.models.homePerson.get({ id: targetId }),
  ]);
  if (!tgt) throw new Error(`target homePerson ${targetId} not found`);
  if (!src) throw new Error(`source homePerson ${sourceId} not found`);

  const rewrites: Record<string, number> = {};

  // ── single-id model rewrites ─────────────────────────────────────────────
  type Model = keyof Schema;
  const singleIdRewrites: { model: Model; field: string }[] = [
    { model: "homeCalendarDay" as Model, field: "personId" },
    { model: "homePersonFace" as Model, field: "personId" },
    { model: "homePhotoFace" as Model, field: "personId" },
    { model: "homeDocument" as Model, field: "ownerPersonId" },
    { model: "homePersonAuth" as Model, field: "personId" },
    { model: "homePendingAuthChallenge" as Model, field: "personId" },
    { model: "homeDocumentAccessLog" as Model, field: "personId" },
    { model: "homeDeviceAction" as Model, field: "personId" },
    { model: "homeOutboundMessage" as Model, field: "personId" },
    { model: "homePushSubscription" as Model, field: "personId" },
    { model: "homeReminder" as Model, field: "personId" },
  ];

  for (const { model, field } of singleIdRewrites) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (client.models as any)[model];
    if (!m) continue;
    const rows = await listAll<{ id: string }>((nextToken) =>
      m.list({ filter: { [field]: { eq: sourceId } }, nextToken })
    );
    for (const r of rows) {
      await m.update({ id: r.id, [field]: targetId });
    }
    if (rows.length > 0) rewrites[`${String(model)}.${field}`] = rows.length;
  }

  // ── array-id model rewrites ──────────────────────────────────────────────
  // No server-side "array contains" filter — fetch everything and
  // walk client-side. These tables stay in the low hundreds for a
  // single household, so the scan is fine.
  const arrayRewrites: { model: Model; field: string }[] = [
    { model: "homeTask" as Model, field: "assignedPersonIds" },
    { model: "homeBill" as Model, field: "assignedPersonIds" },
    { model: "homeCalendarEvent" as Model, field: "assignedPersonIds" },
  ];

  for (const { model, field } of arrayRewrites) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (client.models as any)[model];
    if (!m) continue;
    type Row = { id: string; [k: string]: unknown };
    const rows = await listAll<Row>((nextToken) => m.list({ nextToken }));
    let count = 0;
    for (const r of rows) {
      const arr = (r[field] as (string | null | undefined)[] | null) ?? [];
      if (!arr.includes(sourceId)) continue;
      // Replace source with target, dedup so we don't end up with
      // [target, target] when target was already present.
      const next = [...new Set(arr.filter((x): x is string => !!x).map((x) =>
        x === sourceId ? targetId : x
      ))];
      await m.update({ id: r.id, [field]: next });
      count++;
    }
    if (count > 0) rewrites[`${String(model)}.${field}`] = count;
  }

  // ── delete the source ────────────────────────────────────────────────────
  await client.models.homePerson.delete({ id: sourceId });

  return { ok: true, rewrites, targetId };
};
