// Pure SimpleFIN → household ledger sync logic (no I/O). Ported from
// gennaroanesi.com (amplify/functions/simplefinSync/engine.ts) without the
// brokerage parts (trades, holdings, cash-only balances). The finance-sync
// Lambda supplies the I/O.

import { classify, TRANSFER_CATEGORY, type CategoryRule } from "./categories";
import type { SfAccount, SfTransaction } from "./simplefin";

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
    const newDesc = (draft.description ?? "").trim();
    const oldDesc = (existing.description ?? "").trim();
    if (newDesc && newDesc !== oldDesc && !(isRedacted(newDesc) && !isRedacted(oldDesc))) patch.description = newDesc;
    if ((existing.status ?? "") !== draft.status) patch.status = draft.status;
    if (patch.date || patch.description) patch.importHash = draft.importHash;
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

/** Balance for a SimpleFIN account (cash accounts: the reported balance). */
export function targetBalance(sfAcc: SfAccount): number {
  return sfAcc.balance;
}
