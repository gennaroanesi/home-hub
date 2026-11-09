/**
 * Mock household finances for a sandbox, to see the /finance pages with
 * data: a joint checking, savings and credit card, six months of
 * transactions (contributions from both of us, mortgage, car, utilities,
 * groceries, dining, baby, pets…), schedules, a versioned budget, goals,
 * spend groups, editable rules (with person rules for contributions),
 * daily balance snapshots, 2026 paychecks for both of us (with a stub
 * waiting in the review inbox) and a few invoices with small PDFs. Deterministic: the same data every run.
 *
 * Usage (after `npm run seed:dev`, which creates the logins and people):
 *   npm run seed:finance-dev            # refuses if finance accounts exist
 *   npm run seed:finance-dev -- --reset # deletes ALL finance rows first
 *
 * Signs in as --email / --password (defaults match seed-dev). Refuses to
 * run unless the user pool is tagged amplify:deployment-type=sandbox.
 */

import { readFile } from "node:fs/promises";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { CognitoIdentityProviderClient, DescribeUserPoolCommand } from "@aws-sdk/client-cognito-identity-provider";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Schema } from "../amplify/data/resource";
import { listAllPages } from "../lib/list-all";
import { CATEGORY_RULES, classify, rulesFromDbRows } from "../lib/finance/categories";
import { addDays, advanceByCadence, todayIso } from "../lib/finance/dates";
import { importHash } from "../lib/finance/sync-engine";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { invoicePdfKey, paycheckPdfKey } from "../lib/finance/finance-files";
import { randomUUID } from "node:crypto";

/* eslint-disable @typescript-eslint/no-explicit-any */

const argv = process.argv;
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const opts = {
  email: arg("email", "gennaroanesi@gmail.com"),
  password: arg("password", "Rustic91!"),
  profile: arg("profile", "amplify-dev"),
  reset: argv.includes("--reset"),
};

const FINANCE_MODELS = [
  "homeInvoiceLink",
  "homeInvoice",
  "homePaycheckInbox",
  "homePaycheck",
  "homeFinanceTransaction",
  "homeFinanceRecurring",
  "homeFinanceBudget",
  "homeFinanceSavingsGoal",
  "homeFinanceSpendGroup",
  "homeFinanceCategoryRule",
  "homeFinanceSyncLog",
  "homeFinanceAccountSnapshot",
  "homeFinanceAccount",
] as const;

// Deterministic randomness (mulberry32).
let seed = 20261109;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

function check(r: any, what: string) {
  if (r?.errors?.length) throw new Error(`${what}: ${r.errors[0].message}`);
  return r.data;
}

