// Pure SimpleFIN → household ledger sync logic (no I/O). Ported from
// gennaroanesi.com (amplify/functions/simplefinSync/engine.ts). Invested
// accounts get holdings but no transactions here (so no trade parsing), and
// keep their total value as the balance (no cash-only split). The
// finance-sync Lambda supplies the I/O.

import { classify, TRANSFER_CATEGORY, type CategoryRule } from "./categories";
import type { SfAccount, SfHolding, SfTransaction } from "./simplefin";

export { isInvested } from "./accounts";

export type TxType = "INCOME" | "EXPENSE" | "TRANSFER";
export type CategorySource = "RULE" | "LLM" | "MANUAL";

export type TxDraft = {
  accountId: string;
  date: string;
  amount: number;
  description: string;
  type: TxType;
  status: "POSTED" | "PENDING";
  category: string | null;
  categorySource: CategorySource | null;
  personId: string | null;
  toAccountId?: string | null;
  importHash: string;
  sfTransactionId: string;
};

/**
 * Row id for a synced transaction. Built from the SimpleFIN id, so DynamoDB
 * itself refuses a second copy of the same transaction (create fails when
 * the id exists), whatever the dedup read did or didn't see.
 */
export function syncedTransactionId(accountId: string, sfTransactionId: string): string {
  return `sf-${accountId}-${sfTransactionId}`;
}

