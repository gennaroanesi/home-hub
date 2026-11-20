/**
 * Review the family graph (lib/relationship-review.ts): words to fill in or
 * fix ("child" where he's clearly a son), relationships the existing ones
 * imply (a sibling's cousins, grandparents, aunts / uncles, in-laws), and
 * anything that needs a human (conflicting words).
 *
 * Usage (repo root; signs in with PRD_USER / PRD_PASS from .env.local):
 *   npx tsx --env-file=.env.local scripts/review-relationships.ts <amplify_outputs.json>
 *     → prints the review, numbered. Nothing is written.
 *   … --apply-words          apply every word fix
 *   … --apply 3,5,12         apply these suggestions (numbers from the review)
 *   … --apply likely         apply every "likely" suggestion ("maybe" ones only by number)
 * Writes go through the save_relationship op (one row per pair, inverse derived).
 * Run it again after applying: new links can imply more (Cris's cousins'
 * parents become her aunts and uncles once they're linked).
 */

import { readFileSync } from "node:fs";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { listAllPages } from "../lib/list-all";
import { RELATION_LABELS } from "../lib/relationships";
import { reviewWords, suggestRelationships } from "../lib/relationship-review";

const outputs = process.argv[2];
if (!outputs) throw new Error("usage: review-relationships.ts <amplify_outputs.json> [--apply-words] [--apply 1,2,3|likely]");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? "");
};
const applyWords = process.argv.includes("--apply-words");
const applyPick = arg("--apply");

async function main() {
  Amplify.configure(JSON.parse(readFileSync(outputs, "utf8")), { ssr: false });
  await signOut().catch(() => {});
  await signIn({ username: process.env.PRD_USER!, password: process.env.PRD_PASS! });
  const client = generateClient<any>({ authMode: "userPool" }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const op = async (name: string, input: unknown) => {
    const r = await client.mutations.runOp({ name, input: JSON.stringify(input), via: "web" });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    let data = r.data;
    while (typeof data === "string") data = JSON.parse(data);
    if (data.error) throw new Error(`${name}: ${data.error}`);
    return data.result;
  };

  const [people, rows] = await Promise.all([listAllPages<any>(client.models.homePerson), listAllPages<any>(client.models.homePersonRelationship)]); // eslint-disable-line @typescript-eslint/no-explicit-any
  const names = new Map<string, string>(people.map((p: any) => [p.id, p.name])); // eslint-disable-line @typescript-eslint/no-explicit-any
  const n = (id: string) => names.get(id) ?? id;
  const { fixes, conflicts } = reviewWords(rows, names);
  const suggestions = suggestRelationships(rows, names);

  console.log(`${people.length} people, ${rows.length} relationships\n`);
  console.log(`== Words (${fixes.length})${applyWords ? "" : "  — apply with --apply-words"}`);
  for (const f of fixes) console.log(`  ${n(f.personId)} ↔ ${n(f.relatedPersonId)}: ${f.changes.join("; ")}`);
  if (conflicts.length) {
    console.log(`\n== Needs a look (${conflicts.length})`);
    for (const c of conflicts) console.log(`  ${c.note}`);
  }
  console.log(`\n== Suggested relationships (${suggestions.length})${applyPick ? "" : "  — apply with --apply <numbers> or --apply likely"}`);
  suggestions.forEach((s, i) => {
    const words = [s.label, s.inverseLabel].some(Boolean) ? ` (${s.label ?? RELATION_LABELS[s.kind]} / ${s.inverseLabel ?? "…"})` : "";
    console.log(`  ${String(i + 1).padStart(3)}. ${s.confidence === "maybe" ? "maybe " : ""}${n(s.personId)} is ${RELATION_LABELS[s.kind]} of ${n(s.relatedPersonId)}${words}  ← ${s.reason}`);
  });

  if (applyWords) {
    for (const f of fixes) await op("save_relationship", { relationshipId: f.relationshipId, kind: f.kind, label: f.label, inverseLabel: f.inverseLabel });
    console.log(`\nSaved ${fixes.length} word fixes.`);
  }
  if (applyPick) {
    const picked =
      applyPick === "likely"
        ? suggestions.filter((s) => s.confidence === "likely")
        : applyPick.split(",").map((x) => {
            const s = suggestions[Number(x.trim()) - 1];
            if (!s) throw new Error(`No suggestion ${x}`);
            return s;
          });
    for (const s of picked) await op("save_relationship", { personId: s.personId, relatedPersonId: s.relatedPersonId, kind: s.kind, label: s.label, inverseLabel: s.inverseLabel });
    console.log(`\nAdded ${picked.length} relationships. Run again: new links can imply more.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
