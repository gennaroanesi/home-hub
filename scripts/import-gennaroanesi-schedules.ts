/**
 * Copy household bills from gennaroanesi.com's financeRecurring into
 * homeFinanceRecurring, through save_finance_schedule on the ops Lambda (so
 * the same validation applies). Only the rules named in BILLS: the old site
 * mixes household bills with personal ones (software, flying, SHTF).
 *
 * They're paid from Gennaro's own Chase / AMEX but are household spending,
 * so each gets ledger "household". The old site's next dates went stale
 * when it stopped syncing; each one is rolled forward (on its own day of
 * the month) to the first due date on or after FROM, so this month's
 * payments can be linked (link_finance_schedules). Patterns: the old one
 * where it worked, a fixed or new one where it didn't (see BILLS).
 *
 * Usage:
 *   1. Dump the old rules (read-only; GA_USER / GA_PASS, gennaroanesi.com's
 *      amplify_outputs.json) to a JSON file { rec, acc }.
 *   2. AWS_PROFILE=amplify-dev npx tsx scripts/import-gennaroanesi-schedules.ts <dump.json> <ops-lambda-name> <cognito-username> [--yes]
 * Without --yes it prints the plan. Re-running skips bills already there
 * (same description).
 */

import { readFileSync } from "node:fs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { advanceByCadence, monthlyAnchor, type Cadence } from "../lib/finance/dates";

const FROM = "2026-11-01";

// Old description → category here, the match pattern when the old one was
// missing or wrong, and `due`: November's date as the bank shows it, when
// it differs from the old site's day (that day then carries on monthly).
const BILLS: Record<string, { category: string; pattern?: string; due?: string }> = {
  Gas: { category: "Utilities", due: "2026-11-03" },
  "Water/waste": { category: "Utilities", pattern: "CITY OF ROUND RO" }, // old "ROUND DO" never matched
  Internet: { category: "Utilities", pattern: "ATT PAYMENT", due: "2026-11-06" },
  Mobile: { category: "Mobile", pattern: "ATT PAYMENT", due: "2026-11-09" },
  Electricity: { category: "Utilities", due: "2026-11-12" },
  "Apple Icloud+": { category: "Subscriptions", pattern: "APPLE.COM/BILL" },
  "Apple One": { category: "Subscriptions", pattern: "APPLE.COM/BILL" },
  "Hulu + Disney + ESPN": { category: "Streaming", pattern: "/hulu|disney/i" },
  Netflix: { category: "Streaming", pattern: "NETFLIX" },
  "ESPN Unlimited": { category: "Streaming", pattern: "ESPN" },
  Peacock: { category: "Streaming", pattern: "PEACOCK" },
  "HBO Max": { category: "Streaming", due: "2026-11-11" },
  "Youtube Premium": { category: "Streaming", pattern: "YOUTUBE" },
  Spotify: { category: "Streaming", pattern: "SPOTIFY" },
  "Paramount+": { category: "Streaming" },
  Banfield: { category: "Pets", due: "2026-11-05" },
  Barkio: { category: "Pets", pattern: "BARKIO" },
  Hydrow: { category: "Memberships", due: "2026-11-10" },
  DoorDash: { category: "Memberships", pattern: "DASHPASS", due: "2026-11-14" }, // DashPass, not every DoorDash order
};

// Old account name → account here.
const ACCOUNTS: Record<string, string> = { "Chase Checking": "Gennaro Chase Checking", AMEX: "Gennaro AMEX Platinum" };

const [dumpPath, fn, username] = process.argv.slice(2);
const yes = process.argv.includes("--yes");
if (!dumpPath || !fn || !username) throw new Error("usage: <dump.json> <ops-lambda-name> <cognito-username> [--yes]");

const lambda = new LambdaClient({ region: "us-east-1" });
async function op(name: string, input: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await lambda.send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify({ arguments: { name, input: JSON.stringify(input) }, identity: { username } })) }));
  let out = JSON.parse(Buffer.from(r.Payload!).toString());
  while (typeof out === "string") out = JSON.parse(out);
  if (typeof out.result === "string") out = JSON.parse(out.result);
  else if (out.result) out = out.result;
  if (out.error) throw new Error(`${name}: ${out.error}`);
  return out;
}

/**
 * The first due date on or after FROM, on the rule's due day: its old next
 * date's day of the month (the old startDate is when the rule was entered,
 * not when it's due).
 */
function rolledForward(rule: { cadence: string; startDate: string; nextDate?: string | null }): string {
  const cadence = (rule.cadence ?? "MONTHLY") as Cadence;
  let d = rule.nextDate ?? rule.startDate;
  const anchor = monthlyAnchor({ cadence, startDate: d });
  for (let guard = 0; d < FROM && guard < 500; guard++) d = advanceByCadence(d, cadence, anchor);
  return d;
}

async function main() {
  const { rec, acc } = JSON.parse(readFileSync(dumpPath, "utf8"));
  const oldAccount = new Map<string, string>(acc.map((a: any) => [a.id, a.name])); // eslint-disable-line @typescript-eslint/no-explicit-any
  const summary = await op("get_finance_summary", { ledger: "all" });
  const accountId = new Map<string, string>(summary.accounts.map((a: any) => [a.name, a.id])); // eslint-disable-line @typescript-eslint/no-explicit-any
  const existing = new Set<string>((await op("list_finance_schedules", { includeInactive: true })).schedules.map((s: any) => s.description.toLowerCase())); // eslint-disable-line @typescript-eslint/no-explicit-any

  const wanted = Object.keys(BILLS);
  const missing = wanted.filter((d) => !rec.some((r: any) => r.description === d)); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (missing.length) throw new Error(`Not on the old site: ${missing.join(", ")}`);

  for (const desc of wanted) {
    const r = rec.find((x: any) => x.description === desc); // eslint-disable-line @typescript-eslint/no-explicit-any
    const bill = BILLS[desc];
    const name = desc === "Apple Icloud+" ? "Apple iCloud+" : desc;
    const account = ACCOUNTS[oldAccount.get(r.accountId) ?? ""];
    const id = account && accountId.get(account);
    if (!id) throw new Error(`${desc}: no account here for "${oldAccount.get(r.accountId)}"`);
    const input = {
      description: name,
      amount: Math.abs(r.amount),
      type: "EXPENSE",
      cadence: r.cadence,
      nextDate: bill.due ?? rolledForward(r),
      accountId: id,
      category: bill.category,
      matchPattern: bill.pattern ?? r.matchPattern ?? null,
      ledger: "household",
      notes: "Imported from gennaroanesi.com",
    };
    if (existing.has(name.toLowerCase())) {
      console.log(`skip   ${name} (already here)`);
      continue;
    }
    console.log(`${yes ? "create" : "plan  "} ${name.padEnd(22)} ${String(-input.amount).padStart(8)} ${input.cadence.padEnd(9)} next ${input.nextDate}  ${account.padEnd(24)} ${input.category.padEnd(14)} ${input.matchPattern ?? "(no pattern)"}`);
    if (yes) await op("save_finance_schedule", input);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
