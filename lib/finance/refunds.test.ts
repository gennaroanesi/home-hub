import { describe, expect, it } from "vitest";
import { findRefundPurchase, mayBeRefund, merchantKey, refundFields, refundNote, sameMerchant, withRefundNote } from "./refunds";
import { planRuleChanges } from "./rule-tools";
import { rulesFromDbRows } from "./categories";

const buy = (o: Record<string, unknown>) => ({ id: String(Math.random()), accountId: "card", status: "POSTED", ...o }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("merchantKey", () => {
  it("finds the merchant under processor prefixes, .com and refund wording", () => {
    expect(merchantKey("AMAZON.COM REFUND")).toBe("AMAZON");
    expect(merchantKey("Amazon Mktpl*AB12CD")).toBe("AMAZON");
    expect(merchantKey("SQ *BLUE BOTTLE")).toBe("BLUE");
    expect(merchantKey("POS RETURN TARGET 00012")).toBe("TARGET");
    expect(merchantKey("123 456")).toBeNull();
  });
});

describe("sameMerchant", () => {
  it("matches a merchant however the bank spaces or punctuates it", () => {
    expect(sameMerchant("crateandbarrel.com", "CRATE AND BARREL AUSTIN TX")).toBe(true);
    expect(sameMerchant("CRATE&BARREL REFUND", "crateandbarrel.com")).toBe(true); // "CRATE" in full
    expect(sameMerchant("AMAZON.COM REFUND", "Amazon Mktpl*AB12CD")).toBe(true);
    expect(sameMerchant("POS RETURN TARGET 00012", "TARGET T-1234 AUSTIN")).toBe(true);
    expect(sameMerchant("H-E-B ONLINE REFUND", "H-E-B #123")).toBe(true);
    expect(sameMerchant("TARGET 0001", "AMAZON MKTPL")).toBe(false);
    expect(sameMerchant("CRATE AND BARREL", "CRAFT WAREHOUSE")).toBe(false);
  });
});

describe("findRefundPurchase", () => {
  const sofa = buy({ date: "2026-10-01", amount: -400, description: "AMAZON MKTPL*X1", category: "Baby: Furniture", categorySource: "MANUAL", ledger: "household", spendGroupId: "nursery" });
  const book = buy({ date: "2026-10-20", amount: -25, description: "AMAZON.COM*Z9", category: "Shopping" });
  const other = buy({ date: "2026-10-21", amount: -25, description: "TARGET 0001", category: "Shopping" });
  const refund = { accountId: "card", date: "2026-11-02", amount: 25, description: "AMAZON.COM REFUND", category: "Shopping" };

  it("prefers the exact amount, then a larger purchase, from the same merchant and account", () => {
    expect(findRefundPurchase(refund, [sofa, book, other])).toBe(book);
    expect(findRefundPurchase({ ...refund, amount: 100 }, [sofa, book, other])).toBe(sofa);
    expect(findRefundPurchase({ ...refund, accountId: "joint" }, [sofa, book])).toBeNull();
  });

  it("only looks back REFUND_LOOKBACK_DAYS and never forward", () => {
    expect(findRefundPurchase({ ...refund, date: "2026-09-30" }, [sofa, book])).toBeNull();
    expect(findRefundPurchase({ ...refund, date: "2027-03-01", amount: 400 }, [sofa])).toBeNull();
  });

  it("takes the purchase's category, budget and spend group", () => {
    expect(refundFields(sofa)).toEqual({ category: "Baby: Furniture", ledger: "household", spendGroupId: "nursery", outOfBudget: null });
  });

  it("leaves income, transfers and card payments alone", () => {
    expect(mayBeRefund({ accountId: "a", amount: 25, category: "Shopping" })).toBe(true);
    expect(mayBeRefund({ accountId: "a", amount: 25, category: "Refund" })).toBe(true);
    expect(mayBeRefund({ accountId: "a", amount: 25, category: null })).toBe(true);
    expect(mayBeRefund({ accountId: "a", amount: 3000, category: "Income" })).toBe(false);
    expect(mayBeRefund({ accountId: "a", amount: 500, category: "Credit Card Payment" })).toBe(false);
    expect(mayBeRefund({ accountId: "a", amount: 25, category: "Shopping", type: "TRANSFER" })).toBe(false);
    expect(mayBeRefund({ accountId: "a", amount: -25, category: "Shopping" })).toBe(false);
  });
});

describe("re-apply rules places old refunds", () => {
  const rules = rulesFromDbRows([
    { pattern: "/\\brefund\\b/i", category: "Refund", sortOrder: 1 },
    { pattern: "AMAZON", category: "Shopping", sortOrder: 2 },
  ]);
  const ledgerOf = () => "household";

  it("moves a Refund row onto its purchase's category, only within the chosen days", () => {
    const sofa = buy({ date: "2026-10-01", amount: -400, description: "AMAZON MKTPL*X1", category: "Baby: Furniture", categorySource: "MANUAL", spendGroupId: "nursery" });
    const oldRefund = buy({ date: "2026-10-05", amount: 400, description: "AMAZON.COM REFUND", category: "Refund", categorySource: "RULE" });
    const plan = planRuleChanges([sofa, oldRefund], rules, ledgerOf, "2026-10-02");
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ category: "Baby: Furniture", spendGroupId: "nursery" });
    expect(plan[0].refundOf).toBe(sofa);
    expect(plan[0].notes).toBe("Refund of 2026-10-01 AMAZON MKTPL*X1 ($400.00)");
    // Applied once, nothing is left to change: the note isn't added again.
    const again = planRuleChanges([sofa, { ...oldRefund, category: "Baby: Furniture", spendGroupId: "nursery", notes: plan[0].notes }], rules, ledgerOf, "2026-10-02");
    expect(again).toEqual([]);
    // A hand-picked category is never touched.
    expect(planRuleChanges([sofa, { ...oldRefund, categorySource: "MANUAL" }], rules, ledgerOf, "2026-10-02")).toEqual([]);
  });
});

describe("refund notes", () => {
  const p = { accountId: "a", date: "2026-11-17", amount: -1590.76, description: "crateandbarrel.com" };
  it("names the purchase, and is added once below any existing note", () => {
    expect(refundNote(p)).toBe("Refund of 2026-11-17 crateandbarrel.com ($1,590.76)");
    expect(withRefundNote(null, p)).toBe(refundNote(p));
    expect(withRefundNote("returned the rug", p)).toBe(`returned the rug\n${refundNote(p)}`);
    expect(withRefundNote(withRefundNote("x", p), p)).toBe(`x\n${refundNote(p)}`);
  });
});
