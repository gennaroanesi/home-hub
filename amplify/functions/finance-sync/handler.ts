// finance-sync — pulls balances and transactions from SimpleFIN for every
// homeFinanceAccount with simplefinAccountId set, classifies new rows
// (rules, then a Haiku fallback), reconciles pending → posted in place,
// links posted rows to their scheduled transaction, upserts today's
// balance snapshot for every active account, and writes a
// homeFinanceSyncLog row. Invested accounts (401k, IRA, brokerage) also
// get their positions (homeFinanceHolding); their transactions are stored
// and rule-classified, but skip the Haiku fallback and schedule matching
// (they aren't household cash flow; lib/finance/accounts.ts).
// Ported from gennaroanesi.com's simplefinSync.
//
// Entry points:
//   EventBridge schedule (3×/day)        → 14-day window
//   syncFinance mutation                 → { days?, accountId?, dryRun? }
//   listSimplefinAccounts mutation       → SimpleFIN accounts on the token
//                                          (id, institution, name; no
//                                          balances or transactions) for
//                                          the account mapping picker

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/finance-sync";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../lib/list-all.js";
import { txIndexQuery } from "../../../lib/finance/data.js";
import { fetchAccounts, maskAccessUrl } from "../../../lib/finance/simplefin.js";
import {
  balanceNeedsUpdate,
  buildDedupIndex,
  desiredHoldingsFromSf,
  diffHoldings,
  isInvested,
  markSelfTransfers,
  reconcileDraft,
  sfTxToDraft,
  syncedTransactionId,
  targetBalance,
  type DedupIndex,
  type HoldingDiff,
  type Reconciliation,
  type TxDraft,
} from "../../../lib/finance/sync-engine.js";
import { classifiableCategories, inferCategory, rulesFromDbRows } from "../../../lib/finance/categories.js";
import { findScheduleMatches, MATCH_AUTO_THRESHOLD, nextDateAfter } from "../../../lib/finance/recurring.js";
import { addDays, todayIso } from "../../../lib/finance/dates.js";
import type { RecurringLike } from "../../../lib/finance/types.js";
import { classifyTransactionsLLM } from "./classify-llm";

type DataClient = ReturnType<typeof generateClient<Schema>>;
let _client: DataClient | null = null;
async function getClient(): Promise<DataClient> {
  if (_client) return _client;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _client = generateClient<Schema>();
  return _client;
}

