import { describe, expect, it } from "vitest";
import { NO_SPEND_GROUP, filterTransactions, sortTransactions } from "./tx-filter";
import { HOUSEHOLD } from "./ledger";

const tx = (o: Record<string, unknown>) => ({ accountId: "joint", status: "POSTED", date: "2026-11-10", ...o }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = { rules: [], accountLedger: (id: string) => (id === "gCard" ? "gen" : HOUSEHOLD) };
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("one set of transaction filters", () => {
  const rows = [
    tx({ id: "crib", amount: -800, description: "CRATE & BARREL", category: "Baby: Furniture" }),
    tx({ id: "amzn", amount: -60, description: "AMAZON", lineItems: JSON.stringify([{ name: "diapers", amount: 40, category: "Baby" }, { name: "cable", amount: 20, category: "Electronics" }]) }),
    tx({ id: "zelle", amount: 500, description: "ZELLE FROM CRIS", category: "Contribution", personId: "cris" }),
    tx({ id: "spent", amount: -30, description: "Lunch", category: "Dining", personId: "cris", accountId: "gCard", spendGroupId: "trip" }),
    tx({ id: "mystery", amount: -5, description: "SQ *THING" }),
  ];

  it("categories: any case, parents cover sub-categories, items count", () => {
    expect(ids(filterTransactions(rows, { categories: ["baby"] }, ctx))).toEqual(["crib", "amzn"]);
    expect(ids(filterTransactions(rows, { uncategorized: true }, ctx))).toEqual(["mystery"]);
  });

  it("search reaches notes, categories and item names", () => {
    expect(ids(filterTransactions(rows, { query: "diapers" }, ctx))).toEqual(["amzn"]);
    expect(ids(filterTransactions(rows, { query: "furniture" }, ctx))).toEqual(["crib"]);
  });

  it("a contributor is money in only; groups, direction, accounts and budgets", () => {
    expect(ids(filterTransactions(rows, { personIds: ["cris"] }, ctx))).toEqual(["zelle"]);
    expect(ids(filterTransactions(rows, { spendGroupId: NO_SPEND_GROUP, direction: "out" }, ctx))).toEqual(["crib", "amzn", "mystery"]);
    expect(ids(filterTransactions(rows, { ledger: "gen" }, ctx))).toEqual(["spent"]);
    expect(ids(filterTransactions(rows, { accountIds: ["gCard", "nope"] }, ctx))).toEqual(["spent"]);
  });

  it("sorts without touching the input", () => {
    const dated = [tx({ id: "a", amount: -1, date: "2026-11-01", description: "b" }), tx({ id: "b", amount: 9, date: "2026-11-03", description: "A" }), tx({ id: "c", amount: -5, date: "2026-11-02", description: "c" })];
    expect(ids(sortTransactions(dated))).toEqual(["b", "c", "a"]);
    expect(ids(sortTransactions(dated, "largest"))).toEqual(["b", "c", "a"]);
    expect(ids(sortTransactions(dated, "smallest"))).toEqual(["a", "c", "b"]);
    expect(ids(sortTransactions(dated, "description"))).toEqual(["b", "a", "c"]);
    expect(ids(dated)).toEqual(["a", "b", "c"]);
  });
});