export function importHash(date: string, amount: number, description: string): string {
  const raw = [date, Number(amount).toFixed(2), (description ?? "").trim().toLowerCase()].join("|");
  return Buffer.from(raw, "utf8").toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

/**
 * A SimpleFIN transaction as a ledger row, classified by the rules. Keeps
 * the raw bank `description` (SimpleFIN's cleaned `payee` truncates
 * merchants). Null when SimpleFIN gave no usable date.
 */
export function sfTxToDraft(sfTx: SfTransaction, accountId: string, rules?: CategoryRule[]): TxDraft | null {
  if (!sfTx.posted) return null;
  const description = sfTx.description || sfTx.payee || "(no description)";
  const type: TxType = sfTx.amount >= 0 ? "INCOME" : "EXPENSE";
  const { category, personId } = classify({ type, description, amount: sfTx.amount }, rules);
  return {
    accountId,
    date: sfTx.posted,
    amount: sfTx.amount,
    description,
    type,
    status: sfTx.pending ? "PENDING" : "POSTED",
    category,
    categorySource: category ? "RULE" : null,
    personId,
    importHash: importHash(sfTx.posted, sfTx.amount, description),
    sfTransactionId: sfTx.id,
  };
}

/**
 * Pair drafts that are the same money moving between two tracked accounts
 * (same date, opposite amounts) and mark both TRANSFER. A contribution
 * from a member's personal account isn't paired (that account isn't
 * synced here), so it stays a Contribution.
 */
export function markSelfTransfers(drafts: TxDraft[]): number {
  const used = new Set<number>();
  let paired = 0;
  for (let i = 0; i < drafts.length; i++) {
    if (used.has(i)) continue;
    const a = drafts[i];
    for (let j = i + 1; j < drafts.length; j++) {
      if (used.has(j)) continue;
      const b = drafts[j];
      if (a.date !== b.date || a.accountId === b.accountId || Math.abs(a.amount + b.amount) > 0.005) continue;
      for (const [x, y] of [[a, b], [b, a]] as const) {
        x.type = "TRANSFER";
        x.toAccountId = y.accountId;
        x.category = TRANSFER_CATEGORY;
        x.categorySource = "RULE";
        x.personId = null;
      }
      used.add(i);
      used.add(j);
      paired++;
      break;
    }
  }
  return paired;
}

// ── Dedup / reconciliation ────────────────────────────────────────────────────

export type ExistingTx = {
  id: string;
  date?: string | null;
  amount?: number | null;
  description?: string | null;
  status?: string | null;
  category?: string | null;
  categorySource?: string | null;
  personSource?: string | null;
  importHash?: string | null;
  sfTransactionId?: string | null;
};

export type DedupIndex = {
  hashes: Map<string, ExistingTx>;
  dateAmt: Map<string, ExistingTx>;
  bySfId: Map<string, ExistingTx>;
};

export function buildDedupIndex(rows: ExistingTx[]): DedupIndex {
  const idx: DedupIndex = { hashes: new Map(), dateAmt: new Map(), bySfId: new Map() };
  for (const r of rows) {
    if (r.importHash && !idx.hashes.has(r.importHash)) idx.hashes.set(r.importHash, r);
    if (r.date != null && r.amount != null) {
      const k = `${r.date}|${Number(r.amount).toFixed(2)}`;
      // Prefer an id-less row: only those may be matched by fingerprint.
      if (!idx.dateAmt.has(k) || (idx.dateAmt.get(k)!.sfTransactionId && !r.sfTransactionId)) idx.dateAmt.set(k, r);
    }
    if (r.sfTransactionId && !idx.bySfId.has(r.sfTransactionId)) idx.bySfId.set(r.sfTransactionId, r);
  }
  return idx;
}

/** A masked descriptor ("ACCT XXXXXX") — worse than what it would replace. */
export function isRedacted(description: string): boolean {
  return /x{4,}/i.test(description);
}

export type TxPatch = {
  date?: string;
  amount?: number;
  description?: string;
  status?: "POSTED" | "PENDING";
  importHash?: string;
  category?: string | null;
  categorySource?: CategorySource | null;
  sfTransactionId?: string;
};

export type Reconciliation =
  | { action: "create"; draft: TxDraft }
  | { action: "update"; id: string; patch: TxPatch; draft: TxDraft }
  | { action: "skip"; draft: TxDraft };

/**
 * What a pulled draft does to the stored ledger. A known SimpleFIN id is
 * the same transaction (a pending charge settling, its description filling
 * out): update in place. Otherwise the fingerprint may only suppress a
 * draft when the colliding row has no SimpleFIN id of its own (two $3
 * tolls on one day are two charges).
 */
export function reconcileDraft(
  draft: TxDraft,
  idx: DedupIndex | undefined,
  inferForDescription?: (description: string) => string | null,
): Reconciliation {
  const existing = idx?.bySfId.get(draft.sfTransactionId);
  if (existing) {
    const patch: TxPatch = {};
    if (draft.date && existing.date !== draft.date) patch.date = draft.date;
    // A pending charge can settle for a different amount (a tip, a hotel hold).
    if (existing.amount == null || Math.abs(existing.amount - draft.amount) >= 0.005) patch.amount = draft.amount;
    const newDesc = (draft.description ?? "").trim();
    const oldDesc = (existing.description ?? "").trim();
    if (newDesc && newDesc !== oldDesc && !(isRedacted(newDesc) && !isRedacted(oldDesc))) patch.description = newDesc;
    if ((existing.status ?? "") !== draft.status) patch.status = draft.status;
    if (patch.date || patch.description || patch.amount !== undefined) patch.importHash = draft.importHash;
    if (patch.description && inferForDescription) {
      const next = shouldRecategorize(oldDesc, newDesc, existing.category ?? null, inferForDescription, existing.categorySource ?? null);
      if (next !== undefined) {
        patch.category = next;
        patch.categorySource = next ? "RULE" : null;
      }
    }
    return Object.keys(patch).length ? { action: "update", id: existing.id, patch, draft } : { action: "skip", draft };
  }
  if (idx) {
    const byHash = idx.hashes.get(draft.importHash);
    if (byHash && !byHash.sfTransactionId) return { action: "skip", draft };
    const byDateAmt = idx.dateAmt.get(`${draft.date}|${draft.amount.toFixed(2)}`);
    if (byDateAmt && !byDateAmt.sfTransactionId) return { action: "skip", draft };
  }
  return { action: "create", draft };
}

/**
 * New category for a row whose description changed, or undefined to leave
 * it. MANUAL is never overwritten; RULE/LLM are refreshed when the new
 * description infers something different.
 */
export function shouldRecategorize(
  oldDescription: string,
  newDescription: string,
  storedCategory: string | null,
  infer: (description: string) => string | null,
  storedSource?: string | null,
): string | null | undefined {
  if (storedSource === "MANUAL") return undefined;
  const fromOld = infer(oldDescription);
  const fromNew = infer(newDescription);
  if (fromNew === null || fromNew === fromOld) return undefined;
  const stored = (storedCategory ?? "").trim();
  if (stored === "" || storedSource === "RULE" || storedSource === "LLM") return fromNew;
  return stored === (fromOld ?? "") ? fromNew : undefined;
}

export function balanceNeedsUpdate(current: number, target: number): boolean {
  return Math.abs(current - target) >= 0.005;
}

/** Balance for a SimpleFIN account: the reported total, positions included. */
export function targetBalance(sfAcc: SfAccount): number {
  return sfAcc.balance;
}

// ── Holdings ──────────────────────────────────────────────────────────────────

export type DesiredHolding = {
  holdingKey: string;
  ticker: string | null;
  description: string | null;
  shares: number;
  costBasis: number;
  hasCost: boolean;
  marketValue: number;
};

/**
 * Upper-cased ticker, else "FUND:<description>": 401k plans often report
 * collective trust funds with no symbol, and those are most of the balance.
 */
export function holdingKeyOf(h: Pick<SfHolding, "symbol" | "description">): string | null {
  const symbol = (h.symbol ?? "").trim().toUpperCase();
  if (symbol) return symbol;
  const desc = (h.description ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return desc ? `FUND:${desc}` : null;
}

/**
 * One desired holding per key. SimpleFIN sometimes repeats a position (at
 * zero shares, or split in pieces): sum by key and drop what nets to zero.
 * A 0.00 cost basis means unknown (401k funds), not free shares.
 */
export function desiredHoldingsFromSf(sfAcc: SfAccount): Map<string, DesiredHolding> {
  const byKey = new Map<string, DesiredHolding>();
  for (const h of sfAcc.holdings ?? []) {
    const key = holdingKeyOf(h);
    if (!key) continue;
    const agg = byKey.get(key) ?? { holdingKey: key, ticker: h.symbol.trim().toUpperCase() || null, description: h.description || null, shares: 0, costBasis: 0, hasCost: false, marketValue: 0 };
    agg.shares += h.shares ?? 0;
    if (h.costBasis != null && h.costBasis > 0) {
      agg.costBasis += h.costBasis;
      agg.hasCost = true;
    }
    agg.marketValue += h.marketValue ?? 0;
    byKey.set(key, agg);
  }
  for (const [k, v] of [...byKey]) {
    // A fund reported by value only (no share count) still counts.
    if (Math.abs(v.shares) < 1e-9 && Math.abs(v.marketValue) < 0.005) byKey.delete(k);
  }
  return byKey;
}

export type ExistingHolding = {
  holdingKey: string;
  quantity?: number | null;
  marketValue?: number | null;
  costBasisTotal?: number | null;
  ticker?: string | null;
  description?: string | null;
  source?: string | null;
};

export type HoldingFields = {
  ticker: string | null;
  description: string | null;
  quantity: number;
  marketValue: number;
  costBasisTotal: number | null;
  avgCostBasis: number | null;
  source: "SIMPLEFIN";
  asOf: string | null;
};

export type HoldingDiff = {
  creates: Array<{ holdingKey: string; fields: HoldingFields }>;
  updates: Array<{ holdingKey: string; fields: HoldingFields }>;
  deletes: string[]; // holdingKeys
};

/**
 * SimpleFIN's positions against the stored rows for one account. SimpleFIN
 * owns its rows: positions that vanished (sold out) are deleted, unchanged
 * ones skipped. MANUAL rows are never touched, not even when SimpleFIN now
 * reports the same key.
 */
export function diffHoldings(desired: Map<string, DesiredHolding>, existing: ExistingHolding[], asOf: string | null): HoldingDiff {
  const out: HoldingDiff = { creates: [], updates: [], deletes: [] };
  const stored = new Map(existing.map((h) => [h.holdingKey, h]));
  const differs = (a: number | null | undefined, b: number | null) => (a == null || b == null ? (a ?? null) !== b : Math.abs(a - b) >= 0.005);
  for (const [key, d] of desired) {
    const fields: HoldingFields = {
      ticker: d.ticker,
      description: d.description,
      quantity: d.shares,
      marketValue: Math.round(d.marketValue * 100) / 100,
      costBasisTotal: d.hasCost ? Math.round(d.costBasis * 100) / 100 : null,
      avgCostBasis: d.hasCost && Math.abs(d.shares) > 1e-9 ? d.costBasis / d.shares : null,
      source: "SIMPLEFIN",
      asOf,
    };
    const ex = stored.get(key);
    if (!ex) out.creates.push({ holdingKey: key, fields });
    else if (ex.source === "MANUAL") continue;
    else if (Math.abs((ex.quantity ?? 0) - d.shares) >= 1e-6 || differs(ex.marketValue, fields.marketValue) || differs(ex.costBasisTotal, fields.costBasisTotal) || (ex.description ?? null) !== fields.description) {
      out.updates.push({ holdingKey: key, fields });
    }
  }
  for (const [key, ex] of stored) {
    if (!desired.has(key) && ex.source !== "MANUAL") out.deletes.push(key);
  }
  return out;
}