/**
 * Every transaction on an account matching the date condition (walks
 * nextToken). Throws when a read fails: an empty answer would look like "no
 * rows yet" and the sync would insert everything again.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function txsForAccount(c: DataClient, accountId: string, date: Record<string, string>): Promise<any[]> {
  const out = [];
  let nextToken: string | null | undefined;
  do {
    const res = await txIndexQuery(c, "AccountIdAndDate")(
      { accountId, date },
      { limit: 1000, nextToken },
    );
    if (res.errors?.length) throw new Error(`reading transactions for ${accountId}: ${res.errors[0].message}`);
    out.push(...(res.data ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/** Stored positions for one account (partition-key read). Throws when a read fails. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function holdingsForAccount(c: DataClient, accountId: string): Promise<any[]> {
  const out = [];
  let nextToken: string | null | undefined;
  do {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await c.models.homeFinanceHolding.list({ accountId, limit: 1000, nextToken } as any);
    if (res.errors?.length) throw new Error(`reading holdings for ${accountId}: ${res.errors[0].message}`);
    out.push(...(res.data ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

// Amplify's create refuses an id that exists (DynamoDB conditional check).
function isAlreadyStored(err: { message?: string; errorType?: string }): boolean {
  return /ConditionalCheckFailed/i.test(err.errorType ?? "") || /conditional request failed/i.test(err.message ?? "");
}

// A pending row is stored under a provisional date that can be days before
// the date it posts on; read this much further back so it's found.
const RECONCILE_LOOKBACK_DAYS = 30;

type SyncOptions = { trigger: "CRON" | "MANUAL"; days?: number; accountId?: string; dryRun?: boolean };

type PerAccount = {
  accountId: string;
  name: string;
  txTotal: number;
  txNew: number;
  txUpdated: number;
  balanceBefore: number;
  balanceAfter: number;
  linked: number;
  holdingsChanged?: number; // invested accounts only
};

export type SyncSummary = {
  ok: boolean;
  status: "OK" | "PARTIAL" | "ERROR" | "DRY_RUN";
  accountsChecked: number;
  txPulled: number;
  txInserted: number;
  txUpdated: number;
  balancesUpdated: number;
  linked: number;
  holdingsChanged?: number;
  errors: string[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any = {}) => {
  const field: string | undefined = event?.fieldName ?? event?.info?.fieldName;
  if (field === "listSimplefinAccounts") return listSimplefinAccounts();
  if (field === "syncFinance") {
    const args = event.arguments ?? {};
    return runSync({ trigger: "MANUAL", days: args.days ?? undefined, accountId: args.accountId ?? undefined, dryRun: args.dryRun ?? false });
  }
  const scheduled = event?.source === "aws.events" || event?.["detail-type"] === "Scheduled Event" || Object.keys(event ?? {}).length === 0;
  return runSync({ trigger: scheduled ? "CRON" : "MANUAL", days: event?.days, accountId: event?.accountId, dryRun: event?.dryRun === true });
};

// ── Account discovery ─────────────────────────────────────────────────────────

async function listSimplefinAccounts() {
  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  if (!accessUrl) return { accounts: [], error: "SIMPLEFIN_ACCESS_URL not set" };
  const c = await getClient();
  const mapped = new Map(
    (await listAllPages<{ id: string; name: string; simplefinAccountId?: string | null }>(c.models.homeFinanceAccount))
      .filter((a) => a.simplefinAccountId)
      .map((a) => [a.simplefinAccountId!.trim(), a]),
  );
  try {
    // Balances-only call: names and ids, never the personal accounts' activity.
    const { accounts, errors } = await fetchAccounts(accessUrl, { allAccounts: true, balancesOnly: true, pending: false });
    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        institution: a.orgName,
        name: a.name,
        mappedTo: mapped.get(a.id) ? { id: mapped.get(a.id)!.id, name: mapped.get(a.id)!.name } : null,
      })),
      bridgeErrors: errors,
    };
  } catch (e) {
    return { accounts: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function runSync(opts: SyncOptions): Promise<SyncSummary> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const today = todayIso();
  const windowFrom = addDays(today, -(opts.days ?? 14));
  const windowTo = today;
  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  const errors: string[] = [];
  const bridgeErrors: string[] = [];
  const c = await getClient();
  console.log(`[finance-sync] trigger=${opts.trigger} dryRun=${!!opts.dryRun} window=${windowFrom}→${windowTo} access=${accessUrl ? maskAccessUrl(accessUrl) : "(missing)"}`);

  const log = (status: SyncSummary["status"], counts: Partial<SyncSummary> & { txDuplicate?: number; txFailed?: number }, perAccount: PerAccount[] = []) =>
    writeSyncLog(c, {
      startedAt,
      trigger: opts.trigger,
      status,
      windowFrom,
      windowTo,
      perAccount,
      errors,
      bridgeErrors,
      durationMs: Date.now() - t0,
      ...counts,
    });

  const allAccounts = await listAllPages<any>(c.models.homeFinanceAccount); // eslint-disable-line @typescript-eslint/no-explicit-any
  let mapped = allAccounts.filter((a) => a.active !== false && a.simplefinAccountId?.trim());
  if (opts.accountId) mapped = mapped.filter((a) => a.id === opts.accountId);

  const empty = { accountsChecked: mapped.length, txPulled: 0, txInserted: 0, txUpdated: 0, balancesUpdated: 0, linked: 0 };
  if (!accessUrl) {
    errors.push("SIMPLEFIN_ACCESS_URL not set");
    await log("ERROR", empty);
    return { ok: false, status: "ERROR", ...empty, errors };
  }
  if (mapped.length === 0) {
    console.log("[finance-sync] no mapped accounts; snapshots only");
    if (!opts.dryRun) await upsertSnapshots(c, allAccounts, today, errors);
    await log("OK", empty);
    return { ok: true, status: "OK", ...empty, errors };
  }

  const byId = new Map(mapped.map((a) => [a.simplefinAccountId.trim() as string, a]));
  let sfAccounts: Awaited<ReturnType<typeof fetchAccounts>>["accounts"];
  try {
    const res = await fetchAccounts(accessUrl, { start: windowFrom, end: addDays(windowTo, 1), pending: true, accountIds: [...byId.keys()] });
    bridgeErrors.push(...(res.errors ?? []));
    // Defense in depth: never touch an account we didn't ask for.
    sfAccounts = res.accounts.filter((a) => byId.has(a.id));
  } catch (e) {
    errors.push(`SimpleFIN fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    await log("ERROR", empty);
    return { ok: false, status: "ERROR", ...empty, errors };
  }
  const txPulled = sfAccounts.reduce((n, s) => n + s.transactions.length, 0);

  // Classify.
  const rules = rulesFromDbRows(await listAllPages<any>(c.models.homeFinanceCategoryRule)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const drafts: TxDraft[] = [];
  for (const sfAcc of sfAccounts) {
    const acc = byId.get(sfAcc.id)!;
    for (const t of sfAcc.transactions) {
      const d = sfTxToDraft(t, acc.id, rules);
      if (d) drafts.push(d);
    }
  }
  markSelfTransfers(drafts);

  // Reconcile against stored rows (widened window, see above).
  const reconcileFrom = addDays(windowFrom, -RECONCILE_LOOKBACK_DAYS);
  const dedup = new Map<string, DedupIndex>();
  try {
    for (const a of mapped) {
      dedup.set(a.id, buildDedupIndex(await txsForAccount(c, a.id, { ge: reconcileFrom })));
    }
  } catch (e) {
    // Without the stored rows we can't tell new from known: write nothing.
    errors.push(`Couldn't read stored transactions, nothing written: ${e instanceof Error ? e.message : String(e)}`);
    await log("ERROR", { ...empty, txPulled });
    return { ok: false, status: "ERROR", ...empty, txPulled, errors };
  }
  const infer = (description: string) => inferCategory({ description, type: "EXPENSE", amount: -1 }, rules);
  const plans: Reconciliation[] = drafts.map((d) => reconcileDraft(d, dedup.get(d.accountId), infer));
  const fresh = plans.filter((p) => p.action === "create").map((p) => p.draft);
  const updates = plans.filter((p): p is Extract<Reconciliation, { action: "update" }> => p.action === "update");
  const txDuplicate = plans.filter((p) => p.action === "skip").length;

  // LLM fallback for household money out that no rule recognized.
  const investedIds = new Set(mapped.filter((a) => isInvested(a.type)).map((a) => a.id));
  const toClassify = fresh.filter((d) => !d.category && d.type === "EXPENSE" && !investedIds.has(d.accountId));
  if (toClassify.length) {
    const cats = await classifyTransactionsLLM(
      toClassify.map((d) => ({ description: d.description, amount: d.amount })),
      classifiableCategories(rules),
    );
    cats.forEach((cat, i) => {
      if (cat) {
        toClassify[i].category = cat;
        toClassify[i].categorySource = "LLM";
      }
    });
  }

  // Link posted rows to their scheduled transaction (one occurrence per schedule per run).
  const schedules = (await listAllPages<any>(c.models.homeFinanceRecurring)).filter((r) => r.active !== false) as RecurringLike[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const links = new Map<TxDraft, RecurringLike>();
  const claimed = new Set<string>();
  for (const d of fresh) {
    if (d.status !== "POSTED" || investedIds.has(d.accountId)) continue;
    const best = findScheduleMatches({ id: "", ...d }, schedules, MATCH_AUTO_THRESHOLD).find((m) => !claimed.has(m.rule.id));
    if (best) {
      links.set(d, best.rule);
      claimed.add(best.rule.id);
    }
  }

  const balanceTarget = new Map<string, number>();
  for (const sfAcc of sfAccounts) {
    const acc = byId.get(sfAcc.id)!;
    const target = targetBalance(sfAcc);
    if (balanceNeedsUpdate(acc.currentBalance ?? 0, target)) balanceTarget.set(acc.id, target);
  }

  // Positions in invested accounts. An account whose stored rows can't be
  // read is skipped (a diff against nothing would recreate every row).
  const holdingDiffs = new Map<string, HoldingDiff>();
  for (const sfAcc of sfAccounts) {
    const acc = byId.get(sfAcc.id)!;
    if (!isInvested(acc.type)) continue;
    try {
      holdingDiffs.set(acc.id, diffHoldings(desiredHoldingsFromSf(sfAcc), await holdingsForAccount(c, acc.id), sfAcc.balanceDate || null));
    } catch (e) {
      errors.push(`holdings ${acc.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const diffSize = (d: HoldingDiff) => d.creates.length + d.updates.length + d.deletes.length;
  const holdingsPlanned = [...holdingDiffs.values()].reduce((n, d) => n + diffSize(d), 0);

  const perAccount = new Map<string, PerAccount>(
    mapped.map((a) => [
      a.id,
      { accountId: a.id, name: a.name, txTotal: 0, txNew: 0, txUpdated: 0, balanceBefore: a.currentBalance ?? 0, balanceAfter: balanceTarget.get(a.id) ?? a.currentBalance ?? 0, linked: 0 },
    ]),
  );
  for (const d of drafts) perAccount.get(d.accountId)!.txTotal++;
  for (const d of fresh) perAccount.get(d.accountId)!.txNew++;
  for (const u of updates) perAccount.get(u.draft.accountId)!.txUpdated++;
  for (const d of links.keys()) perAccount.get(d.accountId)!.linked++;
  for (const [id, d] of holdingDiffs) perAccount.get(id)!.holdingsChanged = diffSize(d);
  const perAccountArr = [...perAccount.values()];

  if (opts.dryRun) {
    const counts = { accountsChecked: mapped.length, txPulled, txInserted: fresh.length, txUpdated: updates.length, balancesUpdated: balanceTarget.size, linked: links.size, holdingsChanged: holdingsPlanned };
    await log("DRY_RUN", { ...counts, txDuplicate }, perAccountArr);
    return { ok: true, status: "DRY_RUN", ...counts, errors };
  }

  // ── Writes ──────────────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  let txInserted = 0;
  let txFailed = 0;
  let txAlreadyStored = 0;
  for (const d of fresh) {
    const rule = links.get(d);
    const { errors: e } = await c.models.homeFinanceTransaction.create({
      id: syncedTransactionId(d.accountId, d.sfTransactionId),
      accountId: d.accountId,
      amount: d.amount,
      type: d.type,
      category: d.category,
      categorySource: d.categorySource,
      description: d.description,
      date: d.date,
      status: d.status,
      personId: d.personId,
      personSource: d.personId ? "RULE" : null,
      toAccountId: d.toAccountId ?? null,
      importHash: d.importHash,
      sfTransactionId: d.sfTransactionId,
      recurringId: rule?.id ?? null,
    });
    if (e?.length && isAlreadyStored(e[0])) {
      // The row id is taken: this transaction is already stored.
      txAlreadyStored++;
      links.delete(d);
    } else if (e?.length) {
      txFailed++;
      errors.push(`create ${d.date} ${d.description.slice(0, 40)}: ${e[0].message}`);
    } else txInserted++;
  }

  // Settled / corrected rows: only SimpleFIN-owned fields move; user fields
  // (person, group, goal, notes) and MANUAL categories are left alone.
  let txUpdated = 0;
  for (const u of updates) {
    const p = u.patch;
    const { errors: e } = await c.models.homeFinanceTransaction.update({
      id: u.id,
      ...(p.date !== undefined ? { date: p.date } : {}),
      ...(p.amount !== undefined ? { amount: p.amount } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...(p.importHash !== undefined ? { importHash: p.importHash } : {}),
      ...(p.category !== undefined ? { category: p.category, categorySource: p.categorySource ?? null } : {}),
    });
    if (e?.length) {
      txFailed++;
      errors.push(`update ${u.id}: ${e[0].message}`);
    } else txUpdated++;
  }

  // Advance each linked schedule past the occurrence it just realized.
  for (const [d, rule] of links) {
    const next = nextDateAfter(rule, d.date);
    if (!next && rule.cadence !== "ONCE") continue;
    const patch: Record<string, unknown> = rule.cadence === "ONCE" ? { active: false } : { nextDate: next };
    if (next && rule.endDate && next > rule.endDate) patch.active = false;
    const { errors: e } = await c.models.homeFinanceRecurring.update({ id: rule.id, ...patch });
    if (e?.length) errors.push(`schedule ${rule.description}: ${e[0].message}`);
  }

  let holdingsChanged = 0;
  for (const [accountId, d] of holdingDiffs) {
    for (const w of [...d.creates, ...d.updates]) {
      const row = { accountId, holdingKey: w.holdingKey, ...w.fields };
      const isNew = d.creates.includes(w);
      let r = isNew ? await c.models.homeFinanceHolding.create(row) : await c.models.homeFinanceHolding.update(row);
      // Created by a concurrent run since we read: update it instead.
      if (isNew && r.errors?.length && isAlreadyStored(r.errors[0])) r = await c.models.homeFinanceHolding.update(row);
      if (r.errors?.length) errors.push(`holding ${w.holdingKey}: ${r.errors[0].message}`);
      else holdingsChanged++;
    }
    for (const holdingKey of d.deletes) {
      const { errors: e } = await c.models.homeFinanceHolding.delete({ accountId, holdingKey });
      if (e?.length) errors.push(`holding ${holdingKey} delete: ${e[0].message}`);
      else holdingsChanged++;
    }
  }

  let balancesUpdated = 0;
  const seen = new Set(sfAccounts.map((s) => byId.get(s.id)!.id));
  for (const a of mapped) {
    const s = perAccount.get(a.id)!;
    const bal = balanceTarget.get(a.id);
    const { errors: e } = await c.models.homeFinanceAccount.update({
      id: a.id,
      lastSyncAt: nowIso,
      lastSyncDetails: JSON.stringify({ fromIso: windowFrom, toIso: windowTo, txTotal: s.txTotal, txNew: s.txNew, txUpdated: s.txUpdated, linked: s.linked, ...(s.holdingsChanged !== undefined ? { holdingsChanged: s.holdingsChanged } : {}) }),
      ...(bal !== undefined ? { currentBalance: bal } : {}),
      ...(seen.has(a.id) ? { balanceUpdatedAt: nowIso } : {}),
    });
    if (e?.length) errors.push(`account ${a.name}: ${e[0].message}`);
    else if (bal !== undefined) {
      balancesUpdated++;
      a.currentBalance = bal;
    }
  }

  await upsertSnapshots(c, allAccounts, today, errors);

  const status = txFailed > 0 || errors.length > 0 ? "PARTIAL" : "OK";
  const counts = { accountsChecked: mapped.length, txPulled, txInserted, txUpdated, balancesUpdated, linked: links.size, holdingsChanged };
  console.log(`[finance-sync] ${status}: ${JSON.stringify(counts)} errors=${errors.length}`);
  await log(status, { ...counts, txDuplicate: txDuplicate + txAlreadyStored, txFailed }, perAccountArr);
  return { ok: true, status, ...counts, errors };
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

/** Today's balance + posted in/out per active account, upserted on (accountId, date). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertSnapshots(c: DataClient, accounts: any[], date: string, errors: string[]) {
  const capturedAt = new Date().toISOString();
  for (const a of accounts) {
    if (a.active === false) continue;
    let posted;
    try {
      posted = (await txsForAccount(c, a.id, { eq: date })).filter((t) => t.status !== "PENDING");
    } catch (e) {
      // Skip rather than record a day with nothing in or out.
      errors.push(`snapshot ${a.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const row = {
      accountId: a.id,
      date,
      balance: a.currentBalance ?? 0,
      inflow: posted.filter((t) => t.amount > 0).reduce((s: number, t) => s + t.amount, 0),
      outflow: -posted.filter((t) => t.amount < 0).reduce((s: number, t) => s + t.amount, 0),
      txCount: posted.length,
      capturedAt,
    };
    const { data: existing } = await c.models.homeFinanceAccountSnapshot.get({ accountId: a.id, date });
    const { errors: e } = existing ? await c.models.homeFinanceAccountSnapshot.update(row) : await c.models.homeFinanceAccountSnapshot.create(row);
    if (e?.length) errors.push(`snapshot ${a.name}: ${e[0].message}`);
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────

async function writeSyncLog(
  c: DataClient,
  row: {
    startedAt: string;
    trigger: "CRON" | "MANUAL";
    status: SyncSummary["status"];
    windowFrom: string;
    windowTo: string;
    accountsChecked?: number;
    txPulled?: number;
    txInserted?: number;
    txUpdated?: number;
    txDuplicate?: number;
    txFailed?: number;
    balancesUpdated?: number;
    perAccount: PerAccount[];
    errors: string[];
    bridgeErrors: string[];
    durationMs: number;
  },
): Promise<void> {
  try {
    const { errors } = await c.models.homeFinanceSyncLog.create({
      startedAt: row.startedAt,
      finishedAt: new Date().toISOString(),
      trigger: row.trigger,
      status: row.status,
      windowFrom: row.windowFrom,
      windowTo: row.windowTo,
      accountsChecked: row.accountsChecked ?? 0,
      txPulled: row.txPulled ?? 0,
      txInserted: row.txInserted ?? 0,
      txUpdated: row.txUpdated ?? 0,
      txDuplicate: row.txDuplicate ?? 0,
      txFailed: row.txFailed ?? 0,
      balancesUpdated: row.balancesUpdated ?? 0,
      errorCount: row.errors.length,
      durationMs: row.durationMs,
      perAccountJson: JSON.stringify(row.perAccount),
      errorsJson: JSON.stringify(row.errors),
      bridgeErrorsJson: JSON.stringify(row.bridgeErrors),
    });
    if (errors?.length) console.error("[finance-sync] sync log write failed:", errors);
  } catch (e) {
    console.error("[finance-sync] sync log write threw:", e);
  }
}
