import { describe, expect, it } from "vitest";
import { HOUSEHOLD, accountLedger, allLedgersBudget, inKindContributions, ledgerBudget, ledgerParts, sliceForLedger, txsForLedger } from "./ledger";
import type { BudgetLine } from "./budget";
import { CARD_PAYMENT_CATEGORY, TRANSFER_CATEGORY } from "./categories";

const G = "gennaro";
const C = "cristine";
const accounts = [
  { id: "joint", ownerPersonIds: [] },
  { id: "jointBoth", ownerPersonIds: [G, C] },
  { id: "gCard", ownerPersonIds: [G] },
  { id: "cCard", ownerPersonIds: [C] },
];
const window = { fromIso: "2026-11-01", toIso: "2026-11-30", label: "Nov" };
const TODAY = "2026-11-30";
const tx = (o: Record<string, unknown>) => ({ id: String(Math.random()), status: "POSTED", date: "2026-11-10", ...o }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const line = (o: Partial<BudgetLine>): BudgetLine => ({ id: String(Math.random()), seriesId: String(Math.random()), name: "x", amount: 0, period: "MONTHLY", effectiveFrom: "2026-01-01", ...o });

describe("which ledger", () => {
  it("joint or unowned accounts are the household's; one owner's are theirs", () => {
    expect(accounts.map(accountLedger)).toEqual([HOUSEHOLD, HOUSEHOLD, G, C]);
  });

  it("a transaction can move ledgers, and so can each item", () => {
    expect(ledgerParts(tx({ accountId: "gCard", amount: -50 }), G)).toEqual([{ ledger: G, amount: 50, items: null }]);
    expect(ledgerParts(tx({ accountId: "gCard", amount: -50, ledger: HOUSEHOLD }), G)).toEqual([{ ledger: HOUSEHOLD, amount: 50, items: null }]);
    // $110 Target run: $80 of groceries for the house, $20 of Gennaro's stuff; tax spreads proportionally.
    const target = tx({
      accountId: "gCard",
      amount: -110,
      lineItems: JSON.stringify([
        { name: "groceries", amount: 80, category: "Groceries", ledger: HOUSEHOLD },
        { name: "shirt", amount: 20, category: "Clothing" },
      ]),
    });
    const parts = ledgerParts(target, G);
    expect(parts.map((p) => [p.ledger, Math.round(p.amount * 100) / 100])).toEqual([
      [HOUSEHOLD, 88],
      [G, 22],
    ]);
    const hh = sliceForLedger(target, G, HOUSEHOLD)!;
    expect(hh.amount).toBeCloseTo(-88);
    expect(JSON.parse(hh.lineItems).map((i: { category: string }) => i.category)).toEqual(["Groceries"]);
    expect(sliceForLedger(target, G, C)).toBeNull();
    expect(sliceForLedger(target, G, G)!.amount).toBeCloseTo(-22);
  });

  it("a personal slice without a person is that person's (their paycheck is their income)", () => {
    expect(sliceForLedger(tx({ accountId: "cCard", amount: 3000, category: "Income" }), C, C)!.personId).toBe(C);
    expect(sliceForLedger(tx({ accountId: "joint", amount: 1000, category: "Contribution", personId: G }), HOUSEHOLD, HOUSEHOLD)!.personId).toBe(G);
  });
});

describe("contributions in kind", () => {
  it("household spending on a personal card counts for its owner; personal spending from joint money counts against", () => {
    const m = inKindContributions(
      [
        tx({ accountId: "cCard", amount: -120, category: "Groceries", ledger: HOUSEHOLD }),
        tx({ accountId: "joint", amount: -40, category: "Clothing", ledger: G }),
        tx({ accountId: "gCard", amount: -500, category: CARD_PAYMENT_CATEGORY, ledger: HOUSEHOLD }), // not spending
        tx({ accountId: "cCard", amount: -30, category: "Dining", ledger: HOUSEHOLD, status: "PENDING" }),
        tx({ accountId: "cCard", amount: -30, category: "Dining", ledger: HOUSEHOLD, date: "2026-10-31" }),
        tx({ accountId: "cCard", amount: -60, category: "Coffee" }), // her own
      ],
      accounts,
      window,
    );
    expect(Object.fromEntries(m)).toEqual({ [C]: 120, [G]: -40 });
  });
});

describe("ledger budgets", () => {
  const lines = [
    line({ name: "Gennaro → household", kind: "INCOME", personId: G, amount: 2000 }),
    line({ name: "Cristine → household", kind: "INCOME", personId: C, amount: 2000 }),
    line({ name: "Groceries", categories: ["Groceries"], amount: 800 }),
    line({ name: "Cristine pay", kind: "INCOME", personId: C, amount: 5000, ledger: C }),
    line({ name: "Cristine fun", categories: ["Dining", "Clothing"], amount: 300, ledger: C }),
    line({ name: "Gennaro fun", categories: ["Clothing"], amount: 200, ledger: G }),
  ];
  const txs = [
    tx({ accountId: "joint", amount: 2000, category: "Contribution", personId: G }),
    tx({ accountId: "joint", amount: 1500, category: "Contribution", personId: C }),
    tx({ accountId: "joint", amount: -300, category: "Groceries" }),
    tx({ accountId: "cCard", amount: -120, category: "Groceries", ledger: HOUSEHOLD }),
    tx({ accountId: "cCard", amount: -1500, category: TRANSFER_CATEGORY }), // her side of the contribution
    tx({ accountId: "cCard", amount: 5000, category: "Income" }),
    tx({ accountId: "cCard", amount: -90, category: "Dining" }),
    tx({ accountId: "joint", amount: -40, category: "Clothing", ledger: G }),
  ];

  it("household: only household lines and money; in-kind counts as contribution", () => {
    const v = ledgerBudget(HOUSEHOLD, lines, txs, [], accounts, window, TODAY);
    expect(v.expenseViews.map((e) => [e.line.name, e.spent])).toEqual([["Groceries", 420]]);
    const contrib = Object.fromEntries(v.incomeViews.map((e) => [e.line.personId, e.spent]));
    expect(contrib).toEqual({ [G]: 2000 - 40, [C]: 1500 + 120 });
    expect(Object.fromEntries(v.paidDirectly)).toEqual({ [C]: 120, [G]: -40 });
    expect(v.spentTotal).toBe(420);
  });

  it("personal: their income, their spending, and what went to the household", () => {
    const v = ledgerBudget(C, lines, txs, [], accounts, window, TODAY);
    expect(v.incomeViews.map((e) => [e.line.name, e.spent])).toEqual([["Cristine pay", 5000]]);
    expect(v.expenseViews.map((e) => [e.line.name, e.spent])).toEqual([["Cristine fun", 90]]);
    expect(v.spentTotal).toBe(90); // the household groceries and the transfer aren't hers
    expect(v.toHousehold).toEqual({ planned: 2000, sent: 1620 });
    expect(v.unallocated).toBe(5000 - 300 - 2000);

    const g = ledgerBudget(G, lines, txs, [], accounts, window, TODAY);
    expect(g.expenseViews.map((e) => [e.line.name, e.spent])).toEqual([["Gennaro fun", 40]]);
  });

  it("everything: each line in its own ledger, no household contribution lines", () => {
    const v = allLedgersBudget([G, C], lines, txs, [], accounts, window, TODAY);
    expect(v.incomeViews.map((e) => e.line.name)).toEqual(["Cristine pay"]);
    expect(v.expenseViews.map((e) => [e.line.name, e.line.ledger, e.spent])).toEqual([
      ["Groceries", HOUSEHOLD, 420],
      ["Cristine fun", C, 90],
      ["Gennaro fun", G, 40],
    ]);
    expect(v.spentTotal).toBe(420 + 90 + 40);
  });

  it("an account's scheduled bills count in its own ledger", () => {
    const rules = [
      { id: "r1", accountId: "joint", amount: -100, type: "EXPENSE", category: "Groceries", cadence: "MONTHLY", startDate: "2026-11-05", active: true },
      { id: "r2", accountId: "cCard", amount: -15, type: "EXPENSE", category: "Dining", cadence: "MONTHLY", startDate: "2026-11-05", active: true },
    ] as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ledgerBudget(HOUSEHOLD, lines, txs, rules, accounts, window, TODAY).expenseViews[0].committed).toBe(100);
    expect(ledgerBudget(C, lines, txs, rules, accounts, window, TODAY).expenseViews[0].committed).toBe(15);
  });

  it("txsForLedger keeps only each ledger's share", () => {
    expect(txsForLedger(txs, accounts, G).map((t) => t.amount)).toEqual([-40]);
  });
});
