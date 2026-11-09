/**
 * Copies the household budget lines from gennaroanesi.com (financeBudget)
 * into home-hub (homeFinanceBudget): every version of each chosen series,
 * with labels, so staged 2027 plans come along. gennaroanesi.com is only
 * read. Category names are mapped to the household vocabulary; the
 * salary/bonus/RSU funding source is dropped (one household pool here).
 *
 * Re-run safe: copied rows carry "gennaroanesi.com series <id>" in notes
 * and a series already copied is skipped. Prints the plan unless --yes.
 *
 * Usage:
 *   npx tsx scripts/import-gennaroanesi-budgets.ts \
 *     --from <gennaroanesi.com prod amplify_outputs.json> --to <home-hub amplify_outputs.json> [--yes]
 * Env (.env.local): GA_USER/GA_PASS (gennaroanesi.com admin), PRD_USER/PRD_PASS (home-hub).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { validateBudgetHistory, type BudgetLine } from "../lib/finance/budget";

/* eslint-disable @typescript-eslint/no-explicit-any */

for (const line of readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}

/** Series to copy, by their gennaroanesi.com name → household name. */
const SERIES: Record<string, string> = {
  Mortgage: "Mortgage",
  Car: "Car",
  "Electrical, Water, Gas": "Electrical, Water, Gas",
  "Mobile + Wifi": "Mobile + Wifi",
  Groceries: "Groceries",
  Dolce: "Pets (Dolce)",
  Home: "Home",
  "Baby — essentials": "Baby — essentials",
  "Baby — one-time setup": "Baby — one-time setup",
  "Health insurance dependent delta": "Health insurance dependent delta",
  "Commute (Gas, Toll, Parking)": "Commute (Gas, Toll, Parking)",
  "Media Subscriptions (Streaming, Newspaper, etc)": "Media Subscriptions",
  Dining: "Dining",
  Delivery: "Delivery",
};

/** gennaroanesi.com category → household category (lib/finance/category-rules.json). */
const CATEGORY: Record<string, string> = { Dolce: "Pets", Media: "Streaming" };

const argv = process.argv;
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

async function session(outputs: any, user?: string, pass?: string) {
  if (!user || !pass) throw new Error("Missing login env vars (see header)");
  Amplify.configure(outputs, { ssr: false });
  await signOut().catch(() => {});
  const r = await signIn({ username: user, password: pass });
  if (!r.isSignedIn) throw new Error("Sign-in incomplete");
  return generateClient({ authMode: "userPool" }) as any;
}

async function main() {
  const fromPath = arg("from");
  const toPath = arg("to");
  if (!fromPath || !toPath) throw new Error("Usage: --from <gennaroanesi outputs> --to <home-hub outputs> [--yes]");
  const apply = argv.includes("--yes");

  // categories is an array field the typed client can drop: raw GraphQL.
  const src = await session(JSON.parse(readFileSync(fromPath, "utf8")), process.env.GA_USER, process.env.GA_PASS);
  const q = `query($t:String){ listFinanceBudgets(limit:1000,nextToken:$t){ items{ id seriesId name kind categories amount period rollover effectiveFrom effectiveTo active label notes } nextToken } }`;
  const rows: any[] = [];
  let t: string | null = null;
  do {
    const r: any = await src.graphql({ query: q, variables: { t } });
    rows.push(...r.data.listFinanceBudgets.items);
    t = r.data.listFinanceBudgets.nextToken;
  } while (t);
  await signOut().catch(() => {});

  const chosen = rows.filter((r) => SERIES[r.name] && (r.kind ?? "EXPENSE") === "EXPENSE");
  const missing = Object.keys(SERIES).filter((n) => !chosen.some((r) => r.name === n));
  if (missing.length) console.log(`Not found in gennaroanesi.com: ${missing.join(", ")}`);

  const dst = await session(JSON.parse(readFileSync(toPath, "utf8")), process.env.TO_USER ?? process.env.PRD_USER, process.env.TO_PASS ?? process.env.PRD_PASS);
  const existing: any[] = [];
  let nt: string | null = null;
  do {
    const r: any = await dst.models.homeFinanceBudget.list({ limit: 1000, nextToken: nt });
    existing.push(...(r.data ?? []));
    nt = r.nextToken;
  } while (nt);
  const copied = new Set(existing.map((b) => /gennaroanesi\.com series (\S+)/.exec(b.notes ?? "")?.[1]).filter(Boolean));

  const newSeries = new Map<string, string>();
  const plan: BudgetLine[] = [];
  for (const r of chosen.sort((a, b) => a.name.localeCompare(b.name) || (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? ""))) {
    if (copied.has(r.seriesId)) continue;
    if (!newSeries.has(r.seriesId)) newSeries.set(r.seriesId, randomUUID());
    plan.push({
      id: `new-${plan.length}`,
      seriesId: newSeries.get(r.seriesId)!,
      name: SERIES[r.name],
      kind: "EXPENSE",
      personId: null,
      categories: [...new Set<string>((r.categories ?? []).filter(Boolean).map((c: string) => CATEGORY[c] ?? c))],
      amount: r.amount,
      period: r.period ?? "MONTHLY",
      rollover: r.rollover ?? false,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo ?? null,
      active: r.active !== false,
      label: r.label ?? null,
      notes: [r.notes, `Copied from gennaroanesi.com series ${r.seriesId}`].filter(Boolean).join("\n"),
    });
  }

  console.log(`home-hub: ${existing.length} budget rows already, ${copied.size} series previously copied`);
  console.log(`To copy: ${plan.length} rows in ${newSeries.size} series`);
  for (const l of plan) console.log(`  ${l.name.padEnd(34)} $${Number(l.amount).toFixed(2)}/${l.period}  ${l.effectiveFrom}→${l.effectiveTo ?? "open"}  [${(l.categories ?? []).join(", ")}]${l.label ? `  "${l.label}"` : ""}`);
  const issues = validateBudgetHistory([...existing, ...plan], new Date().toISOString().slice(0, 10)).concat(validateBudgetHistory([...existing, ...plan], "2027-06-01"));
  for (const i of issues) console.log(`  ! ${i.name}: ${i.detail}`);
  if (!apply) {
    console.log("\nDry run. Re-run with --yes to copy.");
    return;
  }
  let n = 0;
  for (const { id: _id, ...row } of plan) {
    const r = await dst.models.homeFinanceBudget.create(row);
    if (r.errors?.length) console.log(`  ! ${row.name} ${row.effectiveFrom}: ${r.errors[0].message}`);
    else n++;
  }
  console.log(`\nCopied ${n} budget rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