async function main() {
  const outputs = JSON.parse(await readFile("./amplify_outputs.json", "utf8"));
  const poolId: string = outputs.auth.user_pool_id;
  const cognito = new CognitoIdentityProviderClient({ region: outputs.auth.aws_region, credentials: fromIni({ profile: opts.profile }) });
  const pool = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
  const deploymentType = pool.UserPool?.UserPoolTags?.["amplify:deployment-type"];
  if (deploymentType !== "sandbox") throw new Error(`User pool ${poolId} is ${deploymentType ?? "untagged"}, not a sandbox. Refusing.`);

  Amplify.configure(outputs, { ssr: false });
  await signOut().catch(() => {});
  const res = await signIn({ username: opts.email, password: opts.password });
  if (!res.isSignedIn) throw new Error("Sign-in incomplete");
  const client: any = generateClient<Schema>({ authMode: "userPool" });
  const m = client.models;

  // ── Reset / guard ────────────────────────────────────────────────────────
  const existing = await listAllPages<any>(m.homeFinanceAccount);
  if (existing.length && !opts.reset) throw new Error(`${existing.length} finance account(s) already exist. Re-run with --reset to replace all finance data.`);
  if (opts.reset) {
    for (const name of FINANCE_MODELS) {
      const rows = await listAllPages<any>(m[name]);
      await inBatches(rows, 25, (r) => m[name].delete(name === "homeFinanceAccountSnapshot" ? { accountId: r.accountId, date: r.date } : { id: r.id }));
      if (rows.length) console.log(`  deleted ${rows.length} ${name}`);
    }
  }

  const people = await listAllPages<any>(m.homePerson);
  const gen = people.find((p) => p.name === "Gennaro");
  const cris = people.find((p) => p.name === "Cristine");
  if (!gen || !cris) throw new Error("Run `npm run seed:dev` first (needs Gennaro and Cristine).");

  const today = todayIso();
  const start = "2026-05-01";

  // ── Accounts ─────────────────────────────────────────────────────────────
  console.log("→ Accounts");
  const checking = check(
    await m.homeFinanceAccount.create({ name: "Joint checking", type: "CHECKING", institution: "Chase", last4: "4417", currentBalance: 0, minBalance: 2000, active: true, sortOrder: 1, ownerPersonIds: [] }),
    "checking",
  );
  const savings = check(
    await m.homeFinanceAccount.create({ name: "Joint savings", type: "SAVINGS", institution: "Chase", last4: "7720", currentBalance: 0, apy: 0.04, active: true, sortOrder: 2, ownerPersonIds: [] }),
    "savings",
  );
  const card = check(
    await m.homeFinanceAccount.create({ name: "Joint Amex", type: "CREDIT", institution: "American Express", last4: "1009", currentBalance: 0, creditLimit: 15000, statementDueDay: 22, apr: 0.2399, active: true, sortOrder: 3, ownerPersonIds: [] }),
    "card",
  );

  // ── Rules: bundled + person rules for contributions ─────────────────────
  console.log("→ Rules");
  const ruleRows: any[] = [
    { pattern: "/from chk \\.\\.\\.8812/i", category: "Contribution", personId: gen.id, sortOrder: 10, active: true, notes: "Gennaro's personal checking" },
    { pattern: "/from chk \\.\\.\\.3051/i", category: "Contribution", personId: cris.id, sortOrder: 20, active: true, notes: "Cristine's personal checking" },
    { pattern: "LUNA BLOOM", category: "Home", sortOrder: 30, active: true, notes: "Florist we use for the house" },
    ...CATEGORY_RULES.map((r, i) => ({ pattern: r.pattern, category: r.category, sortOrder: 100 * (i + 1), active: true })),
  ];
  await inBatches(ruleRows, 20, async (r) => check(await m.homeFinanceCategoryRule.create(r), "rule"));
  const rules = rulesFromDbRows(ruleRows);

  // ── Schedules ────────────────────────────────────────────────────────────
  console.log("→ Scheduled transactions");
  type Sched = { key: string; description: string; amount: number; type: string; day: number; category?: string; personId?: string; matchPattern?: string; autopay?: boolean; account?: any; toAccountId?: string; url?: string; cadence?: string };
  const scheds: Sched[] = [
    { key: "gen1", description: "Gennaro — contribution (1st)", amount: 2250, type: "INCOME", day: 1, category: "Contribution", personId: gen.id, matchPattern: "...8812" },
    { key: "gen15", description: "Gennaro — contribution (15th)", amount: 2250, type: "INCOME", day: 15, category: "Contribution", personId: gen.id, matchPattern: "...8812" },
    { key: "cris", description: "Cristine — contribution", amount: 3000, type: "INCOME", day: 1, category: "Contribution", personId: cris.id, matchPattern: "...3051" },
    { key: "mortgage", description: "Mortgage", amount: -2860, type: "EXPENSE", day: 1, category: "Mortgage Payment", matchPattern: "ROCKET MORTGAGE", url: "https://www.rocketmortgage.com" },
    { key: "car", description: "Car payment (RAV4)", amount: -612.4, type: "EXPENSE", day: 5, category: "Car Payment", matchPattern: "TOYOTA FINANCIAL" },
    { key: "spectrum", description: "Spectrum internet", amount: -80, type: "EXPENSE", day: 12, category: "Utilities", matchPattern: "SPECTRUM" },
    { key: "att", description: "AT&T (2 lines)", amount: -165.3, type: "EXPENSE", day: 14, category: "Mobile", matchPattern: "AT&T" },
    { key: "savings", description: "Move to joint savings", amount: 500, type: "TRANSFER", day: 16, category: "Transfers", toAccountId: savings.id, matchPattern: "TO SAV" },
    { key: "energy", description: "Austin Energy", amount: -190, type: "EXPENSE", day: 18, category: "Utilities", matchPattern: "AUSTIN ENERGY" },
    { key: "water", description: "Austin Water", amount: -85, type: "EXPENSE", day: 20, category: "Utilities", matchPattern: "WATER UTIL" },
    { key: "amex", description: "Amex card payment", amount: -2200, type: "EXPENSE", day: 22, category: "Credit Card Payment", matchPattern: "AMEX EPAYMENT", autopay: false, url: "https://www.americanexpress.com" },
    { key: "geico", description: "GEICO auto insurance", amount: -182.5, type: "EXPENSE", day: 25, category: "Car Insurance", matchPattern: "GEICO" },
    { key: "netflix", description: "Netflix", amount: -22.99, type: "EXPENSE", day: 8, category: "Streaming", matchPattern: "NETFLIX", account: card },
    { key: "spotify", description: "Spotify Duo", amount: -16.99, type: "EXPENSE", day: 10, category: "Streaming", matchPattern: "SPOTIFY", account: card },
  ];
  const nextDue = (day: number) => {
    const thisMonth = `${today.slice(0, 7)}-${String(day).padStart(2, "0")}`;
    return thisMonth > today ? thisMonth : advanceByCadence(thisMonth, "MONTHLY");
  };
  const schedId: Record<string, string> = {};
  for (const s of scheds) {
    const startDate = `${start.slice(0, 7)}-${String(s.day).padStart(2, "0")}`;
    const row = check(
      await m.homeFinanceRecurring.create({
        accountId: (s.account ?? checking).id,
        toAccountId: s.toAccountId ?? null,
        description: s.description,
        amount: s.type === "TRANSFER" ? Math.abs(s.amount) : s.amount,
        type: s.type,
        category: s.category ?? null,
        cadence: "MONTHLY",
        startDate,
        nextDate: nextDue(s.day),
        personId: s.personId ?? null,
        matchPattern: s.matchPattern ?? null,
        autopay: s.autopay ?? true,
        active: true,
        url: s.url ?? null,
      }),
      s.key,
    );
    schedId[s.key] = row.id;
  }
  // A one-off coming up: the nursery furniture delivery balance.
  check(
    await m.homeFinanceRecurring.create({ accountId: checking.id, description: "Nursery furniture — balance due", amount: -850, type: "EXPENSE", category: "Baby", cadence: "ONCE", startDate: addDays(today, 9), nextDate: addDays(today, 9), autopay: false, active: true }),
    "once",
  );

  // ── Spend groups ─────────────────────────────────────────────────────────
  console.log("→ Spend groups");
  const nursery = check(await m.homeFinanceSpendGroup.create({ name: "Nursery", kind: "PROJECT", budget: 3500, startDate: "2026-08-01", endDate: "2026-12-31", notes: "Crib, dresser, glider, paint" }), "nursery");
  const lake = check(await m.homeFinanceSpendGroup.create({ name: "Lake Travis weekend", kind: "TRIP", budget: 900, startDate: "2026-09-11", endDate: "2026-09-13" }), "lake");

  // ── Transactions ─────────────────────────────────────────────────────────
  console.log("→ Transactions");
  type Tx = { accountId: string; date: string; description: string; amount: number; personId?: string | null; recurringId?: string; spendGroupId?: string; toAccountId?: string; type?: string; category?: string; categorySource?: string; notes?: string };
  const txs: Tx[] = [];
  const add = (t: Tx) => {
    if (t.date >= start && t.date <= today) txs.push(t);
  };
  const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
  const d = (month: string, day: number) => `${month}-${String(Math.min(day, 28)).padStart(2, "0")}`;
  const summer = (month: string) => ["2026-06", "2026-07", "2026-08", "2026-09"].includes(month);

  let cardSpendPrev = 1850;
  for (const mo of months) {
    // Contributions. Cristine's November transfer came in short.
    add({ accountId: checking.id, date: d(mo, 1), description: "ONLINE TRANSFER FROM CHK ...8812 REF #GA" + mo.replace("-", ""), amount: 2250, recurringId: schedId.gen1 });
    add({ accountId: checking.id, date: d(mo, 15), description: "ONLINE TRANSFER FROM CHK ...8812 REF #GB" + mo.replace("-", ""), amount: 2250, recurringId: schedId.gen15 });
    add({ accountId: checking.id, date: d(mo, 2), description: "ONLINE TRANSFER FROM CHK ...3051 CRISTINE", amount: mo === "2026-11" ? 1500 : 3000, recurringId: schedId.cris });

    // Bills on checking.
    add({ accountId: checking.id, date: d(mo, 1), description: "ROCKET MORTGAGE MORTGAGE PMT 0098823", amount: -2860, recurringId: schedId.mortgage });
    add({ accountId: checking.id, date: d(mo, 5), description: "TOYOTA FINANCIAL CAR PAYMENT", amount: -612.4, recurringId: schedId.car });
    add({ accountId: checking.id, date: d(mo, 12), description: "SPECTRUM INTERNET 855-707-7328", amount: -80, recurringId: schedId.spectrum });
    add({ accountId: checking.id, date: d(mo, 14), description: "AT&T MOBILITY ONLINE PMT", amount: -165.3, recurringId: schedId.att });
    add({ accountId: checking.id, date: d(mo, 18), description: "AUSTIN ENERGY UTILITY PMT", amount: summer(mo) ? -between(240, 310) : -between(130, 185), recurringId: schedId.energy });
    add({ accountId: checking.id, date: d(mo, 20), description: "CITY OF AUSTIN WATER UTIL", amount: -between(70, summer(mo) ? 135 : 95), recurringId: schedId.water });
    add({ accountId: checking.id, date: d(mo, 25), description: "GEICO AUTO INSURANCE PREM", amount: -182.5, recurringId: schedId.geico });
    add({ accountId: checking.id, date: d(mo, 9), description: "TEXAS GAS SERVICE GAS UTIL", amount: -between(28, 45) });

    // Savings transfer (paired) and interest.
    const xfer = d(mo, 16);
    add({ accountId: checking.id, date: xfer, description: "ONLINE TRANSFER TO SAV ...7720", amount: -500, type: "TRANSFER", category: "Transfers", toAccountId: savings.id, recurringId: schedId.savings });
    add({ accountId: savings.id, date: xfer, description: "ONLINE TRANSFER FROM CHK ...4417", amount: 500, type: "TRANSFER", category: "Transfers", toAccountId: checking.id });
    add({ accountId: savings.id, date: d(mo, 28), description: "INTEREST PAID", amount: between(55, 75) });

    // Card payment (paired), by hand on the 22nd.
    const pay = d(mo, 22);
    add({ accountId: checking.id, date: pay, description: "AMEX EPAYMENT ACH PMT", amount: -cardSpendPrev, type: "TRANSFER", category: "Credit Card Payment", toAccountId: card.id, recurringId: schedId.amex });
    add({ accountId: card.id, date: pay, description: "PAYMENT RECEIVED - THANK YOU", amount: cardSpendPrev, type: "TRANSFER", category: "Credit Card Payment", toAccountId: checking.id });

    // Day-to-day on the card.
    let spend = 0;
    const cardTx = (day: number, description: string, amount: number, extra: Partial<Tx> = {}) => {
      const date = d(mo, day);
      if (date < start || date > today) return;
      spend += amount;
      add({ accountId: card.id, date, description, amount: -amount, ...extra });
    };
    cardTx(8, "NETFLIX.COM", 22.99, { recurringId: schedId.netflix });
    cardTx(10, "SPOTIFY USA", 16.99, { recurringId: schedId.spotify });
    for (const day of [2, 6, 9, 13, 16, 20, 23, 27]) cardTx(day, pick(["H-E-B #612 AUSTIN TX", "H-E-B #054 AUSTIN TX", "HEB CURBSIDE"]), between(48, 175));
    cardTx(11, "COSTCO WHSE #0681", between(180, 320));
    if (rand() > 0.4) cardTx(19, "WHOLE FOODS MARKET #10221", between(35, 90));
    for (const day of [3, 7, 10, 17, 21, 24]) cardTx(day, pick(["TST* VERACRUZ ALL NATURAL", "TORCHYS TACOS #12", "STARBUCKS STORE 08832", "UCHI AUSTIN RESTAURANT", "SQ *CUVEE COFFEE", "TST* TERRY BLACKS BBQ"]), between(14, 95));
    if (rand() > 0.3) cardTx(26, "DOORDASH*THAI KITCHEN", between(32, 58));
    cardTx(4, pick(["SHELL OIL 57444", "BUC-EE'S #22 NEW BRAUNFELS"]), between(42, 68));
    cardTx(18, pick(["SHELL OIL 57444", "EXXONMOBIL 4471"]), between(40, 64));
    cardTx(12, "CHEWY.COM", between(55, 80));
    if (["2026-06", "2026-10"].includes(mo)) cardTx(15, "BANFIELD PET HOSPITAL #1150", between(140, 260));
    cardTx(14, pick(["AMAZON MKTPL*2K4LP", "AMZN Mktp US*7Y21"]), between(25, 140));
    if (rand() > 0.5) cardTx(25, "TARGET 00012345", between(30, 120));
    if (rand() > 0.5) cardTx(8, pick(["THE HOME DEPOT #6544", "LOWE'S #2401"]), between(25, 160));
    if (mo >= "2026-07") cardTx(21, pick(["BABYLIST", "BUYBUY BABY #0412", "CARTER'S #1022"]), between(45, 210));
    if (rand() > 0.6) cardTx(27, "CVS/PHARMACY #07732", between(12, 48));
    cardTx(13, "SP LUNA BLOOM FLOWERS", between(45, 85));
    if (mo === "2026-10") cardTx(29, "PAYPAL *MAKERSMRKT", 64.5);
    if (mo === "2026-11") cardTx(6, "SQ *HILL COUNTRY WOODWORKS", 230);
    cardSpendPrev = Math.round(spend * 100) / 100;
  }

  // Nursery project and the lake weekend (tagged: they count in their group, not the monthly budget).
  add({ accountId: card.id, date: "2026-08-23", description: "POTTERY BARN KIDS #0233", amount: -1299, spendGroupId: nursery.id, category: "Baby", categorySource: "MANUAL", notes: "Crib" });
  add({ accountId: card.id, date: "2026-09-06", description: "IKEA ROUND ROCK", amount: -342.18, spendGroupId: nursery.id, category: "Baby", categorySource: "MANUAL", notes: "Dresser + shelves" });
  add({ accountId: card.id, date: "2026-10-04", description: "SHERWIN-WILLIAMS #3301", amount: -118.4, spendGroupId: nursery.id });
  add({ accountId: checking.id, date: "2026-10-28", description: "ROOM & BOARD DEPOSIT", amount: -850, spendGroupId: nursery.id, category: "Baby", categorySource: "MANUAL", notes: "Glider, deposit" });
  add({ accountId: card.id, date: "2026-09-11", description: "AIRBNB * HMQ3XZ", amount: -486.2, spendGroupId: lake.id });
  add({ accountId: card.id, date: "2026-09-12", description: "TST* THE OASIS ON LAKE TRAVIS", amount: -142.75, spendGroupId: lake.id });
  add({ accountId: card.id, date: "2026-09-13", description: "HEB #401 LAKEWAY TX", amount: -96.3, spendGroupId: lake.id });
  // A one-off: annual home warranty, paid by hand.
  add({ accountId: checking.id, date: "2026-07-14", description: "AMERICAN HOME SHIELD", amount: -660, category: "Home", categorySource: "MANUAL", notes: "Annual home warranty" });

  // Classify like the sync would; leave a few for the LLM-guessed and uncategorized states.
  const rows = txs.map((t) => {
    const inferred = classify({ description: t.description, amount: t.amount }, rules);
    let category = t.category ?? inferred.category;
    let categorySource: string | null = t.categorySource ?? (category ? "RULE" : null);
    if (!t.category && t.description.startsWith("SQ *HILL COUNTRY")) {
      category = "Home";
      categorySource = "LLM";
    }
    const personId = t.personId !== undefined ? t.personId : inferred.personId;
    const pending = t.date > addDays(today, -3) && t.accountId === card.id;
    return {
      accountId: t.accountId,
      date: t.date,
      description: t.description,
      amount: t.amount,
      type: t.type ?? (t.amount >= 0 ? "INCOME" : "EXPENSE"),
      category,
      categorySource,
      personId: personId ?? null,
      personSource: personId ? "RULE" : null,
      status: pending ? "PENDING" : "POSTED",
      toAccountId: t.toAccountId ?? null,
      recurringId: t.recurringId ?? null,
      spendGroupId: t.spendGroupId ?? null,
      importHash: importHash(t.date, t.amount, t.description),
      notes: t.notes ?? null,
    };
  });
  await inBatches(rows, 25, async (r) => check(await m.homeFinanceTransaction.create(r), `tx ${r.date} ${r.description}`));
  console.log(`  ${rows.length} transactions`);

  // ── Balances + daily snapshots ───────────────────────────────────────────
  console.log("→ Balances and snapshots");
  const opening: Record<string, number> = { [checking.id]: 5200, [savings.id]: 21000, [card.id]: -1850 };
  const snaps: any[] = [];
  for (const acc of [checking, savings, card]) {
    let bal = opening[acc.id];
    const mine = rows.filter((r) => r.accountId === acc.id && r.status === "POSTED");
    for (let day = start; day <= today; day = addDays(day, 1)) {
      const todays = mine.filter((r) => r.date === day);
      bal += todays.reduce((s, r) => s + r.amount, 0);
      snaps.push({
        accountId: acc.id,
        date: day,
        balance: Math.round(bal * 100) / 100,
        inflow: todays.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0),
        outflow: -todays.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0),
        txCount: todays.length,
        capturedAt: `${day}T23:30:00.000Z`,
      });
    }
    const now = new Date().toISOString();
    check(await m.homeFinanceAccount.update({ id: acc.id, currentBalance: Math.round(bal * 100) / 100, balanceUpdatedAt: now }), "balance");
    console.log(`  ${acc.name}: ${bal.toFixed(2)}`);
  }
  await inBatches(snaps, 25, async (s) => check(await m.homeFinanceAccountSnapshot.create(s), "snapshot"));
  console.log(`  ${snaps.length} snapshots`);

  // ── Budget (with history) ────────────────────────────────────────────────
  console.log("→ Budget");
  const budget = async (b: any) => check(await m.homeFinanceBudget.create({ period: "MONTHLY", rollover: false, active: true, ...b }), b.name);
  const sid = () => crypto.randomUUID();
  await budget({ seriesId: sid(), name: "Gennaro", kind: "INCOME", personId: gen.id, categories: [], amount: 4500, effectiveFrom: start });
  await budget({ seriesId: sid(), name: "Cristine", kind: "INCOME", personId: cris.id, categories: [], amount: 3000, effectiveFrom: start });
  await budget({ seriesId: sid(), name: "Home", kind: "EXPENSE", categories: ["Mortgage Payment", "Home Insurance", "Home"], amount: 3050, effectiveFrom: start });
  await budget({ seriesId: sid(), name: "Car", kind: "EXPENSE", categories: ["Car Payment", "Car Insurance", "Fuel", "Tolls", "Car"], amount: 950, effectiveFrom: start });
  await budget({ seriesId: sid(), name: "Utilities & phone", kind: "EXPENSE", categories: ["Utilities", "Mobile", "Streaming", "Subscriptions"], amount: 620, effectiveFrom: start });
  const food = sid();
  await budget({ seriesId: food, name: "Food", kind: "EXPENSE", categories: ["Groceries", "Dining", "Food Delivery"], amount: 1300, effectiveFrom: start, effectiveTo: "2026-08-31" });
  await budget({ seriesId: food, name: "Food", kind: "EXPENSE", categories: ["Groceries", "Dining", "Food Delivery"], amount: 1500, effectiveFrom: "2026-09-01", label: "more cooking at home, Costco runs" });
  await budget({ seriesId: sid(), name: "Baby", kind: "EXPENSE", categories: ["Baby"], amount: 250, effectiveFrom: "2026-07-01", label: "baby on the way" });
  await budget({ seriesId: sid(), name: "Pets", kind: "EXPENSE", categories: ["Pets"], amount: 120, effectiveFrom: start });
  await budget({ seriesId: sid(), name: "Shopping", kind: "EXPENSE", categories: ["Amazon", "Shopping"], amount: 200, effectiveFrom: start });
  await budget({ seriesId: sid(), name: "Health", kind: "EXPENSE", categories: ["Medical", "Health"], amount: 100, effectiveFrom: start });
  // Staged for next year.
  await budget({ seriesId: sid(), name: "Childcare", kind: "EXPENSE", categories: ["Childcare"], amount: 1600, effectiveFrom: "2027-08-01", label: "daycare starts" });

  // ── Goals ────────────────────────────────────────────────────────────────
  console.log("→ Goals");
  check(await m.homeFinanceSavingsGoal.create({ name: "Emergency fund", targetAmount: 20000, fundingAccountId: savings.id, priority: 1, active: true, notes: "Six months of fixed costs" }), "goal");
  check(await m.homeFinanceSavingsGoal.create({ name: "Baby fund", targetAmount: 10000, fundingAccountId: savings.id, priority: 2, targetDate: "2027-05-01", active: true }), "goal");
  check(await m.homeFinanceSavingsGoal.create({ name: "Japan 2027", targetAmount: 7000, currentAmount: 1800, targetDate: "2027-10-01", priority: 100, active: true }), "goal");

  // ── Paychecks (2026, biweekly) ───────────────────────────────────────────
  console.log("→ Paychecks");
  const bucket = process.env.HOME_HUB_BUCKET ?? (await readFile("./.env.local", "utf8")).match(/^HOME_HUB_BUCKET=(.*)$/m)?.[1]?.trim();
  const s3 = new S3Client({ region: outputs.auth.aws_region, credentials: fromIni({ profile: opts.profile }) });
  const putPdf = async (key: string, lines: string[]) => {
    if (!bucket) return null;
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: mockPdf(lines), ContentType: "application/pdf" }));
      return key;
    } catch (e) {
      console.warn(`  (couldn't store ${key}: ${e instanceof Error ? e.message : e})`);
      return null;
    }
  };
  type Earner = { person: any; employer: string; annual: number; k401: number; medical: number; extraWh: number; rsu: number };
  const earners: Earner[] = [
    { person: gen, employer: "Meta Platforms, Inc.", annual: 214000, k401: 0.1, medical: 112, extraWh: 150, rsu: 21500 },
    { person: cris, employer: "Ascension Seton", annual: 128000, k401: 0.08, medical: 64, extraWh: 0, rsu: 0 },
  ];
  const OASDI_BASE_2026 = 184500;
  const stubsFor = (e: Earner) => {
    const rows: any[] = [];
    const ytd = { gross: 0, taxable: 0, fed: 0, oasdi: 0, medicare: 0, k401: 0, net: 0, rsu: 0, supFed: 0 };
    let oasdiWages = 0;
    const per = e.annual / 26;
    const dates: Array<{ date: string; rsu: boolean }> = [];
    for (let day = "2026-01-02"; day <= today; day = addDays(day, 14)) dates.push({ date: day, rsu: false });
    if (e.rsu) for (const d of ["2026-02-17", "2026-05-15", "2026-08-17", "2026-11-16"]) if (d <= today) dates.push({ date: d, rsu: true });
    dates.sort((a, b) => a.date.localeCompare(b.date));
    for (const { date, rsu } of dates) {
      const gross = rsu ? 0 : Math.round(per * 100) / 100;
      const rsuGross = rsu ? e.rsu : 0;
      const k401 = rsu ? 0 : Math.round(gross * e.k401 * 100) / 100;
      const pretaxHealth = rsu ? 0 : e.medical + 9.5 + 4.2;
      const taxable = Math.round((gross - k401 - pretaxHealth + rsuGross) * 100) / 100;
      const fed = rsu ? Math.round(rsuGross * 0.22 * 100) / 100 : Math.round((taxable * 0.17 + e.extraWh) * 100) / 100;
      const ssWage = Math.max(0, Math.min(taxable + k401, OASDI_BASE_2026 - oasdiWages));
      oasdiWages += ssWage;
      const oasdi = Math.round(ssWage * 0.062 * 100) / 100;
      const medicare = Math.round((taxable + k401) * 0.0145 * 100) / 100;
      const net = rsu ? 0 : Math.round((gross - k401 - pretaxHealth - fed - oasdi - medicare) * 100) / 100;
      ytd.gross += gross; ytd.taxable += taxable; ytd.fed += fed; ytd.oasdi += oasdi; ytd.medicare += medicare; ytd.k401 += k401; ytd.net += net; ytd.rsu += rsuGross;
      if (rsu) ytd.supFed += fed;
      const r2 = (v: number) => Math.round(v * 100) / 100;
      rows.push({
        personId: e.person.id, payDate: date, periodStart: rsu ? null : addDays(date, -13), periodEnd: rsu ? null : date, employer: e.employer,
        gross, taxableWage: taxable, net, fedWh: fed, stateWh: 0, oasdi, medicare, contrib401k: k401, medical: rsu ? 0 : e.medical, dental: rsu ? 0 : 9.5, vision: rsu ? 0 : 4.2,
        rsuGross: rsuGross || null, supplementalFedWh: rsu ? fed : null,
        ytdGross: r2(ytd.gross), ytdTaxableWage: r2(ytd.taxable), ytdFedWh: r2(ytd.fed), ytdOasdi: r2(ytd.oasdi), ytdMedicare: r2(ytd.medicare), ytd401k: r2(ytd.k401), ytdNet: r2(ytd.net),
        ytdRsuGross: e.rsu ? r2(ytd.rsu) : null, ytdSupplementalFedWh: e.rsu ? r2(ytd.supFed) : null,
        w4FilingStatus: "MFJ", w4ExtraWithholding: e.extraWh, w4Dependents: 0,
        lineItems: JSON.stringify(rsu ? [{ name: "RSU Tax Offset", amount: -rsuGross, ytd: null, type: "POSTTAX" }] : [{ name: "401(k) Employer Match", amount: Math.round(gross * 0.05 * 100) / 100, ytd: null, type: "EMPLOYER_PAID" }]),
      });
    }
    return rows;
  };
  const allStubs = earners.flatMap(stubsFor);
  // Cristine's latest stub hasn't been reviewed yet: it sits in the inbox.
  const crisStubs = allStubs.filter((p) => p.personId === cris.id);
  const pending = crisStubs[crisStubs.length - 1];
  const saved = allStubs.filter((p) => p !== pending);
  await inBatches(saved, 10, async (p) => {
    const id = randomUUID();
    const who = p.personId === gen.id ? "Gennaro" : "Cristine";
    const key = await putPdf(paycheckPdfKey(id), [`${p.employer}`, `Pay statement — ${who}`, `Pay date ${p.payDate}`, `Gross $${p.gross.toFixed(2)}${p.rsuGross ? `  RSU $${p.rsuGross.toFixed(2)}` : ""}`, `Net pay $${p.net.toFixed(2)}`, "(sandbox mock)"]);
    check(await m.homePaycheck.create({ id, ...p, s3KeyPdf: key, source: "EMAIL" }), "paycheck");
  });
  console.log(`  ${saved.length} paychecks`);
  const inboxId = randomUUID();
  const inboxKey = await putPdf(paycheckPdfKey(inboxId), [pending.employer, "Pay statement — Cristine", `Pay date ${pending.payDate}`, `Net pay $${pending.net.toFixed(2)}`, "(sandbox mock)"]);
  const { personId: _pid, lineItems, ...draftFields } = pending;
  check(
    await m.homePaycheckInbox.create({
      id: inboxId, draft: JSON.stringify({ ...draftFields, employeeName: "ANESI, CRISTINE", lineItems: JSON.parse(lineItems) }), personId: cris.id, s3KeyPdf: inboxKey,
      filename: "Payslip.pdf", sizeBytes: 48211, contentHash: `mock-${inboxId}`, emailFrom: "cristine.test@example.com", emailSubject: "Fwd: Your pay statement is ready",
      receivedAt: new Date().toISOString(), status: "NEEDS_REVIEW",
    }),
    "inbox",
  );
  check(
    await m.homePaycheckInbox.create({ emailFrom: "gennaroanesi@gmail.com", emailSubject: "Fwd: Paycheck available in Workday", receivedAt: new Date(Date.now() - 86400_000 * 3).toISOString(), status: "ERROR", parseError: "No PDF attached. Forward the paystub PDF itself." }),
    "inbox",
  );

  // ── Invoices ─────────────────────────────────────────────────────────────
  console.log("→ Invoices");
  const created = await listAllPages<any>(m.homeFinanceTransaction);
  const txFor = (desc: string) => created.find((t) => t.description?.startsWith(desc));
  const invoices: Array<{ vendor: string; number: string | null; issue: string; due: string | null; total: number; category: string; items: any[]; status: "PARSED" | "NEEDS_REVIEW"; tx?: any; source: "EMAIL" | "UPLOAD" }> = [
    { vendor: "American Home Shield", number: "AHS-2207731", issue: "2026-07-12", due: "2026-07-14", total: 660, category: "Home", items: [{ description: "ShieldGold annual plan", qty: 1, unitPrice: 660, amount: 660 }], status: "PARSED", tx: txFor("AMERICAN HOME SHIELD"), source: "EMAIL" },
    { vendor: "Banfield Pet Hospital", number: "INV-88412", issue: "2026-10-15", due: null, total: 0, category: "Pets", items: [{ description: "Wellness exam", qty: 1, unitPrice: 79, amount: 79 }, { description: "Rabies vaccine", qty: 1, unitPrice: 42, amount: 42 }], status: "PARSED", tx: txFor("BANFIELD PET HOSPITAL") && created.filter((t) => t.description?.startsWith("BANFIELD")).find((t) => t.date >= "2026-10-01"), source: "EMAIL" },
    { vendor: "Radiant Plumbing & Air", number: "W-50219", issue: "2026-11-03", due: "2026-11-17", total: 385, category: "Home", items: [{ description: "Water heater flush + anode rod", qty: 1, unitPrice: 385, amount: 385 }], status: "PARSED", source: "EMAIL" },
    { vendor: "Room & Board", number: "RB-1180-22", issue: "2026-10-28", due: "2026-12-15", total: 1700, category: "Baby", items: [{ description: "Glider, oat linen", qty: 1, unitPrice: 1700, amount: 1700 }], status: "PARSED", source: "UPLOAD" },
    { vendor: "Austin Lawn Pros", number: null, issue: "2026-11-01", due: null, total: 0, category: "Home", items: [], status: "NEEDS_REVIEW", source: "EMAIL" },
  ];
  for (const inv of invoices) {
    const total = inv.tx ? Math.abs(inv.tx.amount) : inv.total;
    if (inv.vendor.startsWith("Banfield") && inv.tx) inv.items[0].amount = Math.round((total - 42) * 100) / 100;
    const id = randomUUID();
    const key = (await putPdf(invoicePdfKey(id), [inv.vendor, inv.number ? `Invoice ${inv.number}` : "Receipt", `Date ${inv.issue}`, inv.status === "PARSED" || total ? `Total $${total.toFixed(2)}` : "", "(sandbox mock)"])) ?? invoicePdfKey(id);
    check(
      await m.homeInvoice.create({
        id, vendor: inv.vendor, invoiceNumber: inv.number, issueDate: inv.issue, dueDate: inv.due, currency: "USD", total: inv.status === "PARSED" ? total : null,
        category: inv.category, items: inv.items.length ? JSON.stringify(inv.items) : null, s3KeyPdf: key, contentHash: `mock-${id}`, source: inv.source,
        emailFrom: inv.source === "EMAIL" ? "gennaroanesi@gmail.com" : null, emailSubject: inv.source === "EMAIL" ? `Fwd: ${inv.vendor} invoice` : null,
        receivedAt: `${inv.issue}T15:00:00.000Z`, parseStatus: inv.status, parseError: inv.status === "NEEDS_REVIEW" ? "Total not found in the document" : null,
        paid: !!inv.tx, spendGroupId: inv.category === "Baby" ? nursery.id : null,
      }),
      "invoice",
    );
    if (inv.tx) check(await m.homeInvoiceLink.create({ invoiceId: id, transactionId: inv.tx.id, amount: total }), "link");
  }
  console.log(`  ${invoices.length} invoices`);

  // ── A couple of sync log rows so the status line has something ─────────
  for (const [hoursAgo, status] of [[30, "OK"], [7, "OK"]] as const) {
    const at = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
    check(
      await m.homeFinanceSyncLog.create({ startedAt: at, finishedAt: at, trigger: "CRON", status, windowFrom: addDays(today, -14), windowTo: today, accountsChecked: 3, txPulled: 41, txInserted: 3, txUpdated: 1, txDuplicate: 37, txFailed: 0, balancesUpdated: 2, errorCount: 0, durationMs: 4200, perAccountJson: "[]", errorsJson: "[]", bridgeErrorsJson: "[]" }),
      "sync log",
    );
  }

  console.log("\n✓ Done. Open http://localhost:3001/finance");
}

/** A one-page PDF with a few lines of text (Helvetica), for mock files. */
function mockPdf(lines: string[]): Buffer {
  // Built-in Helvetica is ASCII-only here; escape PDF string delimiters.
  const esc = (t: string) => t.replace(/[^\x20-\x7e]/g, "-").replace(/[\\()]/g, (c) => `\\${c}`);
  const text = lines.filter(Boolean).map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 60 ${720 - i * 22} Td (${esc(l)}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
