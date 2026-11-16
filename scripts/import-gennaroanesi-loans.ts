/**
 * Copies assets and loans from gennaroanesi.com (financeAsset, financeLoan,
 * financeLoanPayment) into home-hub's net worth models. gennaroanesi.com is
 * only read.
 *
 * - Assets → homeFinanceAsset, with a PURCHASE valuation (purchase price +
 *   date) and an ESTIMATE for today's value.
 * - Loans → homeFinanceLoan. The mortgage attaches to home-hub's
 *   SimpleFIN-synced LOAN account (a free LOAN account whose name matches the
 *   loan kind, or --map <gaLoanId>=<accountId>); anything else gets a new
 *   manual LOAN account with gennaroanesi.com's balance. Escrow per month
 *   comes from the latest posted payment that had one. A startDate after the
 *   first payment (a known data slip there) is dropped.
 * - POSTED payments → homeFinanceLoanPayment. Scheduled rows aren't copied:
 *   home-hub computes the schedule. Balances aren't moved by the copy.
 *
 * Re-run safe: copied assets/loans carry "gennaroanesi.com asset|loan <id>"
 * in notes and are skipped; a payment with the same loan, date and total is
 * skipped. Prints the plan unless --yes.
 *
 * Usage:
 *   npx tsx scripts/import-gennaroanesi-loans.ts \
 *     --from <gennaroanesi.com prod amplify_outputs.json> --to <home-hub amplify_outputs.json> [--map <gaLoanId>=<accountId>] [--yes]
 * Env (.env.local): GA_USER/GA_PASS (gennaroanesi.com admin), PRD_USER/PRD_PASS
 * (home-hub; TO_USER/TO_PASS override, e.g. for a sandbox).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Amplify } from "aws-amplify";
import { signIn, signOut } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { todayIso } from "../lib/finance/dates";
import { contractualPayment } from "../lib/finance/loans";

/* eslint-disable @typescript-eslint/no-explicit-any */

for (const line of readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}

const argv = process.argv;
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

async function session(outputs: any, user?: string, pass?: string) {
  if (!user || !pass) throw new Error("Missing login env vars (see header)");
  Amplify.configure(outputs, { ssr: false });
  await signOut().catch(() => {});
  const r = await signIn({ username: user, password: pass });
  if (!r.isSignedIn) throw new Error("Sign-in incomplete");
  return generateClient({ authMode: "userPool" }) as any;
}

