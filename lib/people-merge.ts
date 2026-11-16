// Merging two homePerson rows with the admin-only mergePeople mutation
// (amplify/functions/merge-people/handler.ts): every personId reference
// to the source is rewritten to the target, then the source row is
// deleted. The copy and the result summary are shared by the web
// MergeModal (components/people.tsx) and the mobile "Merge into…"
// action (mobile/components/MergePersonButton.tsx).

type Named = { id: string; name: string; cognitoUsername?: string | null };

/** What a merge does, shown before picking the target. */
export function mergeExplainer(source: Named): string {
  const lines = [
    `Every reference to ${source.name} (tasks, events, photo tags, documents, reminders, relationships, etc.) will be rewritten to point at the person you pick, then ${source.name}'s row will be deleted.`,
    "Only references move: name, phone, birthday, notes and other fields on this row aren't copied.",
  ];
  if (source.cognitoUsername) {
    lines.push(`${source.name} has a login linked to this row; it won't be linked to anyone after the merge.`);
  }
  return lines.join(" ");
}

export function mergeConfirmTitle(source: Named, target: Named): string {
  return `Merge ${source.name} into ${target.name}?`;
}

export function mergeConfirmBody(source: Named, target: Named): string {
  return `Every reference to ${source.name} will point at ${target.name}, and ${source.name}'s row will be deleted. This can't be undone.`;
}

/** Everyone the source can be merged into (anyone but itself). */
export function mergeCandidates<P extends { id: string }>(people: P[], sourceId: string): P[] {
  return people.filter((p) => p.id !== sourceId);
}

const REWRITE_LABELS: Record<string, string> = {
  "homeTask.assignedPersonIds": "Tasks",
  "homeCalendarEvent.assignedPersonIds": "Events",
  "homeCalendarDay.personId": "Calendar days",
  "homePersonFace.personId": "Face samples",
  "homePhotoFace.personId": "Photo tags",
  "homeDocument.ownerPersonId": "Documents",
  "homePersonAuth.personId": "Duo link",
  "homePendingAuthChallenge.personId": "Pending approvals",
  "homeDocumentAccessLog.personId": "Document access log",
  "homeDeviceAction.personId": "Device actions",
  "homeOutboundMessage.personId": "Messages",
  "homePushSubscription.personId": "Push subscriptions",
  "homeReminder.personId": "Reminders",
  "homePersonRelationship.moved": "Relationships moved",
  "homePersonRelationship.dropped": "Duplicate relationships dropped",
};

/** The mutation's `rewrites` (AWSJSON: a JSON string or an object) as counts. */
export function parseMergeRewrites(raw: unknown): Record<string, number> {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const num = typeof n === "number" ? n : Number(n);
    if (Number.isFinite(num) && num > 0) out[k] = num;
  }
  return out;
}

function labelFor(key: string): string {
  if (REWRITE_LABELS[key]) return REWRITE_LABELS[key];
  // Unknown model added to the handler later: "homeFooBar.personId" → "Foo bar".
  const model = key.split(".")[0].replace(/^home/, "");
  const words = model.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Tasks: 3", "Photo tags: 12", … in a stable order (largest first). */
export function mergeRewriteLines(raw: unknown): string[] {
  return Object.entries(parseMergeRewrites(raw))
    .sort((a, b) => b[1] - a[1] || labelFor(a[0]).localeCompare(labelFor(b[0])))
    .map(([k, n]) => `${labelFor(k)}: ${n}`);
}

/** Message shown after a merge succeeds. */
export function mergeSummary(source: Named, target: Named, raw: unknown): string {
  const lines = mergeRewriteLines(raw);
  const head = `${source.name} was merged into ${target.name}.`;
  return lines.length ? `${head}\n\n${lines.join("\n")}` : `${head} Nothing else referenced ${source.name}.`;
}
