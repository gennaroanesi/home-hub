// Refunds: money back for something bought. A refund belongs in the category
// (and budget, spend group) of the purchase it reverses, so it comes off that
// category's spending (lib/finance/budget.ts spendParts) instead of sitting
// in a "Refund" bucket of its own.
//
// classify (categories.ts) already gives money in its merchant rule's
// category. This goes one better when the original purchase is on file: the
// same account, the same merchant, within REFUND_LOOKBACK_DAYS before, so a
// return of something you filed by hand under "Baby: Furniture" lands there
// too. Shared by the finance sync, the CSV import and re-apply rules.

import { addDays } from "./dates";
import { effectiveCategory, isExcludedFromBudget, isRefundableCategory, stripProcessorPrefix, INCOME_CATEGORIES } from "./categories";

export const REFUND_LOOKBACK_DAYS = 120;

// Words that say what kind of entry it is, not who the merchant is.
const NOISE = new Set([
  "THE", "AND", "POS", "DEBIT", "CREDIT", "PURCHASE", "REFUND", "RETURN", "RETURNED", "ONLINE", "CARD", "CHECKCARD",
  "RECURRING", "PAYMENT", "VISA", "MASTERCARD", "ACH", "WWW", "COM", "INC", "LLC", "MERCHANDISE", "VOUCHER", "ADJUSTMENT",
]);

/** The merchant's first significant word ("AMAZON" for "AMAZON.COM REFUND" and "Amazon Mktpl*AB12"), or null. */
export function merchantKey(description: string | null | undefined): string | null {
  const words = merchantWords(description);
  return words[0] ?? null;
}

// The description's words from the first one that names the merchant: a
// leading "POS RETURN" or store number is dropped, the rest kept as is.
function merchantWords(description: string | null | undefined): string[] {
  const words = stripProcessorPrefix(description ?? "")
    .toUpperCase()
    .replace(/(?<=[A-Z0-9])['’-](?=[A-Z0-9])/g, "") // H-E-B → HEB, MACY'S → MACYS
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const start = words.findIndex((w) => w.length >= 3 && /[A-Z]/.test(w) && !NOISE.has(w));
  return start < 0 ? [] : words.slice(start);
}

/**
 * Whether two bank descriptions name the same merchant. Banks space and
 * punctuate a name differently ("crateandbarrel.com" vs "CRATE AND BARREL
 * AUSTIN TX", "AMAZON.COM REFUND" vs "Amazon Mktpl*AB12"), so this compares
 * the names with spaces and punctuation removed: they must start the same
 * for the length of the shorter first word, capped at 6 letters (at least 3).
 */
export function sameMerchant(a: string | null | undefined, b: string | null | undefined): boolean {
  const wa = merchantWords(a);
  const wb = merchantWords(b);
  if (!wa.length || !wb.length) return false;
  const ca = wa.join("");
  const cb = wb.join("");
  let common = 0;
  while (common < ca.length && common < cb.length && ca[common] === cb[common]) common++;
  const need = Math.max(3, Math.min(6, wa[0].length, wb[0].length));
  return common >= need;
}

type TxLikeForRefund = {
  id?: string;
  accountId: string;
  date?: string | null;
  amount?: number | null;
  type?: string | null;
  description?: string | null;
  category?: string | null;
  categorySource?: string | null;
  lineItems?: string | null;
  ledger?: string | null;
  spendGroupId?: string | null;
  outOfBudget?: boolean | null;
};

/**
 * Money in that could be a refund we should place: not a transfer, a card
 * payment or other internal movement, and not already income (a paycheck,
 * a contribution, interest). Its category so far may be anything else: the
 * merchant's (from a rule), Refund, or none.
 */
export function mayBeRefund(tx: TxLikeForRefund): boolean {
  if ((tx.amount ?? 0) <= 0 || tx.type === "TRANSFER") return false;
  const c = (tx.category ?? "").trim();
  return !INCOME_CATEGORIES.has(c) && !isExcludedFromBudget(c);
}

/**
 * The purchase a refund reverses: money out on the same account, same
 * merchant, on or before the refund and at most REFUND_LOOKBACK_DAYS earlier,
 * under a spending category. Best first: the exact amount, then a purchase at
 * least as large (a partial refund), then any; the latest among equals.
 */
export function findRefundPurchase<T extends TxLikeForRefund>(refund: TxLikeForRefund, candidates: T[]): T | null {
  const key = merchantKey(refund.description);
  const date = refund.date ?? "";
  const amount = refund.amount ?? 0;
  if (!key || !date || amount <= 0) return null;
  const from = addDays(date, -REFUND_LOOKBACK_DAYS);
  const tier = (p: T) => {
    const spent = -(p.amount ?? 0);
    return Math.abs(spent - amount) < 0.01 ? 0 : spent >= amount ? 1 : 2;
  };
  const hits = candidates.filter((p) => {
    const d = p.date ?? "";
    return (
      p !== refund &&
      p.accountId === refund.accountId &&
      (p.amount ?? 0) < 0 &&
      p.type !== "TRANSFER" &&
      d >= from &&
      d <= date &&
      sameMerchant(p.description, refund.description) &&
      isRefundableCategory(effectiveCategory(p))
    );
  });
  hits.sort((a, b) => tier(a) - tier(b) || (b.date ?? "").localeCompare(a.date ?? ""));
  return hits[0] ?? null;
}

/** What a refund takes from its purchase: category, and its budget / spend group when the purchase has them. */
export function refundFields(purchase: TxLikeForRefund): { category: string; ledger: string | null; spendGroupId: string | null; outOfBudget: boolean | null } {
  return {
    category: effectiveCategory(purchase),
    ledger: purchase.ledger?.trim() || null,
    spendGroupId: purchase.spendGroupId ?? null,
    outOfBudget: purchase.outOfBudget ?? null,
  };
}

/** The earliest date whose purchases a batch of refunds could match (for loading candidates). */
export function refundLookbackFrom(refunds: Array<{ date?: string | null }>): string | null {
  const dates = refunds.map((r) => r.date ?? "").filter(Boolean).sort();
  return dates.length ? addDays(dates[0], -REFUND_LOOKBACK_DAYS) : null;
}
