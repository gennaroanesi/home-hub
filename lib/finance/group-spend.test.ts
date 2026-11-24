import { describe, expect, it } from "vitest";
import { groupAutoAssignCandidates, groupNetSpend, listGroupTransactions } from "./group-spend";

describe("group spend", () => {
  it("nets spending, refunds back, pending out", () => {
    expect(groupNetSpend([{ amount: -100 }, { amount: 20 }, { amount: -50, status: "PENDING" }])).toBe(80);
  });
  it("offers untagged spending that isn't a transfer", () => {
    const rows = [
      { id: "a", amount: -10, category: "Dining" },
      { id: "b", amount: -10, category: "Transfers" },
      { id: "c", amount: -10, category: "Dining", spendGroupId: "g" },
      { id: "d", amount: 10, category: "Refund" },
    ];
    expect(groupAutoAssignCandidates(rows).map((t) => t.id)).toEqual(["a"]);
  });
  it("pages the spendGroupId index, newest first", async () => {
    const pages: Record<string, { data: any[]; nextToken: string | null }> = {
      start: { data: [{ id: "1", date: "2026-01-01" }], nextToken: "p2" },
      p2: { data: [{ id: "2", date: "2026-02-01" }], nextToken: null },
    };
    const client = { models: { homeFinanceTransaction: { listHomeFinanceTransactionBySpendGroupId: async (_k: unknown, o: { nextToken?: string | null }) => pages[o.nextToken ?? "start"] } } };
    expect((await listGroupTransactions(client, "g")).map((t) => t.id)).toEqual(["2", "1"]);
  });
});
