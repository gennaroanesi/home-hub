/**
 * One-time move of paychecks from gennaroanesi.com (financePaycheck, person
 * ME/SPOUSE, PDFs as `attachment` rows with parentType PAYCHECK) into
 * home-hub (homePaycheck keyed by personId, PDF copied to
 * home/finance/paychecks/<id>.pdf). Home-hub owns paychecks from now on.
 *
 * Re-run safe: each row carries importRef = the source id and is skipped
 * when already imported. Prints the plan and stops unless --yes.
 *
 * Usage:
 *   npx tsx scripts/import-gennaroanesi-paychecks.ts \
 *     --from <gennaroanesi.com prod amplify_outputs.json> \
 *     --to   <home-hub amplify_outputs.json> [--yes]
 *     [--me Gennaro] [--spouse Cristine] [--profile amplify-dev]
 *
 * Env (from the shell or home-hub's .env.local):
 *   GA_USER / GA_PASS     a gennaroanesi.com login in its admins group
 *   PRD_USER / PRD_PASS   a home-hub login in home-users (TO_USER/TO_PASS override)
 *   HOME_HUB_BUCKET       destination bucket for the PDFs
 * PDFs are copied with the AWS profile (S3 CopyObject); a PDF that can't be
 * copied is reported and the paycheck is imported without it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { CopyObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { randomUUID } from "node:crypto";
import { PAYCHECK_FIELDS } from "../lib/finance/paycheck-fields";
import { paycheckPdfKey } from "../lib/finance/finance-files";

/* eslint-disable @typescript-eslint/no-explicit-any */

for (const line of readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}

const argv = process.argv;
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const fromPath = arg("from");
const toPath = arg("to");
const apply = argv.includes("--yes");
const names = { ME: arg("me", "Gennaro")!, SPOUSE: arg("spouse", "Cristine")! };

async function listAll(model: any, filter?: any): Promise<any[]> {
  const out: any[] = [];
  let nextToken: string | null | undefined = null;
  do {
    const r: any = await model.list({ limit: 1000, nextToken, ...(filter ? { filter } : {}) });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    out.push(...(r.data ?? []));
    nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

async function session(outputs: any, user: string | undefined, pass: string | undefined, who: string) {
  if (!user || !pass) throw new Error(`Set the ${who} login (see the header)`);
  Amplify.configure(outputs, { ssr: false });
  await signOut().catch(() => {});
  const r = await signIn({ username: user, password: pass });
  if (!r.isSignedIn) throw new Error(`${who} sign-in incomplete: ${JSON.stringify(r.nextStep)}`);
  return generateClient({ authMode: "userPool" }) as any;
}

async function main() {
  if (!fromPath || !toPath) throw new Error("Usage: --from <gennaroanesi outputs> --to <home-hub outputs> [--yes]");
  const fromOutputs = JSON.parse(readFileSync(fromPath, "utf8"));
  const toOutputs = JSON.parse(readFileSync(toPath, "utf8"));
  const srcBucket: string | undefined = fromOutputs.storage?.bucket_name;
  const dstBucket = process.env.HOME_HUB_BUCKET;
  if (!dstBucket) throw new Error("HOME_HUB_BUCKET must be set");

  // ── Read from gennaroanesi.com ───────────────────────────────────────────
  const src = await session(fromOutputs, process.env.GA_USER, process.env.GA_PASS, "gennaroanesi.com (GA_USER/GA_PASS)");
  const paychecks = await listAll(src.models.financePaycheck);
  const attachments = (await listAll(src.models.attachment, { parentType: { eq: "PAYCHECK" } })).filter((a) => (a.contentType ?? "application/pdf").includes("pdf") || a.s3Key?.endsWith(".pdf"));
  await signOut().catch(() => {});
  const pdfOf = new Map<string, any>();
  for (const a of attachments) if (!pdfOf.has(a.parentId)) pdfOf.set(a.parentId, a);
  console.log(`gennaroanesi.com: ${paychecks.length} paychecks, ${pdfOf.size} with a PDF`);

  // ── Plan against home-hub ────────────────────────────────────────────────
  const dst = await session(toOutputs, process.env.TO_USER ?? process.env.PRD_USER, process.env.TO_PASS ?? process.env.PRD_PASS, "home-hub (PRD_USER/PRD_PASS)");
  const people = await listAll(dst.models.homePerson);
  const personId: Record<string, string | undefined> = {
    ME: people.find((p) => p.name === names.ME)?.id,
    SPOUSE: people.find((p) => p.name === names.SPOUSE)?.id,
  };
  if (!personId.ME || !personId.SPOUSE) throw new Error(`home-hub needs people named ${names.ME} and ${names.SPOUSE} (--me / --spouse)`);
  const already = new Set((await listAll(dst.models.homePaycheck)).map((p) => p.importRef).filter(Boolean));
  const todo = paychecks.filter((p) => !already.has(p.id));
  const unknown = todo.filter((p) => !personId[p.person]);
  const byYear = new Map<string, number>();
  for (const p of todo) byYear.set(`${p.person} ${p.payDate.slice(0, 4)}`, (byYear.get(`${p.person} ${p.payDate.slice(0, 4)}`) ?? 0) + 1);
  console.log(`home-hub: ${already.size} already imported, ${todo.length} to import`);
  for (const [k, n] of [...byYear].sort()) console.log(`  ${k}: ${n}`);
  if (unknown.length) console.log(`  ${unknown.length} have no person (ME/SPOUSE) and will be skipped`);
  if (!apply) {
    console.log("\nDry run. Re-run with --yes to import.");
    return;
  }

  const s3 = new S3Client({ region: "us-east-1", credentials: fromIni({ profile: arg("profile", "amplify-dev") }) });
  let imported = 0;
  let pdfs = 0;
  const failures: string[] = [];
  for (const p of todo) {
    const pid = personId[p.person];
    if (!pid) continue;
    const id = randomUUID();
    let s3KeyPdf: string | null = null;
    const att = pdfOf.get(p.id);
    if (att && srcBucket) {
      try {
        await s3.send(new CopyObjectCommand({ Bucket: dstBucket, Key: paycheckPdfKey(id), CopySource: encodeURI(`${srcBucket}/${att.s3Key}`), ContentType: "application/pdf", MetadataDirective: "REPLACE" }));
        s3KeyPdf = paycheckPdfKey(id);
        pdfs++;
      } catch (e) {
        failures.push(`${p.payDate} ${p.person}: PDF not copied (${e instanceof Error ? e.message : e})`);
      }
    }
    const row: Record<string, unknown> = { id, personId: pid, source: "IMPORT", importRef: p.id, s3KeyPdf, notes: p.notes ?? null };
    for (const k of PAYCHECK_FIELDS) if (p[k] !== undefined && p[k] !== null) row[k] = p[k];
    if (p.lineItems != null) row.lineItems = typeof p.lineItems === "string" ? p.lineItems : JSON.stringify(p.lineItems);
    const r = await dst.models.homePaycheck.create(row);
    if (r.errors?.length) failures.push(`${p.payDate} ${p.person}: ${r.errors[0].message}`);
    else imported++;
  }
  console.log(`\nImported ${imported} paychecks (${pdfs} PDFs copied).`);
  for (const f of failures) console.log(`  ! ${f}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