async function all(model: any): Promise<any[]> {
  const out: any[] = [];
  let nextToken: string | null | undefined;
  do {
    const r = await model.list({ limit: 1000, nextToken });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    out.push(...(r.data ?? []));
    nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

const marker = (kind: "asset" | "loan", id: string) => `gennaroanesi.com ${kind} ${id}`;
const markedId = (notes: string | null | undefined, kind: "asset" | "loan") => new RegExp(`gennaroanesi\\.com ${kind} (\\S+)`).exec(notes ?? "")?.[1];

async function main() {
  const fromPath = arg("from");
  const toPath = arg("to");
  if (!fromPath || !toPath) throw new Error("Usage: --from <gennaroanesi outputs> --to <home-hub outputs> [--map <gaLoanId>=<accountId>] [--yes]");
  const apply = argv.includes("--yes");
  const maps = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--map" && argv[i + 1]) {
      const [k, v] = argv[i + 1].split("=");
      maps.set(k, v);
    }
  }
  const today = todayIso();

  // ── Read gennaroanesi.com ────────────────────────────────────────────────
  const src = await session(JSON.parse(readFileSync(fromPath, "utf8")), process.env.GA_USER, process.env.GA_PASS);
  const [gAccounts, gAssets, gLoans, gPayments] = await Promise.all([all(src.models.financeAccount), all(src.models.financeAsset), all(src.models.financeLoan), all(src.models.financeLoanPayment)]);
  await signOut().catch(() => {});
  const posted = gPayments.filter((p) => p.status === "POSTED");

  // ── Read home-hub ────────────────────────────────────────────────────────
  const dst = await session(JSON.parse(readFileSync(toPath, "utf8")), process.env.TO_USER ?? process.env.PRD_USER, process.env.TO_PASS ?? process.env.PRD_PASS);
  const [hAccounts, hAssets, hLoans, hPayments] = await Promise.all([all(dst.models.homeFinanceAccount), all(dst.models.homeFinanceAsset), all(dst.models.homeFinanceLoan), all(dst.models.homeFinanceLoanPayment)]);
  const assetDone = new Map(hAssets.map((a) => [markedId(a.notes, "asset"), a]).filter(([k]) => k) as Array<[string, any]>);
  const loanDone = new Map(hLoans.map((l) => [markedId(l.notes, "loan"), l]).filter(([k]) => k) as Array<[string, any]>);

  // ── Plan ─────────────────────────────────────────────────────────────────
  console.log(`gennaroanesi.com: ${gAssets.length} assets, ${gLoans.length} loans, ${posted.length} posted payments`);
  console.log(`home-hub: ${hAssets.length} assets, ${hLoans.length} loans, ${hAccounts.filter((a) => a.type === "LOAN").length} LOAN accounts\n`);

  const assetPlan = gAssets.filter((a) => !assetDone.has(a.id));
  for (const a of gAssets) {
    console.log(`Asset ${a.name} (${a.type}): bought ${usd(a.purchaseValue)} ${a.purchaseDate ?? "?"}, now ${usd(a.currentValue)}${a.active === false ? ", inactive" : ""}${assetDone.has(a.id) ? "  [already copied]" : ""}`);
  }

  const taken = new Set(hLoans.map((l) => l.accountId));
  const loanPlan: Array<{ g: any; gAccount: any; account: any | null; startDate: string | null; escrow: number | null; payments: any[] }> = [];
  for (const g of gLoans) {
    const gAccount = gAccounts.find((a) => a.id === g.accountId);
    const pays = posted.filter((p) => p.loanId === g.id).sort((a, b) => a.date.localeCompare(b.date));
    if (loanDone.has(g.id)) {
      console.log(`Loan ${gAccount?.name ?? g.id}: already copied`);
      continue;
    }
    let account: any = null;
    const mapped = maps.get(g.id);
    if (mapped) {
      account = hAccounts.find((a) => a.id === mapped);
      if (!account || account.type !== "LOAN") throw new Error(`--map ${g.id}=${mapped}: not a home-hub LOAN account`);
    } else {
      const kind = g.loanType === "MORTGAGE" ? /mortgage|home/i : g.loanType === "AUTO" ? /car|auto|bmw|vehicle/i : null;
      const hits = hAccounts.filter((a) => a.type === "LOAN" && a.active !== false && !taken.has(a.id) && kind?.test(a.name ?? ""));
      if (hits.length === 1) account = hits[0];
    }
    if (account) taken.add(account.id);
    const startDate = g.startDate && g.startDate > g.firstPaymentDate ? null : g.startDate ?? null;
    const escrow = [...pays].reverse().find((p) => (p.escrow ?? 0) > 0)?.escrow ?? null;
    const payment = contractualPayment({ originalPrincipal: g.originalPrincipal, interestRate: g.interestRate, termMonths: g.termMonths, firstPaymentDate: g.firstPaymentDate });
    console.log(
      `Loan ${gAccount?.name ?? g.id} (${g.loanType}): ${usd(g.originalPrincipal)} at ${(g.interestRate * 100).toFixed(3)}% / ${g.termMonths}mo from ${g.firstPaymentDate}, P&I ${usd(payment)}${escrow ? ` + escrow ${usd(escrow)}` : ""}, owes ${usd(g.currentBalance)}`,
    );
    console.log(`  → ${account ? `attach to ${account.name} (${account.simplefinAccountId ? "synced" : "manual"}, owes ${usd(-(account.currentBalance ?? 0))})` : `new manual LOAN account "${gAccount?.name ?? "Loan"}" owing ${usd(g.currentBalance)}`}`);
    if (g.startDate && !startDate) console.log(`  ! startDate ${g.startDate} is after the first payment; dropped`);
    console.log(`  ${pays.length} posted payments ${pays[0]?.date ?? ""} … ${pays.at(-1)?.date ?? ""}${g.assetId ? `, secured by ${gAssets.find((a) => a.id === g.assetId)?.name ?? g.assetId}` : ""}`);
    loanPlan.push({ g, gAccount, account, startDate, escrow, payments: pays });
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --yes to copy.");
    return;
  }

  // ── Write ────────────────────────────────────────────────────────────────
  const assetIds = new Map<string, string>([...assetDone].map(([gid, a]) => [gid, a.id]));
  for (const a of assetPlan) {
    const r = await dst.models.homeFinanceAsset.create({
      name: a.name,
      type: a.type ?? "OTHER",
      purchaseValue: a.purchaseValue ?? null,
      purchaseDate: a.purchaseDate ?? null,
      currentValue: a.currentValue ?? 0,
      valuedOn: today,
      active: a.active !== false,
      notes: [a.notes, marker("asset", a.id)].filter(Boolean).join("\n"),
    });
    if (r.errors?.length || !r.data) throw new Error(`asset ${a.name}: ${r.errors?.[0]?.message}`);
    assetIds.set(a.id, r.data.id);
    if (a.purchaseValue != null && a.purchaseDate) await dst.models.homeFinanceAssetValuation.create({ assetId: r.data.id, date: a.purchaseDate, value: a.purchaseValue, source: "PURCHASE" });
    await dst.models.homeFinanceAssetValuation.create({ assetId: r.data.id, date: today, value: a.currentValue ?? 0, source: "ESTIMATE", notes: "From gennaroanesi.com" });
    console.log(`+ asset ${a.name}`);
  }

  let paymentsAdded = 0;
  for (const p of loanPlan) {
    let accountId = p.account?.id;
    if (!accountId) {
      const r = await dst.models.homeFinanceAccount.create({
        name: p.gAccount?.name ?? "Loan",
        type: "LOAN",
        institution: p.g.lender ?? p.gAccount?.institution ?? null,
        currentBalance: -Math.abs(p.g.currentBalance ?? 0),
        apr: p.g.interestRate,
        active: true,
        balanceUpdatedAt: new Date().toISOString(),
      });
      if (r.errors?.length || !r.data) throw new Error(`account for ${p.gAccount?.name}: ${r.errors?.[0]?.message}`);
      accountId = r.data.id;
      console.log(`+ account ${r.data.name} (manual LOAN)`);
    } else if (p.account.apr !== p.g.interestRate) {
      await dst.models.homeFinanceAccount.update({ id: accountId, apr: p.g.interestRate });
    }
    const r = await dst.models.homeFinanceLoan.create({
      accountId,
      loanType: p.g.loanType ?? "OTHER",
      lender: p.g.lender || null,
      originalPrincipal: p.g.originalPrincipal,
      interestRate: p.g.interestRate,
      termMonths: p.g.termMonths,
      startDate: p.startDate,
      firstPaymentDate: p.g.firstPaymentDate,
      escrowMonthly: p.escrow,
      assetId: p.g.assetId ? assetIds.get(p.g.assetId) ?? null : null,
      notes: [p.g.notes, marker("loan", p.g.id)].filter(Boolean).join("\n"),
    });
    if (r.errors?.length || !r.data) throw new Error(`loan ${p.gAccount?.name}: ${r.errors?.[0]?.message}`);
    const loanId = r.data.id;
    console.log(`+ loan ${p.gAccount?.name}`);
    const have = new Set(hPayments.filter((x) => x.loanId === loanId).map((x) => `${x.date}|${x.totalAmount}`));
    for (const pay of p.payments) {
      if (have.has(`${pay.date}|${pay.totalAmount}`)) continue;
      const w = await dst.models.homeFinanceLoanPayment.create({
        loanId,
        date: pay.date,
        totalAmount: pay.totalAmount,
        principal: pay.principal,
        interest: pay.interest,
        escrow: pay.escrow ?? null,
        fees: pay.fees ?? null,
        isExtra: !!(pay.isExtraPayment || pay.isCorrection),
        notes: [pay.notes, pay.isCorrection ? "Balance correction (gennaroanesi.com)" : null].filter(Boolean).join("\n") || null,
      });
      if (w.errors?.length) console.log(`  ! payment ${pay.date}: ${w.errors[0].message}`);
      else paymentsAdded++;
    }
  }
  console.log(`\nCopied ${assetPlan.length} assets, ${loanPlan.length} loans, ${paymentsAdded} payments.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
